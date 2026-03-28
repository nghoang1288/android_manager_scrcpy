import { parentPort, workerData } from "node:worker_threads";
import { PNG } from "pngjs";

type ImageMatchSource = string | Uint8Array;

type ImageMatchPayload = {
    screenshot: ImageMatchSource;
    template: ImageMatchSource;
    threshold?: number;
    region?: { x: number; y: number; width: number; height: number };
    mode?: "fast" | "precise";
    preferredScale?: number;
};

function decodePngSource(source: ImageMatchSource): PNG {
    if (typeof source === "string") {
        const match = source.match(/^data:image\/png;base64,(.+)$/i);
        if (!match) {
            throw new Error("Only PNG data URLs are supported");
        }
        return PNG.sync.read(Buffer.from(match[1], "base64"));
    }

    return PNG.sync.read(Buffer.from(source));
}

function pixelDiffRGB(a: Uint8Array, b: Uint8Array, ai: number, bi: number): number {
    const dr = Math.abs(a[ai] - b[bi]);
    const dg = Math.abs(a[ai + 1] - b[bi + 1]);
    const db = Math.abs(a[ai + 2] - b[bi + 2]);
    return dr + dg + db;
}

function resizePngNearest(src: PNG, width: number, height: number): PNG {
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        const sy = Math.min(src.height - 1, Math.floor((y / height) * src.height));
        for (let x = 0; x < width; x++) {
            const sx = Math.min(src.width - 1, Math.floor((x / width) * src.width));
            const si = (sy * src.width + sx) * 4;
            const oi = (y * width + x) * 4;
            out.data[oi] = src.data[si];
            out.data[oi + 1] = src.data[si + 1];
            out.data[oi + 2] = src.data[si + 2];
            out.data[oi + 3] = src.data[si + 3];
        }
    }
    return out;
}

function findBestTemplateMatch(
    screenshot: PNG,
    template: PNG,
    region?: { x: number; y: number; width: number; height: number },
    mode = "precise",
) {
    if (template.width > screenshot.width || template.height > screenshot.height) {
        return {
            confidence: 0,
            x: 0,
            y: 0,
            width: template.width,
            height: template.height,
            centerX: Math.floor(template.width / 2),
            centerY: Math.floor(template.height / 2),
        };
    }

    const sx = Math.max(0, Math.floor(region?.x ?? 0));
    const sy = Math.max(0, Math.floor(region?.y ?? 0));
    const sw = Math.min(screenshot.width - sx, Math.floor(region?.width ?? screenshot.width));
    const sh = Math.min(screenshot.height - sy, Math.floor(region?.height ?? screenshot.height));
    const endX = sx + Math.max(0, sw - template.width);
    const endY = sy + Math.max(0, sh - template.height);
    const templateArea = template.width * template.height;
    const searchArea = sw * sh;
    const fastBias = mode === "fast" ? 1 : 0;
    const sampleStep = templateArea > 160_000 ? 5 + fastBias : templateArea > 90_000 ? 4 + fastBias : templateArea > 30_000 ? 3 + fastBias : 2 + fastBias;
    const positionStep = searchArea > 1_800_000 || templateArea > 160_000
        ? 4 + fastBias
        : searchArea > 900_000 || templateArea > 80_000
            ? 3 + fastBias
            : searchArea > 350_000
                ? 2 + fastBias
                : 1 + fastBias;

    const scoreAt = (x: number, y: number) => {
        let diffSum = 0;
        let sampleCount = 0;

        for (let ty = 0; ty < template.height; ty += sampleStep) {
            for (let tx = 0; tx < template.width; tx += sampleStep) {
                const tIndex = (ty * template.width + tx) * 4;
                if (template.data[tIndex + 3] < 16) {
                    continue;
                }
                const sIndex = ((y + ty) * screenshot.width + (x + tx)) * 4;
                diffSum += pixelDiffRGB(screenshot.data, template.data, sIndex, tIndex);
                sampleCount++;
            }
        }

        if (sampleCount === 0) {
            return -1;
        }

        const maxDiff = sampleCount * 255 * 3;
        return 1 - (diffSum / maxDiff);
    };

    let bestConfidence = -1;
    let bestX = sx;
    let bestY = sy;

    for (let y = sy; y <= endY; y += positionStep) {
        for (let x = sx; x <= endX; x += positionStep) {
            const confidence = scoreAt(x, y);
            if (confidence > bestConfidence) {
                bestConfidence = confidence;
                bestX = x;
                bestY = y;
            }
        }
    }

    if (positionStep > 1) {
        const refineRadius = Math.max(2, positionStep * 2);
        const refineStartX = Math.max(sx, bestX - refineRadius);
        const refineEndX = Math.min(endX, bestX + refineRadius);
        const refineStartY = Math.max(sy, bestY - refineRadius);
        const refineEndY = Math.min(endY, bestY + refineRadius);

        for (let y = refineStartY; y <= refineEndY; y++) {
            for (let x = refineStartX; x <= refineEndX; x++) {
                const confidence = scoreAt(x, y);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestX = x;
                    bestY = y;
                }
            }
        }
    }

    const normalizedConfidence = Math.max(0, Math.min(1, bestConfidence < 0 ? 0 : bestConfidence));
    return {
        confidence: normalizedConfidence,
        x: bestX,
        y: bestY,
        width: template.width,
        height: template.height,
        centerX: bestX + Math.floor(template.width / 2),
        centerY: bestY + Math.floor(template.height / 2),
    };
}

