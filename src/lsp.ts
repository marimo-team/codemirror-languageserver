import type { autocompletion } from "@codemirror/autocomplete";
import type { hoverTooltip } from "@codemirror/view";
import type * as LSP from "vscode-languageserver-protocol";
import {
    ErrorCodes,
    JSONRPCClient,
    type JSONRPCRequest,
    type JSONRPCResponse,
    type Transport,
} from "./jsonrpc.js";

const TIMEOUT = 10000;
const MAX_LOGGED_SERVER_MESSAGE_LENGTH = 2048;
const SERVER_MESSAGE_PREFIX = "Language server: ";

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
    "codeAction/resolve": [LSP.CodeAction, LSP.CodeAction];
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
    /** Keyboard shortcut for the code action menu (default: Ctrl/Cmd+.) */
    codeActions?: string;
}

/**
 * Configuration for the cursor-triggered code action menu
 */
export interface CodeActionsConfig {
    /**
     * Replaces the built-in menu: the host renders the actions and calls
     * `apply` with the chosen one (resolve and edit/command application
     * happen inside `apply`).
     */
    renderMenu?: (
        actions: (LSP.Command | LSP.CodeAction)[],
        apply: (action: LSP.Command | LSP.CodeAction) => Promise<void>,
    ) => void;
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

/**
 * A source location the host is asked to reveal, e.g. a diagnostic's
 * "declared here" related-information link that points outside the current
 * document.
 */
export interface ShowLocationResult {
    /** URI of the document containing the location */
    uri: string;
    /** Range within the document to reveal */
    range: LSP.Range;
    /** Whether the location is in a different file than the current document */
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
    /** Configuration for the code action menu */
    codeActionsConfig?: CodeActionsConfig;
    /** Callback triggered when a go-to-definition action is performed */
    onGoToDefinition?: (result: DefinitionResult) => void;
    /**
     * Callback triggered when the user activates a diagnostic's related-
     * information entry that points to another document. Same-document entries
     * are handled internally (selection + scroll); this is only invoked for
     * external locations the host must open itself.
     */
    onShowLocation?: (result: ShowLocationResult) => void;

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
     * When the server returns a complete (`isIncomplete: false`) completion
     * list, let CodeMirror filter it client-side as the user types instead
     * of re-querying the server on every keystroke.
     * @default false
     */
    clientSideFiltering?: boolean;

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
    /** The client capabilities sent with `initialize`. */
    private advertisedCapabilities?: LSP.ClientCapabilities;

    public initializePromise: Promise<void>;
    private rootUri: string;
    private workspaceFolders: LSP.WorkspaceFolder[] | null;
    private timeout: number;

    private client: JSONRPCClient;
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
        if (!rootUri) {
            throw new Error("rootUri must be a non-empty URI");
        }
        this.rootUri = rootUri;
        this.workspaceFolders = workspaceFolders;
        this.initializationOptions = initializationOptions;
        this.clientCapabilities = capabilities;
        this.timeout = timeout;
        this.ready = false;
        this.capabilities = null;
        this.client = new JSONRPCClient(transport);

