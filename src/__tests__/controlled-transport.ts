import type { JSONRPCMessage, Transport } from "../jsonrpc.js";

/**
 * A {@link Transport} whose connect/receive/close steps are driven by the
 * test, so message ordering and connection failures are deterministic.
 */
export class ControlledTransport implements Transport {
    readonly sent: JSONRPCMessage[] = [];
    closed = false;
    throwOnSend = false;
    private handler?: (message: JSONRPCMessage) => void;
    private resolveConnect!: () => void;
    private rejectConnect!: (reason: unknown) => void;
    private readonly connectPromise = new Promise<void>((resolve, reject) => {
        this.resolveConnect = resolve;
        this.rejectConnect = reject;
    });

    constructor(private readonly autoConnect = true) {
        // A test may fail the connection without ever awaiting connect().
        this.connectPromise.catch(() => {});
    }

    connect(): Promise<void> {
        if (this.autoConnect) {
            this.resolveConnect();
        }
        return this.connectPromise;
    }

    send(message: JSONRPCMessage): void {
        if (this.throwOnSend) {
            throw new Error("send failed");
        }
        this.sent.push(message);
    }

    onMessage(handler: (message: JSONRPCMessage) => void): () => void {
        this.handler = handler;
        return () => {
            this.handler = undefined;
        };
    }

    close(): void {
        this.closed = true;
    }

    receive(message: JSONRPCMessage): void {
        this.handler?.(message);
    }

    openConnection(): void {
        this.resolveConnect();
    }

    failConnection(reason: unknown): void {
        this.rejectConnect(reason);
    }

    get hasHandler(): boolean {
        return this.handler !== undefined;
    }
}