function runImageMatch(payload: ImageMatchPayload) {
    const {
        screenshot,
        template,
        threshold = 0.9,
        region,
        mode = "precise",
        preferredScale,
    } = payload;

    const screenshotPng = decodePngSource(screenshot);
    const templatePng = decodePngSource(template);

    const dedupeScales = (scales: Array<number | undefined>) => {
        const seen = new Set<number>();
        return scales.filter((scale): scale is number => {
            if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
                return false;
            }
            const rounded = Number(scale.toFixed(3));
            if (seen.has(rounded)) {
                return false;
            }
            seen.add(rounded);
            return true;
        });
    };

    const primaryScales = dedupeScales([
        preferredScale,
        1,
        0.95,
        1.05,
        ...(mode === "fast" ? [] : [0.9, 1.1]),
    ]);
    const fallbackScales = mode === "fast"
        ? dedupeScales([0.9, 1.1])
        : dedupeScales([0.85, 1.2, 0.8, 1.25, 0.67, 1.5]);

    let best = {
        confidence: 0,
        x: 0,
        y: 0,
        width: templatePng.width,
        height: templatePng.height,
        centerX: Math.floor(templatePng.width / 2),
        centerY: Math.floor(templatePng.height / 2),
        scale: 1,
    };

    const tryScales = (scales: number[]) => {
        for (const scale of scales) {
            const tw = Math.max(1, Math.round(templatePng.width * scale));
            const th = Math.max(1, Math.round(templatePng.height * scale));
            if (tw > screenshotPng.width || th > screenshotPng.height) {
                continue;
            }
            const scaledTemplate = scale === 1 ? templatePng : resizePngNearest(templatePng, tw, th);
            const candidate = findBestTemplateMatch(screenshotPng, scaledTemplate, region, mode);
            if (candidate.confidence > best.confidence) {
                best = { ...candidate, scale };
            }
            if (best.confidence >= threshold) {
                return true;
            }
        }
        return false;
    };

    const primaryMatched = tryScales(primaryScales);
    const fallbackThreshold = mode === "fast" ? Math.max(0.82, threshold - 0.04) : Math.max(0.75, threshold - 0.08);
    if (!primaryMatched && best.confidence < fallbackThreshold) {
        tryScales(fallbackScales);
    }

    return {
        found: best.confidence >= threshold,
        confidence: best.confidence,
        x: best.x,
        y: best.y,
        width: best.width,
        height: best.height,
        centerX: best.centerX,
        centerY: best.centerY,
        scale: best.scale,
    };
}

function postSuccess(id: number, result: ReturnType<typeof runImageMatch>) {
    parentPort?.postMessage({ id, ok: true, result });
}

function postError(id: number, error: unknown) {
    parentPort?.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : "Image match failed",
        statusCode: 400,
    });
}

parentPort?.on("message", (message: { id: number; payload: ImageMatchPayload }) => {
    try {
        postSuccess(message.id, runImageMatch(message.payload));
    } catch (error) {
        postError(message.id, error);
    }
});

if (workerData) {
    try {
        const payload = "payload" in workerData ? workerData.payload : workerData;
        const id = typeof workerData.id === "number" ? workerData.id : 0;
        postSuccess(id, runImageMatch(payload as ImageMatchPayload));
    } catch (error) {
        postError(typeof workerData.id === "number" ? workerData.id : 0, error);
    }
}
