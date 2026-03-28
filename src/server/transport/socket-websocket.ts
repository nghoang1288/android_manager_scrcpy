import { WritableStream } from "@yume-chan/stream-extra";
import { WebSocket } from "ws";
import type { AdbSocket } from "@yume-chan/adb";
import type { FastifyRequest } from "fastify";
import { delay } from "@yume-chan/async";

export class WS {
    static async build(socket: AdbSocket, client: WebSocket, req: FastifyRequest) {
        client.binaryType = "arraybuffer";

        const writer = socket.writable.getWriter();

        // Read from ADB socket and write to WebSocket.
        void socket.readable.pipeTo(
            new WritableStream({
                async write(chunk) {
                    while (client.readyState === WebSocket.OPEN && client.bufferedAmount >= 1 * 1024 * 1024) {
                        await delay(10);
                    }
                    if (client.readyState !== WebSocket.OPEN) {
                        return;
                    }
                    client.send(chunk);
                },
            }),
        ).catch((error) => {
            req.log.warn({ error }, "ADB -> WebSocket pipe failed");
            if (client.readyState === WebSocket.OPEN) {
                client.close(1011, "Stream error");
            }
        });

        // Read from WebSocket and write to ADB socket.
        client.on("message", async (message) => {
            if (client.readyState !== WebSocket.OPEN) {
                return;
            }
            try {
                client.pause();
                await writer.write(new Uint8Array(message as ArrayBuffer));
            } catch (error) {
                req.log.warn({ error }, "WebSocket -> ADB write failed");
                if (client.readyState === WebSocket.OPEN) {
                    client.close(1011, "Upstream write failed");
                }
            } finally {
                client.resume();
            }
        });

        client.on("error", (error) => {
            req.log.warn({ error }, "WebSocket bridge error");
        });

        // Propagate ADB socket closure to WebSocket.
        void socket.closed
            .then(() => {
                req.log.info("ADB socket closed, closing WebSocket");
                if (client.readyState === WebSocket.OPEN) {
                    client.close();
                }
            })
            .catch((error) => {
                req.log.warn({ error }, "ADB socket closed with error");
                if (client.readyState === WebSocket.OPEN) {
                    client.close(1011, "ADB socket error");
                }
            });

        // Propagate WebSocket closure to ADB socket.
        client.on("close", () => {
            req.log.info("WebSocket closed, closing ADB socket");
            writer.releaseLock();
            void socket.close();
        });
    }
}
