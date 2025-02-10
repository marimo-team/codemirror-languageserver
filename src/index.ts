import { autocompletion, insertCompletionText } from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { Facet } from "@codemirror/state";
import {
    EditorView,
    type Tooltip,
    ViewPlugin,
    hoverTooltip,
} from "@codemirror/view";
import {
    Client,
    RequestManager,
    WebSocketTransport,
} from "@open-rpc/client-js";
import {
    CompletionItemKind,
    CompletionTriggerKind,
    DiagnosticSeverity,
} from "vscode-languageserver-protocol";

import type {
    Completion,
    CompletionContext,
    CompletionResult,
} from "@codemirror/autocomplete";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Transport } from "@open-rpc/client-js/build/transports/Transport";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import type * as LSP from "vscode-languageserver-protocol";
import {
    formatContents,
    isLSPTextEdit,
    offsetToPos,
    posToOffset,
    prefixMatch,
    showErrorMessage,
} from "./utils";

const timeout = 10000;
const changesDelay = 500;

const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

const useLast = <T>(values: T[]) => values.at(-1);

const client = Facet.define<LanguageServerClient, LanguageServerClient>({
    combine: useLast,
});
const documentUri = Facet.define<string, string>({ combine: useLast });
const languageId = Facet.define<string, string>({ combine: useLast });

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Client to server then server to client
interface LSPRequestMap {
    initialize: [LSP.InitializeParams, LSP.InitializeResult];
    "textDocument/hover": [LSP.HoverParams, LSP.Hover];
    "textDocument/completion": [
        LSP.CompletionParams,
        LSP.CompletionItem[] | LSP.CompletionList | null,
    ];
    "textDocument/definition": [
        LSP.DefinitionParams,
        LSP.Definition | LSP.DefinitionLink[] | null,
    ];
    "textDocument/codeAction": [
        LSP.CodeActionParams,
        (LSP.Command | LSP.CodeAction)[] | null,
    ];
    "textDocument/rename": [LSP.RenameParams, LSP.WorkspaceEdit | null];
    "textDocument/prepareRename": [
        LSP.PrepareRenameParams,
        LSP.Range | LSP.PrepareRenameResult | null,
    ];
}

// Client to server
interface LSPNotifyMap {
    initialized: LSP.InitializedParams;
    "textDocument/didChange": LSP.DidChangeTextDocumentParams;
    "textDocument/didOpen": LSP.DidOpenTextDocumentParams;
}

// Server to client
interface LSPEventMap {
    "textDocument/publishDiagnostics": LSP.PublishDiagnosticsParams;
}

type Notification = {
    [key in keyof LSPEventMap]: {
        jsonrpc: "2.0";
        id?: null | undefined;
        method: key;
        params: LSPEventMap[key];
    };
}[keyof LSPEventMap];

export class LanguageServerClient {
    public ready: boolean;
    public capabilities: LSP.ServerCapabilities | null;

    public initializePromise: Promise<void>;
    private rootUri: string;
    private workspaceFolders: LSP.WorkspaceFolder[];
    private autoClose?: boolean;

    private transport: Transport;
    private requestManager: RequestManager;
    private client: Client;
    private initializationOptions: LanguageServerClientOptions["initializationOptions"];
    private clientCapabilities: LanguageServerClientOptions["capabilities"];

    private plugins: LanguageServerPlugin[];

    constructor(options: LanguageServerClientOptions) {
        this.ready = false;
        this.capabilities = null;
        this.rootUri = options.rootUri;
        this.workspaceFolders = options.workspaceFolders;
        this.autoClose = options.autoClose;
        this.plugins = [];
        this.transport = options.transport;
        this.initializationOptions = options.initializationOptions;
        this.clientCapabilities = options.capabilities;
        this.requestManager = new RequestManager([this.transport]);
        this.client = new Client(this.requestManager);

        this.client.onNotification((data: Notification) => {
            this.processNotification(data);
        });

        const webSocketTransport = this.transport as WebSocketTransport;
        if (webSocketTransport?.connection) {
            // XXX(hjr265): Need a better way to do this. Relevant issue:
            // https://github.com/FurqanSoftware/codemirror-languageserver/issues/9
            webSocketTransport.connection.addEventListener(
                "message",
                (message: { data: string }) => {
                    const data = JSON.parse(message.data);
                    if (data.method && data.id) {
                        webSocketTransport.connection.send(
                            JSON.stringify({
                                jsonrpc: "2.0",
                                id: data.id,
                                result: null,
                            }),
                        );
                    }
                },
            );
        }

        this.initializePromise = this.initialize();
    }

