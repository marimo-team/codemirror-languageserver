import type { autocompletion } from "@codemirror/autocomplete";
import type { hoverTooltip } from "@codemirror/view";
import { Client, RequestManager } from "@open-rpc/client-js";
import type { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type * as LSP from "vscode-languageserver-protocol";

const TIMEOUT = 10000;

// JSON-RPC error codes (https://www.jsonrpc.org/specification#error_object)
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

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
 * Handler for a request initiated by the server (e.g.
 * `workspace/configuration`, `window/showMessageRequest`). The resolved value
 * is sent back to the server as the JSON-RPC result; a thrown error is sent
 * back as a JSON-RPC error response.
 */
// biome-ignore lint/suspicious/noExplicitAny: handlers are registered per-method with heterogeneous shapes
export type ServerRequestHandler<P = any, R = any> = (
    params: P,
) => Promise<R> | R;

/** An incoming server->client JSON-RPC request frame */
interface ServerRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: unknown;
    error?: { code: number; message: string };
}

function isServerRequest(frame: unknown): frame is ServerRequest {
    if (frame == null || typeof frame !== "object" || Array.isArray(frame)) {
        return false;
    }
    const candidate = frame as Partial<ServerRequest>;
    // A JSON-RPC id of 0 is valid, so check for presence, not truthiness;
    // frames with a method but no id are notifications, not requests
    return (
        typeof candidate.method === "string" &&
        candidate.id !== undefined &&
        candidate.id !== null
    );
}

/**
 * Every @open-rpc/client-js transport funnels each incoming frame through its
 * TransportRequestManager, which silently drops server->client requests (and
 * can even mistake them for responses to in-flight client requests when ids
 * collide). The manager is the only transport-agnostic seam, so we access it
 * through this narrowed shape.
 */
interface InterceptableTransport {
    transportRequestManager?: {
        resolveResponse(payload: string, emitError?: boolean): unknown;
    };
}

/**
 * Maps client->server request methods to the static server capability that
 * announces support for them, for {@link LanguageServerClient.hasCapability}.
 */
const METHOD_TO_STATIC_CAPABILITY: Partial<
    Record<string, keyof LSP.ServerCapabilities>
