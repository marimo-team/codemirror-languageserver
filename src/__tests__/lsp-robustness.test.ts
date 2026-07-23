import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageServerClient } from "../lsp.js";
import { FakeTransport } from "../testing/fakeTransport.js";

function baseOptions(transport: FakeTransport) {
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
    vi.restoreAllMocks();
});

describe("initialize failure handling", () => {
    it("does not produce an unhandled rejection when initialize fails", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
            const transport = new FakeTransport({
                failInitialize: { code: -32000, message: "server down" },
            });
            const client = new LanguageServerClient(baseOptions(transport));

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
        const client = new LanguageServerClient(
            baseOptions(new FakeTransport()),
        );
        await flushTicks();
        expect(client.ready).toBe(true);
    });
});

describe("server request handling", () => {
    it("answers unhandled requests with MethodNotFound and a matching id (including id 0)", async () => {
        const transport = new FakeTransport();
        new LanguageServerClient(baseOptions(transport));

        transport.receive({
            jsonrpc: "2.0",
            id: 0,
            method: "workspace/unknownMethod",
            params: {},
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            {
                jsonrpc: "2.0",
                id: 0,
                error: {
                    code: -32601,
                    message: "Method not found: workspace/unknownMethod",
                },
            },
        ]);
    });

    it("answers workspace/applyEdit and window requests with spec-valid no-op results", async () => {
        const transport = new FakeTransport();
        new LanguageServerClient(baseOptions(transport));

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "workspace/applyEdit",
            params: { edit: { changes: {} } },
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 2,
            method: "window/showMessageRequest",
            params: { type: 1, message: "pick one", actions: [] },
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 3,
            method: "window/workDoneProgress/create",
            params: { token: "t" },
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            {
                jsonrpc: "2.0",
                id: 1,
                result: {
                    applied: false,
                    failureReason: "workspace/applyEdit is not supported",
                },
            },
            { jsonrpc: "2.0", id: 2, result: null },
            { jsonrpc: "2.0", id: 3, result: null },
        ]);
    });

    it("answers workspace/configuration requests via getWorkspaceConfiguration", async () => {
        const transport = new FakeTransport();
        const getWorkspaceConfiguration = vi.fn().mockReturnValue([{ a: 1 }]);
        new LanguageServerClient({
            ...baseOptions(transport),
            getWorkspaceConfiguration,
        });

        transport.receive({
            jsonrpc: "2.0",
            id: 0,
            method: "workspace/configuration",
            params: { items: [] },
        });
        await flushTicks();

        expect(getWorkspaceConfiguration).toHaveBeenCalledWith({ items: [] });
        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 0, result: [{ a: 1 }] },
        ]);
    });

    it("answers workspace/configuration with one null per item when no option is provided", async () => {
        const transport = new FakeTransport();
        new LanguageServerClient(baseOptions(transport));

        transport.receive({
            jsonrpc: "2.0",
            id: 7,
            method: "workspace/configuration",
            params: { items: [{ section: "a" }, { section: "b" }] },
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 7, result: [null, null] },
        ]);
    });

    it("dispatches to onRequest handlers and unsubscribes them", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        const handler = vi.fn().mockResolvedValue({ ok: true });
        const dispose = client.onRequest("custom/method", handler);

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "custom/method",
            params: { x: 1 },
        });
        await flushTicks();

        expect(handler).toHaveBeenCalledWith({ x: 1 });
        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 1, result: { ok: true } },
        ]);

        dispose();
        transport.receive({
            jsonrpc: "2.0",
            id: 2,
            method: "custom/method",
            params: {},
        });
        await flushTicks();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(transport.serverResponses()[1]).toEqual({
            jsonrpc: "2.0",
            id: 2,
            error: {
                code: -32601,
                message: "Method not found: custom/method",
            },
        });
    });

    it("replies with an internal error when a handler throws, and stays usable", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        client.onRequest("custom/fails", () => {
            throw new Error("boom");
        });
        client.onRequest("custom/works", () => "fine");

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "custom/fails",
            params: {},
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 2,
            method: "custom/works",
            params: {},
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            {
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32603, message: "boom" },
            },
            { jsonrpc: "2.0", id: 2, result: "fine" },
        ]);
    });

    it("coerces a handler's undefined result to null", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        client.onRequest("custom/void", () => undefined);

        transport.receive({
            jsonrpc: "2.0",
            id: 3,
            method: "custom/void",
            params: {},
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 3, result: null },
        ]);
    });

    it("routes notifications to listeners and ignores responses without answering", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));
        const listener = vi.fn();
        client.onNotification(listener);

        const notification = {
            jsonrpc: "2.0" as const,
            method: "textDocument/publishDiagnostics" as const,
            params: { uri: "file:///x", diagnostics: [] },
        };
        // A notification (no id) reaches listeners; a response for an unknown
        // id is silently ignored. Neither elicits a reply to the server.
        transport.receive(notification);
        transport.receive({
            jsonrpc: "2.0",
            id: 999,
            result: { capabilities: {} },
        });
        await flushTicks();

        expect(listener).toHaveBeenCalledWith(notification);
        expect(transport.serverResponses()).toEqual([]);
    });

    it("tracks dynamic capability (un)registration via hasCapability", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        expect(client.hasCapability("textDocument/formatting")).toBe(false);

        transport.receive({
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
        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 1, result: null },
        ]);

        transport.receive({
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
        expect(transport.serverResponses()[1]).toEqual({
            jsonrpc: "2.0",
            id: 2,
            result: null,
        });
    });
});