    protected getInitializationOptions(): LSP.InitializeParams["initializationOptions"] {
        const defaultClientCapabilities: LSP.ClientCapabilities = {
            textDocument: {
                hover: {
                    dynamicRegistration: true,
                    contentFormat: ["plaintext", "markdown"],
                },
                moniker: {},
                synchronization: {
                    dynamicRegistration: true,
                    willSave: false,
                    didSave: false,
                    willSaveWaitUntil: false,
                },
                codeAction: {
                    dynamicRegistration: true,
                    codeActionLiteralSupport: {
                        codeActionKind: {
                            valueSet: [
                                "",
                                "quickfix",
                                "refactor",
                                "refactor.extract",
                                "refactor.inline",
                                "refactor.rewrite",
                                "source",
                                "source.organizeImports",
                            ],
                        },
                    },
                    resolveSupport: {
                        properties: ["edit"],
                    },
                },
                completion: {
                    dynamicRegistration: true,
                    completionItem: {
                        snippetSupport: false,
                        commitCharactersSupport: true,
                        documentationFormat: ["markdown", "plaintext"],
                        deprecatedSupport: false,
                        preselectSupport: false,
                    },
                    contextSupport: false,
                },
                signatureHelp: {
                    dynamicRegistration: true,
                    signatureInformation: {
                        documentationFormat: ["markdown", "plaintext"],
                    },
                },
                declaration: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                definition: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                typeDefinition: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                implementation: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                rename: {
                    dynamicRegistration: true,
                    prepareSupport: true,
                },
            },
            workspace: {
                didChangeConfiguration: {
                    dynamicRegistration: true,
                },
            },
        };

        const defaultOptions = {
            capabilities: this.clientCapabilities
                ? typeof this.clientCapabilities === "function"
                    ? this.clientCapabilities(defaultClientCapabilities)
                    : this.clientCapabilities
                : defaultClientCapabilities,
            initializationOptions: this.initializationOptions,
            processId: null,
            rootUri: this.rootUri,
            workspaceFolders: this.workspaceFolders,
        };

        return defaultOptions;
    }

    public async initialize() {
        const { capabilities } = await this.request(
            "initialize",
            this.getInitializationOptions(),
            timeout * 3,
        );
        this.capabilities = capabilities;
        this.notify("initialized", {});
        this.ready = true;
    }

    public close() {
        this.client.close();
    }

    public textDocumentDidOpen(params: LSP.DidOpenTextDocumentParams) {
        return this.notify("textDocument/didOpen", params);
    }

    public textDocumentDidChange(params: LSP.DidChangeTextDocumentParams) {
        return this.notify("textDocument/didChange", params);
    }

    public async textDocumentHover(params: LSP.HoverParams) {
        return await this.request("textDocument/hover", params, timeout);
    }

    public async textDocumentCompletion(params: LSP.CompletionParams) {
        return await this.request("textDocument/completion", params, timeout);
    }

    public async textDocumentDefinition(params: LSP.DefinitionParams) {
        return await this.request("textDocument/definition", params, timeout);
    }

    public async textDocumentCodeAction(params: LSP.CodeActionParams) {
        return await this.request("textDocument/codeAction", params, timeout);
    }

    public async textDocumentRename(params: LSP.RenameParams) {
        return await this.request("textDocument/rename", params, timeout);
    }

    public async textDocumentPrepareRename(params: LSP.PrepareRenameParams) {
        return await this.request(
            "textDocument/prepareRename",
            params,
            timeout,
        );
    }

