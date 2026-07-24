import type * as LSP from "vscode-languageserver-protocol";
import {
    type JSONRPCMessage,
    LanguageServerClient,
    type Transport,
} from "../../src";

/**
 * A {@link Transport} that speaks JSON-RPC to a Web Worker via `postMessage`.
 * Structured clone carries the message objects verbatim, so — unlike a socket
 * transport — there is no serialization step: outbound frames are posted as-is
 * and inbound `MessageEvent` data is handed to the client directly.
 */
export class WorkerTransport implements Transport {
    private readonly worker: Worker;
    private readonly handlers = new Set<(message: JSONRPCMessage) => void>();

    private readonly onWorkerMessage = (event: MessageEvent) => {
        for (const handler of this.handlers) {
            handler(event.data as JSONRPCMessage);
        }
    };

    constructor(worker: Worker) {
        this.worker = worker;
    }

    connect(): Promise<void> {
        this.worker.addEventListener("message", this.onWorkerMessage);
        return Promise.resolve();
    }

    send(message: JSONRPCMessage): void {
        this.worker.postMessage(message);
    }

    onMessage(handler: (message: JSONRPCMessage) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    close(): void {
        this.worker.removeEventListener("message", this.onWorkerMessage);
        this.handlers.clear();
        this.worker.terminate();
    }
}

/**
 * Convenience factory: wraps a worker in a {@link WorkerTransport} and returns a
 * configured {@link LanguageServerClient} ready to hand to
 * `languageServerWithClient`.
 */
export function createWorkerClient(
    worker: Worker,
    options?: {
        rootUri?: string;
        workspaceFolders?: LSP.WorkspaceFolder[] | null;
    },
): LanguageServerClient {
    return new LanguageServerClient({
        rootUri: options?.rootUri ?? "file:///",
        workspaceFolders: options?.workspaceFolders ?? null,
        transport: new WorkerTransport(worker),
    });
}