describe("close()", () => {
    it("marks the client not ready, clears listeners, and closes the transport", async () => {
        const transport = new FakeTransport();
        const closeSpy = vi.spyOn(transport, "close");
        const client = new LanguageServerClient(baseOptions(transport));
        await flushTicks();
        expect(client.ready).toBe(true);

        const listener = vi.fn();
        client.onNotification(listener);

        client.close();

        expect(client.ready).toBe(false);
        expect(closeSpy).toHaveBeenCalled();

        // Server requests arriving after close are no longer answered
        const responsesBefore = transport.serverResponses().length;
        transport.receive({
            jsonrpc: "2.0",
            id: 9,
            method: "workspace/configuration",
            params: { items: [] },
        });
        await flushTicks();
        expect(transport.serverResponses().length).toBe(responsesBefore);

        // Listeners are cleared, so notifications no longer reach them
        // biome-ignore lint/suspicious/noExplicitAny: accessing protected member in test
        (client as any).processNotification({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: "file:///x", diagnostics: [] },
        });
        expect(listener).not.toHaveBeenCalled();
    });

    it("does not send initialized or become ready when closed before initialize resolves", async () => {
        // Never auto-answer initialize, so it stays in flight until close.
        const transport = new FakeTransport({ autoInitialize: false });
        const client = new LanguageServerClient(baseOptions(transport));

        // Close before the pending initialize request is even sent.
        client.close();
        await flushTicks();

        expect(client.ready).toBe(false);
        expect(transport.notificationsSent("initialized")).toEqual([]);
    });
});

describe("notification listener isolation", () => {
    it("keeps notifying remaining listeners when one throws", () => {
        const client = new LanguageServerClient(
            baseOptions(new FakeTransport()),
        );
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
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        await client.textDocumentDidClose({
            textDocument: { uri: "file:///x" },
        });

        expect(transport.notificationsSent("textDocument/didClose")).toEqual([
            {
                jsonrpc: "2.0",
                method: "textDocument/didClose",
                params: { textDocument: { uri: "file:///x" } },
            },
        ]);
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

    function notifyCount(transport: FakeTransport, method: string) {
        return transport.notificationsSent(method).length;
    }

    it("sends didOpen only once when the same URI is opened twice", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        await client.textDocumentDidOpen(openParams("file:///dup"));
        await client.textDocumentDidOpen(openParams("file:///dup"));

        expect(notifyCount(transport, "textDocument/didOpen")).toBe(1);
    });

    it("sends didClose only when the last view closes", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        await client.textDocumentDidOpen(openParams("file:///dup"));
        await client.textDocumentDidOpen(openParams("file:///dup"));

        // First close just drops a reference; server is not notified yet.
        await client.textDocumentDidClose({
            textDocument: { uri: "file:///dup" },
        });
        expect(notifyCount(transport, "textDocument/didClose")).toBe(0);

        // Second close is the last reference and does notify.
        await client.textDocumentDidClose({
            textDocument: { uri: "file:///dup" },
        });
        expect(notifyCount(transport, "textDocument/didClose")).toBe(1);
    });

    it("tracks distinct URIs independently", async () => {
        const transport = new FakeTransport();
        const client = new LanguageServerClient(baseOptions(transport));

        await client.textDocumentDidOpen(openParams("file:///a"));
        await client.textDocumentDidOpen(openParams("file:///b"));

        expect(notifyCount(transport, "textDocument/didOpen")).toBe(2);

        await client.textDocumentDidClose({
            textDocument: { uri: "file:///a" },
        });
        expect(notifyCount(transport, "textDocument/didClose")).toBe(1);
    });
});
