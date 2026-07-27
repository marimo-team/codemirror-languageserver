import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ErrorCodes,
    JSONRPCClient,
    type JSONRPCMessage,
    type Transport,
} from "../jsonrpc.js";

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

    constructor(private readonly autoConnect = true) {
        this.connectPromise.catch(() => {});
    }

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
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const frame = (value: unknown) => value as JSONRPCMessage;

const pendingMap = (client: JSONRPCClient) =>
    (client as unknown as { pending: Map<unknown, unknown> }).pending;

function track<T>(promise: Promise<T>) {
    const state: { settled: boolean; value?: T; error?: unknown } = {
        settled: false,
    };
    promise.then(
        (value) => {
            state.settled = true;
            state.value = value;
        },
        (error) => {
            state.settled = true;
            state.error = error;
        },
    );
    return state;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("malformed responses", () => {
    it("prefers the error member when a response carries both result and error", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", {}, 1000);
        await tick();
        transport.receive(
            frame({
                jsonrpc: "2.0",
                id: 0,
                result: { looks: "fine" },
                error: { code: -32603, message: "actually broken" },
            }),
        );

        // A frame carrying both members is illegal; failing loud beats
        // silently handing the caller a result the server also flagged.
        await expect(pending).rejects.toMatchObject({
            name: "RPCError",
            code: -32603,
            message: "actually broken",
        });
    });

    it("rejects with a usable RPCError when the server's error member is not an object", async () => {
        for (const badError of ["boom", 42, true]) {
            const transport = new ControlledTransport();
            const client = new JSONRPCClient(transport);
            const pending = client.request("m", {}, 1000);
            pending.catch(() => {});
            await tick();
            transport.receive(
                frame({ jsonrpc: "2.0", id: 0, error: badError }),
            );

            const error = await pending.then(
                () => undefined,
                (reason: unknown) => reason as Error & { code?: unknown },
            );
            expect(error, `error member: ${String(badError)}`).toBeDefined();
            expect(error?.message).not.toBe("");
            expect(typeof error?.code).toBe("number");
        }
    });

    it("rejects a response that has neither a result nor an error member", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("initialize", {}, 1000);
        pending.catch(() => {});
        await tick();
        transport.receive(frame({ jsonrpc: "2.0", id: 0 }));

        await expect(pending).rejects.toBeDefined();
    });

    it("correlates a response whose id was echoed as a string", async () => {
        vi.useFakeTimers();
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const outcome = track(client.request("m", {}, 1000));
        await vi.advanceTimersByTimeAsync(0);
        transport.receive(frame({ jsonrpc: "2.0", id: "0", result: "ok" }));
        await vi.advanceTimersByTimeAsync(1000);

        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toBe("ok");
    });

    it("ignores a duplicate response for an already-settled id", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("m", {}, 1000);
        await tick();
        transport.receive(frame({ jsonrpc: "2.0", id: 0, result: "first" }));
        expect(() =>
            transport.receive(
                frame({ jsonrpc: "2.0", id: 0, result: "second" }),
            ),
        ).not.toThrow();
        expect(() =>
            transport.receive(
                frame({
                    jsonrpc: "2.0",
                    id: 0,
                    error: { code: -1, message: "late" },
                }),
            ),
        ).not.toThrow();

        await expect(pending).resolves.toBe("first");
        expect(pendingMap(client).size).toBe(0);
    });

    it("ignores a late response for a request that already timed out", async () => {
        vi.useFakeTimers();
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const outcome = track(client.request("slow", {}, 1000));
        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome.error).toMatchObject({
            code: ErrorCodes.RequestTimeout,
        });

        // The server answers after the client gave up: inert, and above all
        // it must not re-settle the (already rejected) promise.
        expect(() =>
            transport.receive(frame({ jsonrpc: "2.0", id: 0, result: "late" })),
        ).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome.value).toBeUndefined();
    });
});

describe("frame validation", () => {
    it("ignores frames that do not declare jsonrpc 2.0", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        const onRequest = vi.fn();
        client.onNotification(onNotification);
        client.onRequest(onRequest);

        transport.receive(frame({ method: "window/logMessage", params: {} }));
        transport.receive(
            frame({ jsonrpc: "1.0", method: "window/logMessage", params: {} }),
        );
        transport.receive(
            frame({ jsonrpc: 2, id: 1, method: "workspace/configuration" }),
        );

        expect(onNotification).not.toHaveBeenCalled();
        expect(onRequest).not.toHaveBeenCalled();
    });

    it("ignores array (batch) and primitive frames without throwing", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        const onRequest = vi.fn();
        client.onNotification(onNotification);
        client.onRequest(onRequest);

        // `typeof [] === "object"`, so batches slip past the null/object guard.
        for (const value of [
            [],
            [{ jsonrpc: "2.0", method: "window/logMessage" }],
            "a string",
            42,
            true,
            undefined,
        ]) {
            expect(() => transport.receive(frame(value))).not.toThrow();
        }

        expect(onNotification).not.toHaveBeenCalled();
        expect(onRequest).not.toHaveBeenCalled();
    });

    it("routes a frame with an explicit null id to the notification handler", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        const onRequest = vi.fn();
        client.onNotification(onNotification);
        client.onRequest(onRequest);

        const message = {
            jsonrpc: "2.0" as const,
            id: null,
            method: "window/logMessage",
            params: { message: "hi" },
        };
        transport.receive(frame(message));

        // `id: null` is not a correlatable id, so this is a notification —
        // answering it as a request would send a response nobody asked for.
        expect(onNotification).toHaveBeenCalledWith(message);
        expect(onRequest).not.toHaveBeenCalled();
    });

    it("ignores a frame whose method member is not a string", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        const onRequest = vi.fn();
        client.onNotification(onNotification);
        client.onRequest(onRequest);

        expect(() =>
            transport.receive(frame({ jsonrpc: "2.0", id: 7, method: 123 })),
        ).not.toThrow();
        expect(() =>
            transport.receive(
                frame({ jsonrpc: "2.0", method: { name: "hover" } }),
            ),
        ).not.toThrow();

        expect(onNotification).not.toHaveBeenCalled();
        expect(onRequest).not.toHaveBeenCalled();
    });
});

