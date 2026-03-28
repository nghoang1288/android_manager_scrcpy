import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { AdbServerClient, Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { PNG } from "pngjs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { AdbDaemonDirectSocketsDevice } from "../transport/adb-daemon-direct-sockets";
import { AdbNodeJsCredentialStore } from "../credential-store";
import { prisma } from "../prisma.js";
import { ImageMatchWorkerPool, type ImageMatchWorkerPayload } from "../services/image-match-worker-pool.js";
import { parseMacroScript, type MacroScriptCondition, type MacroScriptNode } from "../../shared/macro-script.js";

const credentialStore = new AdbNodeJsCredentialStore();
const templatePngCache = new Map<string, Buffer>();
const imageBestScaleCache = new Map<string, number>();
const imageMatchWorkerPool = new ImageMatchWorkerPool();
const MACRO_RUN_RETENTION_MS = 15 * 60 * 1000;
const MAX_MACRO_RUNS = 200;
const MAX_MACRO_LOG_ENTRIES = 400;
type MacroRunStatus = "queued" | "running" | "paused" | "completed" | "failed";
type MacroRunLogEntry = {
    at: string;
    message: string;
};

type MacroRunControl = {
    paused: boolean;
    resumeResolvers: Set<() => void>;
};
type MacroExecutionSignal =
    | { type: "goto"; label: string }
    | { type: "break" }
    | { type: "exit" };

const macroRuns = new Map<string, {
    id: string;
    serial: string;
    name: string;
    status: MacroRunStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    message?: string;
    logs: MacroRunLogEntry[];
}>();
const macroRunControls = new Map<string, MacroRunControl>();

function createMacroRunControl(): MacroRunControl {
    return {
        paused: false,
        resumeResolvers: new Set(),
    };
}

function stripPausedPrefix(message?: string): string {
    if (!message) {
        return "";
    }
    return message.startsWith("Paused: ") ? message.slice("Paused: ".length) : message;
}

function formatPausedMessage(message?: string): string {
    const normalized = stripPausedPrefix(message).trim();
    return normalized ? `Paused: ${normalized}` : "Paused";
}

function resumeMacroRunControl(control: MacroRunControl | undefined) {
    if (!control) {
        return;
    }

    control.paused = false;
    for (const resolve of control.resumeResolvers) {
        resolve();
    }
    control.resumeResolvers.clear();
}

function appendMacroRunLog(run: { message?: string; logs: MacroRunLogEntry[] }, message: string) {
    const normalized = message.trim();
    if (!normalized) {
        return;
    }

    run.message = normalized;
    run.logs.push({
        at: new Date().toISOString(),
        message: normalized,
    });

    if (run.logs.length > MAX_MACRO_LOG_ENTRIES) {
        run.logs.splice(0, run.logs.length - MAX_MACRO_LOG_ENTRIES);
    }
}

function parseMacroId(id: string): number | null {
    const parsed = Number.parseInt(id, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function normalizePngLineEndings(buffer: Uint8Array): Buffer {
    const normalized: number[] = [];
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
            normalized.push(0x0a);
            i++;
        } else {
            normalized.push(buffer[i]);
        }
    }
    return Buffer.from(normalized);
}

function isValidPng(buffer: Buffer): boolean {
    try {
        PNG.sync.read(buffer);
        return true;
    } catch {
        return false;
    }
}

function hexToRgb(hex: string) {
    return {
        r: Number.parseInt(hex.slice(1, 3), 16),
        g: Number.parseInt(hex.slice(3, 5), 16),
        b: Number.parseInt(hex.slice(5, 7), 16),
    };
}

function isValidMacroContent(content: string): boolean {
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return true;
        }
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { format?: unknown }).format === "script" &&
            typeof (parsed as { source?: unknown }).source === "string"
        ) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function extractPngBufferFromDataUrl(dataUrl: string): Buffer {
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/i);
    if (!match) {
        throw new Error("Only PNG data URLs are supported");
    }
    return Buffer.from(match[1], "base64");
}

function decodePngDataUrl(dataUrl: string): PNG {
    return PNG.sync.read(extractPngBufferFromDataUrl(dataUrl));
}