    public attachPlugin(plugin: LanguageServerPlugin) {
        this.plugins.push(plugin);
    }

    public detachPlugin(plugin: LanguageServerPlugin) {
        const i = this.plugins.indexOf(plugin);
        if (i === -1) {
            return;
        }
        this.plugins.splice(i, 1);
        if (this.autoClose) {
            this.close();
        }
    }

    protected request<K extends keyof LSPRequestMap>(
        method: K,
        params: LSPRequestMap[K][0],
        timeout: number,
    ): Promise<LSPRequestMap[K][1]> {
        return this.client.request({ method, params }, timeout);
    }

    protected notify<K extends keyof LSPNotifyMap>(
        method: K,
        params: LSPNotifyMap[K],
    ): Promise<LSPNotifyMap[K]> {
        return this.client.notify({ method, params });
    }

    protected processNotification(notification: Notification) {
        for (const plugin of this.plugins) {
            plugin.processNotification(notification);
        }
    }
}

class LanguageServerPlugin implements PluginValue {
    public client: LanguageServerClient;

    private documentUri: string;
    private languageId: string;
    private documentVersion: number;

    private changesTimeout: number;

    constructor(
        private view: EditorView,
        private allowHTMLContent = false,
    ) {
        this.client = this.view.state.facet(client);
        this.documentUri = this.view.state.facet(documentUri);
        this.languageId = this.view.state.facet(languageId);
        this.documentVersion = 0;
        this.changesTimeout = 0;

        this.client.attachPlugin(this);

        this.initialize({
            documentText: this.view.state.doc.toString(),
        });
    }

    public update({ docChanged }: ViewUpdate) {
        if (!docChanged) {
            return;
        }
        if (this.changesTimeout) {
            clearTimeout(this.changesTimeout);
        }
        this.changesTimeout = self.setTimeout(() => {
            this.sendChange({
                documentText: this.view.state.doc.toString(),
            });
        }, changesDelay);
    }

    public destroy() {
        this.client.detachPlugin(this);
    }

    public async initialize({ documentText }: { documentText: string }) {
        if (this.client.initializePromise) {
            await this.client.initializePromise;
        }
        this.client.textDocumentDidOpen({
            textDocument: {
                uri: this.documentUri,
                languageId: this.languageId,
                text: documentText,
                version: this.documentVersion,
            },
        });
    }

    public async sendChange({ documentText }: { documentText: string }) {
        if (!this.client.ready) {
            return;
        }
        try {
            await this.client.textDocumentDidChange({
                textDocument: {
                    uri: this.documentUri,
                    version: this.documentVersion++,
                },
                contentChanges: [{ text: documentText }],
            });
        } catch (e) {
            console.error(e);
        }
    }

    public requestDiagnostics(view: EditorView) {
        this.sendChange({ documentText: view.state.doc.toString() });
    }

    public async requestHoverTooltip(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): Promise<Tooltip | null> {
        if (!this.client.ready || !this.client.capabilities?.hoverProvider) {
            return null;
        }

        this.sendChange({ documentText: view.state.doc.toString() });
        const result = await this.client.textDocumentHover({
            textDocument: { uri: this.documentUri },
            position: { line, character },
        });
        if (!result) {
            return null;
        }
        const { contents, range } = result;
        let pos = posToOffset(view.state.doc, { line, character });
        let end: number | undefined;
        if (range) {
            pos = posToOffset(view.state.doc, range.start);
            end = posToOffset(view.state.doc, range.end);
        }
        if (pos === null) {
            return null;
        }
        const dom = document.createElement("div");
        dom.classList.add("documentation");
        if (this.allowHTMLContent) {
            dom.innerHTML = formatContents(contents);
        } else {
            dom.textContent = formatContents(contents);
        }
        return {
            pos,
            end,
            create: (view) => ({ dom }),
            above: true,
        };
    }

