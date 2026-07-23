import type { JSONRPCMessage, Transport } from "../jsonrpc.js";

export interface FakeTransportOptions {
    /** Capabilities returned for the `initialize` handshake. */
    capabilities?: Record<string, unknown>;
    /** When set, `initialize` is answered with this JSON-RPC error instead. */
    failInitialize?: { code: number; message: string };
    /**
     * Auto-answer the `initialize` handshake so the client reaches `ready`.
     * @default true
     */
    autoInitialize?: boolean;
}

/**
 * An in-memory {@link Transport} for tests. Records every frame the client
 * sends, lets a test inject inbound frames via {@link receive}, and (by
 * default) auto-answers the `initialize` handshake so the client becomes ready.
 */
export class FakeTransport implements Transport {
    /** Every frame the client has sent, in order. */
    readonly sent: JSONRPCMessage[] = [];
    private readonly handlers = new Set<(message: JSONRPCMessage) => void>();

    constructor(private readonly options: FakeTransportOptions = {}) {}

    connect(): Promise<void> {
        return Promise.resolve();
    }

    send(message: JSONRPCMessage): void {
        this.sent.push(message);
        const auto = this.options.autoInitialize ?? true;
        if (
            auto &&
            "id" in message &&
            "method" in message &&
            message.method === "initialize"
        ) {
            const { failInitialize, capabilities } = this.options;
            this.receive(
                failInitialize
                    ? { jsonrpc: "2.0", id: message.id, error: failInitialize }
                    : {
                          jsonrpc: "2.0",
                          id: message.id,
                          result: { capabilities: capabilities ?? {} },
                      },
            );
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
    }

    /** Deliver an inbound (server→client) frame to the client. */
    receive(message: JSONRPCMessage): void {
        for (const handler of this.handlers) {
            handler(message);
        }
    }

    /** Frames the client sent in reply to server→client requests. */
    serverResponses(): JSONRPCMessage[] {
        return this.sent.filter((m) => "id" in m && !("method" in m));
    }

    /** Notifications the client sent, optionally filtered by method. */
    notificationsSent(method?: string): JSONRPCMessage[] {
        return this.sent.filter(
            (m) =>
                "method" in m &&
                !("id" in m) &&
                (method === undefined || m.method === method),
        );
    }
}