function toUsablePngBuffer(source: Uint8Array): Buffer {
    const rawBuffer = Buffer.from(source);
    if (isValidPng(rawBuffer)) {
        return rawBuffer;
    }

    const normalizedBuffer = normalizePngLineEndings(source);
    if (isValidPng(normalizedBuffer)) {
        return normalizedBuffer;
    }

    return rawBuffer;
}

function normalizeMacroName(name: string): string | null {
    const normalized = name.trim();
    if (normalized.length === 0) {
        return null;
    }
    return normalized;
}

function normalizeAssetFileName(name: string): string | null {
    const base = name.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!base) {
        return null;
    }
    const withExt = base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
    if (withExt.includes("..") || withExt.includes("/") || withExt.includes("\\")) {
        return null;
    }
    return withExt;
}

type MacroAssetRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

type MacroAssetMetadata = {
    region?: MacroAssetRegion;
    updatedAt?: string;
};

function buildAssetPublicPath(fileName: string) {
    return `/api/macros/assets/${encodeURIComponent(fileName)}`;
}

function buildVersionedAssetUrl(fileName: string, updatedAt?: string) {
    const assetPath = buildAssetPublicPath(fileName);
    if (!updatedAt) {
        return assetPath;
    }

    const version = Date.parse(updatedAt);
    if (!Number.isFinite(version)) {
        return assetPath;
    }

    return `${assetPath}?v=${version}`;
}

function getCanonicalAssetPath(template: string) {
    try {
        const url = new URL(template, "http://localhost");
        return url.pathname;
    } catch {
        return template.split("?")[0] ?? template;
    }
}

async function runImageMatchInWorker(payload: ImageMatchWorkerPayload) {
    return await imageMatchWorkerPool.run(payload);
}

