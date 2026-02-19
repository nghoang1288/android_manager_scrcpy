import {
    ADB_DAEMON_DEFAULT_FEATURES,
    AdbBanner,
    AdbReverseNotSupportedError,
    type AdbSocket,
    type AdbTransport,
} from "@yume-chan/adb";
import { MaybeConsumable, ReadableStream, TransformStream } from "@yume-chan/stream-extra";
import { WebSocketStream } from "./websocket-stream.d";

export class WebSocketTransport implements AdbTransport {
    serial: string;
    maxPayloadSize: number;
    banner: AdbBanner;

    #disconnected = Promise.withResolvers<void>();
    get disconnected() {
        return this.#disconnected.promise;
    }

    clientFeatures = ADB_DAEMON_DEFAULT_FEATURES;

    #sockets = new Set<WebSocketStream>();

    constructor(
        serial: string,
        maxPayloadSize: number,
        banner: AdbBanner,
    ) {
        this.serial = serial;
        this.maxPayloadSize = maxPayloadSize;
        this.banner = banner;
    }

    addReverseTunnel(): never {
        throw new AdbReverseNotSupportedError();
    }

    removeReverseTunnel(): never {
        throw new AdbReverseNotSupportedError();
    }

    clearReverseTunnels(): never {
        throw new AdbReverseNotSupportedError();
    }

    async connect(service: string): Promise<AdbSocket> {
        // 根据当前页面协议自动选择 ws:// 或 wss://
        const socket = new WebSocketStream(
            `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/adb/device/${this.serial}?service=${encodeURIComponent(service)}`
        );
        const open = await socket.opened;
        this.#sockets.add(socket);
        const writer = open.writable.getWriter();
        return {
            service,
            readable: open.readable.pipeThrough(new TransformStream<string | Uint8Array, string | Uint8Array>({
                transform(chunk, controller) {
                    // Chrome's implementation still gives `ArrayBuffer`
                    controller.enqueue(new Uint8Array(chunk as Uint8Array));
                }
            })) as ReadableStream<Uint8Array>,
            writable: new MaybeConsumable.WritableStream({
                async write(chunk) {
                    await writer.write(chunk);
                },
            }),
            close() {
                socket.close();
            },
            closed: socket.closed as never as Promise<undefined>,
        };
    }

    close() {
        for (const socket of this.#sockets) {
            socket.close();
        }
        this.#sockets.clear();
        this.#disconnected.resolve();
    }
}