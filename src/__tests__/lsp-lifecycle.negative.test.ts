import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentUri, languageId } from "../config.js";
import type { JSONRPCMessage, JSONRPCRequest } from "../jsonrpc.js";
import {
    LanguageServerClient,
    type LanguageServerClientOptions,
} from "../lsp.js";
import { FakeTransport } from "../testing/fakeTransport.js";

/**
 * Negative-path tests for the client lifecycle: the initialize handshake,
 * request gating, shutdown, document bookkeeping, capability tracking,
 * server-initiated requests, notification listeners, and facet validation.
 */

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

/** Frames the client sent as requests (id + method) for the given method. */
function sentRequests(
    transport: FakeTransport,
    method: string,
): JSONRPCRequest[] {
    return transport.sent.filter(
        (m): m is JSONRPCRequest =>
            "method" in m && "id" in m && m.method === method,
    );
}

/** Index of the first frame matching `method`, or -1. */
function indexOfMethod(transport: FakeTransport, method: string): number {
    return transport.sent.findIndex(
        (m: JSONRPCMessage) => "method" in m && m.method === method,
    );
}

/**
 * Observe how a promise settles without ever hanging: anything still pending
 * after a few macrotasks is reported as "pending".
 */
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
    // BUG: a null initialize result should reject with a descriptive protocol
    // error — currently `const { capabilities } = await this.request(...)`
    // (lsp.ts:556) destructures unguarded and rejects with
    // "Cannot destructure property 'capabilities' of ... as it is null".
    it.fails(
        "stays not-ready when initialize returns a null result",
        async () => {
            const transport = new FakeTransport({ autoInitialize: false });
            const client = makeClient({ transport });
            await flushTicks(1);

            const [request] = sentRequests(transport, "initialize");
            transport.receive({ jsonrpc: "2.0", id: request.id, result: null });
            await flushTicks();

            expect(client.ready).toBe(false);
            await expect(client.initializePromise).rejects.toThrow(
                /initialize/i,
            );
        },
    );

    // BUG: a result without `capabilities` is not a usable handshake and should
    // leave the client not-ready — currently `ready` flips to true and
    // `capabilities` is stored as undefined, so every feature silently no-ops.
    it.fails(
        "stays not-ready when initialize returns a result with no capabilities",
        async () => {
            const transport = new FakeTransport({ autoInitialize: false });
            const client = makeClient({ transport });
            await flushTicks(1);

            const [request] = sentRequests(transport, "initialize");
            transport.receive({ jsonrpc: "2.0", id: request.id, result: {} });
            await flushTicks();

            expect(client.ready).toBe(false);
        },
    );

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

        // initialize gets timeout * 3 (lsp.ts:559)
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
        const transport = new FakeTransport();
        const client = makeClient({ transport });
        // Called immediately, before the handshake could have completed.
        void client.textDocumentHover(hoverParams).catch(() => {});
        await flushTicks();

        const initializeIndex = indexOfMethod(transport, "initialize");
        const hoverIndex = indexOfMethod(transport, "textDocument/hover");
        expect(initializeIndex).toBeGreaterThanOrEqual(0);
        expect(hoverIndex).toBeGreaterThanOrEqual(0);
        expect(initializeIndex).toBeLessThan(hoverIndex);
    });

    // BUG: a request method should not hit the wire for a capability the server
    // never announced — currently the capability guards live only in plugin.ts,
    // so LanguageServerClient.textDocumentHover() sends textDocument/hover to a
    // server with no hoverProvider (which may answer MethodNotFound or hang).
    it.fails(
        "does not send textDocument/hover when the server has no hoverProvider",
        async () => {
            const transport = new FakeTransport({ capabilities: {} });
            const client = makeClient({ transport });
            await client.initializePromise;
            expect(client.hasCapability("textDocument/hover")).toBe(false);

            void client.textDocumentHover(hoverParams).catch(() => {});
            await flushTicks();

            expect(sentRequests(transport, "textDocument/hover")).toEqual([]);
        },
    );

    // BUG: after a failed handshake every feature request should reject
    // immediately with the initialization error — currently the request is sent
    // on an uninitialized connection and only rejects after the full timeout.
    it.fails("rejects feature requests after initialize failed", async () => {
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
    // BUG: close() should send the `shutdown` request and the `exit`
    // notification before dropping the transport — currently neither is sent
    // (lsp.ts:571-578 only tears down the JSON-RPC client), which violates the
    // LSP lifecycle and can leave the server process running.
    it.fails(
        "sends shutdown and exit before tearing down the transport",
        async () => {
            const transport = new FakeTransport();
            const client = makeClient({ transport });
            await client.initializePromise;

            client.close();
            await flushTicks();

            const shutdownIndex = indexOfMethod(transport, "shutdown");
            const exitIndex = indexOfMethod(transport, "exit");
            expect(shutdownIndex).toBeGreaterThanOrEqual(0);
            expect(exitIndex).toBeGreaterThan(shutdownIndex);
        },
    );

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
        expect(transportClose).toHaveBeenCalledTimes(1);
    });

    // BUG: close() should drop the per-URI open counts along with the other
    // per-connection state — currently documentOpenCounts survives teardown,
    // retaining every URI the client ever opened.
    it.fails("clears document open counts on close", async () => {
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

        // Forwarding an unmatched close is deliberate (lsp.ts:686-698: "direct
        // callers are not silently swallowed"); what must not happen is a stale
        // or negative entry that breaks the next open/close pair.
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

    // BUG: a registration without the spec-required `id` should be rejected —
    // currently dynamicCapabilities.set(undefined, ...) creates an entry that
    // client/unregisterCapability can never remove.
    it.fails("ignores a dynamic registration with no id", async () => {
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

    // BUG: a duplicate registration id should be refused (or kept alongside the
    // first) — currently the second registration overwrites the first by id, so
    // an already-registered capability silently disappears without any
    // client/unregisterCapability.
    it.fails(
        "does not let a duplicate registration id silently overwrite another",
        async () => {
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
                    registrations: [
                        { id: "reg-1", method: "textDocument/hover" },
                    ],
                },
            });
            await flushTicks();

            expect(client.hasCapability("textDocument/formatting")).toBe(true);
        },
    );
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

    // BUG: a malformed `registrations` member should be ignored and answered
    // with a plain null result — currently a string is iterated character by
    // character (registering four un-removable undefined-keyed entries) and a
    // non-iterable object throws, turning into an InternalError reply.
    it.fails(
        "answers client/registerCapability when registrations is not an array",
        async () => {
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
            // The string is iterated character by character today
            expect(client.dynamicCapabilities.size).toBe(0);
        },
    );

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

    // BUG: server-supplied message text should be truncated and stripped of
    // control characters before reaching the console — currently lsp.ts:397-407
    // passes it straight into console.info, so a hostile or buggy server can
    // flood the log and inject terminal escape sequences.
    it.fails(
        "does not log an unbounded or control-character message from showMessageRequest",
        async () => {
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
        },
    );
});

