import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    JSONRPCClient,
    type JSONRPCMessage,
    type Transport,
} from "../jsonrpc.js";
import { LanguageServerClient } from "../lsp.js";
import { FakeTransport } from "../testing/fakeTransport.js";

describe("LSP request cancellation", () => {
    let client: JSONRPCClient;
    let emit: (message: JSONRPCMessage) => void;
    let disconnect: (error: Error) => void;
    let connected: ReturnType<typeof Promise.withResolvers<undefined>>;
    let transport: Transport & {
        send: ReturnType<typeof vi.fn<(message: JSONRPCMessage) => void>>;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        connected = Promise.withResolvers<undefined>();
        transport = {
            connect: () => connected.promise,
            close: vi.fn(),
            send: vi.fn<(message: JSONRPCMessage) => void>(),
            onMessage: (handler) => {
                emit = handler;
                return vi.fn();
            },
            onClose: (handler) => {
                disconnect = handler;
                return vi.fn();
            },
        };
        client = new JSONRPCClient(transport);
    });

    afterEach(() => {
        client.close();
        vi.useRealTimers();
    });

    async function connect() {
        connected.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
    }

    it("does not send an already-aborted request", async () => {
        await connect();
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.request("complete", {}, 1000, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(transport.send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels while connecting without sending either request or cancellation", async () => {
        const controller = new AbortController();
        const response = client.request(
            "complete",
            {},
            1000,
            controller.signal,
        );
        controller.abort();
        await expect(response).rejects.toMatchObject({ name: "AbortError" });
        await connect();
        expect(transport.send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels exactly the matching request, ignores late replies, and leaves others active", async () => {
        await connect();
        const controller = new AbortController();
        const first = client.request(
            "complete",
            { position: 1 },
            1000,
            controller.signal,
        );
        const second = client.request("complete", { position: 2 }, 1000);
        controller.abort();
        controller.abort();
        await expect(first).rejects.toMatchObject({ name: "AbortError" });
        emit({ jsonrpc: "2.0", id: 0, result: "stale" });
        emit({ jsonrpc: "2.0", id: 1, result: "latest" });
        await expect(second).resolves.toBe("latest");
        expect(transport.send.mock.calls).toEqual([
            [
                {
                    jsonrpc: "2.0",
                    id: 0,
                    method: "complete",
                    params: { position: 1 },
                },
            ],
            [
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "complete",
                    params: { position: 2 },
                },
            ],
            [{ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 0 } }],
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        "success",
        "error",
        "timeout",
        "disconnect",
        "close",
        "send failure",
    ])("removes the abort listener and timer after %s", async (outcome) => {
        await connect();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        if (outcome === "send failure") {
            transport.send.mockImplementationOnce(() => {
                throw new Error("send failed");
            });
        }
        const response = client.request(
            "complete",
            {},
            1000,
            controller.signal,
        );
        // Attach the rejection handler before advancing timers or dropping the connection.
        const settled = response.then(
            (value) => ({ status: "fulfilled", value }),
            (error: unknown) => ({ status: "rejected", error }),
        );
        if (outcome === "success") {
            emit({ jsonrpc: "2.0", id: 0, result: "ok" });
        }
        if (outcome === "error") {
            emit({
                jsonrpc: "2.0",
                id: 0,
                error: { code: -32603, message: "failed" },
            });
        }
        if (outcome === "timeout") {
            await vi.advanceTimersByTimeAsync(999);
            expect(transport.send).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(transport.send.mock.calls).toEqual([
                [{ jsonrpc: "2.0", id: 0, method: "complete", params: {} }],
                [
                    {
                        jsonrpc: "2.0",
                        method: "$/cancelRequest",
                        params: { id: 0 },
                    },
                ],
            ]);
            // A late response must not resurrect a timed-out request.
            emit({ jsonrpc: "2.0", id: 0, result: "late" });
        }
        if (outcome === "disconnect") {
            disconnect(new Error("disconnected"));
        }
        if (outcome === "close") {
            client.close();
        }
        const expectedError = expect.any(Error);
        expect(await settled).toEqual(
            outcome === "success"
                ? { status: "fulfilled", value: "ok" }
                : { status: "rejected", error: expectedError },
        );
        expect(remove).toHaveBeenCalledExactlyOnceWith(
            "abort",
            expect.any(Function),
        );
        expect(vi.getTimerCount()).toBe(0);
        const calls = transport.send.mock.calls.length;
        controller.abort();
        expect(transport.send).toHaveBeenCalledTimes(calls);
    });

    it("settles cancellation even if sending the cancellation notification fails", async () => {
        await connect();
        const controller = new AbortController();
        const response = client.request(
            "complete",
            {},
            1000,
            controller.signal,
        );
        transport.send.mockImplementationOnce(() => {
            throw new Error("connection gone");
        });
        controller.abort();
        await expect(response).rejects.toMatchObject({ name: "AbortError" });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("LanguageServerClient cancellation", () => {
    class CancellableClient extends LanguageServerClient {
        hover(signal: AbortSignal) {
            return this.request(
                "textDocument/hover",
                {
                    textDocument: { uri: "file:///test.py" },
                    position: { line: 0, character: 0 },
                },
                1000,
                signal,
            );
        }
    }

    let client: CancellableClient;
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(async () => {
        client.close();
        await client.initializePromise.catch(() => {});
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    async function startHandshake() {
        const transport = new FakeTransport({ autoInitialize: false });
        client = new CancellableClient({
            transport,
            rootUri: "file:///",
            workspaceFolders: null,
        });
        await vi.advanceTimersByTimeAsync(0);
        const request = transport.sent.find(
            (message) => "method" in message && message.method === "initialize",
        );
        if (!(request && "id" in request))
            throw new Error("Expected initialize request");
        return { transport, id: request.id };
    }

    it("forwards cancellation through the initialized language server client", async () => {
        vi.useFakeTimers();
        const transport = new FakeTransport({
            capabilities: { hoverProvider: true },
        });
        client = new CancellableClient({
            transport,
            rootUri: "file:///",
            workspaceFolders: null,
        });
        await client.initializePromise;
        const controller = new AbortController();
        const response = client.hover(controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        const request = transport.sent.find(
            (message) =>
                "method" in message && message.method === "textDocument/hover",
        );
        expect(request).toMatchObject({
            method: "textDocument/hover",
            id: expect.any(Number),
        });
        if (!(request && "id" in request))
            throw new Error("Expected hover request");
        controller.abort();
        await expect(response).rejects.toMatchObject({ name: "AbortError" });
        expect(transport.notificationsSent("$/cancelRequest")).toEqual([
            {
                jsonrpc: "2.0",
                method: "$/cancelRequest",
                params: {
                    id: request.id,
                },
            },
        ]);
    });

    it.each(["already aborted", "abort during handshake"])(
        "rejects before initialization completes: %s",
        async (timing) => {
            const { transport, id } = await startHandshake();
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, "removeEventListener");
            if (timing === "already aborted") controller.abort();
            const rejected = vi.fn();
            const settled = client.hover(controller.signal).catch(rejected);
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);

            // Assert before answering initialize: a stuck handshake must not block abort.
            expect(rejected).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ name: "AbortError" }),
            );
            expect(client.ready).toBe(false);
            expect(transport.notificationsSent("$/cancelRequest")).toEqual([]);
            expect(remove).toHaveBeenCalledTimes(
                timing === "already aborted" ? 0 : 1,
            );

            // The shared handshake and unrelated requests remain usable.
            const otherController = new AbortController();
            const removeOther = vi.spyOn(
                otherController.signal,
                "removeEventListener",
            );
            const other = client.hover(otherController.signal);
            transport.receive({
                jsonrpc: "2.0",
                id,
                result: { capabilities: { hoverProvider: true } },
            });
            await client.initializePromise;
            await vi.advanceTimersByTimeAsync(0);
            const requests = transport.sent.filter(
                (message) =>
                    "method" in message &&
                    message.method === "textDocument/hover",
            );
            expect(requests).toHaveLength(1);
            expect(removeOther).toHaveBeenCalledExactlyOnceWith(
                "abort",
                expect.any(Function),
            );
            const request = requests[0];
            if (!(request && "id" in request))
                throw new Error("Expected hover request");
            transport.receive({ jsonrpc: "2.0", id: request.id, result: null });
            await expect(other).resolves.toBeNull();
            expect(removeOther).toHaveBeenCalledTimes(2);
            otherController.abort();
            await settled;
            expect(rejected).toHaveBeenCalledTimes(1);
            expect(transport.notificationsSent("$/cancelRequest")).toEqual([]);
        },
    );

    it.each(["error", "close", "abort then error"])(
        "cleans up a waiting request after handshake %s",
        async (outcome) => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const { transport, id } = await startHandshake();
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, "removeEventListener");
            const rejected = vi.fn();
            const settled = client.hover(controller.signal).catch(rejected);
            if (outcome === "abort then error") {
                controller.abort();
                await vi.advanceTimersByTimeAsync(0);
                expect(rejected).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({ name: "AbortError" }),
                );
            }
            if (outcome === "close") {
                client.close();
            } else {
                transport.receive({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32603, message: "handshake failed" },
                });
            }
            await settled;
            expect(rejected).toHaveBeenCalledTimes(1);
            expect(rejected).toHaveBeenCalledWith(
                expect.objectContaining(
                    outcome === "abort then error"
                        ? { name: "AbortError" }
                        : {
                              message:
                                  outcome === "error"
                                      ? "handshake failed"
                                      : "Client closed",
                          },
                ),
            );
            expect(remove).toHaveBeenCalledExactlyOnceWith(
                "abort",
                expect.any(Function),
            );
            controller.abort();
            expect(transport.sent).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it("does not send a request aborted as initialization resolves", async () => {
        const { transport, id } = await startHandshake();
        const controller = new AbortController();
        const settled = client
            .hover(controller.signal)
            .catch((error: unknown) => error);
        transport.receive({
            jsonrpc: "2.0",
            id,
            result: { capabilities: { hoverProvider: true } },
        });
        controller.abort();
        await expect(settled).resolves.toMatchObject({ name: "AbortError" });
        await client.initializePromise;
        expect(
            transport.sent.filter((message) => "id" in message),
        ).toHaveLength(1);
        expect(transport.notificationsSent("$/cancelRequest")).toEqual([]);
    });
});