describe("pending-request lifetime", () => {
    it("clears the pending map after a timeout, a send failure, and a connect failure", async () => {
        vi.useFakeTimers();

        const timedOut = new ControlledTransport();
        const timeoutClient = new JSONRPCClient(timedOut);
        track(timeoutClient.request("slow", {}, 1000));
        await vi.advanceTimersByTimeAsync(1000);
        expect(pendingMap(timeoutClient).size, "after timeout").toBe(0);

        const failingSend = new ControlledTransport();
        failingSend.throwOnSend = true;
        const sendClient = new JSONRPCClient(failingSend);
        track(sendClient.request("m", {}, 1000));
        await vi.advanceTimersByTimeAsync(0);
        expect(pendingMap(sendClient).size, "after send failure").toBe(0);

        const failingConnect = new ControlledTransport(false);
        const connectClient = new JSONRPCClient(failingConnect);
        track(connectClient.request("m", {}, 1000));
        failingConnect.failConnection(new Error("no route"));
        await vi.advanceTimersByTimeAsync(0);
        expect(pendingMap(connectClient).size, "after connect failure").toBe(0);
    });
});

describe("fire-and-forget sends", () => {
    it("does not produce an unhandled rejection when a notification is sent over a failed connection", async () => {
        const seen: unknown[] = [];
        const capture = (reason: unknown) => {
            seen.push(reason);
        };
        // Take over the hook so the runner's own reporter doesn't also
        // claim the rejection; everything is restored below.
        const previous = process.listeners("unhandledRejection");
        process.removeAllListeners("unhandledRejection");
        process.on("unhandledRejection", capture);

        try {
            const transport = new ControlledTransport(false);
            const client = new JSONRPCClient(transport);

            // Deliberately fire-and-forget, exactly like the call sites.
            client.notify("textDocument/didChange", { uri: "file:///x" });
            transport.failConnection(new Error("no route"));

            await tick();
            await tick();
        } finally {
            process.off("unhandledRejection", capture);
            for (const listener of previous) {
                process.on(
                    "unhandledRejection",
                    listener as (reason: unknown) => void,
                );
            }
        }

        expect(seen).toEqual([]);
    });

    it("surfaces a send failure from notify without leaving the client unusable", async () => {
        const transport = new ControlledTransport();
        transport.throwOnSend = true;
        const client = new JSONRPCClient(transport);

        await expect(client.notify("a/b", { x: 1 })).rejects.toThrow(
            "send failed",
        );

        // The failure is per-send, not terminal: the next frame still goes out.
        transport.throwOnSend = false;
        await client.notify("c/d", { y: 2 });
        expect(transport.sent).toEqual([
            { jsonrpc: "2.0", method: "c/d", params: { y: 2 } },
        ]);
    });
});

describe("well-formed traffic (regression guards)", () => {
    it("resolves a request from a well-formed success response", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("textDocument/hover", { a: 1 }, 1000);
        await tick();
        expect(transport.sent).toEqual([
            {
                jsonrpc: "2.0",
                id: 0,
                method: "textDocument/hover",
                params: { a: 1 },
            },
        ]);

        transport.receive({
            jsonrpc: "2.0",
            id: 0,
            result: { contents: "docs" },
        });
        await expect(pending).resolves.toEqual({ contents: "docs" });
        expect(pendingMap(client).size).toBe(0);
    });

    it("rejects a request from a well-formed error response", async () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);

        const pending = client.request("unknown/method", {}, 1000);
        await tick();
        transport.receive({
            jsonrpc: "2.0",
            id: 0,
            error: {
                code: ErrorCodes.MethodNotFound,
                message: "Method not found",
                data: { method: "unknown/method" },
            },
        });

        await expect(pending).rejects.toMatchObject({
            name: "RPCError",
            code: ErrorCodes.MethodNotFound,
            message: "Method not found",
            data: { method: "unknown/method" },
        });
    });

    it("delivers a well-formed notification to the notification handler", () => {
        const transport = new ControlledTransport();
        const client = new JSONRPCClient(transport);
        const onNotification = vi.fn();
        const onRequest = vi.fn();
        client.onNotification(onNotification);
        client.onRequest(onRequest);

        const message = {
            jsonrpc: "2.0" as const,
            method: "textDocument/publishDiagnostics",
            params: { uri: "file:///x", diagnostics: [] },
        };
        transport.receive(message);

        expect(onNotification).toHaveBeenCalledWith(message);
        expect(onRequest).not.toHaveBeenCalled();
    });
});
