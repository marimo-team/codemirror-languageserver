import type { autocompletion } from "@codemirror/autocomplete";
import type { hoverTooltip } from "@codemirror/view";
import {
    Client,
    RequestManager,
    type WebSocketTransport,
} from "@open-rpc/client-js";
import type { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type * as LSP from "vscode-languageserver-protocol";

const TIMEOUT = 10000;

// Client to server then server to client
export interface LSPRequestMap {
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
    "textDocument/willSaveWaitUntil": [
        LSP.WillSaveTextDocumentParams,
        LSP.TextEdit[] | null,
    ];
}

// Client to server
export interface LSPNotifyMap {
    initialized: LSP.InitializedParams;
    "textDocument/didChange": LSP.DidChangeTextDocumentParams;
    "textDocument/didOpen": LSP.DidOpenTextDocumentParams;
    "textDocument/didClose": LSP.DidCloseTextDocumentParams;
    "textDocument/willSave": LSP.WillSaveTextDocumentParams;
    "textDocument/didSave": LSP.DidSaveTextDocumentParams;
}

// Server to client
export interface LSPEventMap {
    "textDocument/publishDiagnostics": LSP.PublishDiagnosticsParams;
}

export type Notification = {
    [key in keyof LSPEventMap]: {
        jsonrpc: "2.0";
        id?: null | undefined;
        method: key;
        params: LSPEventMap[key];
    };
}[keyof LSPEventMap];

/**
 * Options for configuring the language server client
 */
export interface LanguageServerClientOptions {
    /** The root URI of the workspace, used for LSP initialization */
    rootUri: string;
    /** List of workspace folders to send to the language server */
    workspaceFolders: LSP.WorkspaceFolder[] | null;
    /** Transport mechanism for communicating with the language server */
    transport: Transport;
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
export interface KeyboardShortcuts {
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
export interface DefinitionResult {
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
    /** Additional options for signature help */
    signatureHelpOptions?: {
        /** Position of the signature help tooltip (default: "below") */
        position?: "above" | "below";
    };
}

/**
 * Complete options for configuring the language server integration
 */
export interface LanguageServerOptions extends FeatureOptions {
    /** Pre-configured language server client instance or options */
    client: LanguageServerClient;
    /** Whether to allow HTML content in hover tooltips and other UI elements */
    allowHTMLContent?: boolean;
    /** Whether to prefer snippet insertion for completions when available */
    useSnippetOnCompletion?: boolean;
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

    /**
     * Specify an alternative renderer for markdown content.
     * @param markdown Markdown string content.
     * @returns The rendered HTML content.
     */
    markdownRenderer?: (markdown: string) => string;
}

/**
 * Options for connecting to a language server via WebSocket
 */
export interface LanguageServerWebsocketOptions
    extends Omit<LanguageServerOptions, "client">,
        Omit<LanguageServerClientOptions, "transport"> {
    /** WebSocket URI for connecting to the language server */
    serverUri: `ws://${string}` | `wss://${string}`;
}

export class LanguageServerClient {
    public ready: boolean;
    public capabilities: LSP.ServerCapabilities | null;

    public initializePromise: Promise<void>;
    private rootUri: string;
    private workspaceFolders: LSP.WorkspaceFolder[] | null;
    private timeout: number;

    private transport: Transport;
    private requestManager: RequestManager;
    private client: Client;
    private initializationOptions: LanguageServerClientOptions["initializationOptions"];
    public clientCapabilities: LanguageServerClientOptions["capabilities"];

    private notificationListeners: Set<(n: Notification) => void> = new Set();
    /**
     * How many open editors (plugins) hold each document URI. Several views
     * may share one client and one URI (e.g. split views); the server should
     * see a single didOpen/didClose pair, so we only notify on the 0->1 and
     * 1->0 transitions.
     */
    private documentOpenCounts = new Map<string, number>();
    private webSocketConnection?: WebSocketTransport["connection"];
    private webSocketMessageHandler?: (message: { data: unknown }) => void;
    private isClosed = false;

    constructor({
        rootUri,
        workspaceFolders,
        transport,
        initializationOptions,
        capabilities,
        timeout = TIMEOUT,
        getWorkspaceConfiguration,
    }: LanguageServerClientOptions) {
        this.rootUri = rootUri;
        this.workspaceFolders = workspaceFolders;
        this.transport = transport;
        this.initializationOptions = initializationOptions;
        this.clientCapabilities = capabilities;
        this.timeout = timeout;
        this.ready = false;
        this.capabilities = null;
        this.requestManager = new RequestManager([this.transport]);
        this.client = new Client(this.requestManager);

        this.client.onNotification((data) => {
            this.processNotification(data as Notification);
        });

        const webSocketTransport = this.transport as WebSocketTransport;
        if (webSocketTransport?.connection) {
            this.webSocketConnection = webSocketTransport.connection;
            this.webSocketMessageHandler = (message: { data: unknown }) => {
                if (typeof message.data !== "string") {
                    return;
                }
                // biome-ignore lint/suspicious/noExplicitAny: raw JSON-RPC frame
                let data: any;
                try {
                    data = JSON.parse(message.data);
                } catch {
                    // Ignore non-JSON frames (e.g. keepalive pings)
                    return;
                }
                if (data == null || typeof data !== "object") {
                    return;
                }
                // A JSON-RPC id of 0 is valid, so check for presence, not truthiness
                const isRequest = data.id !== undefined && data.id !== null;
                if (
                    data.method === "workspace/configuration" &&
                    isRequest &&
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
                } else if (data.method && isRequest) {
                    webSocketTransport.connection.send(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: data.id,
                            result: null,
                        }),
                    );
                }
            };
            webSocketTransport.connection.addEventListener(
                "message",
                // @ts-ignore
                this.webSocketMessageHandler,
            );
        }

        this.initializePromise = this.initialize();
        // Keep a failed initialize from becoming an unhandled rejection;
        // awaiters of initializePromise still observe the rejection themselves
        this.initializePromise.catch((error) => {
            console.error("Language server initialization failed", error);
        });
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
                    willSave: true,
                    didSave: true,
                    willSaveWaitUntil: true,
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
        // The client may have been closed while initialize was in flight;
        // don't send `initialized` on a dead transport or revive `ready`
        if (this.isClosed) {
            return;
        }
        this.capabilities = capabilities;
        this.notify("initialized", {});
        this.ready = true;
    }

    public close() {
        this.isClosed = true;
        this.ready = false;
        this.notificationListeners.clear();
        if (this.webSocketConnection && this.webSocketMessageHandler) {
            this.webSocketConnection.removeEventListener(
                "message",
                // @ts-ignore
                this.webSocketMessageHandler,
            );
            this.webSocketConnection = undefined;
            this.webSocketMessageHandler = undefined;
        }
        this.client.close();
    }

    public textDocumentDidOpen(params: LSP.DidOpenTextDocumentParams) {
        const uri = params.textDocument.uri;
        const previous = this.documentOpenCounts.get(uri) ?? 0;
        this.documentOpenCounts.set(uri, previous + 1);
        // Additional views onto an already-open document share the server's
        // single open; only the first view sends didOpen.
        if (previous > 0) {
            return Promise.resolve(undefined);
        }
        return this.notify("textDocument/didOpen", params);
    }

    public textDocumentDidChange(params: LSP.DidChangeTextDocumentParams) {
        return this.notify("textDocument/didChange", params);
    }

    public textDocumentDidClose(params: LSP.DidCloseTextDocumentParams) {
        const uri = params.textDocument.uri;
        const previous = this.documentOpenCounts.get(uri) ?? 0;
        // Only the last view closing the document notifies the server; earlier
        // closes just drop a reference. A close with no tracked open (previous
        // <= 1) still notifies, so direct callers are not silently swallowed.
        if (previous > 1) {
            this.documentOpenCounts.set(uri, previous - 1);
            return Promise.resolve(undefined);
        }
        this.documentOpenCounts.delete(uri);
        return this.notify("textDocument/didClose", params);
    }

    public textDocumentWillSave(params: LSP.WillSaveTextDocumentParams) {
        return this.notify("textDocument/willSave", params);
    }

    public async textDocumentWillSaveWaitUntil(
        params: LSP.WillSaveTextDocumentParams,
    ) {
        return await this.request(
            "textDocument/willSaveWaitUntil",
            params,
            this.timeout,
        );
    }

    public textDocumentDidSave(params: LSP.DidSaveTextDocumentParams) {
        return this.notify("textDocument/didSave", params);
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

    public onNotification(listener: (n: Notification) => void) {
        this.notificationListeners.add(listener);

        return () => this.notificationListeners.delete(listener);
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
        for (const l of this.notificationListeners) {
            try {
                l(notification);
            } catch (error) {
                // One faulty listener must not starve the others
                console.error("Notification listener failed", error);
            }
        }
    }
}
