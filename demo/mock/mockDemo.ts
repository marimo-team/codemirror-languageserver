import { javascript } from "@codemirror/lang-javascript";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import type {
    IJSONRPCData,
    IJSONRPCNotification,
    IJSONRPCResponse,
    JSONRPCRequestData,
} from "@open-rpc/client-js/build/Request";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import { basicSetup } from "codemirror";
import { LanguageServerClient, languageServerWithClient } from "../../src";
import { MockLSPServer } from "../mockLSP";

// Mock WebSocket-like bridge to the in-memory LSP server.
class MockWebSocket {
    private server: MockLSPServer;
    private onMessageCallback?: (data: IJSONRPCResponse) => void;
    private onNotificationCallback?: (data: IJSONRPCNotification) => void;
    private onErrorCallback?: (data: IJSONRPCNotification) => void;

    constructor(server: MockLSPServer) {
        this.server = server;
        this.server.setOnDiagnostics((params) => {
            if (this.onNotificationCallback) {
                this.onNotificationCallback({
                    jsonrpc: "2.0",
                    method: "textDocument/publishDiagnostics",
                    params,
                });
            }
        });
    }

    send(data: IJSONRPCData) {
        const request = data;
        const { method, id: _id, params } = request.request;
        // biome-ignore lint/suspicious/noExplicitAny: RPC params are dynamic.
        const anyParams = params as any;
        const id = _id ?? "_";

        if (method === "initialize") {
            return this.respond(id, this.server.initialize());
        }
        if (method === "textDocument/didOpen") {
            return this.server.didOpenTextDocument(anyParams);
        }
        if (method === "textDocument/didChange") {
            return this.server.didChangeTextDocument(anyParams);
        }
        if (method === "textDocument/completion") {
            return this.server
                .completion(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "completionItem/resolve") {
            return this.server
                .completionResolve(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/hover") {
            return this.server
                .hover(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/definition") {
            return this.server
                .definition(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/prepareRename") {
            return this.server
                .prepareRename(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/rename") {
            return this.server
                .rename(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/codeAction") {
            return this.server
                .codeAction(anyParams)
                .then((result) => this.respond(id, result));
        }
        if (method === "textDocument/signatureHelp") {
            return this.server
                .signatureHelp(anyParams)
                .then((result) => this.respond(id, result));
        }
    }

    addEventListener(
        event: string,
        callback: (data: IJSONRPCResponse | IJSONRPCNotification) => void,
    ) {
        if (event === "notification") {
            this.onNotificationCallback = callback;
        }
        if (event === "error") {
            this.onErrorCallback = callback;
        }
        if (event === "message") {
            this.onMessageCallback = callback;
        }
    }

    private respond(id: string | number, result: IJSONRPCResponse["result"]) {
        const body: IJSONRPCResponse = {
            jsonrpc: "2.0",
            id,
            result,
        };
        if (this.onMessageCallback) {
            this.onMessageCallback(body);
        }
        return body;
    }
}

class MockTransport extends Transport {
    private callbacks: Map<
        string,
        ((data: IJSONRPCResponse | IJSONRPCNotification) => void)[]
    > = new Map();

    constructor(private socket: MockWebSocket) {
        super();
    }

    connect() {
        return Promise.resolve();
    }

    send(data: IJSONRPCData) {
        return this.socket.send(data);
    }

    subscribe(
        event: string,
        callback: (data: IJSONRPCResponse | IJSONRPCNotification) => void,
    ) {
        const callbacks = this.callbacks.get(event) || [];
        callbacks.push(callback);
        this.callbacks.set(event, callbacks);
        this.socket.addEventListener(event, (data) => {
            for (const cb of callbacks) {
                cb(data);
            }
        });
    }

    async sendData(data: JSONRPCRequestData) {
        const body = await this.socket.send(data as IJSONRPCData);
        if (body) {
            return "result" in body ? body.result : undefined;
        }
        return body;
    }

    close() {
        this.callbacks.clear();
    }
}

const DOCUMENT_URI = "file:///example.ts";

const SAMPLE = `// CodeMirror LSP Demo (in-memory mock server)
// Try these features:
// 1. Hover over text
// 2. Press F2 to rename
// 3. Ctrl/Cmd+Click for definition
// 4. Type 'console.' for completion

function example() {
    console.log("Hello, World!");
}
`;

/**
 * Mounts the original demo: a hand-written in-memory mock LSP server with
 * buttons to push synthetic diagnostics. Unchanged in behavior from the
 * pre-tabs demo.
 */
export function mountMockDemo(container: HTMLElement): () => void {
    const mockServer = new MockLSPServer();
    const mockSocket = new MockWebSocket(mockServer);
    const mockTransport = new MockTransport(mockSocket);

    const controls = document.createElement("div");
    controls.className = "demo-controls";
    const addError = button("Add Error");
    const addWarning = button("Add Warning");
    const clear = button("Clear Diagnostics");
    controls.append(addError, addWarning, clear);
    container.appendChild(controls);

    const client = new LanguageServerClient({
        rootUri: "file:///",
        workspaceFolders: [],
        transport: mockTransport,
    });

    const view = new EditorView({
        state: EditorState.create({
            doc: SAMPLE,
            extensions: [
                basicSetup,
                javascript(),
                tooltips({ position: "absolute" }),
                lintGutter(),
                languageServerWithClient({
                    client,
                    allowHTMLContent: true,
                    documentUri: DOCUMENT_URI,
                    languageId: "typescript",
                    onGoToDefinition: (result) => {
                        console.debug("Go to definition", result);
                    },
                }),
            ],
        }),
        parent: container,
    });

    const currentLine = () =>
        view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    addError.addEventListener("click", () => {
        mockServer.addErrorDiagnostic(DOCUMENT_URI, currentLine());
    });
    addWarning.addEventListener("click", () => {
        mockServer.addWarningDiagnostic(DOCUMENT_URI, currentLine());
    });
    clear.addEventListener("click", () => {
        mockServer.clearDiagnostics(DOCUMENT_URI);
    });

    return () => {
        view.destroy();
        client.close();
    };
}

function button(label: string): HTMLButtonElement {
    const element = document.createElement("button");
    element.textContent = label;
    return element;
}
