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
    private opened = false;
    private rejectConnect?: (reason: unknown) => void;
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
            this.rejectConnect = reject;

            socket.addEventListener("open", () => {
                this.opened = true;
                this.rejectConnect = undefined;
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

            // An error or a close before `open` rejects connect() so awaiters
            // (JSONRPCClient.connected) never hang; after `open`, reject is a
            // no-op.
            socket.addEventListener("error", () => {
                reject(new Error(`WebSocket connection to ${this.url} failed`));
            });
            socket.addEventListener("close", () => {
                if (!this.opened) {
                    reject(
                        new Error(
                            `WebSocket to ${this.url} closed before opening`,
                        ),
                    );
                }
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
        // Settle a still-pending connect() so its awaiters don't hang forever.
        this.rejectConnect?.(new Error(`WebSocket to ${this.url} closed`));
        this.rejectConnect = undefined;
        this.handlers.clear();
        this.outbox = [];
        this.socket?.close();
        this.socket = undefined;
    }
}
