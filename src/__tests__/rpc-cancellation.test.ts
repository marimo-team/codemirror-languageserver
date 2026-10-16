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
            await vi.advanceTimersByTimeAsync(1000);
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
    afterEach(() => {
        client.close();
        vi.useRealTimers();
    });

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

    it("does not send a queued request aborted during initialization", async () => {
        vi.useFakeTimers();
        const transport = new FakeTransport({ autoInitialize: false });
        client = new CancellableClient({
            transport,
            rootUri: "file:///",
            workspaceFolders: null,
        });
        const controller = new AbortController();
        const response = client.hover(controller.signal);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        const request = transport.sent.find(
            (message) => "method" in message && message.method === "initialize",
        );
        if (!(request && "id" in request))
            throw new Error("Expected initialize request");
        transport.receive({
            jsonrpc: "2.0",
            id: request.id,
            result: { capabilities: { hoverProvider: true } },
        });
        await expect(response).rejects.toMatchObject({ name: "AbortError" });
        expect(
            transport.sent.filter(
                (message) =>
                    "method" in message &&
                    message.method === "textDocument/hover",
            ),
        ).toEqual([]);
        expect(transport.notificationsSent("$/cancelRequest")).toEqual([]);
    });
});