    public async requestCompletion(
        context: CompletionContext,
        { line, character }: { line: number; character: number },
        {
            triggerKind,
            triggerCharacter,
        }: {
            triggerKind: CompletionTriggerKind;
            triggerCharacter: string | undefined;
        },
    ): Promise<CompletionResult | null> {
        if (
            !this.client.ready ||
            !this.client.capabilities?.completionProvider
        ) {
            return null;
        }
        this.sendChange({
            documentText: context.state.doc.toString(),
        });

        const result = await this.client.textDocumentCompletion({
            textDocument: { uri: this.documentUri },
            position: { line, character },
            context: {
                triggerKind,
                triggerCharacter,
            },
        });

        if (!result) {
            return null;
        }

        let items = "items" in result ? result.items : result;

        const [_span, match] = prefixMatch(items);
        const token = context.matchBefore(match);
        let { pos } = context;

        if (token) {
            pos = token.from;
            const word = token.text.toLowerCase();
            if (/^\w+$/.test(word)) {
                items = items
                    .filter(({ label, filterText }) => {
                        const text = filterText ?? label;
                        return text.toLowerCase().startsWith(word);
                    })
                    .sort((a, b) => {
                        const aText = a.sortText ?? a.label;
                        const bText = b.sortText ?? b.label;
                        switch (true) {
                            case aText.startsWith(token.text) &&
                                !bText.startsWith(token.text):
                                return -1;
                            case !aText.startsWith(token.text) &&
                                bText.startsWith(token.text):
                                return 1;
                        }
                        return 0;
                    });
            }
        }

        const options = items.map(
            ({
                detail,
                label,
                kind,
                textEdit,
                documentation,
                additionalTextEdits,
            }) => {
                const completion: Completion = {
                    label,
                    detail,
                    apply(
                        view: EditorView,
                        completion: Completion,
                        from: number,
                        to: number,
                    ) {
                        if (isLSPTextEdit(textEdit)) {
                            view.dispatch(
                                insertCompletionText(
                                    view.state,
                                    textEdit.newText,
                                    posToOffset(
                                        view.state.doc,
                                        textEdit.range.start,
                                    ),
                                    posToOffset(
                                        view.state.doc,
                                        textEdit.range.end,
                                    ),
                                ),
                            );
                        } else {
                            view.dispatch(
                                insertCompletionText(
                                    view.state,
                                    label,
                                    from,
                                    to,
                                ),
                            );
                        }
                        if (!additionalTextEdits) {
                            return;
                        }
                        for (const textEdit of additionalTextEdits.sort(
                            ({ range: { end: a } }, { range: { end: b } }) => {
                                if (
                                    posToOffset(view.state.doc, a) <
                                    posToOffset(view.state.doc, b)
                                ) {
                                    return 1;
                                }
                                if (
                                    posToOffset(view.state.doc, a) >
                                    posToOffset(view.state.doc, b)
                                ) {
                                    return -1;
                                }
                                return 0;
                            },
                        )) {
                            view.dispatch(
                                view.state.update({
                                    changes: {
                                        from: posToOffset(
                                            view.state.doc,
                                            textEdit.range.start,
                                        ),
                                        to: posToOffset(
                                            view.state.doc,
                                            textEdit.range.end,
                                        ),
                                        insert: textEdit.newText,
                                    },
                                }),
                            );
                        }
                    },
                    type: kind && CompletionItemKindMap[kind].toLowerCase(),
                };
                if (documentation) {
                    completion.info = () => {
                        const dom = document.createElement("div");
                        dom.classList.add("documentation");
                        if (this.allowHTMLContent) {
                            dom.innerHTML = formatContents(documentation);
                        } else {
                            dom.textContent = formatContents(documentation);
                        }
                        return dom;
                    };
                }
                return completion;
            },
        );

        return {
            from: pos,
            options,
            filter: false,
        };
    }