> = {
    "textDocument/hover": "hoverProvider",
    "textDocument/completion": "completionProvider",
    "textDocument/definition": "definitionProvider",
    "textDocument/declaration": "declarationProvider",
    "textDocument/typeDefinition": "typeDefinitionProvider",
    "textDocument/implementation": "implementationProvider",
    "textDocument/references": "referencesProvider",
    "textDocument/documentHighlight": "documentHighlightProvider",
    "textDocument/documentSymbol": "documentSymbolProvider",
    "textDocument/codeAction": "codeActionProvider",
    "textDocument/codeLens": "codeLensProvider",
    "textDocument/documentLink": "documentLinkProvider",
    "textDocument/formatting": "documentFormattingProvider",
    "textDocument/rangeFormatting": "documentRangeFormattingProvider",
    "textDocument/onTypeFormatting": "documentOnTypeFormattingProvider",
    "textDocument/rename": "renameProvider",
    "textDocument/prepareRename": "renameProvider",
    "textDocument/signatureHelp": "signatureHelpProvider",
    "textDocument/foldingRange": "foldingRangeProvider",
    "textDocument/selectionRange": "selectionRangeProvider",
    "workspace/symbol": "workspaceSymbolProvider",
    "workspace/executeCommand": "executeCommandProvider",
};

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
     *
     * Note: this coalesces open/close only. didChange notifications and
     * document versions remain per-plugin, so concurrently editing the same
     * URI from multiple views is not fully synchronized.
     */
    private documentOpenCounts = new Map<string, number>();
    private serverRequestHandlers = new Map<string, ServerRequestHandler>();
    /**
     * Capabilities the server registered dynamically via
     * `client/registerCapability`, keyed by registration id. Consult
     * {@link hasCapability} to check method support regardless of whether the
     * server announced it statically or dynamically.
     */
    public dynamicCapabilities = new Map<string, LSP.Registration>();
    private detachServerRequestInterceptor?: () => void;
    private serverResponseCount = 0;
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

        this.detachServerRequestInterceptor =
            this.attachServerRequestInterceptor(this.transport);

        this.onRequest(
            "workspace/configuration",
            (params: LSP.ConfigurationParams) => {
                if (getWorkspaceConfiguration) {
                    return getWorkspaceConfiguration(params);
                }
                // Per spec the result must have one entry per requested item
                return (params?.items ?? []).map(() => null);
            },
        );
        this.onRequest(
            "client/registerCapability",
            (params: LSP.RegistrationParams) => {
                for (const registration of params?.registrations ?? []) {
                    this.dynamicCapabilities.set(registration.id, registration);
                }
                return null;
            },
        );
        this.onRequest(
            "client/unregisterCapability",
            (params: LSP.UnregistrationParams) => {
                // "unregisterations" is a spelling mistake baked into the LSP spec
                for (const unregistration of params?.unregisterations ?? []) {
                    this.dynamicCapabilities.delete(unregistration.id);
                }
                return null;
            },
        );
        // Minimal spec-valid answers for requests the client cannot fully
        // honor yet; hosts can override these via onRequest. Truthfully
        // reporting "not applied" / "no action selected" beats a
        // MethodNotFound error, which some servers treat as a hard failure.
        this.onRequest(
            "workspace/applyEdit",
            (): LSP.ApplyWorkspaceEditResult => ({
                applied: false,
                failureReason: "workspace/applyEdit is not supported",
            }),
        );
        this.onRequest(
            "window/showMessageRequest",
            (params: LSP.ShowMessageRequestParams) => {
                // No UI for message requests; surface the message in the
                // console and answer null ("no action selected")
                if (params?.message) {
                    console.info(`Language server: ${params.message}`);
                }
                return null;
            },
        );
        // Acknowledge progress-token creation; the progress notifications
        // that follow are ignored
        this.onRequest("window/workDoneProgress/create", () => null);

        this.initializePromise = this.initialize();
        // Keep a failed initialize from becoming an unhandled rejection;
        // awaiters of initializePromise still observe the rejection themselves
        this.initializePromise.catch((error) => {
            console.error("Language server initialization failed", error);
        });
    }

    protected getInitializationOptions(): LSP.InitializeParams["initializationOptions"] {
        // dynamicRegistration is only advertised for features whose support
        // checks go through hasCapability() and whose registrations carry no
        // options the client would otherwise ignore. Everything else stays
        // false so servers announce those capabilities statically instead of
        // registering behavior we cannot honor.
        const defaultClientCapabilities: LSP.ClientCapabilities = {
            textDocument: {
                hover: {
                    dynamicRegistration: true,
                    contentFormat: ["markdown", "plaintext"],
                },
                moniker: {},
                synchronization: {
                    dynamicRegistration: false,
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
                    // Dynamic completion registrations carry triggerCharacters
                    // and resolveProvider options that are still read from the
                    // static capability only
                    dynamicRegistration: false,
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
                    // Same as completion: triggerCharacters come from the
                    // static capability only
                    dynamicRegistration: false,
                    signatureInformation: {
                        documentationFormat: ["markdown", "plaintext"],
                    },
                },
                declaration: {
                    dynamicRegistration: false,
                    linkSupport: true,
                },
                definition: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                typeDefinition: {
                    dynamicRegistration: false,
                    linkSupport: true,
                },
                implementation: {
                    dynamicRegistration: false,
                    linkSupport: true,
                },
                rename: {
                    dynamicRegistration: true,
                    prepareSupport: true,
                },
            },
            workspace: {
                didChangeConfiguration: {
                    dynamicRegistration: false,
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
        this.serverRequestHandlers.clear();
        this.dynamicCapabilities.clear();
        this.detachServerRequestInterceptor?.();
        this.detachServerRequestInterceptor = undefined;
        this.client.close();
    }

    /**
     * Registers a handler for a request initiated by the server. The handler's
     * resolved value is sent back as the JSON-RPC result; a thrown error
     * becomes a JSON-RPC error response. Requests with no registered handler
     * are answered with a `MethodNotFound` (-32601) error so servers can fall
     * back gracefully.
     *
     * @returns A function that removes the handler.
     */
    public onRequest(
        method: string,
        handler: ServerRequestHandler,
    ): () => void {
        this.serverRequestHandlers.set(method, handler);
        return () => {
            // Don't remove a newer handler registered for the same method
            if (this.serverRequestHandlers.get(method) === handler) {
                this.serverRequestHandlers.delete(method);
            }
        };
    }

    /**
     * Whether the server supports the given client->server method, counting
     * both statically announced capabilities and capabilities the server
     * registered dynamically via `client/registerCapability`.
     */
    public hasCapability(method: string): boolean {
        for (const registration of this.dynamicCapabilities.values()) {
            if (registration.method === method) {
                return true;
            }
        }
        const capability = METHOD_TO_STATIC_CAPABILITY[method];
        if (!capability) {
            return false;
        }
        return Boolean(this.capabilities?.[capability]);
    }

    /**
     * Patches the transport's TransportRequestManager so server->client
     * requests are dispatched to {@link serverRequestHandlers} instead of
     * being silently dropped (or, worse, matched against a pending client
     * request with a colliding id). Responses and notifications still flow
     * through the original code path untouched.
     */
    private attachServerRequestInterceptor(
        transport: Transport,
    ): (() => void) | undefined {
        const manager = (transport as unknown as InterceptableTransport)
            .transportRequestManager;
        if (!manager || typeof manager.resolveResponse !== "function") {
            return undefined;
        }
        const original = manager.resolveResponse.bind(manager);
        manager.resolveResponse = (payload: string, emitError?: boolean) => {
            if (typeof payload === "string") {
                let frame: unknown;
                try {
                    frame = JSON.parse(payload);
                } catch {
                    frame = undefined;
                }
                if (isServerRequest(frame)) {
                    void this.handleServerRequest(frame);
                    return undefined;
                }
            }
            return original(payload, emitError);
        };
        return () => {
            manager.resolveResponse = original;
        };
    }

    private async handleServerRequest(request: ServerRequest): Promise<void> {
        const handler = this.serverRequestHandlers.get(request.method);
        let response: JsonRpcResponse;
        if (!handler) {
            response = {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                    code: METHOD_NOT_FOUND,
                    message: `Method not found: ${request.method}`,
                },
            };
        } else {
            try {
                const result = await handler(request.params);
                response = {
                    jsonrpc: "2.0",
                    id: request.id,
                    // JSON.stringify drops `result: undefined`, which would
                    // produce a spec-invalid response; send an explicit null
                    result: result === undefined ? null : result,
                };
            } catch (error) {
                response = {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: INTERNAL_ERROR,
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                };
            }
        }
        if (this.isClosed) {
            return;
        }
        // sendData wraps outgoing payloads in {internalID, request} and sends
        // `request` verbatim, so a raw response object rides through any
        // transport. Because the response carries an id, the transport tracks
        // it as if it were a request awaiting an answer that never comes; the
        // timeout cleans up that entry and the rejection is expected.
        const internalID = `codemirror-languageserver:server-reply:${this.serverResponseCount++}`;
        try {
            await this.transport.sendData(
                // biome-ignore lint/suspicious/noExplicitAny: a response frame is not part of JSONRPCRequestData
                { internalID, request: response as any },
                this.timeout,
            );
        } catch {
            // Expected: responses get no acknowledgement
        }
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
