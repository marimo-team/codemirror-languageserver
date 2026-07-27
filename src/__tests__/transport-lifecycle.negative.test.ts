import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSONRPCClient, type JSONRPCMessage } from "../jsonrpc.js";
import { WebSocketTransport } from "../transport.js";

// biome-ignore lint/complexity/noBannedTypes: minimal event-listener registry
type Listener = Function;

/** A hand-driven stand-in for the global WebSocket (see `transport.test.ts`). */
class MockSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static last: MockSocket | undefined;
    static readonly all: MockSocket[] = [];

    readyState = MockSocket.CONNECTING;
    closed = false;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(
        readonly url: string,
        readonly protocols?: string | string[],
    ) {
        MockSocket.last = this;
        MockSocket.all.push(this);
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

    /** Deliver a non-string payload (binary frames, etc.). */
    emitRawMessage(data: unknown): void {
        this.fire("message", { data });
    }

    emitError(): void {
        this.fire("error", {});
    }

    emitClose(): void {
        this.readyState = MockSocket.CLOSED;
        this.fire("close", {});
    }

    private fire(type: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

beforeEach(() => {
    MockSocket.last = undefined;
    MockSocket.all.length = 0;
    vi.stubGlobal("WebSocket", MockSocket);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function lastSocket(): MockSocket {
    if (!MockSocket.last) {
        throw new Error("no socket was constructed");
    }
    return MockSocket.last;
}

/** The transport's private pre-open send buffer, for growth assertions. */
const outboxOf = (transport: WebSocketTransport) =>
    (transport as unknown as { outbox: string[] }).outbox;

const noteFrame = (n: number): JSONRPCMessage => ({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { n },
});

/** An upper bound a sane buffer must respect; today's outbox has none. */
const OUTBOX_LIMIT = 1000;

describe("send after close", () => {
    // BUG: frames sent after close() should be dropped (the transport is dead
    // and nothing will ever flush them) — currently close() clears `socket`, so
    // send() takes the buffering branch and every frame is appended to an
    // uncapped `outbox` that no longer has a socket to drain it: an unbounded
    // leak for any client that keeps notifying after teardown.
    it.fails(
        "drops frames sent after close instead of buffering them forever",
        async () => {
            const transport = new WebSocketTransport("ws://host/lsp");
            const connected = transport.connect();
            const socket = lastSocket();
            socket.emitOpen();
            await connected;

            transport.close();
            for (let i = 0; i < 1000; i++) {
                transport.send(noteFrame(i));
            }

            expect(outboxOf(transport)).toHaveLength(0);
            expect(socket.sent).toHaveLength(0);
        },
    );
});

describe("pre-open buffering", () => {
    // BUG: the pre-open outbox should be capped (dropping or erroring past a
    // bound) so a server that never finishes its handshake cannot exhaust
    // memory — currently every frame is retained with no limit at all, and a
    // busy editor produces a didChange per keystroke.
    it.fails(
        "caps the pre-open outbox instead of growing without bound",
        () => {
            const transport = new WebSocketTransport("ws://host/lsp");
            const connected = transport.connect();
            connected.catch(() => {});

            // The socket never opens: a slow/hung handshake.
            for (let i = 0; i < 10_000; i++) {
                transport.send(noteFrame(i));
            }

            expect(outboxOf(transport).length).toBeLessThanOrEqual(
                OUTBOX_LIMIT,
            );
        },
    );
});

describe("post-open failure", () => {
    // BUG: a socket that closes (or errors) after opening should be surfaced to
    // the client so in-flight requests fail immediately — currently the `error`
    // and `close` listeners are no-ops once `opened` is true and `Transport`
    // exposes no onClose/onError channel, so JSONRPCClient never learns the
    // socket died and every in-flight request waits out its full timeout
    // (10s by default) before rejecting. Fixing this needs a Transport
    // interface addition.
    it.fails(
        "surfaces a post-open socket close so in-flight requests fail fast",
        async () => {
            vi.useFakeTimers();
            const transport = new WebSocketTransport("ws://host/lsp");
            const client = new JSONRPCClient(transport);
            const socket = lastSocket();
            socket.emitOpen();

            let settled = false;
            client.request("textDocument/hover", {}, 10_000).then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(socket.sent).toHaveLength(1);

            socket.emitClose();
            await vi.advanceTimersByTimeAsync(1);

            expect(settled).toBe(true);
        },
    );
});

describe("repeated connect", () => {
    // BUG: a second connect() should either be rejected or fully replace the
    // first socket (closing it and detaching its listeners) — currently it
    // constructs a new WebSocket and overwrites `this.socket`, leaving the
    // first socket open, unreferenced, and still dispatching its inbound
    // frames into the shared handler set: a leaked connection plus duplicate
    // message delivery from a socket the caller believes is gone.
    it.fails(
        "does not leak or double-dispatch when connect is called twice",
        () => {
            const transport = new WebSocketTransport("ws://host/lsp");
            transport.connect().catch(() => {});
            const first = lastSocket();
            transport.connect().catch(() => {});
            const second = lastSocket();
            expect(second).not.toBe(first);

            const handler = vi.fn();
            transport.onMessage(handler);
            second.emitOpen();

            first.emitMessage(
                JSON.stringify({ jsonrpc: "2.0", method: "stale" }),
            );

            expect(first.closed).toBe(true);
            expect(handler).not.toHaveBeenCalled();
        },
    );
});

describe("url validation", () => {
    /** Attempt a connection and report whether any socket was opened. */
    function attempt(url: string): { threw: boolean; socketOpened: boolean } {
        MockSocket.last = undefined;
        let threw = false;
        try {
            const transport = new WebSocketTransport(url);
            transport.connect().catch(() => {});
        } catch {
            threw = true;
        }
        return { threw, socketOpened: MockSocket.last !== undefined };
    }

    // BUG: a non-WebSocket URL should be rejected before any socket is opened
    // (throw from the constructor or reject connect()) — currently there is no
    // runtime check at all; the `ws://|wss://` constraint lives only in the
    // TypeScript template-literal type on `serverUri`, which is erased at
    // runtime, so a value from config/user input reaches `new WebSocket(...)`
    // unvalidated.
    it.fails("rejects a non-WebSocket URL scheme", () => {
        for (const url of [
            "http://host/lsp",
            "https://host/lsp",
            "javascript:alert(1)",
            "",
        ]) {
            const { socketOpened } = attempt(url);
            expect(socketOpened, `opened a socket for ${url}`).toBe(false);
        }
    });

    // BUG: an insecure ws:// endpoint used from an https:// page should at
    // least warn (browsers block the connection outright as mixed content) —
    // currently the transport says nothing and the developer only sees an
    // opaque connection failure.
    it.fails(
        "warns when an insecure ws:// URL is used from a secure page",
        () => {
            vi.stubGlobal("location", {
                protocol: "https:",
                host: "app.example",
                href: "https://app.example/",
            });
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            const transport = new WebSocketTransport("ws://host/lsp");
            transport.connect().catch(() => {});

            expect(warn).toHaveBeenCalled();
        },
    );
});

describe("inbound frames", () => {
    // BUG: binary frames (ArrayBuffer/Blob, which every WebSocket can deliver)
    // should be decoded and dispatched — currently `String(event.data)` yields
    // "[object ArrayBuffer]", JSON.parse throws, and the catch drops the frame
    // silently, so a server that switches to binary framing looks simply
    // unresponsive with nothing logged.
    it.fails("ignores binary frames without silently losing them", () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        transport.connect().catch(() => {});
        const socket = lastSocket();

        const handler = vi.fn();
        transport.onMessage(handler);

        const message = { jsonrpc: "2.0", id: 0, result: { ok: true } };
        const bytes = new TextEncoder().encode(JSON.stringify(message));
        socket.emitRawMessage(bytes.buffer);

        expect(handler).toHaveBeenCalledWith(message);
    });

    // BUG: one throwing handler must not starve the others — the dispatch loop
    // should isolate each listener the way lsp.ts's notification fan-out does
    // — currently the exception escapes the `for` loop, so every handler
    // registered after the faulty one silently stops receiving frames.
    it.fails("keeps dispatching to remaining handlers when one throws", () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        transport.connect().catch(() => {});
        const socket = lastSocket();

        const faulty = vi.fn(() => {
            throw new Error("handler blew up");
        });
        const healthy = vi.fn();
        transport.onMessage(faulty);
        transport.onMessage(healthy);

        const message = { jsonrpc: "2.0", method: "window/logMessage" };
        try {
            socket.emitMessage(JSON.stringify(message));
        } catch {
            // A real DOM event dispatch swallows listener errors; the mock
            // rethrows, which is not what is under test here.
        }

        expect(faulty).toHaveBeenCalledTimes(1);
        expect(healthy).toHaveBeenCalledWith(message);
    });

    // BUG: `onMessage` handlers are typed to receive a JSONRPCMessage, so
    // inbound JSON that parses to a non-object should be dropped by the
    // transport — currently only a JSON *syntax* error is guarded, so `null`,
    // `123`, `"str"` and `[]` are handed to every handler and each one has to
    // re-validate (JSONRPCClient does; other consumers may not).
    it.fails("does not dispatch inbound JSON that is not an object", () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        transport.connect().catch(() => {});
        const socket = lastSocket();

        const handler = vi.fn();
        transport.onMessage(handler);

        for (const payload of ["null", "123", '"str"', "true", "[]"]) {
            expect(() => socket.emitMessage(payload)).not.toThrow();
        }

        expect(handler).not.toHaveBeenCalled();
    });
});

describe("close and reconnect", () => {
    it("does not resurrect handlers registered before close when reconnecting", async () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        const connected = transport.connect();
        const first = lastSocket();
        first.emitOpen();
        await connected;

        const stale = vi.fn();
        transport.onMessage(stale);
        transport.close();

        const reconnected = transport.connect();
        const second = lastSocket();
        expect(second).not.toBe(first);
        second.emitOpen();
        await reconnected;

        const fresh = vi.fn();
        transport.onMessage(fresh);
        const message = { jsonrpc: "2.0", method: "window/logMessage" };
        second.emitMessage(JSON.stringify(message));

        // close() dropped every subscription; only post-reconnect ones fire.
        expect(stale).not.toHaveBeenCalled();
        expect(fresh).toHaveBeenCalledWith(message);
    });

    it("is idempotent and safe to call close before connect", () => {
        const transport = new WebSocketTransport("ws://host/lsp");

        expect(() => transport.close()).not.toThrow();
        expect(MockSocket.all).toHaveLength(0);

        // A later connect still works on a never-opened, already-closed
        // transport.
        expect(() => transport.connect().catch(() => {})).not.toThrow();
    });

    it("is safe to call close twice", async () => {
        const transport = new WebSocketTransport("ws://host/lsp");
        const connected = transport.connect();
        const socket = lastSocket();
        socket.emitOpen();
        await connected;

        transport.close();
        expect(() => transport.close()).not.toThrow();
        expect(socket.closed).toBe(true);
    });
});