    public async requestDefinition(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ) {
        if (
            !this.client.ready ||
            !this.client.capabilities?.definitionProvider
        ) {
            return;
        }

        const result = await this.client.textDocumentDefinition({
            textDocument: { uri: this.documentUri },
            position: { line, character },
        });

        if (!result) return;

        const locations = Array.isArray(result) ? result : [result];
        if (locations.length === 0) return;

        // For now just handle the first location
        const location = locations[0];
        const uri = "uri" in location ? location.uri : location.targetUri;
        const range =
            "range" in location ? location.range : location.targetRange;

        console.debug(
            `Definition found at ${uri}:${range.start.line}:${range.start.character}`,
        );

        // Not from the same document
        if (uri !== this.documentUri) {
            return;
        }

        this.view.dispatch(
            this.view.state.update({
                selection: {
                    anchor: posToOffset(this.view.state.doc, range.start),
                    head: posToOffset(this.view.state.doc, range.end),
                },
            }),
        );

        return { uri, range };
    }

    public processNotification(notification: Notification) {
        try {
            switch (notification.method) {
                case "textDocument/publishDiagnostics":
                    this.processDiagnostics(notification.params);
            }
        } catch (error) {
            console.log(error);
        }
    }

    public async processDiagnostics(params: PublishDiagnosticsParams) {
        if (params.uri !== this.documentUri) {
            return;
        }

        const diagnostics = params.diagnostics.map(
            async ({ range, message, severity, code, source }) => {
                const actions = await this.requestCodeActions(range, [
                    code as string,
                ]);
                return {
                    from: posToOffset(this.view.state.doc, range.start),
                    to: posToOffset(this.view.state.doc, range.end),
                    severity: (
                        {
                            [DiagnosticSeverity.Error]: "error",
                            [DiagnosticSeverity.Warning]: "warning",
                            [DiagnosticSeverity.Information]: "info",
                            [DiagnosticSeverity.Hint]: "info",
                        } as const
                    )[severity ?? DiagnosticSeverity.Error],
                    message,
                    actions:
                        actions?.map((action) => ({
                            name:
                                "command" in action &&
                                typeof action.command === "object"
                                    ? action.command?.title || action.title
                                    : action.title,
                            apply: async () => {
                                if ("edit" in action && action.edit) {
                                    // Apply workspace edit
                                    for (const change of action.edit.changes?.[
                                        this.documentUri
                                    ] || []) {
                                        this.view.dispatch(
                                            this.view.state.update({
                                                changes: {
                                                    from: posToOffset(
                                                        this.view.state.doc,
                                                        change.range.start,
                                                    ),
                                                    to: posToOffset(
                                                        this.view.state.doc,
                                                        change.range.end,
                                                    ),
                                                    insert: change.newText,
                                                },
                                            }),
                                        );
                                    }
                                }
                                if ("command" in action && action.command) {
                                    // Execute command if present
                                    console.log(
                                        "Executing command:",
                                        action.command,
                                    );
                                }
                            },
                        })) || [],
                };
            },
        );

        const resolvedDiagnostics = await Promise.all(diagnostics);
        this.view.dispatch(
            setDiagnostics(this.view.state, resolvedDiagnostics),
        );
    }

    private async requestCodeActions(
        range: LSP.Range,
        diagnosticCodes: string[],
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        if (
            !this.client.ready ||
            !this.client.capabilities?.codeActionProvider
        ) {
            return null;
        }

        return await this.client.textDocumentCodeAction({
            textDocument: { uri: this.documentUri },
            range,
            context: {
                diagnostics: [
                    {
                        range,
                        code: diagnosticCodes[0],
                        source: this.languageId,
                        message: "",
                    },
                ],
            },
        });
    }

