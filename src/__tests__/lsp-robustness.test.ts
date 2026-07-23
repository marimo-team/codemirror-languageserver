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

function createFakeTransport() {
    // Stands in for the TransportRequestManager every @open-rpc/client-js
    // transport routes incoming frames through; the client patches
    // resolveResponse to intercept server->client requests.
    const originalResolveResponse = vi.fn();
    return {
        transportRequestManager: {
            resolveResponse: originalResolveResponse,
        },
        originalResolveResponse,
        sendData: vi.fn().mockResolvedValue({}),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        connect: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: minimal transport stub
    } as any;
}

/** Simulates an incoming frame arriving on the transport */
// biome-ignore lint/suspicious/noExplicitAny: test helper
function receiveFrame(transport: any, frame: unknown) {
    transport.transportRequestManager.resolveResponse(
        typeof frame === "string" ? frame : JSON.stringify(frame),
    );
}

// biome-ignore lint/suspicious/noExplicitAny: inspecting mock args
function sentResponses(transport: any) {
    return transport.sendData.mock.calls.map(
        // biome-ignore lint/suspicious/noExplicitAny: inspecting mock args
        (call: any[]) => call[0].request,
    );
}

function baseOptions(transport = createFakeTransport()) {
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

describe("server request handling", () => {
    it("answers unhandled requests with MethodNotFound and a matching id (including id 0)", async () => {
        const transport = createFakeTransport();
        new LanguageServerClient(baseOptions(transport));

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 0,
            method: "window/showMessageRequest",
            params: {},
        });
        await flushTicks();

        expect(sentResponses(transport)).toEqual([
            {
                jsonrpc: "2.0",
                id: 0,
                error: {
                    code: -32601,
                    message: "Method not found: window/showMessageRequest",
                },
            },
        ]);
        // The request must not leak into the response/notification path
        expect(transport.originalResolveResponse).not.toHaveBeenCalled();
    });

    it("answers workspace/configuration requests via getWorkspaceConfiguration", async () => {
        const transport = createFakeTransport();
        const getWorkspaceConfiguration = vi.fn().mockReturnValue([{ a: 1 }]);
        new LanguageServerClient({
            ...baseOptions(transport),
            getWorkspaceConfiguration,
        });

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 0,
            method: "workspace/configuration",
            params: { items: [] },
        });
        await flushTicks();

        expect(getWorkspaceConfiguration).toHaveBeenCalledWith({ items: [] });
        expect(sentResponses(transport)).toEqual([
            { jsonrpc: "2.0", id: 0, result: [{ a: 1 }] },
        ]);
    });

    it("answers workspace/configuration with one null per item when no option is provided", async () => {
        const transport = createFakeTransport();
        new LanguageServerClient(baseOptions(transport));

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 7,
            method: "workspace/configuration",
            params: { items: [{ section: "a" }, { section: "b" }] },
        });
        await flushTicks();

        expect(sentResponses(transport)).toEqual([
            { jsonrpc: "2.0", id: 7, result: [null, null] },
        ]);
    });

    it("dispatches to onRequest handlers and unsubscribes them", async () => {
        const transport = createFakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        const handler = vi.fn().mockResolvedValue({ ok: true });
        const dispose = client.onRequest("custom/method", handler);

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 1,
            method: "custom/method",
            params: { x: 1 },
        });
        await flushTicks();

        expect(handler).toHaveBeenCalledWith({ x: 1 });
        expect(sentResponses(transport)).toEqual([
            { jsonrpc: "2.0", id: 1, result: { ok: true } },
        ]);

        dispose();
        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 2,
            method: "custom/method",
            params: {},
        });
        await flushTicks();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(sentResponses(transport)[1]).toEqual({
            jsonrpc: "2.0",
            id: 2,
            error: {
                code: -32601,
                message: "Method not found: custom/method",
            },
        });
    });

    it("replies with an internal error when a handler throws, and stays usable", async () => {
        const transport = createFakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        client.onRequest("custom/fails", () => {
            throw new Error("boom");
        });
        client.onRequest("custom/works", () => "fine");

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 1,
            method: "custom/fails",
            params: {},
        });
        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 2,
            method: "custom/works",
            params: {},
        });
        await flushTicks();

        expect(sentResponses(transport)).toEqual([
            {
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32603, message: "boom" },
            },
            { jsonrpc: "2.0", id: 2, result: "fine" },
        ]);
    });

    it("coerces a handler's undefined result to null", async () => {
        const transport = createFakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        client.onRequest("custom/void", () => undefined);

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 3,
            method: "custom/void",
            params: {},
        });
        await flushTicks();

        expect(sentResponses(transport)).toEqual([
            { jsonrpc: "2.0", id: 3, result: null },
        ]);
    });

    it("forwards non-JSON frames, notifications, and responses untouched", async () => {
        const transport = createFakeTransport();
        new LanguageServerClient(baseOptions(transport));

        const notification = JSON.stringify({
            jsonrpc: "2.0",
            method: "window/logMessage",
            params: {},
        });
        const response = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { capabilities: {} },
        });

        receiveFrame(transport, "ping");
        receiveFrame(transport, notification);
        receiveFrame(transport, response);
        await flushTicks();

        expect(transport.sendData).not.toHaveBeenCalled();
        expect(
            transport.originalResolveResponse.mock.calls.map((c) => c[0]),
        ).toEqual(["ping", notification, response]);
    });

    it("tracks dynamic capability (un)registration via hasCapability", async () => {
        const transport = createFakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        expect(client.hasCapability("textDocument/formatting")).toBe(false);

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 1,
            method: "client/registerCapability",
            params: {
                registrations: [
                    {
                        id: "reg-1",
                        method: "textDocument/formatting",
                        registerOptions: {},
                    },
                ],
            },
        });
        await flushTicks();

        expect(client.hasCapability("textDocument/formatting")).toBe(true);
        expect(sentResponses(transport)).toEqual([
            { jsonrpc: "2.0", id: 1, result: null },
        ]);

        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 2,
            method: "client/unregisterCapability",
            params: {
                unregisterations: [
                    { id: "reg-1", method: "textDocument/formatting" },
                ],
            },
        });
        await flushTicks();

        expect(client.hasCapability("textDocument/formatting")).toBe(false);
        expect(sentResponses(transport)[1]).toEqual({
            jsonrpc: "2.0",
            id: 2,
            result: null,
        });
    });
});

