import type { JSONRPCMessage, Transport } from "./jsonrpc.js";

/**
 * A {@link Transport} that speaks JSON-RPC over a WebSocket, one JSON frame per
 * message (the framing LSP web bridges use). Frames sent before the socket
 * opens are buffered and flushed on `open`.
 */
export class WebSocketTransport implements Transport {
    private readonly url: string;
    private readonly protocols?: string | string[];
    private socket?: WebSocket;
    private readonly handlers = new Set<(message: JSONRPCMessage) => void>();
    private outbox: string[] = [];

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
    }

    connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(this.url, this.protocols);
            this.socket = socket;

            socket.addEventListener("open", () => {
                for (const frame of this.outbox) {
                    socket.send(frame);
                }
                this.outbox = [];
                resolve();
            });

            socket.addEventListener("message", (event: MessageEvent) => {
                let message: JSONRPCMessage;
                try {
                    message = JSON.parse(String(event.data));
                } catch {
                    // Ignore frames that are not valid JSON.
                    return;
                }
                for (const handler of this.handlers) {
                    handler(message);
                }
            });

            // Rejects only a pre-open failure; after `open` resolved, this is
            // a no-op.
            socket.addEventListener("error", () => {
                reject(new Error(`WebSocket connection to ${this.url} failed`));
            });
        });
    }

    send(message: JSONRPCMessage): void {
        const frame = JSON.stringify(message);
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(frame);
        } else {
            this.outbox.push(frame);
        }
    }

    onMessage(handler: (message: JSONRPCMessage) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    close(): void {
        this.handlers.clear();
        this.outbox = [];
        this.socket?.close();
        this.socket = undefined;
    }
}