        this.client.onNotification((notification) => {
            this.processNotification(notification as unknown as Notification);
        });
        this.client.onRequest((request) => {
            void this.handleServerRequest(request);
        });

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
                const registrations = params?.registrations;
                if (!Array.isArray(registrations)) {
                    return null;
                }
                for (const registration of registrations) {
                    if (
                        !registration ||
                        typeof registration.id !== "string" ||
                        registration.id.length === 0 ||
                        typeof registration.method !== "string" ||
                        this.dynamicCapabilities.has(registration.id)
                    ) {
                        continue;
                    }
                    this.dynamicCapabilities.set(registration.id, registration);
                }
                return null;
            },
        );
        this.onRequest(
            "client/unregisterCapability",
            (params: LSP.UnregistrationParams) => {
                // "unregisterations" is a spelling mistake baked into the LSP spec
                const unregisterations = params?.unregisterations;
                if (!Array.isArray(unregisterations)) {
                    return null;
                }
                for (const unregistration of unregisterations) {
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
                    const message = String(params.message)
                        .replace(
                            // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing server-controlled log text
                            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
                            "",
                        )
                        .slice(
                            0,
                            MAX_LOGGED_SERVER_MESSAGE_LENGTH -
                                SERVER_MESSAGE_PREFIX.length,
                        );
                    console.info(`${SERVER_MESSAGE_PREFIX}${message}`);
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
                        deprecatedSupport: true,
                        preselectSupport: false,
                        insertReplaceSupport: true,
                        tagSupport: {
                            // CompletionItemTag.Deprecated
                            valueSet: [1],
                        },
                        resolveSupport: {
                            properties: [
                                "documentation",
                                "detail",
                                "additionalTextEdits",
                            ],
                        },
                    },
                    completionList: {
                        itemDefaults: [
                            "commitCharacters",
                            "editRange",
                            "insertTextFormat",
                            "insertTextMode",
                            "data",
                        ],
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
                publishDiagnostics: {
                    relatedInformation: true,
                    // DiagnosticTag.Unnecessary (1) and .Deprecated (2)
                    tagSupport: { valueSet: [1, 2] },
                    versionSupport: true,
                    codeDescriptionSupport: true,
                    // Preserve the `data` field between publishDiagnostics and
                    // codeAction so servers can round-trip fix context
                    dataSupport: true,
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
        const options = this.getInitializationOptions();
        this.advertisedCapabilities = (
            options as { capabilities?: LSP.ClientCapabilities } | undefined
        )?.capabilities;
        const result = await this.request(
            "initialize",
            options,
            this.timeout * 3,
        );
        if (
            !result ||
            typeof result !== "object" ||
            !("capabilities" in result) ||
            typeof result.capabilities !== "object" ||
            result.capabilities === null
        ) {
            throw new Error(
                "Invalid initialize response: missing server capabilities",
            );
        }
        // The client may have been closed while initialize was in flight;
        // don't send `initialized` on a dead transport or revive `ready`
        if (this.isClosed) {
            return;
        }
        this.capabilities = result.capabilities;
        this.notify("initialized", {});
        this.ready = true;
    }

    public close() {
        if (this.isClosed) {
            return;
        }
        this.isClosed = true;
        this.ready = false;
        this.notificationListeners.clear();
        this.serverRequestHandlers.clear();
        this.dynamicCapabilities.clear();
        this.documentOpenCounts.clear();
        if (this.capabilities) {
            // Per the LSP lifecycle, `exit` follows the shutdown *response*.
            // Tearing the transport down immediately would cut the server off
            // mid-shutdown, so wait for it - bounded by the request timeout,
            // and unblocked by the rejection when it expires.
            void this.client
                .request("shutdown", null, this.timeout)
                .catch(() => {})
                .then(() => {
                    this.client.notify("exit", undefined).catch(() => {});
                    this.client.close();
                });
            return;
        }
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
     * Whether the server is still free to announce this method through
     * `client/registerCapability`, which arrives after the initialize
     * response. Only true for features this client advertised
     * `dynamicRegistration` for; for anything else the initialize response is
     * the final word.
     */
    private mayRegisterDynamically(method: string): boolean {
        const [scope, feature] = method.split("/");
        if (scope !== "textDocument" || !feature) {
            return false;
        }
        const textDocument = this.advertisedCapabilities?.textDocument as
            | Record<string, { dynamicRegistration?: boolean } | undefined>
            | undefined;
        return textDocument?.[feature]?.dynamicRegistration === true;
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
     * Answers a server-initiated request by running its registered handler and
     * sending the result (or error) back to the server. Requests with no
     * handler get a spec-compliant `MethodNotFound` so servers can fall back
     * gracefully.
     */
    private async handleServerRequest(request: JSONRPCRequest): Promise<void> {
        const handler = this.serverRequestHandlers.get(request.method);
        let response: JSONRPCResponse;
        if (!handler) {
            response = {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                    code: ErrorCodes.MethodNotFound,
                    message: `Method not found: ${request.method}`,
                },
            };
        } else {
            try {
                const result = await handler(request.params);
                response = {
                    jsonrpc: "2.0",
                    id: request.id,
                    // A JSON-RPC result member is required; coerce a handler's
                    // undefined to an explicit null.
                    result: result === undefined ? null : result,
                };
            } catch (error) {
                response = {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: ErrorCodes.InternalError,
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
        // An async handler may finish after the transport closed; swallow the
        // resulting send failure so teardown is not an unhandled rejection.
        void this.client.respond(response).catch(() => {});
    }

    /**
     * @returns Whether this call sent `didOpen`. Additional views onto an
     * already-open document share the server's single open and resolve
     * `false`, meaning the server never saw *this* caller's text.
     */
    public textDocumentDidOpen(
        params: LSP.DidOpenTextDocumentParams,
    ): Promise<boolean> {
        const uri = params.textDocument.uri;
        const previous = this.documentOpenCounts.get(uri) ?? 0;
        this.documentOpenCounts.set(uri, previous + 1);
        // Additional views onto an already-open document share the server's
        // single open; only the first view sends didOpen.
        if (previous > 0) {
            return Promise.resolve(false);
        }
        return this.notify("textDocument/didOpen", params).then(() => true);
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

    public async codeActionResolve(action: LSP.CodeAction) {
        return await this.request("codeAction/resolve", action, this.timeout);
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
        if (method === "initialize") {
            return this.client.request(method, params, timeout) as Promise<
                LSPRequestMap[K][1]
            >;
        }
        // A capability the server has since dropped still counts, so a request
        // issued while it was advertised is not failed by a later change.
        const capabilityWasAvailable = this.hasCapability(method);
        // A request made before the handshake answered cannot be judged by the
        // initialize response alone when a dynamic registration for it may
        // still be on its way.
        const registrationMayBePending =
            !(this.ready || this.capabilities) &&
            this.mayRegisterDynamically(method);
        return this.initializePromise.then(() => {
            if (this.isClosed) {
                throw new Error("Language server client is closed");
            }
            if (
                METHOD_TO_STATIC_CAPABILITY[method] &&
                !registrationMayBePending &&
                !(capabilityWasAvailable || this.hasCapability(method))
            ) {
                throw new Error(
                    `Language server does not support method ${method}`,
                );
            }
            return this.client.request(method, params, timeout) as Promise<
                LSPRequestMap[K][1]
            >;
        });
    }

    protected notify<K extends keyof LSPNotifyMap>(
        method: K,
        params: LSPNotifyMap[K],
    ): Promise<void> {
        return this.client.notify(method, params);
    }

    protected processNotification(notification: Notification) {
        for (const l of this.notificationListeners) {
            try {
                Promise.resolve(l(notification)).catch((error) => {
                    console.error("Notification listener failed", error);
                });
            } catch (error) {
                // One faulty listener must not starve the others
                console.error("Notification listener failed", error);
            }
        }
    }
}
