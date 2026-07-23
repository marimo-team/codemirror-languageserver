import { getNotifications } from "@open-rpc/client-js/build/Request";
import type {
    IJSONRPCData,
    JSONRPCRequestData,
} from "@open-rpc/client-js/build/Request";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../../src";

/**
 * An `@open-rpc/client-js` transport that speaks JSON-RPC to a Web Worker via
 * `postMessage`. It mirrors the built-in `PostMessageWindowTransport`: every
 * inbound message is fed to the request manager (which matches responses by id
 * and dispatches notifications), and outbound requests are posted verbatim.
 *
 * Notifications (`initialized`, `textDocument/didOpen`, `textDocument/didChange`)
 * have no id, so `settlePendingRequest` resolves their `sendData` promise
 * immediately — the client never waits on the worker for a fire-and-forget call.
 */
export class WorkerTransport extends Transport {
    private worker: Worker;

    private messageHandler = (event: MessageEvent) => {
        this.transportRequestManager.resolveResponse(
            JSON.stringify(event.data),
        );
    };

    constructor(worker: Worker) {
        super();
        this.worker = worker;
    }

    connect(): Promise<void> {
        this.worker.addEventListener("message", this.messageHandler);
        return Promise.resolve();
    }

    close(): void {
        this.worker.removeEventListener("message", this.messageHandler);
        this.worker.terminate();
    }

    async sendData(
        data: JSONRPCRequestData,
        timeout: number | null = null,
    ): Promise<unknown> {
        const promise = this.transportRequestManager.addRequest(data, timeout);
        const notifications = getNotifications(data);
        this.worker.postMessage((data as IJSONRPCData).request);
        this.transportRequestManager.settlePendingRequest(notifications);
        return promise;
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
