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
import { languageServerWithTransport } from "../src";
import { MockLSPServer } from "./mockLSP";

// Create mock WebSocket transport
class MockWebSocket {
    private server: MockLSPServer;
    private onMessageCallback?: (data: IJSONRPCResponse) => void;
    private onNotificationCallback?: (data: IJSONRPCNotification) => void;
    private onErrorCallback?: (data: IJSONRPCNotification) => void;

    constructor(server: MockLSPServer) {
        this.server = server;
        // Set up diagnostic notifications
        this.server.setOnDiagnostics((params) => {
            console.log("diagnostic", params);
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
        const { method, id, params } = request.request;
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        const anyParams = params as any;

        // Handle LSP messages
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
        console.log("unhandled method", method);
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

// Create mock transport
const mockServer = new MockLSPServer();
const mockSocket = new MockWebSocket(mockServer);
class MockTransport extends Transport {
    private callbacks: Map<
        string,
        ((data: IJSONRPCResponse | IJSONRPCNotification) => void)[]
    > = new Map();

    connect() {
        return Promise.resolve();
    }

    send(data: IJSONRPCData) {
        return mockSocket.send(data);
    }

    subscribe(
        event: string,
        callback: (data: IJSONRPCResponse | IJSONRPCNotification) => void,
    ) {
        const callbacks = this.callbacks.get(event) || [];
        callbacks.push(callback);
        this.callbacks.set(event, callbacks);
        mockSocket.addEventListener(event, (data) => {
            if ("method" in data) {
                // This is a notification
                for (const cb of callbacks) {
                    cb(data);
                }
            } else {
                // This is a response
                for (const cb of callbacks) {
                    cb(data);
                }
            }
        });
    }

    async sendData(data: JSONRPCRequestData) {
        const body = await mockSocket.send(data as IJSONRPCData);
        if (body) {
            return "result" in body ? body.result : undefined;
        }
        return body;
    }

    close() {
        this.callbacks.clear();
    }
}

const mockTransport = new MockTransport();

// Set up the editor
const doc = `// CodeMirror LSP Demo
// Try these features:
// 1. Hover over text
// 2. Press F2 to rename
// 3. Ctrl/Cmd+Click for definition
// 4. Type 'console.' for completion

function example() {
    console.log("Hello, World!");
}
`;

const state = EditorState.create({
    doc,
    extensions: [
        basicSetup,
        javascript(),
        tooltips({
            position: "absolute",
        }),
        lintGutter(),
        languageServerWithTransport({
            rootUri: "file:///",
            workspaceFolders: [],
            allowHTMLContent: true,
            documentUri: "file:///example.ts",
            languageId: "typescript",
            transport: mockTransport,
        }),
    ],
});

const view = new EditorView({
    state,
    parent: document.querySelector("#editor"),
});

// Set up diagnostic buttons
document.querySelector("#addError")?.addEventListener("click", () => {
    const line =
        view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    mockServer.addErrorDiagnostic("file:///example.ts", line);
});

document.querySelector("#addWarning")?.addEventListener("click", () => {
    const line =
        view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    mockServer.addWarningDiagnostic("file:///example.ts", line);
});

document.querySelector("#clearDiagnostics")?.addEventListener("click", () => {
    mockServer.clearDiagnostics("file:///example.ts");
});
