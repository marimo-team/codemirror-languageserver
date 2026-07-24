/**
 * A minimal, transport-agnostic JSON-RPC 2.0 client for the Language Server
 * Protocol. LSP is bidirectional — the server can send requests back to the
 * client (e.g. `workspace/configuration`) — so client requests, notifications,
 * and server-initiated requests are all first-class. A {@link Transport} owns
 * the wire format and hands the client parsed message objects.
 */

/** A JSON-RPC request/response correlation id. */
export type RequestId = number | string;

/** A client→server or server→client request. */
export interface JSONRPCRequest {
    jsonrpc: "2.0";
    id: RequestId;
    method: string;
    params?: unknown;
}

/** A fire-and-forget message with no response. */
export interface JSONRPCNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

/** The `error` member of a JSON-RPC error response. */
export interface JSONRPCErrorObject {
    code: number;
    message: string;
    data?: unknown;
}

export interface JSONRPCSuccessResponse {
    jsonrpc: "2.0";
    id: RequestId;
    result: unknown;
}

export interface JSONRPCErrorResponse {
    jsonrpc: "2.0";
    id: RequestId;
    error: JSONRPCErrorObject;
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;

/** Any frame that can travel over a {@link Transport}. */
export type JSONRPCMessage =
    | JSONRPCRequest
    | JSONRPCNotification
    | JSONRPCResponse;

/**
 * Standard JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification),
 * plus one non-standard code this client raises for client-side timeouts.
 */
export const ErrorCodes = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    /** Non-standard: a request exceeded its client-side timeout. */
    RequestTimeout: -32001,
} as const;

/** An error carrying a JSON-RPC error code and optional structured data. */
export class RPCError extends Error {
    readonly code: number;
    readonly data?: unknown;

    constructor(code: number, message: string, data?: unknown) {
        super(message);
        this.name = "RPCError";
        this.code = code;
        this.data = data;
    }
}

/**
 * A bidirectional channel that carries JSON-RPC frames between the client and
 * the server. Implementations own their wire format and lifecycle; the client
 * only ever sees parsed message objects.
 */
export interface Transport {
    /** Open the connection; the client awaits this once before its first send. */
    connect(): Promise<void>;
    /** Send a single JSON-RPC frame to the server. */
    send(message: JSONRPCMessage): void;
    /** Subscribe to inbound frames; the returned function unsubscribes. */
    onMessage(handler: (message: JSONRPCMessage) => void): () => void;
    /** Tear down the connection and release resources. */
    close(): void;
}

const DEFAULT_TIMEOUT = 10000;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}

function hasId(
    message: JSONRPCMessage,
): message is JSONRPCRequest | JSONRPCResponse {
    const id = (message as { id?: unknown }).id;
    return id !== undefined && id !== null;
}

function toError(value: unknown): Error {
    return value instanceof Error
        ? value
        : new RPCError(ErrorCodes.InternalError, String(value));
}

/**
 * A JSON-RPC 2.0 client over a {@link Transport}. Correlates responses to
 * requests by id, dispatches inbound notifications and server-initiated
 * requests to registered handlers, and enforces per-request timeouts.
 */
export class JSONRPCClient {
    private readonly transport: Transport;
    private readonly pending = new Map<RequestId, PendingRequest>();
    private readonly disconnect: () => void;
    private readonly connected: Promise<void>;
    private nextId = 0;
    private closed = false;
    private notificationHandler?: (notification: JSONRPCNotification) => void;
    private requestHandler?: (request: JSONRPCRequest) => void;

    constructor(transport: Transport) {
        this.transport = transport;
        this.disconnect = transport.onMessage((message) =>
            this.receive(message),
        );
        this.connected = transport.connect();
        // A connection failure surfaces on the first request/notification;
        // swallow it here so it is never an unhandled rejection on its own.
        this.connected.catch(() => {});
    }

    /** Register the handler invoked for each inbound notification. */
    onNotification(handler: (notification: JSONRPCNotification) => void): void {
        this.notificationHandler = handler;
    }

    /** Register the handler invoked for each server→client request. */
    onRequest(handler: (request: JSONRPCRequest) => void): void {
        this.requestHandler = handler;
    }

    /**
     * Send a request and resolve with its result. Rejects with an
     * {@link RPCError} if the server returns an error, the request times out,
     * or the client is closed while it is in flight.
     */
    request(
        method: string,
        params: unknown,
        timeout: number = DEFAULT_TIMEOUT,
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(
                new RPCError(ErrorCodes.InternalError, "Client closed"),
            );
        }
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new RPCError(
                        ErrorCodes.RequestTimeout,
                        `Request "${method}" timed out after ${timeout}ms`,
                    ),
                );
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.connected.then(
                () => {
                    // The request may have timed out or been closed while
                    // connecting; only send if it is still pending.
                    if (!this.pending.has(id)) {
                        return;
                    }
                    try {
                        this.transport.send({
                            jsonrpc: "2.0",
                            id,
                            method,
                            params,
                        });
                    } catch (error) {
                        this.settle(id, (p) => p.reject(toError(error)));
                    }
                },
                (error) => this.settle(id, (p) => p.reject(toError(error))),
            );
        });
    }

    /** Send a fire-and-forget notification. */
    notify(method: string, params: unknown): Promise<void> {
        return this.dispatch({ jsonrpc: "2.0", method, params });
    }

    /** Send a response to a server-initiated request. */
    respond(response: JSONRPCResponse): Promise<void> {
        return this.dispatch(response);
    }

    /** Reject all in-flight requests and tear down the transport. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(
                new RPCError(ErrorCodes.InternalError, "Client closed"),
            );
        }
        this.pending.clear();
        this.disconnect();
        this.transport.close();
    }

    /** Send once the transport is connected; a no-op if closed meanwhile. */
    private dispatch(message: JSONRPCMessage): Promise<void> {
        if (this.closed) {
            return Promise.resolve();
        }
        return this.connected.then(() => {
            // close() may have torn down the transport while connecting.
            if (!this.closed) {
                this.transport.send(message);
            }
        });
    }

    private settle(id: RequestId, handle: (pending: PendingRequest) => void) {
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        handle(pending);
    }

    private receive(message: JSONRPCMessage): void {
        if (this.closed || message == null || typeof message !== "object") {
            return;
        }
        // A frame with a method is a request (has an id) or a notification (no
        // id); anything else correlates to a pending request by id.
        if (typeof (message as { method?: unknown }).method === "string") {
            if (hasId(message)) {
                this.requestHandler?.(message as JSONRPCRequest);
            } else {
                this.notificationHandler?.(message as JSONRPCNotification);
            }
            return;
        }
        if (!hasId(message)) {
            return;
        }
        const response = message as JSONRPCResponse;
        this.settle(response.id, (pending) => {
            if ("error" in response && response.error) {
                pending.reject(
                    new RPCError(
                        response.error.code,
                        response.error.message,
                        response.error.data,
                    ),
                );
            } else {
                pending.resolve((response as JSONRPCSuccessResponse).result);
            }
        });
    }
}