export async function macroRoutes(fastify: FastifyInstance) {
    const macroAssetDir = path.resolve(process.cwd(), "prisma", "macro-assets");
    const macroAssetMetadataPath = path.join(macroAssetDir, "_meta.json");
    const connector = new AdbServerNodeTcpConnector(config.adb);
    const adbClient = new AdbServerClient(connector);
    const pruneMacroRuns = () => {
        const now = Date.now();
        for (const [id, run] of macroRuns) {
            const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : 0;
            if (finishedAt > 0 && now - finishedAt > MACRO_RUN_RETENTION_MS) {
                macroRuns.delete(id);
            }
        }

        if (macroRuns.size <= MAX_MACRO_RUNS) {
            return;
        }

        const removable = [...macroRuns.values()]
            .filter((run) => run.status === "completed" || run.status === "failed")
            .sort((a, b) => Date.parse(a.finishedAt ?? a.createdAt) - Date.parse(b.finishedAt ?? b.createdAt));

        while (macroRuns.size > MAX_MACRO_RUNS && removable.length > 0) {
            const run = removable.shift();
            if (!run) {
                break;
            }
            macroRuns.delete(run.id);
        }
    };
    const macroRunCleanupTimer = setInterval(pruneMacroRuns, 60_000);

    fastify.addHook("onClose", async () => {
        clearInterval(macroRunCleanupTimer);
        for (const control of macroRunControls.values()) {
            resumeMacroRunControl(control);
        }
        macroRunControls.clear();
        await imageMatchWorkerPool.close();
    });

    const readAssetMetadata = async (): Promise<Record<string, MacroAssetMetadata>> => {
        try {
            const raw = await fs.readFile(macroAssetMetadataPath, "utf8");
            const parsed = JSON.parse(raw) as Record<string, MacroAssetMetadata>;
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            return {};
        }
    };

    const writeAssetMetadata = async (metadata: Record<string, MacroAssetMetadata>) => {
        await fs.mkdir(macroAssetDir, { recursive: true });
        await fs.writeFile(macroAssetMetadataPath, JSON.stringify(metadata, null, 2), "utf8");
    };

    const createFreshTransport = async (serial: string) => {
        try {
            const devices = await adbClient.getDevices();
            const device = devices.find((d) => d.serial === serial);
            if (device) {
                return await adbClient.createTransport(device);
            }
        } catch (error) {
            fastify.log.warn({ error, serial }, "Macro runner failed to create transport via ADB client");
        }

        if (serial.includes(":")) {
            const [host, portText] = serial.split(":");
            const directDevice = new AdbDaemonDirectSocketsDevice({
                host,
                port: Number.parseInt(portText, 10),
            });
            const connection = await directDevice.connect();
            return await AdbDaemonTransport.authenticate({
                serial: directDevice.serial,
                connection,
                credentialStore,
            });
        }

        throw new Error("Device not found");
    };

    const runShell = async (adb: Adb, command: string) => {
        const process = await adb.subprocess.shellProtocol!.spawn(command);
        let output = "";
        const reader = process.stdout.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                output += decoder.decode(value, { stream: true });
            }
        }
        output += decoder.decode();
        return output.trim();
    };

    const captureScreenshotPngBuffer = async (adb: Adb) => {
        const process = await adb.subprocess.shellProtocol!.spawn("screencap -p");
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = process.stdout.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                chunks.push(value);
                total += value.length;
            }
        }

        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        return toUsablePngBuffer(merged);
    };

    const resolveTemplatePngSource = async (template: string): Promise<string | Uint8Array> => {
        if (template.startsWith("data:image/")) {
            return template;
        }

        const canonicalTemplate = getCanonicalAssetPath(template);
        const cached = templatePngCache.get(canonicalTemplate);
        if (cached) {
            return cached;
        }

        if (canonicalTemplate.startsWith("/api/macros/assets/")) {
            const fileName = normalizeAssetFileName(decodeURIComponent(canonicalTemplate.split("/").pop() ?? ""));
            if (!fileName) {
                throw new Error(`Invalid template path: ${template}`);
            }
            const payload = await fs.readFile(path.join(macroAssetDir, fileName));
            templatePngCache.set(canonicalTemplate, payload);
            return payload;
        }

        throw new Error(`Unsupported template path: ${template}`);
    };

    const runServerScript = async (serial: string, source: string, control?: MacroRunControl, onLog?: (message: string) => void) => {
        const parsedScript = parseMacroScript(source);
        const transport = await createFreshTransport(serial);
        const adb = new Adb(transport);
        let lastImageMatch: { centerX: number; centerY: number } | null = null;
        let lastDebug = "Script test completed";
        const logStep = (message: string) => {
            lastDebug = message;
            onLog?.(message);
        };
        const waitForResumeIfPaused = async () => {
            while (control?.paused) {
                await new Promise<void>((resolve) => {
                    control.resumeResolvers.add(resolve);
                });
            }
        };
        const waitWithPause = async (durationMs: number) => {
            let remainingMs = durationMs;
            while (remainingMs > 0) {
                await waitForResumeIfPaused();
                const chunkMs = Math.min(remainingMs, 250);
                await new Promise((resolve) => setTimeout(resolve, chunkMs));
                remainingMs -= chunkMs;
            }
        };

        const evaluateCondition = async (condition: MacroScriptCondition): Promise<boolean> => {
            await waitForResumeIfPaused();
            const screenshotPng = await captureScreenshotPngBuffer(adb);
            if (condition.type === "pixel") {
                const png = PNG.sync.read(screenshotPng);
                if (condition.x < 0 || condition.y < 0 || condition.x >= png.width || condition.y >= png.height) {
                    logStep(`IF PIXEL ${condition.x} ${condition.y}: out of bounds`);
                    return false;
                }
                const idx = (condition.y * png.width + condition.x) * 4;
                const sampled = {
                    r: png.data[idx],
                    g: png.data[idx + 1],
                    b: png.data[idx + 2],
                };
                const target = hexToRgb(condition.color);
                const diff = Math.abs(sampled.r - target.r) + Math.abs(sampled.g - target.g) + Math.abs(sampled.b - target.b);
                logStep(`IF PIXEL ${condition.x} ${condition.y}: diff=${diff}, tol=${condition.tolerance}`);
                return diff <= condition.tolerance;
            }

            const templatePng = await resolveTemplatePngSource(condition.template);
            const imageCacheKey = `${serial}::${getCanonicalAssetPath(condition.template)}::${condition.mode ?? "precise"}`;
            const result = await runImageMatchInWorker({
                screenshot: screenshotPng,
                template: templatePng,
                threshold: condition.threshold,
                region: condition.region,
                mode: condition.mode,
                preferredScale: imageBestScaleCache.get(imageCacheKey),
            });
            const confidenceText = Number(result.confidence ?? 0).toFixed(3);
            const scaleText = Number(result.scale ?? 1).toFixed(2);
            if (result.found) {
                imageBestScaleCache.set(imageCacheKey, result.scale);
                lastImageMatch = { centerX: result.centerX, centerY: result.centerY };
                logStep(`IF IMAGE ${condition.template}${condition.mode ? ` ${condition.mode.toUpperCase()}` : ""}: FOUND center=(${result.centerX}, ${result.centerY}), conf=${confidenceText}, scale=${scaleText}`);
                return true;
            }
            lastImageMatch = null;
            logStep(`IF IMAGE ${condition.template}${condition.mode ? ` ${condition.mode.toUpperCase()}` : ""}: NOT FOUND best=(${result.x}, ${result.y}), conf=${confidenceText}, scale=${scaleText}`);
            return false;
        };

        const resolveKeyCode = (key: string) => {
            switch (key) {
                case "HOME": return "3";
                case "BACK": return "4";
                case "POWER": return "26";
                case "RECENTS":
                case "APP_SWITCH":
                    return "187";
                default:
                    return null;
            }
        };

        const executeNodes = async (currentNodes: MacroScriptNode[]): Promise<MacroExecutionSignal | null> => {
            for (const node of currentNodes) {
                await waitForResumeIfPaused();
                if (node.type === "wait") {
                    if (node.ms > 0) {
                        logStep(`WAIT ${node.ms}`);
                        await waitWithPause(node.ms);
                    }
                    continue;
                }
                if (node.type === "label") {
                    continue;
                }
                if (node.type === "goto") {
                    logStep(`GOTO ${node.label}`);
                    return { type: "goto", label: node.label };
                }
                if (node.type === "break") {
                    logStep("BREAK");
                    return { type: "break" };
                }
                if (node.type === "exit") {
                    logStep("EXIT");
                    return { type: "exit" };
                }
                if (node.type === "tap") {
                    await runShell(adb, `input tap ${node.x} ${node.y}`);
                    logStep(`TAP ${node.x} ${node.y}`);
                    continue;
                }
                if (node.type === "tap_match") {
                    if (!lastImageMatch) {
                        logStep("TAP_MATCH skipped because no image match result is available");
                        continue;
                    }
                    const tapX = Math.round(lastImageMatch.centerX + node.offsetX);
                    const tapY = Math.round(lastImageMatch.centerY + node.offsetY);
                    await runShell(adb, `input tap ${tapX} ${tapY}`);
                    logStep(`TAP_MATCH at (${tapX}, ${tapY})`);
                    continue;
                }
                if (node.type === "drag") {
                    await runShell(adb, `input swipe ${node.x1} ${node.y1} ${node.x2} ${node.y2} ${node.durationMs}`);
                    logStep(`DRAG ${node.x1} ${node.y1} -> ${node.x2} ${node.y2}`);
                    continue;
                }
                if (node.type === "key") {
                    const keyCode = resolveKeyCode(node.key);
                    if (!keyCode) {
                        logStep(`Unsupported KEY ${node.key}`);
                        continue;
                    }
                    await runShell(adb, `input keyevent ${keyCode}`);
                    logStep(`KEY ${node.key}`);
                    continue;
                }
                if (node.type === "for_each") {
                    let iteration = 0;
                    while (node.count === null || iteration < node.count) {
                        logStep(node.count === null ? `FOR EACH iteration ${iteration + 1}` : `FOR EACH ${iteration + 1}/${node.count}`);
                        const signal = await executeNodes(node.body);
                        if (!signal) {
                            iteration += 1;
                            continue;
                        }
                        if (signal.type === "break") {
                            break;
                        }
                        return signal;
                    }
                    continue;
                }

                const matched = await evaluateCondition(node.condition);
                await waitForResumeIfPaused();
                const signal = await executeNodes(matched ? node.thenNodes : node.elseNodes);
                if (signal) {
                    return signal;
                }
            }

            return null;
        };

        try {
            let nextIndex = 0;
            while (nextIndex < parsedScript.nodes.length) {
                const signal = await executeNodes(parsedScript.nodes.slice(nextIndex));
                if (!signal) {
                    break;
                }
                if (signal.type === "goto") {
                    const targetIndex = parsedScript.topLevelLabels[signal.label];
                    if (targetIndex === undefined) {
                        throw new Error(`Unknown label "${signal.label}"`);
                    }
                    nextIndex = targetIndex;
                    continue;
                }
                if (signal.type === "exit") {
                    break;
                }
                throw new Error("BREAK can only be used inside FOR EACH");
            }
            return { success: true, message: lastDebug };
        } finally {
            try {
                await transport.close();
            } catch {
                // Ignore transport close errors.
            }
        }
    };

    fastify.get("/", async (_request, reply) => {
        try {
            const macros = await prisma.macro.findMany({
                orderBy: { createdAt: "desc" },
            });
            return macros;
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch macros" });
        }
    });

    fastify.post("/", {
        schema: {
            body: {
                type: "object",
                required: ["name", "content"],
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 120 },
                    content: { type: "string", minLength: 2 },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: { name: string; content: string } }>, reply) => {
        const { name, content } = request.body;
        const normalizedName = normalizeMacroName(name);
        if (!normalizedName) {
            return reply.status(400).send({ error: "Macro name cannot be empty" });
        }

        if (!isValidMacroContent(content)) {
            return reply.status(400).send({ error: "Invalid macro content. Expected JSON array." });
        }

        try {
            const macro = await prisma.macro.create({
                data: {
                    name: normalizedName,
                    content,
                },
            });
            return macro;
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create macro" });
        }
    });

    fastify.put("/:id", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string" },
                },
            },
            body: {
                type: "object",
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 120 },
                    content: { type: "string", minLength: 2 },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { id: string }; Body: { name?: string; content?: string } }>, reply) => {
        const macroId = parseMacroId(request.params.id);
        if (!macroId) {
            return reply.status(400).send({ error: "Invalid macro id" });
        }

        const { name, content } = request.body;
        if (name === undefined && content === undefined) {
            return reply.status(400).send({ error: "Nothing to update" });
        }
        if (content !== undefined && !isValidMacroContent(content)) {
            return reply.status(400).send({ error: "Invalid macro content. Expected JSON array." });
        }

        let normalizedName: string | undefined;
        if (name !== undefined) {
            normalizedName = normalizeMacroName(name) ?? undefined;
            if (!normalizedName) {
                return reply.status(400).send({ error: "Macro name cannot be empty" });
            }
        }

        try {
            const macro = await prisma.macro.update({
                where: { id: macroId },
                data: {
                    ...(normalizedName !== undefined ? { name: normalizedName } : {}),
                    ...(content !== undefined ? { content } : {}),
                },
            });
            return macro;
        } catch (error) {
            fastify.log.error(error);
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
                return reply.status(404).send({ error: "Macro not found" });
            }
            return reply.status(500).send({ error: "Failed to update macro" });
        }
    });

    fastify.delete("/:id", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const macroId = parseMacroId(request.params.id);
        if (!macroId) {
            return reply.status(400).send({ error: "Invalid macro id" });
        }

        try {
            await prisma.macro.delete({
                where: { id: macroId },
            });
            return { success: true };
        } catch (error) {
            fastify.log.error(error);
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
                return reply.status(404).send({ error: "Macro not found" });
            }
            return reply.status(500).send({ error: "Failed to delete macro" });
        }
    });

    fastify.post("/run", {
        schema: {
            body: {
                type: "object",
                required: ["serial", "source"],
                properties: {
                    serial: { type: "string", minLength: 1, maxLength: 120 },
                    source: { type: "string", minLength: 1, maxLength: 50000 },
                    name: { type: "string", minLength: 1, maxLength: 120 },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: { serial: string; source: string; name?: string } }>, reply) => {
        const serial = request.body.serial.trim();
        const source = request.body.source;
        const name = normalizeMacroName(request.body.name ?? "Script Test") ?? "Script Test";

        try {
            parseMacroScript(source);
        } catch (error) {
            return reply.status(400).send({
                error: error instanceof Error ? error.message : "Invalid script",
            });
        }

        const id = randomUUID();
        const run = {
            id,
            serial,
            name,
            status: "queued" as const,
            createdAt: new Date().toISOString(),
            message: "Queued",
            logs: [],
        };
        const control = createMacroRunControl();
        pruneMacroRuns();
        appendMacroRunLog(run, "Queued");
        macroRuns.set(id, run);
        macroRunControls.set(id, control);

        void (async () => {
            const current = macroRuns.get(id);
            if (!current) {
                return;
            }
            current.status = control.paused ? "paused" : "running";
            current.startedAt = new Date().toISOString();
            appendMacroRunLog(current, control.paused ? formatPausedMessage(current.message) : "Running");
            try {
                const result = await runServerScript(serial, source, control, (message) => {
                    appendMacroRunLog(current, message);
                });
                current.status = "completed";
                current.finishedAt = new Date().toISOString();
                appendMacroRunLog(current, result.message ? `Completed: ${result.message}` : "Completed");
            } catch (error) {
                current.status = "failed";
                current.finishedAt = new Date().toISOString();
                appendMacroRunLog(current, error instanceof Error ? `Failed: ${error.message}` : "Failed: Run failed");
                fastify.log.error({ error, serial, runId: id }, "Macro server run failed");
            } finally {
                resumeMacroRunControl(control);
                macroRunControls.delete(id);
                pruneMacroRuns();
            }
        })();

        return {
            success: true,
            runId: id,
            status: run.status,
        };
    });

    fastify.get("/run/:id", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const run = macroRuns.get(request.params.id);
        if (!run) {
            return reply.status(404).send({ error: "Run not found" });
        }
        return run;
    });

    fastify.post("/run/:id/pause", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const run = macroRuns.get(request.params.id);
        if (!run) {
            return reply.status(404).send({ error: "Run not found" });
        }
        if (run.status === "completed" || run.status === "failed") {
            return reply.status(409).send({ error: "Run has already finished" });
        }

        const control = macroRunControls.get(request.params.id);
        if (!control) {
            return reply.status(409).send({ error: "Run cannot be paused" });
        }

        control.paused = true;
        run.status = "paused";
        appendMacroRunLog(run, formatPausedMessage(run.message));

        return {
            success: true,
            runId: run.id,
            status: run.status,
            message: run.message,
        };
    });

    fastify.post("/run/:id/resume", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const run = macroRuns.get(request.params.id);
        if (!run) {
            return reply.status(404).send({ error: "Run not found" });
        }
        if (run.status === "completed" || run.status === "failed") {
            return reply.status(409).send({ error: "Run has already finished" });
        }

        const control = macroRunControls.get(request.params.id);
        if (!control) {
            return reply.status(409).send({ error: "Run cannot be resumed" });
        }

        resumeMacroRunControl(control);
        run.status = "running";
        appendMacroRunLog(run, stripPausedPrefix(run.message) || "Running");

        return {
            success: true,
            runId: run.id,
            status: run.status,
            message: run.message,
        };
    });

    fastify.post("/image-match", {
        bodyLimit: 25 * 1024 * 1024,
        schema: {
            body: {
                type: "object",
                required: ["screenshotDataUrl"],
                properties: {
                    screenshotDataUrl: { type: "string", minLength: 32 },
                    template: { type: "string", minLength: 1 },
                    templateDataUrl: { type: "string", minLength: 32 },
                    threshold: { type: "number", minimum: 0, maximum: 1 },
                    mode: { type: "string", enum: ["fast", "precise"] },
                    preferredScale: { type: "number", minimum: 0.1, maximum: 5 },
                    region: {
                        type: "object",
                        properties: {
                            x: { type: "number", minimum: 0 },
                            y: { type: "number", minimum: 0 },
                            width: { type: "number", minimum: 1 },
                            height: { type: "number", minimum: 1 },
                        },
                    },
                },
            },
        },
    }, async (request: FastifyRequest<{
        Body: {
            screenshotDataUrl: string;
            template?: string;
            templateDataUrl?: string;
            threshold?: number;
            region?: { x: number; y: number; width: number; height: number };
            mode?: "fast" | "precise";
            preferredScale?: number;
        };
    }>, reply) => {
        const { screenshotDataUrl, template, templateDataUrl, threshold = 0.9, region, mode, preferredScale } = request.body;

        try {
            if (!template && !templateDataUrl) {
                return reply.status(400).send({ error: "template or templateDataUrl is required" });
            }

            const templateSource = template
                ? await resolveTemplatePngSource(template)
                : templateDataUrl;

            if (!templateSource) {
                return reply.status(400).send({ error: "template or templateDataUrl is required" });
            }

            return await runImageMatchInWorker({
                screenshot: screenshotDataUrl,
                template: templateSource,
                threshold,
                region,
                mode,
                preferredScale,
            });
        } catch (error) {
            fastify.log.error(error);
            const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
                ? error.statusCode
                : 500;
            return reply.status(statusCode).send({
                error: error instanceof Error ? error.message : "Image matching failed",
            });
        }
    });

    fastify.post("/assets", {
        schema: {
            body: {
                type: "object",
                required: ["name", "dataUrl"],
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 160 },
                    dataUrl: { type: "string", minLength: 32 },
                    region: {
                        type: "object",
                        properties: {
                            x: { type: "number", minimum: 0 },
                            y: { type: "number", minimum: 0 },
                            width: { type: "number", minimum: 1 },
                            height: { type: "number", minimum: 1 },
                        },
                    },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: { name: string; dataUrl: string; region?: MacroAssetRegion } }>, reply) => {
        const fileName = normalizeAssetFileName(request.body.name);
        if (!fileName) {
            return reply.status(400).send({ error: "Invalid file name" });
        }

        try {
            const png = decodePngDataUrl(request.body.dataUrl);
            const encoded = PNG.sync.write(png);
            await fs.mkdir(macroAssetDir, { recursive: true });
            const filePath = path.join(macroAssetDir, fileName);
            await fs.writeFile(filePath, encoded);
            const metadata = await readAssetMetadata();
            const updatedAt = new Date().toISOString();
            metadata[fileName] = {
                ...metadata[fileName],
                region: request.body.region,
                updatedAt,
            };
            await writeAssetMetadata(metadata);
            const publicPath = buildAssetPublicPath(fileName);
            templatePngCache.set(publicPath, Buffer.from(encoded));
            for (const key of [...imageBestScaleCache.keys()]) {
                if (key.includes(`::${publicPath}::`)) {
                    imageBestScaleCache.delete(key);
                }
            }

            return {
                success: true,
                name: fileName,
                url: buildVersionedAssetUrl(fileName, updatedAt),
                width: png.width,
                height: png.height,
                region: request.body.region,
            };
        } catch (error) {
            fastify.log.error(error);
            return reply.status(400).send({ error: "Invalid PNG data URL" });
        }
    });

    fastify.get("/assets", async (_request, reply) => {
        try {
            await fs.mkdir(macroAssetDir, { recursive: true });
            const entries = await fs.readdir(macroAssetDir, { withFileTypes: true });
            const metadata = await readAssetMetadata();
            const files = entries
                .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
                .map((entry) => entry.name)
                .sort((a, b) => a.localeCompare(b));

            return files.map((name) => ({
                name,
                url: buildVersionedAssetUrl(name, metadata[name]?.updatedAt),
                region: metadata[name]?.region,
            }));
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to list macro assets" });
        }
    });

    fastify.get("/assets/:name", {
        schema: {
            params: {
                type: "object",
                required: ["name"],
                properties: {
                    name: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
        const decodedName = decodeURIComponent(request.params.name);
        const fileName = normalizeAssetFileName(decodedName);
        if (!fileName) {
            return reply.status(400).send({ error: "Invalid file name" });
        }

        const filePath = path.join(macroAssetDir, fileName);
        try {
            const payload = await fs.readFile(filePath);
            reply.header("Cache-Control", "public, max-age=31536000, immutable");
            reply.type("image/png");
            return reply.send(payload);
        } catch {
            return reply.status(404).send({ error: "Image not found" });
        }
    });

    fastify.delete("/assets/:name", {
        schema: {
            params: {
                type: "object",
                required: ["name"],
                properties: {
                    name: { type: "string" },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
        const decodedName = decodeURIComponent(request.params.name);
        const fileName = normalizeAssetFileName(decodedName);
        if (!fileName) {
            return reply.status(400).send({ error: "Invalid file name" });
        }

        const filePath = path.join(macroAssetDir, fileName);
        try {
            await fs.unlink(filePath);
            const publicPath = buildAssetPublicPath(fileName);
            templatePngCache.delete(publicPath);
            const metadata = await readAssetMetadata();
            delete metadata[fileName];
            await writeAssetMetadata(metadata);
            for (const key of [...imageBestScaleCache.keys()]) {
                if (key.includes(`::${publicPath}::`)) {
                    imageBestScaleCache.delete(key);
                }
            }
            return { success: true };
        } catch {
            return reply.status(404).send({ error: "Image not found" });
        }
    });
}