describe("notification listeners", () => {
    // BUG: processNotification should also absorb a listener's asynchronous
    // failure — currently its try/catch (lsp.ts:797-806) is synchronous only,
    // so the rejected promise a listener returns is never handled.
    it.fails(
        "does not produce an unhandled rejection when a listener rejects asynchronously",
        async () => {
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown) => unhandled.push(reason);
            process.on("unhandledRejection", onUnhandled);

            try {
                const client = makeClient({ transport: new FakeTransport() });
                // An async listener whose promise rejects: the returned promise
                // is dropped on the floor by processNotification.
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

                // The other listener still runs...
                expect(other).toHaveBeenCalledWith(notification);
                // ...and the failure is absorbed rather than escaping.
                expect(unhandled).toEqual([]);
            } finally {
                process.off("unhandledRejection", onUnhandled);
            }
        },
    );

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
    /**
     * The facet is usable only if it yields a real value; the throwing proxy
     * surfaces on property access. Accepts either an eager throw from combine
     * or the lazy proxy.
     */
    function expectUnusable<T>(
        combine: (values: readonly T[]) => T,
        values: readonly T[],
        message: RegExp,
    ) {
        let combined: T;
        try {
            combined = combine(values);
        } catch (error) {
            // Rejecting eagerly is an equally correct fix.
            expect(String(error)).toMatch(message);
            return;
        }
        expect(
            () => (combined as unknown as { anyProperty: unknown }).anyProperty,
        ).toThrow(message);
    }

    // BUG: an empty document URI should be rejected like a missing one —
    // `values[0] ?? fallback` (config.ts:16) is nullish coalescing, so "" passes
    // the guard and becomes the document identity, after which every URI
    // comparison in plugin.ts matches on "".
    it.fails("should throw when the document URI is an empty string", () => {
        expectUnusable(documentUri.combine, [""], /document URI/i);
    });

    // BUG: an empty language ID should be rejected like a missing one — same
    // nullish-coalescing hole in config.ts:16.
    it.fails("should throw when the language ID is an empty string", () => {
        expectUnusable(languageId.combine, [""], /language ID/i);
    });

    // BUG: the document URI must be an absolute URI (LSP DocumentUri) — a bare
    // relative path is accepted today and then never matches the URIs the
    // server reports diagnostics for.
    it.fails("should reject a document URI that is not an absolute URI", () => {
        expectUnusable(documentUri.combine, ["relative/path.ts"], /URI/i);
    });

    // BUG: an empty rootUri should be rejected — LanguageServerClient forwards
    // it verbatim into the initialize params, where "" is not a valid URI
    // (the spec's "no root" value is null).
    it.fails("should reject an empty rootUri", async () => {
        const transport = new FakeTransport();
        try {
            makeClient({ transport, rootUri: "" });
        } catch {
            // Rejecting eagerly in the constructor is the preferred fix.
            return;
        }
        await flushTicks();

        const [initialize] = sentRequests(transport, "initialize");
        expect((initialize.params as { rootUri: unknown }).rootUri).not.toBe(
            "",
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
            "No document URI provided. Either pass a one into the extension or use documentUri.of().",
        );
        expect(() => languageId.combine([]).anyProperty).toThrow(
            "No language ID provided. Either pass a one into the extension or use languageId.of().",
        );
    });
});
