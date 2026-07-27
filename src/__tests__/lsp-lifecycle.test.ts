import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentUri, languageId } from "../config.js";
import type { JSONRPCMessage, JSONRPCRequest } from "../jsonrpc.js";
import {
    LanguageServerClient,
    type LanguageServerClientOptions,
} from "../lsp.js";
import { FakeTransport } from "../testing/fakeTransport.js";

const openClients: LanguageServerClient[] = [];

function makeClient(
    options: Partial<LanguageServerClientOptions> & {
        transport: FakeTransport;
    },
): LanguageServerClient {
    const client = new LanguageServerClient({
        rootUri: "file:///test",
        workspaceFolders: null,
        ...options,
    });
    openClients.push(client);
    return client;
}

async function flushTicks(count = 5) {
    for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function sentRequests(
    transport: FakeTransport,
    method: string,
): JSONRPCRequest[] {
    return transport.sent.filter(
        (m): m is JSONRPCRequest =>
            "method" in m && "id" in m && m.method === method,
    );
}

function indexOfMethod(transport: FakeTransport, method: string): number {
    return transport.sent.findIndex(
        (m: JSONRPCMessage) => "method" in m && m.method === method,
    );
}

async function settlement(
    promise: Promise<unknown>,
): Promise<"resolved" | "rejected" | "pending"> {
    let state: "resolved" | "rejected" | "pending" = "pending";
    promise.then(
        () => {
            state = "resolved";
        },
        () => {
            state = "rejected";
        },
    );
    await flushTicks();
    return state;
}

const hoverParams = {
    textDocument: { uri: "file:///a.ts" },
    position: { line: 0, character: 0 },
};

function openParams(uri: string) {
    return {
        textDocument: { uri, languageId: "plaintext", text: "", version: 0 },
    };
}

beforeEach(() => {
    // Several tests intentionally fail initialize; the client logs that.
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    for (const client of openClients.splice(0)) {
        try {
            client.close();
        } catch {
            // already torn down
        }
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("initialize handshake", () => {
    it("stays not-ready when initialize returns a null result", async () => {
        const transport = new FakeTransport({ autoInitialize: false });
        const client = makeClient({ transport });
        await flushTicks(1);

        const [request] = sentRequests(transport, "initialize");
        transport.receive({ jsonrpc: "2.0", id: request.id, result: null });
        await flushTicks();

        expect(client.ready).toBe(false);
        await expect(client.initializePromise).rejects.toThrow(/initialize/i);
    });

    it("stays not-ready when initialize returns a result with no capabilities", async () => {
        const transport = new FakeTransport({ autoInitialize: false });
        const client = makeClient({ transport });
        await flushTicks(1);

        const [request] = sentRequests(transport, "initialize");
        transport.receive({ jsonrpc: "2.0", id: request.id, result: {} });
        await flushTicks();

        expect(client.ready).toBe(false);
    });

    it("rejects initialize with a timeout when the server never answers", async () => {
        vi.useFakeTimers();
        const transport = new FakeTransport({ autoInitialize: false });
        const client = makeClient({ transport, timeout: 1000 });

        let outcome: unknown = "pending";
        client.initializePromise.then(
            () => {
                outcome = "resolved";
            },
            (error) => {
                outcome = error;
            },
        );

        await vi.advanceTimersByTimeAsync(2999);
        expect(outcome).toBe("pending");

        await vi.advanceTimersByTimeAsync(2);
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).toMatch(/timed out/i);
        expect(client.ready).toBe(false);
    });

    it("becomes ready, stores capabilities and notifies initialized on success", async () => {
        const transport = new FakeTransport({
            capabilities: { hoverProvider: true },
        });
        const client = makeClient({ transport });
        await client.initializePromise;

        expect(client.ready).toBe(true);
        expect(client.capabilities).toEqual({ hoverProvider: true });
        expect(transport.notificationsSent("initialized")).toEqual([
            { jsonrpc: "2.0", method: "initialized", params: {} },
        ]);
    });
});

describe("request gating", () => {
    it("sends initialize before any feature request", async () => {
        const transport = new FakeTransport({
            capabilities: { hoverProvider: true },
        });
        const client = makeClient({ transport });
        void client.textDocumentHover(hoverParams).catch(() => {});
        await flushTicks();

        const initializeIndex = indexOfMethod(transport, "initialize");
        const hoverIndex = indexOfMethod(transport, "textDocument/hover");
        expect(initializeIndex).toBeGreaterThanOrEqual(0);
        expect(hoverIndex).toBeGreaterThanOrEqual(0);
        expect(initializeIndex).toBeLessThan(hoverIndex);
    });

    it("does not send textDocument/hover when the server has no hoverProvider", async () => {
        const transport = new FakeTransport({ capabilities: {} });
        const client = makeClient({ transport });
        await client.initializePromise;
        expect(client.hasCapability("textDocument/hover")).toBe(false);

        void client.textDocumentHover(hoverParams).catch(() => {});
        await flushTicks();

        expect(sentRequests(transport, "textDocument/hover")).toEqual([]);
    });

    it("gates a request queued during initialization on the final capabilities", async () => {
        // The request is issued before the handshake answers, so the decision
        // can only be made once the server's capabilities are known.
        const transport = new FakeTransport({ capabilities: {} });
        const client = makeClient({ transport });

        const hover = client.textDocumentHover(hoverParams);
        hover.catch(() => {});
        await flushTicks();

        await expect(hover).rejects.toThrow(/does not support/i);
        expect(sentRequests(transport, "textDocument/hover")).toEqual([]);
    });

    it("rejects feature requests after initialize failed", async () => {
        const transport = new FakeTransport({
            failInitialize: { code: -32000, message: "server down" },
        });
        const client = makeClient({ transport });
        await expect(client.initializePromise).rejects.toThrow("server down");

        const hover = client.textDocumentHover(hoverParams);
        hover.catch(() => {});
        expect(await settlement(hover)).toBe("rejected");
    });
});

describe("shutdown and teardown", () => {
    it("sends shutdown and exit before tearing down the transport", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        await client.initializePromise;

        client.close();
        await flushTicks();

        const shutdownIndex = indexOfMethod(transport, "shutdown");
        const exitIndex = indexOfMethod(transport, "exit");
        expect(shutdownIndex).toBeGreaterThanOrEqual(0);
        expect(exitIndex).toBeGreaterThan(shutdownIndex);
    });

    it("rejects an in-flight request when the client is closed", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        await client.initializePromise;

        const hover = client.textDocumentHover(hoverParams);
        hover.catch(() => {});
        client.close();

        expect(await settlement(hover)).toBe("rejected");
        await expect(hover).rejects.toThrow(/closed/i);
    });

    it("is idempotent when closed twice", async () => {
        const transport = new FakeTransport();
        const transportClose = vi.spyOn(transport, "close");
        const client = makeClient({ transport });
        await client.initializePromise;

        client.close();
        expect(() => client.close()).not.toThrow();
        expect(client.ready).toBe(false);
        // The transport is torn down once the shutdown response lands
        await flushTicks();
        expect(transportClose).toHaveBeenCalledTimes(1);
    });

    it("clears document open counts on close", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        await client.textDocumentDidOpen(openParams("file:///leak.ts"));

        client.close();

        // biome-ignore lint/suspicious/noExplicitAny: reading a private field in a test
        expect((client as any).documentOpenCounts.size).toBe(0);
    });
});

