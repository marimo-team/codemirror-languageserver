import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ErrorCodes,
    JSONRPCClient,
    type JSONRPCMessage,
    RPCError,
    type Transport,
} from "../jsonrpc.js";

/** A transport whose connection and inbound frames the test drives by hand. */
class ControlledTransport implements Transport {
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

    constructor(private readonly autoConnect = true) {}

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

/** Flush pending microtasks (the connect→send hop). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.useRealTimers();
});

describe("request", () => {
    it("sends a well-formed frame with incrementing ids and resolves on match", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const first = client.request("a/b", { x: 1 }, 1000);
        const second = client.request("c/d", { y: 2 }, 1000);
        await tick();

        expect(transport.sent).toEqual([
            { jsonrpc: "2.0", id: 0, method: "a/b", params: { x: 1 } },
            { jsonrpc: "2.0", id: 1, method: "c/d", params: { y: 2 } },
        ]);

        // Answer out of order to prove correlation is by id, not arrival.
        transport.receive({ jsonrpc: "2.0", id: 1, result: "second" });
        transport.receive({ jsonrpc: "2.0", id: 0, result: "first" });

        await expect(first).resolves.toBe("first");
        await expect(second).resolves.toBe("second");
    });

    it("rejects with an RPCError carrying the server code, message, and data", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("boom", {}, 1000);
        await tick();
        transport.receive({
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32001, message: "nope", data: { detail: 1 } },
        });

        await expect(pending).rejects.toMatchObject({
            name: "RPCError",
            code: -32001,
            message: "nope",
            data: { detail: 1 },
        });
    });

    it("rejects with a timeout error when no response arrives", async () => {
        vi.useFakeTimers();
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("slow", {}, 1000);
        pending.catch(() => {}); // avoid unhandled rejection while advancing
        await vi.advanceTimersByTimeAsync(1000);

        await expect(pending).rejects.toMatchObject({
            name: "RPCError",
            code: ErrorCodes.RequestTimeout,
        });
    });

    it("ignores a response with an unknown id", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", {}, 1000);
        await tick();
        transport.receive({ jsonrpc: "2.0", id: 999, result: "stray" });
        transport.receive({ jsonrpc: "2.0", id: 0, result: "real" });

        await expect(pending).resolves.toBe("real");
    });

    it("waits for the connection before sending, then flushes", async () => {
        const transport = new ControlledTransport(false);
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", { a: 1 }, 1000);
        await tick();
        expect(transport.sent).toEqual([]); // still connecting

        transport.openConnection();
        await tick();
        expect(transport.sent).toEqual([
            { jsonrpc: "2.0", id: 0, method: "m", params: { a: 1 } },
        ]);

        transport.receive({ jsonrpc: "2.0", id: 0, result: "ok" });
        await expect(pending).resolves.toBe("ok");
    });

    it("rejects in-flight requests when the connection fails", async () => {
        const transport = new ControlledTransport(false);
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", {}, 1000);
        transport.failConnection(new Error("no route"));

        await expect(pending).rejects.toThrow("no route");
        expect(transport.sent).toEqual([]);
    });

    it("settles immediately when the transport send throws", async () => {
        const transport = new ControlledTransport();
        transport.throwOnSend = true;
        const client = new JSONRPCClient(transport);

        await expect(client.request("m", {}, 1000)).rejects.toThrow(
            "send failed",
        );
    });

    it("rejects requests started after close without waiting for a timeout", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        client.close();

        await expect(client.request("m", {}, 1000)).rejects.toMatchObject({
            name: "RPCError",
            message: "Client closed",
        });
        expect(transport.sent).toEqual([]);
    });
});

describe("notify and respond", () => {
    it("sends a notification frame with no id", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        await client.notify("textDocument/didOpen", { uri: "file:///x" });

        expect(transport.sent).toEqual([
            {
                jsonrpc: "2.0",
                method: "textDocument/didOpen",
                params: { uri: "file:///x" },
            },
        ]);
    });

    it("sends a response frame verbatim", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        await client.respond({ jsonrpc: "2.0", id: 5, result: null });

        expect(transport.sent).toEqual([
            { jsonrpc: "2.0", id: 5, result: null },
        ]);
    });

    it("drops notifications and responses after close without rejecting", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        client.close();

        await expect(client.notify("x", {})).resolves.toBeUndefined();
        await expect(
            client.respond({ jsonrpc: "2.0", id: 1, result: null }),
        ).resolves.toBeUndefined();
        expect(transport.sent).toEqual([]);
    });
});

describe("inbound routing", () => {
    it("routes notifications to the notification handler", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        client.onNotification(onNotification);

        const frame = {
            jsonrpc: "2.0" as const,
            method: "window/logMessage",
            params: { message: "hi" },
        };
        transport.receive(frame);

        expect(onNotification).toHaveBeenCalledWith(frame);
    });

    it("routes server-initiated requests (with an id) to the request handler", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onRequest = vi.fn();
        client.onRequest(onRequest);

        const frame = {
            jsonrpc: "2.0" as const,
            id: 0,
            method: "workspace/configuration",
            params: { items: [] },
        };
        transport.receive(frame);

        expect(onRequest).toHaveBeenCalledWith(frame);
    });

    it("ignores non-object frames without throwing", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        client.onNotification(onNotification);

        expect(() =>
            transport.receive(null as unknown as JSONRPCMessage),
        ).not.toThrow();
        expect(onNotification).not.toHaveBeenCalled();
    });
});

describe("close", () => {
    it("rejects pending requests, unsubscribes, and closes the transport", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", {}, 1000);
        await tick();
        client.close();

        await expect(pending).rejects.toBeInstanceOf(RPCError);
        expect(transport.closed).toBe(true);
        expect(transport.hasHandler).toBe(false);
    });

    it("is idempotent and drops inbound frames after close", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        client.onNotification(onNotification);

        client.close();
        expect(() => client.close()).not.toThrow();

        // The handler was removed on close; even a direct receive is inert.
        transport.receive({
            jsonrpc: "2.0",
            method: "window/logMessage",
            params: {},
        });
        expect(onNotification).not.toHaveBeenCalled();
    });
});
