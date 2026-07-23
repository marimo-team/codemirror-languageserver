import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageServerClient } from "../lsp.js";

// biome-ignore lint/suspicious/noExplicitAny: test helpers
const clientInstances: any[] = [];
let failInitialize = false;

vi.mock("@open-rpc/client-js", () => ({
    Client: vi.fn().mockImplementation(() => {
        const instance = {
            request: vi
                .fn()
                .mockImplementation(() =>
                    failInitialize
                        ? Promise.reject(new Error("server down"))
                        : Promise.resolve({ capabilities: {} }),
                ),
            notify: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(),
            onNotification: vi.fn(),
        };
        clientInstances.push(instance);
        return instance;
    }),
    RequestManager: vi.fn(),
}));

interface FakeConnection {
    handlers: Record<string, (message: { data: unknown }) => void>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
}

function createFakeWebSocketTransport() {
    const connection: FakeConnection = {
        handlers: {},
        addEventListener: vi.fn((event: string, handler) => {
            connection.handlers[event] = handler;
        }),
        removeEventListener: vi.fn((event: string) => {
            delete connection.handlers[event];
        }),
        send: vi.fn(),
    };
    return {
        connection,
        sendData: vi.fn().mockResolvedValue({}),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        connect: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: minimal transport stub
    } as any;
}

function baseOptions(transport = createFakeWebSocketTransport()) {
    return {
        rootUri: "file:///test",
        workspaceFolders: null,
        transport,
    };
}

async function flushTicks(count = 5) {
    for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

beforeEach(() => {
    clientInstances.length = 0;
    failInitialize = false;
});

describe("initialize failure handling", () => {
    it("does not produce an unhandled rejection when initialize fails", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
            failInitialize = true;
            const client = new LanguageServerClient(baseOptions());

            await flushTicks();
            expect(unhandled).toEqual([]);
            expect(client.ready).toBe(false);
            // Awaiters still observe the rejection themselves
            await expect(client.initializePromise).rejects.toThrow(
                "server down",
            );
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("becomes ready when initialize succeeds", async () => {
        const client = new LanguageServerClient(baseOptions());
        await flushTicks();
        expect(client.ready).toBe(true);
    });
});

describe("WebSocket message handling", () => {
    it("responds to server requests with id 0", async () => {
        const transport = createFakeWebSocketTransport();
        new LanguageServerClient(baseOptions(transport));
        const handler = transport.connection.handlers.message;
        expect(handler).toBeDefined();

        handler({
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "client/registerCapability",
                params: {},
            }),
        });

        expect(transport.connection.send).toHaveBeenCalledWith(
            JSON.stringify({ jsonrpc: "2.0", id: 0, result: null }),
        );
    });

    it("ignores non-JSON frames without throwing", () => {
        const transport = createFakeWebSocketTransport();
        new LanguageServerClient(baseOptions(transport));
        const handler = transport.connection.handlers.message;

        expect(() => handler({ data: "ping" })).not.toThrow();
        expect(() => handler({ data: new Blob(["binary"]) })).not.toThrow();
        expect(transport.connection.send).not.toHaveBeenCalled();
    });

    it("answers workspace/configuration requests (including id 0)", () => {
        const transport = createFakeWebSocketTransport();
        const getWorkspaceConfiguration = vi.fn().mockReturnValue([{ a: 1 }]);
        new LanguageServerClient({
            ...baseOptions(transport),
            getWorkspaceConfiguration,
        });
        const handler = transport.connection.handlers.message;

        handler({
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "workspace/configuration",
                params: { items: [] },
            }),
        });

        expect(getWorkspaceConfiguration).toHaveBeenCalledWith({ items: [] });
        expect(transport.connection.send).toHaveBeenCalledWith(
            JSON.stringify({ jsonrpc: "2.0", id: 0, result: [{ a: 1 }] }),
        );
    });

    it("does not reply to notifications (no id)", () => {
        const transport = createFakeWebSocketTransport();
        new LanguageServerClient(baseOptions(transport));
        const handler = transport.connection.handlers.message;

        handler({
            data: JSON.stringify({
                jsonrpc: "2.0",
                method: "window/logMessage",
                params: {},
            }),
        });

        expect(transport.connection.send).not.toHaveBeenCalled();
    });
});

describe("close()", () => {
    it("marks the client not ready, clears listeners, and detaches the ws handler", async () => {
        const transport = createFakeWebSocketTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        await flushTicks();
        expect(client.ready).toBe(true);

        const listener = vi.fn();
        client.onNotification(listener);

        client.close();

        expect(client.ready).toBe(false);
        expect(transport.connection.removeEventListener).toHaveBeenCalledWith(
            "message",
            expect.any(Function),
        );
        // biome-ignore lint/suspicious/noExplicitAny: accessing protected member in test
        (client as any).processNotification({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: "file:///x", diagnostics: [] },
        });
        expect(listener).not.toHaveBeenCalled();
        expect(clientInstances.at(-1).close).toHaveBeenCalled();
    });

    it("does not send initialized or become ready when closed before initialize resolves", async () => {
        const client = new LanguageServerClient(baseOptions());
        const internal = clientInstances.at(-1);

        // Close before the pending initialize response is processed
        client.close();
        await flushTicks();

        expect(client.ready).toBe(false);
        const initializedCalls = internal.notify.mock.calls.filter(
            // biome-ignore lint/suspicious/noExplicitAny: inspecting mock args
            (call: any[]) => call[0]?.method === "initialized",
        );
        expect(initializedCalls).toHaveLength(0);
    });
});

describe("notification listener isolation", () => {
    it("keeps notifying remaining listeners when one throws", () => {
        const client = new LanguageServerClient(baseOptions());
        const bad = vi.fn().mockImplementation(() => {
            throw new Error("listener failed");
        });
        const good = vi.fn();
        client.onNotification(bad);
        client.onNotification(good);

        const notification = {
            jsonrpc: "2.0" as const,
            method: "textDocument/publishDiagnostics" as const,
            params: { uri: "file:///x", diagnostics: [] },
        };
        expect(() =>
            // biome-ignore lint/suspicious/noExplicitAny: accessing protected member in test
            (client as any).processNotification(notification),
        ).not.toThrow();
        expect(good).toHaveBeenCalledWith(notification);
    });
});

describe("textDocumentDidClose", () => {
    it("sends a textDocument/didClose notification", async () => {
        const client = new LanguageServerClient(baseOptions());
        const internal = clientInstances.at(-1);

        await client.textDocumentDidClose({
            textDocument: { uri: "file:///x" },
        });

        expect(internal.notify).toHaveBeenCalledWith({
            method: "textDocument/didClose",
            params: { textDocument: { uri: "file:///x" } },
        });
    });
});
