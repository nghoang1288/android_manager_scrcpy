/**
 * ADB 设备管理路由
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { AdbServerClient, Adb, AdbDaemonTransport, type AdbPacketData, type AdbPacketInit } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import type { AdbTransport } from "@yume-chan/adb";
import { WebSocket } from "ws";
import { type ReadableWritablePair, Consumable, ReadableStream, TextDecoderStream } from "@yume-chan/stream-extra";
import { AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath } from "@yume-chan/scrcpy";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import fs from "fs/promises";
import { PNG } from "pngjs";
import cookie from "@fastify/cookie";
import { config } from "../config.js";
import { AdbDaemonDirectSocketsDevice } from "../transport/adb-daemon-direct-sockets";
import { AdbNodeJsCredentialStore } from "../credential-store";
import { prisma } from "../prisma.js";
import { WS } from "../transport/socket-websocket.ts";
import type { DeviceInfo, DeviceResponse, DeviceBasicInfo } from "../../types/device.types";

const credentialStore = new AdbNodeJsCredentialStore();
const WS_HEARTBEAT_INTERVAL_MS = 25_000;
const WS_HEARTBEAT_TIMEOUT_MS = 10_000;
const TRANSPORT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEVICE_INFO_TTL_MS = 15_000;
const DEVICE_LIST_BROADCAST_DEBOUNCE_MS = 150;
type RegisteredDeviceLite = {
    serial_no: string;
    market_name: string | null;
    model: string | null;
};

type TransportCacheEntry = {
    transport: AdbTransport;
    lastUsedAt: number;
    activeSockets: number;
};

type DeviceInfoCacheEntry = {
    info: DeviceInfo;
    expiresAt: number;
};

type DevicePowerState = {
    screenOff: boolean;
    screenState: string;
    interactive: boolean | null;
    wakefulness: string | null;
};

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

function normalizeSerial(serial: string): string {
    return serial.trim().toLowerCase();
}

function mergeDeviceInfos(basicInfos: DeviceBasicInfo[], registeredDevices: RegisteredDeviceLite[]): DeviceBasicInfo[] {
    const onlineSerials = new Set(basicInfos.map((device) => normalizeSerial(device.serial)));
    const registeredDeviceInfos = registeredDevices
        .filter((device) => !onlineSerials.has(normalizeSerial(device.serial_no)))
        .map((device): DeviceBasicInfo => ({
            serial: device.serial_no,
            state: "offline",
            model: device.market_name || '',
            product: device.serial_no || '',
            device: device.model || '',
            transportId: Number(-1)
        }));

    return [...basicInfos, ...registeredDeviceInfos];
}

function attachHeartbeat(socket: WebSocket, logger: FastifyInstance["log"], channel: string): () => void {
    let isAlive = true;
    let pongTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
        clearInterval(interval);
        if (pongTimeout) {
            clearTimeout(pongTimeout);
            pongTimeout = null;
        }
        socket.off("pong", onPong);
    };

    const onPong = () => {
        isAlive = true;
        if (pongTimeout) {
            clearTimeout(pongTimeout);
            pongTimeout = null;
        }
    };

    socket.on("pong", onPong);

    const interval = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
            cleanup();
            return;
        }

        if (!isAlive) {
            logger.warn({ channel }, "WebSocket heartbeat timeout, terminating stale connection");
            socket.terminate();
            cleanup();
            return;
        }

        isAlive = false;
        try {
            socket.ping();
            pongTimeout = setTimeout(() => {
                if (!isAlive && socket.readyState === WebSocket.OPEN) {
                    logger.warn({ channel }, "WebSocket pong not received in time, terminating connection");
                    socket.terminate();
                }
            }, WS_HEARTBEAT_TIMEOUT_MS);
        } catch (error) {
            logger.warn({ channel, error }, "Failed to send WebSocket ping");
            socket.terminate();
            cleanup();
        }
    }, WS_HEARTBEAT_INTERVAL_MS);

    socket.on("close", cleanup);
    socket.on("error", cleanup);
    return cleanup;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function runShellCommand(adb: Adb, command: string): Promise<string> {
    const process = await adb.subprocess.shellProtocol!.spawn(command);
    let output = "";
    for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
        output += chunk;
    }
    return output.trim();
}

function normalizeScreenState(rawState: string | undefined | null): string {
    const normalized = rawState?.trim().toUpperCase();
    if (!normalized) {
        return "UNKNOWN";
    }

    switch (normalized) {
        case "0":
        case "UNKNOWN":
            return "UNKNOWN";
        case "1":
        case "OFF":
            return "OFF";
        case "2":
        case "ON":
            return "ON";
        case "3":
        case "DOZE":
            return "DOZE";
        case "4":
        case "DOZE_SUSPEND":
            return "DOZE_SUSPEND";
        case "5":
        case "VR":
            return "VR";
        case "6":
        case "ON_SUSPEND":
            return "ON_SUSPEND";
        default:
            return normalized;
    }
}

function parseDevicePowerState(powerDump: string, displayDump = ""): DevicePowerState {
    const wakefulnessMatch = powerDump.match(/mWakefulness=([A-Za-z_]+)/);
    const interactiveMatch = powerDump.match(/mInteractive=(true|false)/i);
    const screenStateMatch =
        powerDump.match(/Display Power:\s*state=([A-Za-z0-9_]+)/i) ??
        powerDump.match(/mScreenState=([A-Za-z0-9_]+)/i) ??
        displayDump.match(/mScreenState=([A-Za-z0-9_]+)/i) ??
        displayDump.match(/mGlobalDisplayState=([A-Za-z0-9_]+)/i) ??
        displayDump.match(/mDisplayState=([A-Za-z0-9_]+)/i) ??
        displayDump.match(/screenState=([A-Za-z0-9_]+)/i);

    const wakefulness = wakefulnessMatch?.[1]?.toUpperCase() ?? null;
    const interactive = interactiveMatch
        ? interactiveMatch[1].toLowerCase() === "true"
        : null;
    const screenState = normalizeScreenState(screenStateMatch?.[1]);
    const inferredScreenOffFromWakefulness = wakefulness === "ASLEEP";
    const screenOff = screenState === "OFF" || screenState === "DOZE" || screenState === "DOZE_SUSPEND"
        ? true
        : screenState === "UNKNOWN"
            ? inferredScreenOffFromWakefulness
            : false;

    return {
        screenOff,
        screenState,
        interactive,
        wakefulness,
    };
}

async function readDevicePowerState(adb: Adb): Promise<DevicePowerState> {
    const powerDump = await runShellCommand(adb, "dumpsys power");
    let parsed = parseDevicePowerState(powerDump);

    if (parsed.screenState !== "UNKNOWN") {
        return parsed;
    }

    const displayDump = await runShellCommand(adb, "dumpsys display");
    parsed = parseDevicePowerState(powerDump, displayDump);
    return parsed;
}

export async function adbRoutes(fastify: FastifyInstance) {

    // 初始化 ADB 客户端
    const connector = new AdbServerNodeTcpConnector(config.adb);
    const adbClient = new AdbServerClient(connector);
    fastify.log.info('ADB client initialized');

    // 读取 scrcpy server
    const server = await fs.readFile(BIN);
    fastify.log.info({ version: VERSION }, 'Scrcpy server loaded');

    // 模块内部状态
    const transportCache = new Map<string, TransportCacheEntry>();
    const deviceInfoCache = new Map<string, DeviceInfoCacheEntry>();
    const wsClients = new Set<WebSocket>();
    let pendingDeviceBroadcast: DeviceBasicInfo[] | null = null;
    let deviceBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
    const loadRegisteredDevicesLite = async (): Promise<RegisteredDeviceLite[]> => {
        return await prisma.device.findMany({
            select: {
                serial_no: true,
                market_name: true,
                model: true,
            },
        });
    };
    const touchTransportEntry = (serial: string) => {
        const entry = transportCache.get(serial);
        if (entry) {
            entry.lastUsedAt = Date.now();
        }
        return entry ?? null;
    };
    const setTransportEntry = (serial: string, transport: AdbTransport) => {
        const entry: TransportCacheEntry = {
            transport,
            lastUsedAt: Date.now(),
            activeSockets: 0,
        };
        transportCache.set(serial, entry);
        return entry;
    };
    const closeTransportEntry = async (serial: string, reason: string) => {
        const entry = transportCache.get(serial);
        if (!entry) {
            return;
        }

        transportCache.delete(serial);
        deviceInfoCache.delete(serial);

        try {
            await entry.transport.close();
        } catch (error) {
            fastify.log.warn({ serial, error, reason }, "Failed to close cached transport");
        }
    };
    const mapAdbDevicesToBasicInfos = (devices: ReadonlyArray<{ serial: string; state: string; model?: string; product?: string; device?: string; transportId?: bigint | number }>) => {
        return devices.map((device): DeviceBasicInfo => ({
            serial: device.serial,
            state: device.state as DeviceBasicInfo["state"],
            model: device.model || "",
            product: device.product || "",
            device: device.device || "",
            transportId: Number(device.transportId),
        }));
    };
    const buildMergedDeviceInfos = async (basicInfos: DeviceBasicInfo[]) => {
        const registeredDevices = await loadRegisteredDevicesLite();
        return mergeDeviceInfos(basicInfos, registeredDevices);
    };
    const broadcastDeviceInfos = async (basicInfos: DeviceBasicInfo[]) => {
        const allDeviceInfos = await buildMergedDeviceInfos(basicInfos);
        const payload = JSON.stringify(allDeviceInfos);
        for (const client of wsClients) {
            if (client.readyState !== WebSocket.OPEN) {
                continue;
            }
            try {
                client.send(payload);
            } catch (error) {
                fastify.log.warn({ error }, "Failed to push device update over WebSocket");
            }
        }
    };
    const scheduleDeviceBroadcast = (basicInfos: DeviceBasicInfo[]) => {
        pendingDeviceBroadcast = basicInfos;
        if (deviceBroadcastTimer) {
            clearTimeout(deviceBroadcastTimer);
        }
        deviceBroadcastTimer = setTimeout(() => {
            const snapshot = pendingDeviceBroadcast;
            pendingDeviceBroadcast = null;
            deviceBroadcastTimer = null;
            if (snapshot) {
                void broadcastDeviceInfos(snapshot);
            }
        }, DEVICE_LIST_BROADCAST_DEBOUNCE_MS);
    };
    const cleanupIdleTransports = async () => {
        const now = Date.now();
        for (const [serial, entry] of transportCache) {
            if (entry.activeSockets > 0) {
                continue;
            }
            if (now - entry.lastUsedAt > TRANSPORT_IDLE_TTL_MS) {
                await closeTransportEntry(serial, "idle_ttl");
            }
        }

        for (const [serial, entry] of deviceInfoCache) {
            if (entry.expiresAt <= now) {
                deviceInfoCache.delete(serial);
            }
        }
    };
    const transportCleanupTimer = setInterval(() => {
        void cleanupIdleTransports();
    }, 60_000);
    const getOrCreateTransport = async (serial: string): Promise<{ transport: AdbTransport | null; directTcpErrorMessage?: string }> => {
        let transport = touchTransportEntry(serial)?.transport ?? null;
        let directTcpErrorMessage: string | undefined;
        if (transport) {
            return { transport };
        }

        try {
            const devices = await adbClient.getDevices();
            const device = devices.find((d) => d.serial === serial);
            if (device) {
                transport = await adbClient.createTransport(device);
                setTransportEntry(serial, transport);
                return { transport };
            }
        } catch (e) {
            fastify.log.warn({ err: e, serial }, "Failed to create transport via ADB Client");
        }

        if (serial.includes(":")) {
            try {
                const ipi = serial.split(":");
                const device = new AdbDaemonDirectSocketsDevice({
                    host: ipi[0],
                    port: parseInt(ipi[1], 10),
                });
                const connection = await withTimeout(
                    device.connect(),
                    8000,
                    `Direct TCP connect timeout to ${serial}`
                );
                transport = await withTimeout(AdbDaemonTransport.authenticate({
                    serial: device.serial,
                    connection,
                    credentialStore,
                }),
                    8000,
                    `Direct TCP authentication timeout for ${serial}`
                );
                setTransportEntry(serial, transport);
                return { transport };
            } catch (e) {
                directTcpErrorMessage = e instanceof Error ? e.message : "Direct TCP connection failed";
                fastify.log.error({ err: e, serial }, "Failed to create Direct TCP transport");
            }
        }

        return { transport: null, directTcpErrorMessage };
    };
    const createFreshTransport = async (serial: string): Promise<{ transport: AdbTransport | null; directTcpErrorMessage?: string }> => {
        let directTcpErrorMessage: string | undefined;

        try {
            const devices = await adbClient.getDevices();
            const device = devices.find((d) => d.serial === serial);
            if (device) {
                const transport = await adbClient.createTransport(device);
                return { transport };
            }
        } catch (e) {
            fastify.log.warn({ err: e, serial }, "Failed to create fresh transport via ADB Client");
        }

        if (serial.includes(":")) {
            try {
                const ipi = serial.split(":");
                const device = new AdbDaemonDirectSocketsDevice({
                    host: ipi[0],
                    port: parseInt(ipi[1], 10),
                });
                const connection = await withTimeout(
                    device.connect(),
                    8000,
                    `Direct TCP connect timeout to ${serial}`
                );
                const transport = await withTimeout(AdbDaemonTransport.authenticate({
                    serial: device.serial,
                    connection,
                    credentialStore,
                }),
                    8000,
                    `Direct TCP authentication timeout for ${serial}`
                );
                return { transport };
            } catch (e) {
                directTcpErrorMessage = e instanceof Error ? e.message : "Direct TCP connection failed";
                fastify.log.error({ err: e, serial }, "Failed to create fresh Direct TCP transport");
            }
        }

        return { transport: null, directTcpErrorMessage };
    };

    // 注册清理钩子（优雅关闭时执行）
    fastify.addHook('onClose', async () => {
        fastify.log.info('Cleaning up ADB resources...');
        clearInterval(transportCleanupTimer);
        if (deviceBroadcastTimer) {
            clearTimeout(deviceBroadcastTimer);
            deviceBroadcastTimer = null;
        }

        // 关闭所有 WebSocket 连接
        for (const client of wsClients) {
            if (client.readyState === 1) { // OPEN
                client.close(1001, 'Server shutting down');
            }
        }
        fastify.log.info({ count: wsClients.size }, 'WebSocket clients closed');

        // 关闭所有 Transport 连接
        for (const serial of [...transportCache.keys()]) {
            await closeTransportEntry(serial, "server_shutdown");
            fastify.log.debug({ serial }, 'Transport closed');
        }
        fastify.log.info({ count: transportCache.size }, 'Transport connections closed');
    });

    // 设备变化监听
    adbClient.trackDevices().then((observer) => {
        observer.onListChange(async (devices) => {
            fastify.log.debug({ count: devices.length }, 'Device list changed');

            // 广播给所有 WebSocket 客户端
            const basicInfos = mapAdbDevicesToBasicInfos(devices);
            const onlineSerials = new Set(
                basicInfos
                    .filter((device) => device.state === "device")
                    .map((device) => normalizeSerial(device.serial)),
            );

            for (const [serial, entry] of transportCache) {
                if (entry.activeSockets === 0 && !onlineSerials.has(normalizeSerial(serial))) {
                    await closeTransportEntry(serial, "device_offline");
                }
            }

            scheduleDeviceBroadcast(basicInfos);
        });
    }).catch((error) => {
        fastify.log.error(error, 'Failed to track devices');
    });

    // 认证 Hook
    // fastify.addHook('preValidation', async (request, reply) => {
    //     const cookies = cookie.parse(request.headers.cookie || "");
    //     if (request.ws && cookies.session !== config.auth.sessionToken) {
    //         return reply.code(401).send({error: "Unauthorized"});
    //     }
    // });

    // 获取设备列表（HTTP + WebSocket）
    fastify.route({
        method: 'GET',
        url: '/devices',
        handler: async (_req, reply) => {
            try {
                const devices = await adbClient.getDevices();
                const basicInfos = mapAdbDevicesToBasicInfos(devices);
                const allDeviceInfos = await buildMergedDeviceInfos(basicInfos);
                reply.setCookie("session", config.auth.sessionToken, {
                    path: "/",
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: "lax"
                }).send(allDeviceInfos);
            } catch (err) {
                reply.log.error(err, "Failed to get devices");
                reply.code(500).send({ error: "Failed to get devices" });
            }
        },
        wsHandler: async (socket) => {
            wsClients.add(socket);
            const detachHeartbeat = attachHeartbeat(socket, fastify.log, "/api/adb/devices");

            socket.on("close", () => {
                wsClients.delete(socket);
                detachHeartbeat();
            });

            try {
                let devices: any[] = [];
                try {
                    devices = await adbClient.getDevices();
                } catch (e) {
                    fastify.log.warn("Failed to get ADB devices (ADB server might be down), continuing with DB devices only");
                }

                const basicInfos = mapAdbDevicesToBasicInfos(devices);
                const allDeviceInfos = await buildMergedDeviceInfos(basicInfos);
                socket.send(JSON.stringify(allDeviceInfos));

            } catch (err) {
                fastify.log.error(err, 'Failed to send initial device list to WebSocket');
                // Don't close socket on error, to allow retry or keep connection alive
                // socket.close(); 
            }
        }
    });

    fastify.post("/wireless/connect", {
        schema: {
            body: {
                type: "object",
                required: ["address"],
                properties: {
                    address: { type: "string", minLength: 7, maxLength: 64 },
                },
            },
        },
    }, async (req: FastifyRequest<{ Body: { address: string } }>, reply) => {
        const address = req.body.address.trim();
        try {
            await withTimeout(
                adbClient.wireless.connect(address),
                8000,
                `Wireless connect timeout for ${address}`
            );
            return { success: true, address };
        } catch (error) {
            req.log.error({ error, address }, "Wireless connect failed");
            return reply.status(400).send({
                success: false,
                error: error instanceof Error ? error.message : "Wireless connect failed",
                address,
            });
        }
    });

    fastify.post("/wireless/pair", {
        schema: {
            body: {
                type: "object",
                required: ["pairAddress", "pairingCode"],
                properties: {
                    pairAddress: { type: "string", minLength: 7, maxLength: 64 },
                    pairingCode: { type: "string", minLength: 4, maxLength: 16 },
                    connectAddress: { type: "string", minLength: 7, maxLength: 64 },
                },
            },
        },
    }, async (req: FastifyRequest<{
        Body: { pairAddress: string; pairingCode: string; connectAddress?: string };
    }>, reply) => {
        const pairAddress = req.body.pairAddress.trim();
        const pairingCode = req.body.pairingCode.trim();
        const connectAddress = req.body.connectAddress?.trim();

        try {
            await withTimeout(
                adbClient.wireless.pair(pairAddress, pairingCode),
                10000,
                `Wireless pair timeout for ${pairAddress}`
            );

            if (connectAddress) {
                await withTimeout(
                    adbClient.wireless.connect(connectAddress),
                    8000,
                    `Wireless connect timeout for ${connectAddress}`
                );
            }

            return {
                success: true,
                pairAddress,
                connectAddress: connectAddress ?? null,
            };
        } catch (error) {
            req.log.error({ error, pairAddress, connectAddress }, "Wireless pair failed");
            return reply.status(400).send({
                success: false,
                error: error instanceof Error ? error.message : "Wireless pair failed",
                pairAddress,
                connectAddress: connectAddress ?? null,
            });
        }
    });

    // 获取单个设备信息（HTTP + WebSocket）
    fastify.get("/device/:serial/power-state", {
        schema: {
            params: {
                type: "object",
                required: ["serial"],
                properties: {
                    serial: { type: "string" },
                },
            },
        },
    }, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
        const serial = decodeURIComponent(req.params.serial);
        const { transport, directTcpErrorMessage } = await getOrCreateTransport(serial);

        try {
            if (!transport) {
                if (directTcpErrorMessage) {
                    return reply.status(504).send({
                        error: directTcpErrorMessage,
                        hint: "Ensure device is reachable and Wireless Debugging is active.",
                    });
                }
                return reply.status(404).send({ error: "Device not found" });
            }

            const powerState = await readDevicePowerState(new Adb(transport));
            return {
                success: true,
                serial,
                ...powerState,
            };
        } catch (error) {
            await closeTransportEntry(serial, "power_state_error");
            req.log.error({ error, serial }, "Failed to get device power state");
            return reply.status(500).send({ error: "Failed to get device power state" });
        }
    });

    fastify.get("/device/:serial/screenshot", {
        schema: {
            params: {
                type: "object",
                required: ["serial"],
                properties: {
                    serial: { type: "string" },
                },
            },
        },
    }, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
        const serial = decodeURIComponent(req.params.serial);
        const { transport, directTcpErrorMessage } = await createFreshTransport(serial);
        if (!transport) {
            if (directTcpErrorMessage) {
                return reply.status(504).send({
                    error: directTcpErrorMessage,
                    hint: "Ensure device is reachable and Wireless Debugging is active.",
                });
            }
            return reply.status(404).send({ error: "Device not found" });
        }

        try {
            const adb = new Adb(transport);
            const process = await adb.subprocess.shellProtocol!.spawn("screencap -p");
            const chunks: Uint8Array[] = [];
            let total = 0;
            const reader = process.stdout.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
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

            const buffer = toUsablePngBuffer(merged);
            return {
                success: true,
                serial,
                dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
            };
        } catch (error) {
            req.log.error({ error, serial }, "Failed to capture screenshot");
            return reply.status(500).send({ error: "Failed to capture screenshot" });
        } finally {
            try {
                await transport.close();
            } catch (closeError) {
                req.log.warn({ closeError, serial }, "Failed to close fresh screenshot transport");
            }
        }
    });
fastify.route({
        method: 'GET',
        url: '/device/:serial',
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    serial: { type: 'string' },
                    service: { type: 'string' }
                }
            }
        },
        handler: async (req: FastifyRequest<{ Params: { serial: string }, Querystring: { service: string } }>, reply) => {
            const serial = decodeURIComponent(req.params.serial);
            const { transport, directTcpErrorMessage } = await getOrCreateTransport(serial);
            

            try {
                // 从缓存获取 如果transport失效 可能出现麻烦 无响应等
                

                if (!transport) {
                    if (directTcpErrorMessage) {
                        return reply.status(504).send({
                            message: directTcpErrorMessage,
                            hint: "Ensure device was paired (adb pair), host/port reachable, and wireless debugging is active.",
                        });
                    }
                    return reply.status(404).send({ message: "Device not found" });
                }

                const cachedInfo = deviceInfoCache.get(serial);
                if (cachedInfo && cachedInfo.expiresAt > Date.now()) {
                    return {
                        serial,
                        state: "device",
                        model: transport.banner.model || '',
                        product: transport.banner.product || transport.banner.model || '',
                        device: transport.banner.device || '',
                        maxPayloadSize: transport.maxPayloadSize,
                        features: transport.banner.features,
                        info: cachedInfo.info,
                    } satisfies DeviceResponse;
                }

                const deviceInfo = await parseDeviceInfo(new Adb(transport), fastify);

                // 保存或更新设备信息到数据库
                try {
                    await prisma.device.upsert({
                        where: {
                            serial_no: serial
                        },
                        update: {
                            android_id: deviceInfo.android_id,
                            boot_id: deviceInfo.boot_id,
                            ble_mac: deviceInfo.ble_mac,
                            model: deviceInfo.model,
                            market_name: deviceInfo.market_name,
                            version: deviceInfo.android_version,
                            kernel_ver: deviceInfo.kernel_version,
                            adb_enabled: deviceInfo.adb_enabled ? '1' : '0',
                            adb_port: deviceInfo.adb_port.toString(),
                            adb_status: deviceInfo.adb_status,
                            adb_pid: deviceInfo.adb_pid.toString(),
                            iface: deviceInfo.network_interface,
                            src_ip: deviceInfo.network_src_ip,
                            iface_ip: deviceInfo.network_ip,
                        },
                        create: {
                            serial_no: serial,
                            android_id: deviceInfo.android_id,
                            boot_id: deviceInfo.boot_id,
                            ble_mac: deviceInfo.ble_mac,
                            model: deviceInfo.model,
                            market_name: deviceInfo.market_name,
                            version: deviceInfo.android_version,
                            kernel_ver: deviceInfo.kernel_version,
                            adb_enabled: deviceInfo.adb_enabled ? '1' : '0',
                            adb_port: deviceInfo.adb_port.toString(),
                            adb_status: deviceInfo.adb_status,
                            adb_pid: deviceInfo.adb_pid.toString(),
                            iface: deviceInfo.network_interface,
                            src_ip: deviceInfo.network_src_ip,
                            iface_ip: deviceInfo.network_ip,
                        }
                    });
                    deviceInfoCache.set(serial, {
                        info: deviceInfo,
                        expiresAt: Date.now() + DEVICE_INFO_TTL_MS,
                    });
                    req.log.info({ serial: deviceInfo.serial_no || serial }, 'Device info saved to database');
                } catch (dbError) {
                    req.log.error(dbError, 'Failed to save device info to database');
                    // 不影响主流程，继续返回响应
                }

                // 返回符合 DeviceResponse 接口的数据
                const response: DeviceResponse = {
                    serial: serial,
                    state: "device",
                    model: transport.banner.model || '',
                    product: transport.banner.product || transport.banner.model || '',
                    device: transport.banner.device || '',
                    maxPayloadSize: transport.maxPayloadSize,
                    features: transport.banner.features,
                    info: deviceInfo,
                };

                return response;
            } catch (error) {
                await closeTransportEntry(serial, "device_info_error");
                req.log.error(error, "Failed to get device info");
                return reply.code(500).send({ error: "Failed to get device info" });
            }
        },
        wsHandler: async (client, req: FastifyRequest<{
            Params: { serial: string },
            Querystring: { service: string }
        }>) => {
            const serial = decodeURIComponent(req.params.serial);
            const { service } = req.query;

            req.log.info({ serial, service }, "WebSocket connection");

            if (!serial) {
                client.close(4000, "Serial number required");
                return;
            }
            const transportEntry = touchTransportEntry(serial);
            const transport = transportEntry?.transport;
            if (!transportEntry || !transport) {
                client.close(4004, "Transport not found");
                return;
            }

            const detachHeartbeat = attachHeartbeat(client, req.log, `/api/adb/device/${serial}`);
            transportEntry.activeSockets += 1;
            client.on("close", () => {
                transportEntry.activeSockets = Math.max(0, transportEntry.activeSockets - 1);
                transportEntry.lastUsedAt = Date.now();
                detachHeartbeat();
            });

            try {

                // 推送 scrcpy server（如果需要）
                if (service.includes("com.genymobile.scrcpy.Server")) {
                    req.log.info("Pushing scrcpy server");
                    const adb = new Adb(transport);
                    await AdbScrcpyClient.pushServer(
                        adb,
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(new Uint8Array(server));
                                controller.close();
                            },
                        }),
                        DefaultServerPath
                    );
                }

                try {
                    const socket = await transport.connect(service);
                    await WS.build(socket, client, req)
                } catch (err) {
                    req.log.error(err, "ADB socket open failed")
                    client.close();
                    return;
                }
            } catch (error) {
                await closeTransportEntry(serial, "ws_connection_error");
                req.log.error(error, "WebSocket connection failed");
                client.close(4500, "Connection failed");
            }
        }
    });
}

async function parseDeviceInfo(adb: Adb, fastify: FastifyInstance): Promise<DeviceInfo> {
    // 执行多个 shell 命令获取设备信息
    const commands = {
        serial_no: 'getprop ro.serialno',
        android_id: 'settings get secure android_id',
        ble_mac: 'settings get secure bluetooth_address',
        boot_id: 'cat /proc/sys/kernel/random/boot_id',
        model: 'getprop ro.product.model',
        market_name: 'getprop ro.product.vendor.marketname',
        manufacturer: 'getprop ro.product.manufacturer',
        brand: 'getprop ro.product.brand',
        product: 'getprop ro.product.product',
        device: 'getprop ro.product.device',
        version: 'getprop ro.build.version.release',
        sdk_version: 'getprop ro.build.version.sdk',
        security_patch: 'getprop ro.build.version.security_patch',
        kernel_ver: 'uname -r',
        adb_enabled: 'settings get global adb_enabled',
        adb_port: 'getprop service.adb.tcp.port',
        adb_status: 'getprop init.svc.adbd',
        adb_pid: 'pidof adbd',
        iface: "ip route get 1 | grep -oE 'dev [^ ]+' | awk '{print $2}'",
        src_ip: "ip route get 1 | grep -oE 'src [^ ]+' | awk '{print $2}'",
        // 获取主网络接口的 IP（去除网络前缀）
        iface_ip: "iface=$(ip route get 1 | grep -oE 'dev [^ ]+' | awk '{print $2}') && ip -f inet addr show \"$iface\" | awk '/inet / {print $2}' | cut -d/ -f1",
        // CPU 信息
        cpu_info: "cat /proc/cpuinfo | grep 'Hardware' | head -1 | cut -d: -f2",
        cpu_cores: "cat /proc/cpuinfo | grep processor | wc -l",
        // 内存信息
        mem_total: "cat /proc/meminfo | grep MemTotal | awk '{print $2}'",
        mem_available: "cat /proc/meminfo | grep MemAvailable | awk '{print $2}'",
        // 存储信息
        storage_info: "df -h /data | tail -1 | awk '{print $2,$3,$4,$5}'",
        // 电池信息
        battery_level: "dumpsys battery | grep level | awk '{print $2}'",
        battery_status: "dumpsys battery | grep status | awk '{print $2}'",
        battery_temp: "dumpsys battery | grep temperature | awk '{print $2}'",
        // 屏幕信息
        // screen_size: "wm size | grep Physical | awk '{print $3}'",
        screen_size: "wm size | awk '{print $3}'",
        screen_density: "wm density | grep Physical | awk '{print $3}'",
        screen_orientation: "dumpsys display | grep mCurrentOrientation | awk -F= '{print $2}'",
    };

    const info: Record<string, string> = {};

    // 并发执行所有命令以提高性能
    const results = await Promise.allSettled(
        Object.entries(commands).map(async ([key, cmd]) => {
            try {
                const process = await adb.subprocess.shellProtocol!.spawn(cmd);
                let output = '';
                for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
                    output += chunk;
                }
                return { key, value: output.trim() };
            } catch (error) {
                fastify.log.warn({ key, cmd, error }, 'Failed to execute command');
                return { key, value: '' };
            }
        })
    );

    // 收集结果
    for (const result of results) {
        if (result.status === 'fulfilled') {
            const { key, value } = result.value;
            info[key] = value;
        }
    }

    // 解析并格式化某些字段（扁平结构）
    const deviceInfo: DeviceInfo = {
        // 基本信息
        serial: adb.serial,
        serial_no: info.serial_no,
        android_id: info.android_id,
        boot_id: info.boot_id,
        ble_mac: info.ble_mac,

        // 设备型号
        model: info.model,
        market_name: info.market_name,
        manufacturer: info.manufacturer,
        brand: info.brand,
        device: info.device,

        // 系统版本
        android_version: info.version,
        sdk_version: parseInt(info.sdk_version) || 0,
        security_patch: info.security_patch,
        kernel_version: info.kernel_ver,

        // ADB 信息
        adb_enabled: info.adb_enabled === '1',
        adb_port: parseInt(info.adb_port) || -1,
        adb_status: info.adb_status,
        adb_pid: parseInt(info.adb_pid) || 0,

        // 网络信息
        network_interface: info.iface,          // 主网络接口名称，如: wlan0
        network_ip: info.iface_ip,              // 主网络接口 IP，如: 192.168.23.184
        network_src_ip: info.src_ip,            // 源 IP

        // 硬件信息
        cpu: info.cpu_info?.trim() || '',
        cpu_cores: parseInt(info.cpu_cores) || 0,
        mem_total_kb: parseInt(info.mem_total) || 0,
        mem_available_kb: parseInt(info.mem_available) || 0,
        storage: info.storage_info,

        // 电池信息
        battery_level: parseInt(info.battery_level) || 0,
        battery_status: parseInt(info.battery_status) || 0,
        battery_temperature: parseInt(info.battery_temp) || 0,

        // 屏幕信息
        screen_width: parseInt(info.screen_size.split("x")[0]) || 0,
        screen_height: parseInt(info.screen_size.split("x")[1]) || 0,
        screen_density: parseInt(info.screen_density) || 0,
        screen_orientation: parseInt(info.screen_orientation.trim()) || 0,
    };

    return deviceInfo;
}

