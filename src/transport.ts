import type { JSONRPCMessage, Transport } from "./jsonrpc.js";

/**
 * A {@link Transport} that speaks JSON-RPC over a WebSocket, one JSON frame per
 * message (the framing LSP web bridges use). Frames sent before the socket
 * opens are buffered and flushed on `open`.
 */
export class WebSocketTransport implements Transport {
    private static readonly OUTBOX_LIMIT = 1000;
    private readonly url: string;
    private readonly protocols?: string | string[];
    private socket?: WebSocket;
    private opened = false;
    private closed = false;
    private rejectConnect?: (reason: unknown) => void;
    private readonly handlers = new Set<(message: JSONRPCMessage) => void>();
    private readonly closeHandlers = new Set<(error: Error) => void>();
    private outbox: string[] = [];

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
    }

    connect(): Promise<void> {
        if (!/^wss?:\/\//i.test(this.url)) {
            return Promise.reject(
                new Error(`Invalid WebSocket URL: ${this.url || "(empty)"}`),
            );
        }
        if (
            this.url.toLowerCase().startsWith("ws://") &&
            typeof location !== "undefined" &&
            location.protocol === "https:"
        ) {
            console.warn(
                `Insecure WebSocket ${this.url} may be blocked from an HTTPS page`,
            );
        }
        this.rejectConnect?.(
            new Error(`WebSocket connection to ${this.url} was replaced`),
        );
        this.rejectConnect = undefined;
        this.socket?.close();
        this.opened = false;
        this.closed = false;
        return new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(this.url, this.protocols);
            this.socket = socket;
            this.rejectConnect = reject;

            socket.addEventListener("open", () => {
                if (this.socket !== socket) {
                    return;
                }
                this.opened = true;
                this.rejectConnect = undefined;
                for (const frame of this.outbox) {
                    socket.send(frame);
                }
                this.outbox = [];
                resolve();
            });

            socket.addEventListener("message", (event: MessageEvent) => {
                if (this.socket !== socket) {
                    return;
                }
                this.receiveFrame(event.data, socket);
            });

            // An error or a close before `open` rejects connect() so awaiters
            // (JSONRPCClient.connected) never hang; after `open`, reject is a
            // no-op.
            socket.addEventListener("error", () => {
                if (this.socket !== socket) {
                    return;
                }
                const error = new Error(
                    `WebSocket connection to ${this.url} failed`,
                );
                if (!this.opened) {
                    reject(error);
                } else {
                    this.emitClose(error);
                }
            });
            socket.addEventListener("close", () => {
                if (this.socket !== socket) {
                    return;
                }
                if (!this.opened) {
                    reject(
                        new Error(
                            `WebSocket to ${this.url} closed before opening`,
                        ),
                    );
                } else if (!this.closed) {
                    this.emitClose(
                        new Error(`WebSocket connection to ${this.url} closed`),
                    );
                }
            });
        });
    }

    send(message: JSONRPCMessage): void {
        if (this.closed) {
            return;
        }
        const frame = JSON.stringify(message);
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(frame);
        } else {
            if (this.outbox.length < WebSocketTransport.OUTBOX_LIMIT) {
                this.outbox.push(frame);
            }
        }
    }

    onMessage(handler: (message: JSONRPCMessage) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    onClose(handler: (error: Error) => void): () => void {
        this.closeHandlers.add(handler);
        return () => {
            this.closeHandlers.delete(handler);
        };
    }

    close(): void {
        // Settle a still-pending connect() so its awaiters don't hang forever.
        this.rejectConnect?.(new Error(`WebSocket to ${this.url} closed`));
        this.rejectConnect = undefined;
        this.closed = true;
        this.opened = false;
        this.handlers.clear();
        this.closeHandlers.clear();
        this.outbox = [];
        this.socket?.close();
        this.socket = undefined;
    }

    private receiveFrame(data: unknown, source: WebSocket): void {
        if (
            data instanceof ArrayBuffer ||
            Object.prototype.toString.call(data) === "[object ArrayBuffer]"
        ) {
            this.dispatchFrame(
                new TextDecoder().decode(data as AllowSharedBufferSource),
            );
            return;
        }
        if (typeof Blob !== "undefined" && data instanceof Blob) {
            // Reading a Blob is async, so the connection may have been
            // replaced or closed by the time the text arrives; a frame from a
            // dead socket must not settle requests on the new session.
            data.text().then((text) => {
                if (this.socket !== source) {
                    return;
                }
                this.dispatchFrame(text);
            });
            return;
        }
        this.dispatchFrame(String(data));
    }

    private dispatchFrame(frame: string): void {
        // A peer close leaves `socket` assigned, so a frame that was already
        // in flight (or an async Blob read) can still land here afterwards.
        if (this.closed) {
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(frame);
        } catch {
            return;
        }
        if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            return;
        }
        const message = parsed as JSONRPCMessage;
        for (const handler of this.handlers) {
            try {
                handler(message);
            } catch (error) {
                console.error("WebSocket message handler failed", error);
            }
        }
    }

    private emitClose(error: Error): void {
        this.opened = false;
        this.closed = true;
        for (const handler of this.closeHandlers) {
            try {
                handler(error);
            } catch (handlerError) {
                console.error("WebSocket close handler failed", handlerError);
            }
        }
    }
}