describe("document open/close bookkeeping", () => {
    it("does not suppress a later didOpen after an unmatched didClose", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        const uri = "file:///reopen.ts";

        await client.textDocumentDidOpen(openParams(uri));
        await client.textDocumentDidClose({ textDocument: { uri } });
        // An extra, unmatched close must not push the count negative.
        await client.textDocumentDidClose({ textDocument: { uri } });
        await client.textDocumentDidOpen(openParams(uri));

        expect(
            transport.notificationsSent("textDocument/didOpen"),
        ).toHaveLength(2);
    });

    it("keeps open counts consistent for a didClose on a never-opened URI", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        const uri = "file:///never-opened.ts";

        await client.textDocumentDidClose({ textDocument: { uri } });

        // biome-ignore lint/suspicious/noExplicitAny: reading a private field in a test
        expect((client as any).documentOpenCounts.size).toBe(0);

        await client.textDocumentDidOpen(openParams(uri));
        expect(
            transport.notificationsSent("textDocument/didOpen"),
        ).toHaveLength(1);
    });
});

describe("capabilities", () => {
    it("reports false for a capability the server explicitly disabled", async () => {
        const transport = new FakeTransport({
            capabilities: { hoverProvider: false, completionProvider: {} },
        });
        const client = makeClient({ transport });
        await client.initializePromise;

        expect(client.hasCapability("textDocument/hover")).toBe(false);
        expect(client.hasCapability("textDocument/completion")).toBe(true);
    });

    it("reports true for a dynamically registered capability", async () => {
        const transport = new FakeTransport({ capabilities: {} });
        const client = makeClient({ transport });
        await client.initializePromise;
        expect(client.hasCapability("textDocument/formatting")).toBe(false);

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "client/registerCapability",
            params: {
                registrations: [
                    { id: "reg-1", method: "textDocument/formatting" },
                ],
            },
        });
        await flushTicks();

        expect(client.hasCapability("textDocument/formatting")).toBe(true);
    });

    it("ignores a dynamic registration with no id", async () => {
        const transport = new FakeTransport({ capabilities: {} });
        const client = makeClient({ transport });
        await client.initializePromise;

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "client/registerCapability",
            params: { registrations: [{ method: "textDocument/formatting" }] },
        });
        await flushTicks();

        expect(
            client.dynamicCapabilities.has(undefined as unknown as string),
        ).toBe(false);
        expect(client.dynamicCapabilities.size).toBe(0);
    });

    it("does not let a duplicate registration id silently overwrite another", async () => {
        const transport = new FakeTransport({ capabilities: {} });
        const client = makeClient({ transport });
        await client.initializePromise;

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "client/registerCapability",
            params: {
                registrations: [
                    { id: "reg-1", method: "textDocument/formatting" },
                ],
            },
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 2,
            method: "client/registerCapability",
            params: {
                registrations: [{ id: "reg-1", method: "textDocument/hover" }],
            },
        });
        await flushTicks();

        expect(client.hasCapability("textDocument/formatting")).toBe(true);
    });
});