    public async requestRename(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ) {
        if (!this.client.ready) {
            showErrorMessage(view, "Language server not ready");
            return;
        }

        if (!this.client.capabilities?.renameProvider) {
            showErrorMessage(view, "Rename not supported by language server");
            return;
        }

        try {
            // First check if rename is possible at this position
            const prepareResult = await this.client.textDocumentPrepareRename({
                textDocument: { uri: this.documentUri },
                position: { line, character },
            });

            if (!prepareResult || "defaultBehavior" in prepareResult) {
                showErrorMessage(view, "Cannot rename this symbol");
                return;
            }

            // Create popup input
            const popup = document.createElement("div");
            popup.className = "cm-rename-popup";
            popup.style.cssText =
                "position: absolute; padding: 4px; background: white; border: 1px solid #ddd; box-shadow: 0 2px 8px rgba(0,0,0,.15); z-index: 99;";

            const input = document.createElement("input");
            input.type = "text";
            input.style.cssText =
                "width: 200px; padding: 4px; border: 1px solid #ddd;";

            // Get current word as default value
            const range =
                "range" in prepareResult ? prepareResult.range : prepareResult;
            const from = posToOffset(view.state.doc, range.start);
            const to = posToOffset(view.state.doc, range.end);
            input.value = view.state.doc.sliceString(from, to);

            popup.appendChild(input);

            // Position the popup near the word
            const coords = view.coordsAtPos(from);
            if (!coords) return;

            popup.style.left = `${coords.left}px`;
            popup.style.top = `${coords.bottom + 5}px`;

            // Handle input
            const handleRename = async () => {
                const newName = input.value.trim();
                if (!newName) {
                    showErrorMessage(view, "New name cannot be empty");
                    popup.remove();
                    return;
                }

                if (newName === input.defaultValue) {
                    popup.remove();
                    return;
                }

                try {
                    const edit = await this.client.textDocumentRename({
                        textDocument: { uri: this.documentUri },
                        position: { line, character },
                        newName,
                    });

                    if (!edit?.changes) {
                        showErrorMessage(view, "No changes to apply");
                        popup.remove();
                        return;
                    }

                    // Apply all changes
                    for (const [uri, changes] of Object.entries(edit.changes)) {
                        if (uri !== this.documentUri) {
                            showErrorMessage(
                                view,
                                "Multi-file rename not supported yet",
                            );
                            continue;
                        }

                        // Sort changes in reverse order to avoid position shifts
                        const sortedChanges = changes.sort((a, b) => {
                            const posA = posToOffset(
                                view.state.doc,
                                a.range.start,
                            );
                            const posB = posToOffset(
                                view.state.doc,
                                b.range.start,
                            );
                            return (posB ?? 0) - (posA ?? 0);
                        });

                        view.dispatch(
                            view.state.update({
                                changes: sortedChanges.map((change) => ({
                                    from:
                                        posToOffset(
                                            view.state.doc,
                                            change.range.start,
                                        ) ?? 0,
                                    to:
                                        posToOffset(
                                            view.state.doc,
                                            change.range.end,
                                        ) ?? 0,
                                    insert: change.newText,
                                })),
                            }),
                        );
                    }
                } catch (error) {
                    showErrorMessage(
                        view,
                        `Rename failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    );
                } finally {
                    popup.remove();
                }
            };

            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    handleRename();
                } else if (e.key === "Escape") {
                    popup.remove();
                }
                e.stopPropagation(); // Prevent editor handling
            });

            // Handle clicks outside
            const handleOutsideClick = (e: MouseEvent) => {
                if (!popup.contains(e.target as Node)) {
                    popup.remove();
                    document.removeEventListener(
                        "mousedown",
                        handleOutsideClick,
                    );
                }
            };
            document.addEventListener("mousedown", handleOutsideClick);

            // Add to DOM
            document.body.appendChild(popup);
            input.focus();
            input.select();
        } catch (error) {
            showErrorMessage(
                view,
                `Rename failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
        }
    }
}

interface LanguageServerBaseOptions {
    rootUri: string;
    workspaceFolders: LSP.WorkspaceFolder[];
    documentUri: string;
    languageId: string;
}

interface LanguageServerClientOptions extends LanguageServerBaseOptions {
    transport: Transport;
    autoClose?: boolean;
    capabilities?:
        | LSP.InitializeParams["capabilities"]
        | ((
              defaultCapabilities: LSP.InitializeParams["capabilities"],
          ) => LSP.InitializeParams["capabilities"]);
    initializationOptions?: LSP.InitializeParams["initializationOptions"];
}

interface KeyboardShortcuts {
    rename?: string;
    goToDefinition?: string;
}

interface LanguageServerOptions extends LanguageServerClientOptions {
    client?: LanguageServerClient;
    allowHTMLContent?: boolean;
    keyboardShortcuts?: KeyboardShortcuts;
}

interface LanguageServerWebsocketOptions extends LanguageServerBaseOptions {
    serverUri: `ws://${string}` | `wss://${string}`;
}

export function languageServer(options: LanguageServerWebsocketOptions) {
    const { serverUri, ...rest } = options;
    return languageServerWithTransport({
        ...rest,
        transport: new WebSocketTransport(serverUri),
    });
}

export function languageServerWithTransport(options: LanguageServerOptions) {
    let plugin: LanguageServerPlugin | null = null;
    const shortcuts = {
        rename: "F2",
        goToDefinition: "ctrlcmd", // ctrlcmd means Ctrl on Windows/Linux, Cmd on Mac
        ...options.keyboardShortcuts,
    };

    return [
        client.of(
            options.client ||
                new LanguageServerClient({ ...options, autoClose: true }),
        ),
        documentUri.of(options.documentUri),
        languageId.of(options.languageId),
        ViewPlugin.define((view) => {
            plugin = new LanguageServerPlugin(view, options.allowHTMLContent);
            return plugin;
        }),
        hoverTooltip(
            (view, pos) =>
                plugin?.requestHoverTooltip(
                    view,
                    offsetToPos(view.state.doc, pos),
                ) ?? null,
        ),
        autocompletion({
            override: [
                async (context) => {
                    if (plugin == null) {
                        return null;
                    }

                    const { state, pos, explicit } = context;
                    const line = state.doc.lineAt(pos);
                    let trigKind: CompletionTriggerKind =
                        CompletionTriggerKind.Invoked;
                    let trigChar: string | undefined;
                    if (
                        !explicit &&
                        plugin.client.capabilities?.completionProvider?.triggerCharacters?.includes(
                            line.text[pos - line.from - 1],
                        )
                    ) {
                        trigKind = CompletionTriggerKind.TriggerCharacter;
                        trigChar = line.text[pos - line.from - 1];
                    }
                    if (
                        trigKind === CompletionTriggerKind.Invoked &&
                        !context.matchBefore(/\w+$/)
                    ) {
                        return null;
                    }
                    return await plugin.requestCompletion(
                        context,
                        offsetToPos(state.doc, pos),
                        {
                            triggerCharacter: trigChar,
                            triggerKind: trigKind,
                        },
                    );
                },
            ],
        }),
        EditorView.domEventHandlers({
            click: (event, view) => {
                if (
                    shortcuts.goToDefinition === "ctrlcmd" &&
                    (event.ctrlKey || event.metaKey)
                ) {
                    const pos = view.posAtCoords({
                        x: event.clientX,
                        y: event.clientY,
                    });
                    if (pos && plugin) {
                        plugin
                            .requestDefinition(
                                view,
                                offsetToPos(view.state.doc, pos),
                            )
                            .catch((error) =>
                                showErrorMessage(
                                    view,
                                    `Go to definition failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                                ),
                            );
                        event.preventDefault();
                    }
                }
            },
            keydown: (event, view) => {
                if (event.key === shortcuts.rename && plugin) {
                    const pos = view.state.selection.main.head;
                    plugin.requestRename(
                        view,
                        offsetToPos(view.state.doc, pos),
                    );
                    event.preventDefault();
                } else if (
                    shortcuts.goToDefinition !== "ctrlcmd" &&
                    event.key === shortcuts.goToDefinition &&
                    plugin
                ) {
                    const pos = view.state.selection.main.head;
                    plugin
                        .requestDefinition(
                            view,
                            offsetToPos(view.state.doc, pos),
                        )
                        .catch((error) =>
                            showErrorMessage(
                                view,
                                `Go to definition failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                            ),
                        );
                    event.preventDefault();
                }
            },
        }),
    ];
}
