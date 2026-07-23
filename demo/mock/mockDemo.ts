import { javascript } from "@codemirror/lang-javascript";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
    type JSONRPCMessage,
    LanguageServerClient,
    type Transport,
    languageServerWithClient,
} from "../../src";
import { MockLSPServer } from "../mockLSP";

/**
 * A {@link Transport} that routes JSON-RPC frames to an in-memory
 * {@link MockLSPServer} and delivers its results (and diagnostics) back to the
 * client. Requests are dispatched by method; notifications with no matching
 * handler are simply ignored.
 */
class MockTransport implements Transport {
    private readonly handlers = new Set<(message: JSONRPCMessage) => void>();

    constructor(private readonly server: MockLSPServer) {
        server.setOnDiagnostics((params) => {
            this.emit({
                jsonrpc: "2.0",
                method: "textDocument/publishDiagnostics",
                params,
            });
        });
    }

    connect(): Promise<void> {
        return Promise.resolve();
    }

    send(message: JSONRPCMessage): void {
        void this.dispatch(message);
    }

    onMessage(handler: (message: JSONRPCMessage) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    close(): void {
        this.handlers.clear();
    }

    private emit(message: JSONRPCMessage): void {
        for (const handler of this.handlers) {
            handler(message);
        }
    }

    private async dispatch(message: JSONRPCMessage): Promise<void> {
        if (!("method" in message)) {
            return; // responses from the client (server requests) are ignored
        }
        const server = this.server;
        // biome-ignore lint/suspicious/noExplicitAny: RPC params are dynamic.
        const params = (message as any).params;
        const id = "id" in message ? message.id : undefined;
        const reply = (result: unknown) => {
            if (id !== undefined) {
                this.emit({ jsonrpc: "2.0", id, result });
            }
        };

        switch (message.method) {
            case "initialize":
                return reply(server.initialize());
            case "textDocument/didOpen":
                return void server.didOpenTextDocument(params);
            case "textDocument/didChange":
                return void server.didChangeTextDocument(params);
            case "textDocument/completion":
                return reply(await server.completion(params));
            case "completionItem/resolve":
                return reply(await server.completionResolve(params));
            case "textDocument/hover":
                return reply(await server.hover(params));
            case "textDocument/definition":
                return reply(await server.definition(params));
            case "textDocument/prepareRename":
                return reply(await server.prepareRename(params));
            case "textDocument/rename":
                return reply(await server.rename(params));
            case "textDocument/codeAction":
                return reply(await server.codeAction(params));
            case "textDocument/signatureHelp":
                return reply(await server.signatureHelp(params));
        }
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
    const mockTransport = new MockTransport(mockServer);

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
