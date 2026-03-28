import os from "node:os";
import { Worker } from "node:worker_threads";

export type ImageMatchBinarySource = Uint8Array;

export type ImageMatchSource = string | ImageMatchBinarySource;

export type ImageMatchWorkerPayload = {
    screenshot: ImageMatchSource;
    template: ImageMatchSource;
    threshold?: number;
    region?: { x: number; y: number; width: number; height: number };
    mode?: "fast" | "precise";
    preferredScale?: number;
};

export type ImageMatchWorkerResult = {
    found: boolean;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    scale: number;
};

type WorkerTask = {
    id: number;
    payload: ImageMatchWorkerPayload;
    timeoutMs: number;
    resolve: (value: ImageMatchWorkerResult) => void;
    reject: (error: Error) => void;
};

type WorkerResponse = {
    id: number;
    ok: boolean;
    result?: ImageMatchWorkerResult;
    error?: string;
    statusCode?: number;
};

type WorkerState = {
    worker: Worker;
    busy: boolean;
    current?: {
        task: WorkerTask;
        timeout: ReturnType<typeof setTimeout>;
    };
};

const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(4, os.cpus().length - 1));

export class ImageMatchWorkerPool {
    #states: WorkerState[] = [];
    #queue: WorkerTask[] = [];
    #nextTaskId = 1;
    #closed = false;
    #size: number;

    constructor(size = DEFAULT_WORKER_COUNT) {
        this.#size = size;
        for (let i = 0; i < this.#size; i++) {
            this.#states.push(this.#createWorker());
        }
    }

    async run(payload: ImageMatchWorkerPayload, timeoutMs = 45_000): Promise<ImageMatchWorkerResult> {
        if (this.#closed) {
            throw new Error("Image match worker pool is closed");
        }

        return await new Promise<ImageMatchWorkerResult>((resolve, reject) => {
            this.#queue.push({
                id: this.#nextTaskId++,
                payload,
                timeoutMs,
                resolve,
                reject,
            });
            this.#dispatch();
        });
    }

    async close() {
        if (this.#closed) {
            return;
        }

        this.#closed = true;

        for (const task of this.#queue.splice(0)) {
            task.reject(new Error("Image match worker pool is shutting down"));
        }

        await Promise.all(
            this.#states.map(async (state) => {
                if (state.current) {
                    clearTimeout(state.current.timeout);
                    state.current.task.reject(new Error("Image match worker pool is shutting down"));
                    state.current = undefined;
                }
                await state.worker.terminate().catch(() => undefined);
            }),
        );
        this.#states = [];
    }

    #createWorker(): WorkerState {
        const worker = new Worker(new URL("../workers/image-match.worker.mjs", import.meta.url));
        const state: WorkerState = { worker, busy: false };

        worker.on("message", (message: WorkerResponse) => {
            const current = state.current;
            if (!current || message.id !== current.task.id) {
                return;
            }

            clearTimeout(current.timeout);
            state.current = undefined;
            state.busy = false;

            if (message.ok && message.result) {
                current.task.resolve(message.result);
            } else {
                const error = new Error(message.error || "Image match failed") as Error & { statusCode?: number };
                error.statusCode = message.statusCode;
                current.task.reject(error);
            }

            this.#dispatch();
        });

        const handleCrash = (error: Error) => {
            const current = state.current;
            if (current) {
                clearTimeout(current.timeout);
                current.task.reject(error);
            }

            state.current = undefined;
            state.busy = false;

            if (this.#closed) {
                return;
            }

            const replacement = this.#createWorker();
            const index = this.#states.indexOf(state);
            if (index >= 0) {
                this.#states[index] = replacement;
            }
            this.#dispatch();
        };

        worker.on("error", (error) => {
            handleCrash(error instanceof Error ? error : new Error(String(error)));
        });

        worker.on("exit", (code) => {
            if (this.#closed || code === 0) {
                return;
            }
            handleCrash(new Error(`Image match worker exited with code ${code}`));
        });

        return state;
    }

    #dispatch() {
        if (this.#closed) {
            return;
        }

        for (const state of this.#states) {
            if (state.busy) {
                continue;
            }

            const task = this.#queue.shift();
            if (!task) {
                return;
            }

            state.busy = true;
            const timeout = setTimeout(() => {
                if (!state.current || state.current.task.id !== task.id) {
                    return;
                }

                state.current.task.reject(new Error("Image match worker timed out"));
                state.current = undefined;
                state.busy = false;

                const index = this.#states.indexOf(state);
                void state.worker.terminate().catch(() => undefined).finally(() => {
                    if (this.#closed) {
                        return;
                    }
                    const replacement = this.#createWorker();
                    if (index >= 0) {
                        this.#states[index] = replacement;
                    }
                    this.#dispatch();
                });
            }, task.timeoutMs);

            state.current = { task, timeout };
            state.worker.postMessage({
                id: task.id,
                payload: task.payload,
            });
        }
    }
}