describe("close()", () => {
    it("marks the client not ready, clears listeners, and detaches the request interceptor", async () => {
        const transport = createFakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        // The constructor patches resolveResponse to intercept server requests
        expect(transport.transportRequestManager.resolveResponse).not.toBe(
            transport.originalResolveResponse,
        );
        await flushTicks();
        expect(client.ready).toBe(true);

        const listener = vi.fn();
        client.onNotification(listener);

        client.close();

        expect(client.ready).toBe(false);
        // Server requests arriving after close are no longer answered
        receiveFrame(transport, {
            jsonrpc: "2.0",
            id: 9,
            method: "workspace/configuration",
            params: { items: [] },
        });
        await flushTicks();
        expect(transport.sendData).not.toHaveBeenCalled();
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

describe("document open ref-counting", () => {
    function openParams(uri: string) {
        return {
            textDocument: {
                uri,
                languageId: "plaintext",
                text: "",
                version: 0,
            },
        };
    }

    function countNotifications(
        // biome-ignore lint/suspicious/noExplicitAny: inspecting mock args
        internal: any,
        method: string,
    ) {
        return internal.notify.mock.calls.filter(
            // biome-ignore lint/suspicious/noExplicitAny: inspecting mock args
            (call: any[]) => call[0]?.method === method,
        ).length;
    }

    it("sends didOpen only once when the same URI is opened twice", async () => {
        const client = new LanguageServerClient(baseOptions());
        const internal = clientInstances.at(-1);

        await client.textDocumentDidOpen(openParams("file:///dup"));
        await client.textDocumentDidOpen(openParams("file:///dup"));

        expect(countNotifications(internal, "textDocument/didOpen")).toBe(1);
    });

    it("sends didClose only when the last view closes", async () => {
        const client = new LanguageServerClient(baseOptions());
        const internal = clientInstances.at(-1);

        await client.textDocumentDidOpen(openParams("file:///dup"));
        await client.textDocumentDidOpen(openParams("file:///dup"));

        // First close just drops a reference; server is not notified yet.
        await client.textDocumentDidClose({
            textDocument: { uri: "file:///dup" },
        });
        expect(countNotifications(internal, "textDocument/didClose")).toBe(0);

        // Second close is the last reference and does notify.
        await client.textDocumentDidClose({
            textDocument: { uri: "file:///dup" },
        });
        expect(countNotifications(internal, "textDocument/didClose")).toBe(1);
    });

    it("tracks distinct URIs independently", async () => {
        const client = new LanguageServerClient(baseOptions());
        const internal = clientInstances.at(-1);

        await client.textDocumentDidOpen(openParams("file:///a"));
        await client.textDocumentDidOpen(openParams("file:///b"));

        expect(countNotifications(internal, "textDocument/didOpen")).toBe(2);

        await client.textDocumentDidClose({
            textDocument: { uri: "file:///a" },
        });
        expect(countNotifications(internal, "textDocument/didClose")).toBe(1);
    });
});