describe("server-initiated requests", () => {
    it("answers workspace/configuration with an empty array when params are missing", async () => {
        const transport = new FakeTransport();
        makeClient({ transport });

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "workspace/configuration",
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 1, result: [] },
        ]);
    });

    it("answers client/registerCapability when registrations is not an array", async () => {
        const transport = new FakeTransport();
        const client = makeClient({ transport });

        transport.receive({
            jsonrpc: "2.0",
            id: 1,
            method: "client/registerCapability",
            params: { registrations: "nope" },
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 2,
            method: "client/registerCapability",
            params: { registrations: { id: "reg-1" } },
        });
        await flushTicks();

        // Order between the two replies is not guaranteed, so compare by id
        const responses = [...transport.serverResponses()].sort(
            (a, b) => Number("id" in a && a.id) - Number("id" in b && b.id),
        );
        expect(responses).toEqual([
            { jsonrpc: "2.0", id: 1, result: null },
            { jsonrpc: "2.0", id: 2, result: null },
        ]);
        expect(client.dynamicCapabilities.size).toBe(0);
    });

    it("answers duplicate server request ids independently", async () => {
        const transport = new FakeTransport();
        makeClient({ transport });

        transport.receive({
            jsonrpc: "2.0",
            id: 5,
            method: "workspace/applyEdit",
            params: { edit: { changes: {} } },
        });
        transport.receive({
            jsonrpc: "2.0",
            id: 5,
            method: "window/workDoneProgress/create",
            params: { token: "t" },
        });
        await flushTicks();

        expect(transport.serverResponses()).toEqual([
            {
                jsonrpc: "2.0",
                id: 5,
                result: {
                    applied: false,
                    failureReason: "workspace/applyEdit is not supported",
                },
            },
            { jsonrpc: "2.0", id: 5, result: null },
        ]);
    });

    it("does not log an unbounded or control-character message from showMessageRequest", async () => {
        const transport = new FakeTransport();
        makeClient({ transport });
        const info = vi.spyOn(console, "info").mockImplementation(() => {});

        transport.receive({
            jsonrpc: "2.0",
            id: 3,
            method: "window/showMessageRequest",
            params: {
                type: 1,
                message: `${"A".repeat(20000)}\u0000\u001b[31mred`,
                actions: [],
            },
        });
        await flushTicks();

        // The request is still answered with "no action selected".
        expect(transport.serverResponses()).toEqual([
            { jsonrpc: "2.0", id: 3, result: null },
        ]);

        const logged = info.mock.calls.map((c) => String(c[0])).join("");
        expect(logged.length).toBeLessThanOrEqual(2048);
        expect(logged).not.toMatch(
            // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are stripped
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/,
        );
    });
});

