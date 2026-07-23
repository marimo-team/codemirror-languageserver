import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "../jsonrpc.js";
import { WebSocketTransport } from "../transport.js";

// biome-ignore lint/complexity/noBannedTypes: minimal event-listener registry
type Listener = Function;

/** A hand-driven stand-in for the global WebSocket. */
class MockSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static last: MockSocket | undefined;

    readyState = MockSocket.CONNECTING;
    closed = false;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(
        readonly url: string,
        readonly protocols?: string | string[],
    ) {
        MockSocket.last = this;
    }

    addEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
        this.readyState = MockSocket.CLOSED;
    }

    emitOpen(): void {
        this.readyState = MockSocket.OPEN;
        this.fire("open");
    }

    emitMessage(data: string): void {
        this.fire("message", { data });
    }

    emitError(): void {
        this.fire("error", {});
    }

    private fire(type: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

beforeEach(() => {
    MockSocket.last = undefined;
    vi.stubGlobal("WebSocket", MockSocket);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function lastSocket(): MockSocket {
    if (!MockSocket.last) {
        throw new Error("no socket was constructed");
    }
    return MockSocket.last;
}

describe("connect", () => {
    it("passes url and protocols through and resolves on open", async () => {
        const transport = new WebSocketTransport("ws://host/lsp", "lsp.v1");
        const connected = transport.connect();
        const socket = lastSocket();

        expect(socket.url).toBe("ws://host/lsp");
        expect(socket.protocols).toBe("lsp.v1");

        socket.emitOpen();
        await expect(connected).resolves.toBeUndefined();
    });

    it("rejects on a pre-open error", async () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        const connected = transport.connect();
        connected.catch(() => {});
        lastSocket().emitError();

        await expect(connected).rejects.toThrow("ws://host/lsp");
    });
});

describe("send", () => {
    it("buffers frames sent before open and flushes them in order", async () => {
        const transport = new WebSocketTransport("ws://host");
        const connected = transport.connect();
        const socket = lastSocket();

        transport.send({ jsonrpc: "2.0", id: 0, method: "a", params: {} });
        transport.send({ jsonrpc: "2.0", method: "b", params: {} });
        expect(socket.sent).toEqual([]); // still connecting

        socket.emitOpen();
        await connected;

        expect(socket.sent).toEqual([
            JSON.stringify({ jsonrpc: "2.0", id: 0, method: "a", params: {} }),
            JSON.stringify({ jsonrpc: "2.0", method: "b", params: {} }),
        ]);
    });

    it("serializes and sends immediately once open", async () => {
        const transport = new WebSocketTransport("ws://host");
        const connected = transport.connect();
        const socket = lastSocket();
        socket.emitOpen();
        await connected;

        const frame: JSONRPCMessage = {
            jsonrpc: "2.0",
            id: 1,
            method: "hover",
            params: { line: 1 },
        };
        transport.send(frame);

        expect(socket.sent).toEqual([JSON.stringify(frame)]);
    });
});

describe("onMessage", () => {
    it("parses inbound JSON and dispatches to handlers", () => {
        const transport = new WebSocketTransport("ws://host");
        transport.connect();
        const socket = lastSocket();

        const handler = vi.fn();
        transport.onMessage(handler);

        const frame = { jsonrpc: "2.0", id: 0, result: { ok: true } };
        socket.emitMessage(JSON.stringify(frame));

        expect(handler).toHaveBeenCalledWith(frame);
    });

    it("ignores non-JSON frames", () => {
        const transport = new WebSocketTransport("ws://host");
        transport.connect();
        const socket = lastSocket();

        const handler = vi.fn();
        transport.onMessage(handler);
        expect(() => socket.emitMessage("not json {")).not.toThrow();
        expect(handler).not.toHaveBeenCalled();
    });

    it("stops dispatching after unsubscribe", () => {
        const transport = new WebSocketTransport("ws://host");
        transport.connect();
        const socket = lastSocket();

        const handler = vi.fn();
        const unsubscribe = transport.onMessage(handler);
        unsubscribe();

        socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "x" }));
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("close", () => {
    it("closes the socket and clears handlers", () => {
        const transport = new WebSocketTransport("ws://host");
        transport.connect();
        const socket = lastSocket();
        const handler = vi.fn();
        transport.onMessage(handler);

        transport.close();

        expect(socket.closed).toBe(true);
        // A late frame on the old socket reaches no one.
        socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "x" }));
        expect(handler).not.toHaveBeenCalled();
    });
});
