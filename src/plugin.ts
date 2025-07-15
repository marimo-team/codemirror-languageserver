import { autocompletion } from "@codemirror/autocomplete";
import {
    type Action,
    type Diagnostic,
    forEachDiagnostic,
    setDiagnostics,
} from "@codemirror/lint";
import {
    EditorView,
    type Tooltip,
    ViewPlugin,
    hoverTooltip,
    keymap,
} from "@codemirror/view";
import {
    Client,
    RequestManager,
    WebSocketTransport,
} from "@open-rpc/client-js";
import {
    CompletionTriggerKind,
    DiagnosticSeverity,
} from "vscode-languageserver-protocol";

import type {
    CompletionContext,
    CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type * as LSP from "vscode-languageserver-protocol";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { convertCompletionItem, sortCompletionItems } from "./completion.js";
import { documentUri, languageId } from "./config.js";
import {
    eventsFromChangeSet,
    formatContents,
    isEmptyDocumentation,
    offsetToPos,
    posToOffset,
    posToOffsetOrZero,
    prefixMatch,
    renderMarkdown,
    showErrorMessage,
} from "./utils.js";

const TIMEOUT = 10000;

const logger = console.log;

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Client to server then server to client
interface LSPRequestMap {
    initialize: [LSP.InitializeParams, LSP.InitializeResult];
    "textDocument/hover": [LSP.HoverParams, LSP.Hover];
    "textDocument/completion": [
        LSP.CompletionParams,
        LSP.CompletionItem[] | LSP.CompletionList | null,
    ];
    "completionItem/resolve": [LSP.CompletionItem, LSP.CompletionItem];
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
    "textDocument/signatureHelp": [
        LSP.SignatureHelpParams,
        LSP.SignatureHelp | null,
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
    private workspaceFolders: LSP.WorkspaceFolder[] | null;
    private autoClose?: boolean;
    private timeout: number;

    private transport: Transport;
    private requestManager: RequestManager;
    private client: Client;
    private initializationOptions: LanguageServerClientOptions["initializationOptions"];
    public clientCapabilities: LanguageServerClientOptions["capabilities"];

    private plugins: LanguageServerPlugin[];

    constructor({
        rootUri,
        workspaceFolders,
        transport,
        autoClose,
        initializationOptions,
        capabilities,
        timeout = TIMEOUT,
        getWorkspaceConfiguration,
    }: LanguageServerClientOptions) {
        this.rootUri = rootUri;
        this.workspaceFolders = workspaceFolders;
        this.transport = transport;
        this.autoClose = autoClose;
        this.initializationOptions = initializationOptions;
        this.clientCapabilities = capabilities;
        this.timeout = timeout;
        this.ready = false;
        this.capabilities = null;
        this.plugins = [];
        this.requestManager = new RequestManager([this.transport]);
        this.client = new Client(this.requestManager);

        this.client.onNotification((data) => {
            this.processNotification(data as Notification);
        });

        const webSocketTransport = this.transport as WebSocketTransport;
        if (webSocketTransport?.connection) {
            webSocketTransport.connection.addEventListener(
                "message",
                (message: { data: string }) => {
                    const data = JSON.parse(message.data);
                    if (
                        data.method === "workspace/configuration" &&
                        getWorkspaceConfiguration
                    ) {
                        webSocketTransport.connection.send(
                            JSON.stringify({
                                jsonrpc: "2.0",
                                id: data.id,
                                result: getWorkspaceConfiguration(data.params),
                            }),
                        );
                        // XXX(hjr265): Need a better way to do this. Relevant issue:
                        // https://github.com/FurqanSoftware/codemirror-languageserver/issues/9
                    } else if (data.method && data.id) {
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
                    contentFormat: ["markdown", "plaintext"],
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
                        snippetSupport: true,
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
            this.timeout * 3,
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
        return await this.request("textDocument/hover", params, this.timeout);
    }

    public async textDocumentCompletion(params: LSP.CompletionParams) {
        return await this.request(
            "textDocument/completion",
            params,
            this.timeout,
        );
    }

    public async completionItemResolve(item: LSP.CompletionItem) {
        return await this.request("completionItem/resolve", item, this.timeout);
    }

    public async textDocumentDefinition(params: LSP.DefinitionParams) {
        return await this.request(
            "textDocument/definition",
            params,
            this.timeout,
        );
    }

    public async textDocumentCodeAction(params: LSP.CodeActionParams) {
        return await this.request(
            "textDocument/codeAction",
            params,
            this.timeout,
        );
    }

    public async textDocumentRename(params: LSP.RenameParams) {
        return await this.request("textDocument/rename", params, this.timeout);
    }

    public async textDocumentPrepareRename(params: LSP.PrepareRenameParams) {
        return await this.request(
            "textDocument/prepareRename",
            params,
            this.timeout,
        );
    }

    public async textDocumentSignatureHelp(params: LSP.SignatureHelpParams) {
        return await this.request(
            "textDocument/signatureHelp",
            params,
            this.timeout,
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

function uniqueId() {
    return String(Date.now() + Math.random());
}

export class LanguageServerPlugin implements PluginValue {
    private documentVersion: number;
    private pluginId: string;
    public client: LanguageServerClient;
    public documentUri: string;
    public languageId: string;
    public view: EditorView;
    public allowHTMLContent = false;
    public sendIncrementalChanges: boolean;
    public featureOptions: Required<FeatureOptions>;
    public onGoToDefinition: ((result: DefinitionResult) => void) | undefined;

    constructor(
        client: LanguageServerClient,
        documentUri: string,
        languageId: string,
        view: EditorView,
        featureOptions: Required<FeatureOptions>,
        sendIncrementalChanges = true,
        allowHTMLContent = false,
        onGoToDefinition?: (result: DefinitionResult) => void,
    ) {
        this.documentVersion = 0;
        this.pluginId = uniqueId();
        this.client = client;
        this.documentUri = documentUri;
        this.languageId = languageId;
        this.view = view;
        this.allowHTMLContent = allowHTMLContent;
        this.sendIncrementalChanges = sendIncrementalChanges;
        this.featureOptions = featureOptions;
        this.onGoToDefinition = onGoToDefinition;

        this.client.attachPlugin(this);

        this.initialize({
            documentText: this.view.state.doc.toString(),
        });
    }

    public update({
        state,
        docChanged,
        startState: { doc },
        changes,
    }: ViewUpdate) {
        if (!docChanged) {
            return;
        }

        if (this.sendIncrementalChanges) {
            this.sendChanges(eventsFromChangeSet(doc, changes));
        } else {
            this.sendChanges([{ text: state.doc.toString() }]);
        }
    }

    public destroy() {
        // Clear diagnostics from this plugin when destroying
        this.clearDiagnostics();
        this.client.detachPlugin(this);
    }

    public async initialize({ documentText }: { documentText: string }) {
        if (this.client.initializePromise) {
            await this.client.initializePromise;
        }
        await this.client.textDocumentDidOpen({
            textDocument: {
                uri: this.documentUri,
                languageId: this.languageId,
                text: documentText,
                version: this.documentVersion,
            },
        });
    }

    public async sendChanges(
        contentChanges: LSP.TextDocumentContentChangeEvent[],
    ) {
        if (!this.client.ready) {
            return;
        }
        try {
            await this.client.textDocumentDidChange({
                textDocument: {
                    uri: this.documentUri,
                    version: ++this.documentVersion,
                },
                contentChanges,
            });
        } catch (e) {
            console.error(e);
        }
    }

    public requestDiagnostics(view: EditorView) {
        this.sendChanges([
            {
                text: view.state.doc.toString(),
            },
        ]);
    }

    public async requestHoverTooltip(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): Promise<Tooltip | null> {
        // Check if hover is enabled
        if (!this.featureOptions.hoverEnabled) {
            return null;
        }

        if (!(this.client.ready && this.client.capabilities?.hoverProvider)) {
            return null;
        }

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
        if (pos == null) {
            return null;
        }
        if (isEmptyDocumentation(contents)) {
            return null;
        }
        const dom = document.createElement("div");
        dom.classList.add("documentation", "cm-lsp-hover-tooltip");
        if (this.allowHTMLContent) {
            dom.innerHTML = formatContents(contents);
        } else {
            dom.textContent = formatContents(contents);
        }
        return {
            pos,
            end,
            create: (_view) => ({ dom }),
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
        // Check if completion is enabled
        if (!this.featureOptions.completionEnabled) {
            return null;
        }

        if (
            !(this.client.ready && this.client.capabilities?.completionProvider)
        ) {
            return null;
        }

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

        const items = "items" in result ? result.items : result;

        // Match is undefined if there are no common prefixes
        const match = prefixMatch(items);

        const token = match
            ? context.matchBefore(match)
            : // Fallback to matching any character
              context.matchBefore(/[a-zA-Z0-9]+/);
        let { pos } = context;

        const sortedItems = sortCompletionItems(
            items,
            token?.text,
            this.languageId,
        );

        // If we found a token that matches our completion pattern
        if (token) {
            // Set position to the start of the token
            pos = token.from;
        }

        const options = sortedItems.map((item) => {
            return convertCompletionItem(item, {
                allowHTMLContent: this.allowHTMLContent,
                hasResolveProvider:
                    this.client.capabilities?.completionProvider
                        ?.resolveProvider ?? false,
                resolveItem: this.client.completionItemResolve.bind(
                    this.client,
                ),
            });
        });

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
        // Check if definition is enabled
        if (!this.featureOptions.definitionEnabled) {
            return;
        }

        if (
            !(this.client.ready && this.client.capabilities?.definitionProvider)
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
        if (!location) return;
        const uri = "uri" in location ? location.uri : location.targetUri;
        const range =
            "range" in location ? location.range : location.targetRange;

        // Check if the definition is in a different document
        const isExternalDocument = uri !== this.documentUri;

        // Create the definition result
        const definitionResult: DefinitionResult = {
            uri,
            range,
            isExternalDocument,
        };

        // If it's the same document, update the selection
        if (!isExternalDocument) {
            view.dispatch(
                view.state.update({
                    selection: {
                        anchor: posToOffsetOrZero(view.state.doc, range.start),
                        head: posToOffset(view.state.doc, range.end),
                    },
                }),
            );
        }

        if (this.onGoToDefinition) {
            this.onGoToDefinition(definitionResult);
        }

        return definitionResult;
    }

    public processNotification(notification: Notification) {
        try {
            switch (notification.method) {
                case "textDocument/publishDiagnostics":
                    this.processDiagnostics(notification.params);
            }
        } catch (error) {
            logger(error);
        }
    }

    private lastSeenDiagnosticsVersion = 0;

    public async processDiagnostics(params: PublishDiagnosticsParams) {
        if (params.uri !== this.documentUri) {
            return;
        }

        // If the version is newer, clear the diagnostics and update the last seen version
        if (
            params.version != null &&
            params.version > this.lastSeenDiagnosticsVersion
        ) {
            this.lastSeenDiagnosticsVersion = params.version;
            this.clearDiagnostics();
        }

        // Check if diagnostics are enabled
        const diagEnabled = this.featureOptions.diagnosticsEnabled;
        if (!diagEnabled) {
            // Clear any existing diagnostics from this plugin if disabled
            this.clearDiagnostics();
            return;
        }

        const severityMap: Record<DiagnosticSeverity, Diagnostic["severity"]> =
            {
                [DiagnosticSeverity.Error]: "error",
                [DiagnosticSeverity.Warning]: "warning",
                [DiagnosticSeverity.Information]: "info",
                [DiagnosticSeverity.Hint]: "info",
            };

        const diagnostics = params.diagnostics.map(
            async ({ range, message, severity, code, source }) => {
                const actions = await this.requestCodeActions(range, [
                    code as string,
                ]);

                const codemirrorActions = actions?.map(
                    (action): Action => ({
                        name:
                            "command" in action &&
                            typeof action.command === "object"
                                ? action.command?.title || action.title
                                : action.title,
                        apply: async () => {
                            if ("edit" in action && action.edit?.changes) {
                                const changes =
                                    action.edit.changes[this.documentUri];

                                if (!changes) {
                                    return;
                                }

                                // Apply workspace edit
                                for (const change of changes) {
                                    this.view.dispatch(
                                        this.view.state.update({
                                            changes: {
                                                from: posToOffsetOrZero(
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
                                // TODO: Implement command execution
                                // Execute command if present
                                logger("Executing command:", action.command);
                            }
                        },
                    }),
                );

                const diagnostic: Diagnostic = {
                    from: posToOffsetOrZero(this.view.state.doc, range.start),
                    to: posToOffsetOrZero(this.view.state.doc, range.end),
                    severity: severityMap[severity ?? DiagnosticSeverity.Error],
                    message: message,
                    renderMessage: () => {
                        const dom = document.createElement("div");
                        dom.innerHTML = renderMarkdown(message);
                        return dom;
                    },
                    source: source || this.languageId,
                    markClass: this.pluginId,
                    actions: codemirrorActions,
                };

                return diagnostic;
            },
        );

        const resolvedDiagnostics = await Promise.all(diagnostics);
        this.addDiagnostics(resolvedDiagnostics);
    }

    /**
     * Adds diagnostics to the current state
     */
    private addDiagnostics(newDiagnostics: Diagnostic[]) {
        if (newDiagnostics.length === 0) {
            return;
        }

        const state = this.view.state;

        // Get current diagnostics from the state
        const currentDiagnostics: Diagnostic[] = [];
        forEachDiagnostic(state, (diagnostic) => {
            currentDiagnostics.push(diagnostic);
            return true;
        });

        // Sources
        const uniqueSources = new Set(
            newDiagnostics
                .map((diagnostic) => diagnostic.source)
                .filter(Boolean),
        );

        // Filter out diagnostics from the same source
        const diagnosticsFromOtherSources = newDiagnostics.filter(
            (diagnostic) => {
                return !uniqueSources.has(diagnostic.source);
            },
        );

        this.view.dispatch(
            setDiagnostics(state, [
                ...diagnosticsFromOtherSources,
                ...newDiagnostics,
            ]),
        );
    }

    private clearDiagnostics() {
        this.view.dispatch(setDiagnostics(this.view.state, []));
    }

    private async requestCodeActions(
        range: LSP.Range,
        diagnosticCodes: string[],
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        // Check if code actions are enabled
        if (!this.featureOptions.codeActionsEnabled) {
            return null;
        }

        if (
            !(this.client.ready && this.client.capabilities?.codeActionProvider)
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
        // Check if rename is enabled
        if (!this.featureOptions.renameEnabled) {
            return;
        }

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
            const prepareResult = await this.client
                .textDocumentPrepareRename({
                    textDocument: { uri: this.documentUri },
                    position: { line, character },
                })
                .catch(() => {
                    // In case prepareRename is not supported,
                    // we fallback to the default implementation
                    return this.prepareRenameFallback(view, {
                        line,
                        character,
                    });
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
            if (from == null) {
                return;
            }
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

                    await this.applyRenameEdit(view, edit);
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

    /**
     * Request signature help from the language server
     * @param view The editor view
     * @param position The cursor position
     * @returns A tooltip with the signature help information or null if not available
     */
    public async requestSignatureHelp(
        view: EditorView,
        {
            line,
            character,
        }: {
            line: number;
            character: number;
        },
        triggerCharacter: string | undefined = undefined,
    ): Promise<Tooltip | null> {
        // Check if signature help is enabled
        if (
            !(
                this.featureOptions.signatureHelpEnabled &&
                this.client.ready &&
                this.client.capabilities?.signatureHelpProvider
            )
        ) {
            return null;
        }

        try {
            // Request signature help
            const result = await this.client.textDocumentSignatureHelp({
                textDocument: { uri: this.documentUri },
                position: { line, character },
                context: {
                    isRetrigger: false,
                    triggerKind: 1, // Invoked
                    triggerCharacter,
                },
            });

            if (!result?.signatures || result.signatures.length === 0) {
                return null;
            }

            // Create the tooltip container
            const dom = this.createTooltipContainer();

            // Get active signature
            const activeSignatureIndex = result.activeSignature ?? 0;
            const activeSignature =
                result.signatures[activeSignatureIndex] || result.signatures[0];

            if (!activeSignature) {
                return null;
            }

            const activeParameterIndex =
                result.activeParameter ?? activeSignature.activeParameter ?? 0;

            // Create and add signature display element
            const signatureElement = this.createSignatureElement(
                activeSignature,
                activeParameterIndex,
            );
            dom.appendChild(signatureElement);

            // Add documentation if available
            if (activeSignature.documentation) {
                dom.appendChild(
                    this.createDocumentationElement(
                        activeSignature.documentation,
                    ),
                );
            }

            // Add parameter documentation if available
            const activeParam =
                activeSignature.parameters?.[activeParameterIndex];

            if (activeParam?.documentation) {
                dom.appendChild(
                    this.createParameterDocElement(activeParam.documentation),
                );
            }

            // Position tooltip at cursor
            const pos = posToOffset(view.state.doc, { line, character });
            if (pos == null) {
                return null;
            }

            return {
                pos,
                end: pos,
                create: (_view) => ({ dom }),
                above: false,
            };
        } catch (error) {
            console.error("Signature help error:", error);
            return null;
        }
    }

    /**
     * Shows a signature help tooltip at the specified position
     */
    public async showSignatureHelpTooltip(
        view: EditorView,
        pos: number,
        triggerCharacter?: string,
    ) {
        const tooltip = await this.requestSignatureHelp(
            view,
            offsetToPos(view.state.doc, pos),
            triggerCharacter,
        );

        if (tooltip) {
            // Create and show the tooltip manually
            const { pos: tooltipPos, create } = tooltip;
            const tooltipView = create(view);

            const tooltipElement = document.createElement("div");
            tooltipElement.className = "cm-tooltip cm-signature-tooltip";
            tooltipElement.style.position = "absolute";

            tooltipElement.appendChild(tooltipView.dom);

            // Position the tooltip
            const coords = view.coordsAtPos(tooltipPos);
            if (coords) {
                tooltipElement.style.left = `${coords.left}px`;
                tooltipElement.style.top = `${coords.bottom + 5}px`;

                // Add to DOM
                document.body.appendChild(tooltipElement);

                // Remove after a delay or on editor changes
                setTimeout(() => {
                    tooltipElement.remove();
                }, 10000); // Show for 10 seconds

                // Also remove on any user input
                const removeTooltip = () => {
                    tooltipElement.remove();
                    view.dom.removeEventListener("keydown", removeTooltip);
                    view.dom.removeEventListener("mousedown", removeTooltip);
                };

                view.dom.addEventListener("keydown", removeTooltip);
                view.dom.addEventListener("mousedown", removeTooltip);
            }
        }
    }

    /**
     * Creates the main tooltip container for signature help
     */
    private createTooltipContainer(): HTMLElement {
        const dom = document.createElement("div");
        dom.classList.add("cm-signature-help");
        dom.style.cssText = "padding: 6px; max-width: 400px;";
        return dom;
    }

    /**
     * Creates the signature element with parameter highlighting
     */
    private createSignatureElement(
        signature: LSP.SignatureInformation,
        activeParameterIndex: number,
    ): HTMLElement {
        const signatureElement = document.createElement("div");
        signatureElement.classList.add("cm-signature");
        signatureElement.style.cssText =
            "font-family: monospace; margin-bottom: 4px;";

        if (!signature.label || typeof signature.label !== "string") {
            signatureElement.textContent = "Signature information unavailable";
            return signatureElement;
        }

        const signatureText = signature.label;
        const parameters = signature.parameters || [];

        // If there are no parameters or no active parameter, just show the signature text
        if (parameters.length === 0 || !parameters[activeParameterIndex]) {
            signatureElement.textContent = signatureText;
            return signatureElement;
        }

        // Handle parameter highlighting based on the parameter label type
        const paramLabel = parameters[activeParameterIndex].label;

        if (typeof paramLabel === "string") {
            // Simple string replacement
            if (this.allowHTMLContent) {
                signatureElement.innerHTML = signatureText.replace(
                    paramLabel,
                    `<strong class="cm-signature-active-param">${paramLabel}</strong>`,
                );
            } else {
                signatureElement.textContent = signatureText.replace(
                    paramLabel,
                    `«${paramLabel}»`,
                );
            }
        } else if (Array.isArray(paramLabel) && paramLabel.length === 2) {
            // Handle array format [startIndex, endIndex]
            this.applyRangeHighlighting(
                signatureElement,
                signatureText,
                paramLabel[0],
                paramLabel[1],
            );
        } else {
            signatureElement.textContent = signatureText;
        }

        return signatureElement;
    }

    /**
     * Applies parameter highlighting using a range approach
     */
    private applyRangeHighlighting(
        element: HTMLElement,
        text: string,
        startIndex: number,
        endIndex: number,
    ): void {
        // Clear any existing content
        element.textContent = "";

        // Split the text into three parts: before, parameter, after
        const beforeParam = text.substring(0, startIndex);
        const param = text.substring(startIndex, endIndex);
        const afterParam = text.substring(endIndex);

        // Add the parts to the element
        element.appendChild(document.createTextNode(beforeParam));

        const paramSpan = document.createElement("span");
        paramSpan.classList.add("cm-signature-active-param");
        paramSpan.style.cssText =
            "font-weight: bold; text-decoration: underline;";
        paramSpan.textContent = param;
        element.appendChild(paramSpan);

        element.appendChild(document.createTextNode(afterParam));
    }

    /**
     * Creates the documentation element for signatures
     */
    private createDocumentationElement(
        documentation: string | LSP.MarkupContent,
    ): HTMLElement {
        const docsElement = document.createElement("div");
        docsElement.classList.add("cm-signature-docs");
        docsElement.style.cssText = "margin-top: 4px; color: #666;";

        const formattedContent = formatContents(documentation);

        if (this.allowHTMLContent) {
            docsElement.innerHTML = formattedContent;
        } else {
            docsElement.textContent = formattedContent;
        }

        return docsElement;
    }

    /**
     * Creates the parameter documentation element
     */
    private createParameterDocElement(
        documentation: string | LSP.MarkupContent,
    ): HTMLElement {
        const paramDocsElement = document.createElement("div");
        paramDocsElement.classList.add("cm-parameter-docs");
        paramDocsElement.style.cssText =
            "margin-top: 4px; font-style: italic; border-top: 1px solid #eee; padding-top: 4px;";

        const formattedContent = formatContents(documentation);

        if (this.allowHTMLContent) {
            paramDocsElement.innerHTML = formattedContent;
        } else {
            paramDocsElement.textContent = formattedContent;
        }

        return paramDocsElement;
    }

    /**
     * Fallback implementation of prepareRename.
     * We try to find the word at the cursor position and return the range of the word.
     */
    private prepareRenameFallback(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): LSP.PrepareRenameResult | null {
        const doc = view.state.doc;
        const lineText = doc.line(line + 1).text;
        const wordRegex = /\w+/g;
        let match: RegExpExecArray | null;
        let start = character;
        let end = character;
        // Find all word matches in the line
        // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
        while ((match = wordRegex.exec(lineText)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;

            // Check if cursor position is within or at the boundaries of this word
            if (character >= matchStart && character <= matchEnd) {
                start = matchStart;
                end = matchEnd;
                break;
            }
        }

        if (start === character && end === character) {
            return null; // No word found at cursor position
        }

        return {
            range: {
                start: {
                    line,
                    character: start,
                },
                end: {
                    line,
                    character: end,
                },
            },
            placeholder: lineText.slice(start, end),
        };
    }

    /**
     * Apply workspace edit from rename operation
     * @param view The editor view
     * @param edit The workspace edit to apply
     * @returns True if changes were applied successfully
     */
    protected async applyRenameEdit(
        view: EditorView,
        edit: LSP.WorkspaceEdit | null,
    ): Promise<boolean> {
        if (!edit) {
            showErrorMessage(view, "No edit returned from language server");
            return false;
        }

        const changesMap = edit.changes ?? {};
        const documentChanges = edit.documentChanges ?? [];

        if (
            Object.keys(changesMap).length === 0 &&
            documentChanges.length === 0
        ) {
            showErrorMessage(view, "No changes to apply");
            return false;
        }

        // Handle documentChanges (preferred) if available
        if (documentChanges.length > 0) {
            for (const docChange of documentChanges) {
                if ("textDocument" in docChange) {
                    // This is a TextDocumentEdit
                    const uri = docChange.textDocument.uri;

                    if (uri !== this.documentUri) {
                        showErrorMessage(
                            view,
                            "Multi-file rename not supported yet",
                        );
                        continue;
                    }

                    // Sort edits in reverse order to avoid position shifts
                    const sortedEdits = docChange.edits.sort((a, b) => {
                        const posA = posToOffset(view.state.doc, a.range.start);
                        const posB = posToOffset(view.state.doc, b.range.start);
                        return (posB ?? 0) - (posA ?? 0);
                    });

                    // Create a single transaction with all changes
                    const changes = sortedEdits.map((edit) => ({
                        from:
                            posToOffset(view.state.doc, edit.range.start) ?? 0,
                        to: posToOffset(view.state.doc, edit.range.end) ?? 0,
                        insert: edit.newText,
                    }));

                    view.dispatch(view.state.update({ changes }));
                    return true;
                }

                // This is a CreateFile, RenameFile, or DeleteFile operation
                showErrorMessage(
                    view,
                    "File creation, deletion, or renaming operations not supported yet",
                );
                return false;
            }
        }
        // Fall back to changes if documentChanges is not available
        else if (Object.keys(changesMap).length > 0) {
            // Apply all changes
            for (const [uri, changes] of Object.entries(changesMap)) {
                if (uri !== this.documentUri) {
                    showErrorMessage(
                        view,
                        "Multi-file rename not supported yet",
                    );
                    continue;
                }

                // Sort changes in reverse order to avoid position shifts
                const sortedChanges = changes.sort((a, b) => {
                    const posA = posToOffset(view.state.doc, a.range.start);
                    const posB = posToOffset(view.state.doc, b.range.start);
                    return (posB ?? 0) - (posA ?? 0);
                });

                // Create a single transaction with all changes
                const changeSpecs = sortedChanges.map((change) => ({
                    from: posToOffset(view.state.doc, change.range.start) ?? 0,
                    to: posToOffset(view.state.doc, change.range.end) ?? 0,
                    insert: change.newText,
                }));

                view.dispatch(view.state.update({ changes: changeSpecs }));
            }
        }

        return false;
    }
}

/**
 * Options for configuring the language server client
 */
interface LanguageServerClientOptions {
    /** The root URI of the workspace, used for LSP initialization */
    rootUri: string;
    /** List of workspace folders to send to the language server */
    workspaceFolders: LSP.WorkspaceFolder[] | null;
    /** Transport mechanism for communicating with the language server */
    transport: Transport;
    /** Whether to automatically close the connection when the editor is destroyed */
    autoClose?: boolean;
    /** Timeout for requests to the language server */
    timeout?: number;
    /**
     * Client capabilities to send to the server during initialization.
     * Can be an object or a function that modifies the default capabilities.
     */
    capabilities?:
        | LSP.InitializeParams["capabilities"]
        | ((
              defaultCapabilities: LSP.InitializeParams["capabilities"],
          ) => LSP.InitializeParams["capabilities"]);
    /** Additional initialization options to send to the language server */
    initializationOptions?: LSP.InitializeParams["initializationOptions"];
    getWorkspaceConfiguration?: (
        params: LSP.ConfigurationParams,
    ) => LSP.LSPAny[];
}

/**
 * Keyboard shortcut configuration for LSP features
 */
interface KeyboardShortcuts {
    /** Keyboard shortcut for rename operations (default: F2) */
    rename?: string;
    /** Keyboard shortcut for go to definition (default: Ctrl/Cmd+Click) */
    goToDefinition?: string;
    /** Keyboard shortcut for signature help (default: Ctrl/Cmd+Shift+Space) */
    signatureHelp?: string;
}

/**
 * Result of a definition lookup operation
 */
interface DefinitionResult {
    /** URI of the target document containing the definition */
    uri: string;
    /** Range in the document where the definition is located */
    range: LSP.Range;
    /** Whether the definition is in a different file than the current document */
    isExternalDocument: boolean;
}

export interface FeatureOptions {
    /** Whether to enable diagnostic messages (default: true) */
    diagnosticsEnabled?: boolean;
    /** Whether to enable hover tooltips (default: true) */
    hoverEnabled?: boolean;
    /** Whether to enable code completion (default: true) */
    completionEnabled?: boolean;
    /** Whether to enable go-to-definition (default: true) */
    definitionEnabled?: boolean;
    /** Whether to enable rename functionality (default: true) */
    renameEnabled?: boolean;
    /** Whether to enable code actions (default: true) */
    codeActionsEnabled?: boolean;
    /** Whether to enable signature help (default: true) */
    signatureHelpEnabled?: boolean;
    /** Whether to show signature help while typing (default: false) */
    signatureActivateOnTyping?: boolean;
}

/**
 * Complete options for configuring the language server integration
 */
interface LanguageServerOptions extends FeatureOptions {
    /** Pre-configured language server client instance or options */
    client: LanguageServerClient;
    /** Whether to allow HTML content in hover tooltips and other UI elements */
    allowHTMLContent?: boolean;
    /** URI of the current document being edited. If not provided, must be passed via the documentUri facet. */
    documentUri?: string;
    /** Language identifier (e.g., 'typescript', 'javascript', etc.). If not provided, must be passed via the languageId facet. */
    languageId?: string;
    /** Configuration for keyboard shortcuts */
    keyboardShortcuts?: KeyboardShortcuts;
    /** Callback triggered when a go-to-definition action is performed */
    onGoToDefinition?: (result: DefinitionResult) => void;

    /**
     * Configuration for the completion feature.
     * If not provided, the default completion config will be used.
     */
    completionConfig?: Parameters<typeof autocompletion>[0];
    /**
     * Configuration for the hover feature.
     * If not provided, the default hover config will be used.
     */
    hoverConfig?: Parameters<typeof hoverTooltip>[1];

    /**
     * Regular expression for determining when to show completions.
     * Default is to show completions when typing a word, after a dot, or after a slash.
     */
    completionMatchBefore?: RegExp;

    /**
     * Whether to send incremental changes to the language server.
     * @default true
     */
    sendIncrementalChanges?: boolean;
}

/**
 * Options for connecting to a language server via WebSocket
 */
interface LanguageServerWebsocketOptions
    extends Omit<LanguageServerOptions, "client">,
        Omit<LanguageServerClientOptions, "transport"> {
    /** WebSocket URI for connecting to the language server */
    serverUri: `ws://${string}` | `wss://${string}`;
}

export function languageServer(options: LanguageServerWebsocketOptions) {
    const { serverUri, ...rest } = options;
    return languageServerWithClient({
        ...rest,
        client: new LanguageServerClient({
            ...options,
            transport: new WebSocketTransport(serverUri),
            autoClose: true,
        }),
    });
}

export function languageServerWithClient(options: LanguageServerOptions) {
    let plugin: LanguageServerPlugin | null = null;
    const shortcuts = {
        rename: "F2",
        goToDefinition: "F12",
        signatureHelp: "Mod-Shift-Space",
        ...options.keyboardShortcuts,
    };

    const lsClient = options.client;

    const featuresOptions: Required<FeatureOptions> = {
        // Default to true
        diagnosticsEnabled: true,
        hoverEnabled: true,
        completionEnabled: true,
        definitionEnabled: true,
        renameEnabled: true,
        codeActionsEnabled: true,
        signatureHelpEnabled: true,
        signatureActivateOnTyping: false,
        // Override defaults with provided options
        ...options,
    };

    // Create base extensions array
    const extensions: Extension[] = [
        ViewPlugin.define((view) => {
            plugin = new LanguageServerPlugin(
                lsClient,
                options.documentUri ?? view.state.facet(documentUri),
                options.languageId ?? view.state.facet(languageId),
                view,
                featuresOptions,
                options.sendIncrementalChanges ?? true,
                options.allowHTMLContent ?? false,
                options.onGoToDefinition,
            );
            return plugin;
        }),
    ];

    // Add shortcuts
    extensions.push(
        keymap.of([
            {
                key: shortcuts.signatureHelp,
                run: (view) => {
                    if (!(plugin && featuresOptions.signatureHelpEnabled))
                        return false;

                    const pos = view.state.selection.main.head;
                    plugin.showSignatureHelpTooltip(view, pos);
                    return true;
                },
            },
            {
                key: shortcuts.rename,
                run: (view) => {
                    if (!(plugin && featuresOptions.renameEnabled))
                        return false;

                    const pos = view.state.selection.main.head;
                    plugin.requestRename(
                        view,
                        offsetToPos(view.state.doc, pos),
                    );
                    return true;
                },
            },
            {
                key: shortcuts.goToDefinition,
                run: (view) => {
                    if (!(plugin && featuresOptions.definitionEnabled))
                        return false;

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
                    return true;
                },
            },
        ]),
    );

    // Only add hover tooltip if enabled
    if (featuresOptions.hoverEnabled) {
        extensions.push(
            hoverTooltip((view, pos) => {
                if (plugin == null) {
                    return null;
                }
                return plugin.requestHoverTooltip(
                    view,
                    offsetToPos(view.state.doc, pos),
                );
            }, options.hoverConfig),
        );
    }

    // Add signature help support if enabled
    if (featuresOptions.signatureHelpEnabled) {
        extensions.push(
            EditorView.updateListener.of(async (update) => {
                if (!(plugin && update.docChanged)) return;

                // Early exit if signature help capability is not supported
                if (!plugin.client.capabilities?.signatureHelpProvider) return;

                // Only proceed if signatureActivateOnTyping is enabled
                if (!featuresOptions.signatureActivateOnTyping) return;

                const triggerChars = plugin.client.capabilities
                    .signatureHelpProvider.triggerCharacters || ["(", ","];
                let triggerCharacter: string | undefined;

                // Check if changes include trigger characters
                const changes = update.changes;
                let shouldTrigger = false;
                let triggerPos = -1;

                changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
                    if (shouldTrigger) return; // Skip if already found a trigger

                    const text = inserted.toString();
                    if (!text) return;

                    for (const char of triggerChars) {
                        if (text.includes(char)) {
                            shouldTrigger = true;
                            triggerPos = toB;
                            triggerCharacter = char;
                            break;
                        }
                    }
                });

                if (shouldTrigger && triggerPos >= 0) {
                    plugin.showSignatureHelpTooltip(
                        update.view,
                        triggerPos,
                        triggerCharacter,
                    );
                }
            }),
        );
    }

    // Only add autocompletion if enabled
    if (featuresOptions.completionEnabled) {
        extensions.push(
            autocompletion({
                ...options.completionConfig,
                override: [
                    /**
                     * Completion source function that handles LSP-based autocompletion
                     *
                     * This function determines the appropriate trigger kind and character,
                     * checks if completion should be shown, and delegates to the plugin's
                     * requestCompletion method.
                     *
                     * @param context The completion context from CodeMirror
                     * @returns A CompletionResult or null if no completions are available
                     */
                    async (context) => {
                        // Don't proceed if plugin isn't initialized
                        if (plugin == null) {
                            return null;
                        }

                        const { state, pos } = context;

                        const result = getCompletionTriggerKind(
                            context,
                            plugin.client.capabilities?.completionProvider
                                ?.triggerCharacters ?? [],
                            options.completionMatchBefore,
                        );

                        if (result == null) {
                            return null;
                        }

                        // Request completions from the language server
                        return await plugin.requestCompletion(
                            context,
                            offsetToPos(state.doc, pos),
                            result,
                        );
                    },
                    ...(options.completionConfig?.override || []),
                ],
            }),
        );
    }

    // Add event handlers for rename and go to definition
    extensions.push(
        EditorView.domEventHandlers({
            click: (event, view) => {
                // Check if definition is enabled
                if (!featuresOptions.definitionEnabled) return;

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
        }),
    );

    return extensions;
}

export function getCompletionTriggerKind(
    context: CompletionContext,
    triggerCharacters: string[],
    matchBeforePattern?: RegExp,
) {
    const { state, pos, explicit } = context;
    const line = state.doc.lineAt(pos);

    // Determine trigger kind and character
    let triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked;
    let triggerCharacter: string | undefined;

    // Check if completion was triggered by a special character
    const prevChar = line.text[pos - line.from - 1] || "";
    const isTriggerChar = triggerCharacters?.includes(prevChar);

    if (!explicit && isTriggerChar) {
        triggerKind = CompletionTriggerKind.TriggerCharacter;
        triggerCharacter = prevChar;
    }
    // For manual invocation, only show completions when typing
    // Use the provided pattern or default to words, dots, commas, or slashes
    if (
        triggerKind === CompletionTriggerKind.Invoked &&
        !context.matchBefore(matchBeforePattern || /(\w+|\w+\.|\/|,)$/)
    ) {
        return null;
    }

    return { triggerKind, triggerCharacter };
}
