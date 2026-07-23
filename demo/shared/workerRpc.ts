/// <reference lib="webworker" />
import type * as LSP from "vscode-languageserver-protocol";

/**
 * Minimal worker-side JSON-RPC dispatch loop, the counterpart to
 * {@link WorkerTransport}. Register `requests` (must return a result) and
 * `notifications` (fire-and-forget) keyed by LSP method name and call
 * {@link serve}. Handlers receive the raw params and cast to the LSP type.
 */
export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void | Promise<void>;

export interface ServeHandlers {
    requests?: Record<string, RequestHandler>;
    notifications?: Record<string, NotificationHandler>;
}

interface IncomingMessage {
    id?: string | number | null;
    method: string;
    params: unknown;
}

function post(message: unknown): void {
    (self as DedicatedWorkerGlobalScope).postMessage(message);
}

export function serve(handlers: ServeHandlers): void {
    self.onmessage = async (event: MessageEvent) => {
        const { id, method, params } = event.data as IncomingMessage;

        // No id => JSON-RPC notification (didOpen/didChange/initialized/...).
        if (id == null) {
            await handlers.notifications?.[method]?.(params);
            return;
        }

        try {
            const handler = handlers.requests?.[method];
            const result = handler ? await handler(params) : null;
            post({ jsonrpc: "2.0", id, result: result ?? null });
        } catch (error) {
            post({
                jsonrpc: "2.0",
                id,
                error: {
                    code: -32000,
                    message:
                        error instanceof Error ? error.message : String(error),
                    data: null,
                },
            });
        }
    };
}

/** Push a `textDocument/publishDiagnostics` notification to the main thread. */
export function publishDiagnostics(params: LSP.PublishDiagnosticsParams): void {
    post({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params,
    });
}