describe("notification listeners", () => {
    it("does not produce an unhandled rejection when a listener rejects asynchronously", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
            const client = makeClient({ transport: new FakeTransport() });
            client.onNotification(() =>
                Promise.reject(new Error("async listener failed")),
            );
            const other = vi.fn();
            client.onNotification(other);

            const notification = {
                jsonrpc: "2.0" as const,
                method: "textDocument/publishDiagnostics" as const,
                params: { uri: "file:///x", diagnostics: [] },
            };
            // biome-ignore lint/suspicious/noExplicitAny: calling a protected member in a test
            (client as any).processNotification(notification);
            await flushTicks();

            expect(other).toHaveBeenCalledWith(notification);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("isolates a listener that throws synchronously", () => {
        const client = makeClient({ transport: new FakeTransport() });
        const bad = vi.fn(() => {
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
            // biome-ignore lint/suspicious/noExplicitAny: calling a protected member in a test
            (client as any).processNotification(notification),
        ).not.toThrow();
        expect(bad).toHaveBeenCalled();
        expect(good).toHaveBeenCalledWith(notification);
    });
});

describe("config validation", () => {
    it("should throw when the document URI is an empty string", () => {
        expect(() => documentUri.combine([""])).toThrow(/document URI/i);
    });

    it("should throw when the language ID is an empty string", () => {
        expect(() => languageId.combine([""])).toThrow(/language ID/i);
    });

    it("should reject a document URI that is not an absolute URI", () => {
        expect(() => documentUri.combine(["relative/path.ts"])).toThrow(/URI/i);
    });

    it("should reject an empty rootUri", () => {
        const transport = new FakeTransport();
        expect(() => makeClient({ transport, rootUri: "" })).toThrow(
            /rootUri/i,
        );
    });

    it("accepts a valid document URI and language ID", () => {
        expect(documentUri.combine(["file:///valid.ts"])).toBe(
            "file:///valid.ts",
        );
        expect(languageId.combine(["typescript"])).toBe("typescript");
    });

    it("throws the documented error when no document URI or language ID is provided", () => {
        expect(() => documentUri.combine([]).anyProperty).toThrow(
            "No document URI provided. Pass one to the extension or use documentUri.of().",
        );
        expect(() => languageId.combine([]).anyProperty).toThrow(
            "No language ID provided. Pass one to the extension or use languageId.of().",
        );
    });
});
