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
    showTooltip,
} from "@codemirror/view";
import {
    CompletionTriggerKind,
    DiagnosticSeverity,
    TextDocumentSaveReason,
    TextDocumentSyncKind,
} from "vscode-languageserver-protocol";

import type {
    CompletionContext,
    CompletionResult,
} from "@codemirror/autocomplete";
import {
    Annotation,
    type Extension,
    StateEffect,
    StateField,
} from "@codemirror/state";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type * as LSP from "vscode-languageserver-protocol";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import {
    completionOptionClass,
    convertCompletionItem,
    resolveItemDefaults,
    sortCompletionItems,
} from "./completion.js";
import { documentUri, languageId } from "./config.js";
import {
    type CodeActionsConfig,
    type DefinitionResult,
    type FeatureOptions,
    LanguageServerClient,
    type LanguageServerOptions,
    type LanguageServerWebsocketOptions,
    type Notification,
} from "./lsp.js";
import { WebSocketTransport } from "./transport.js";
import {
    eventsFromChangeSet,
    isCompletionList,
    isEmptyDocumentation,
    offsetToPos,
    posToOffset,
    posToOffsetOrZero,
    prefixMatch,
    renderDocumentation,
    renderMarkdown,
    showErrorMessage,
} from "./utils.js";

const logger = console.log;

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

function uniqueId() {
    return String(Date.now() + Math.random());
}

/**
 * A bare `Command` is executed as-is; only literal `CodeAction`s may carry an
 * edit or be sent to `codeAction/resolve`.
 */
function isBareCommand(
    action: LSP.Command | LSP.CodeAction,
): action is LSP.Command {
    return typeof (action as LSP.Command).command === "string";
}

function comparePosition(a: LSP.Position, b: LSP.Position): number {
    return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

function rangesOverlap(a: LSP.Range, b: LSP.Range): boolean {
    // LSP ranges are end-exclusive, so adjacent ranges do not overlap. Empty
    // ranges are treated as touching points so a zero-length diagnostic still
    // matches actions at its position.
    const aEmpty = comparePosition(a.start, a.end) === 0;
    const bEmpty = comparePosition(b.start, b.end) === 0;
    if (aEmpty || bEmpty) {
        return (
            comparePosition(a.start, b.end) <= 0 &&
            comparePosition(b.start, a.end) <= 0
        );
    }
    return (
        comparePosition(a.start, b.end) < 0 &&
        comparePosition(b.start, a.end) < 0
    );
}

/**
 * Actions that declare the diagnostics they address are matched by range
 * overlap; actions without that metadata attach to every diagnostic.
 */
function actionAppliesToDiagnostic(
    action: LSP.Command | LSP.CodeAction,
    diagnostic: LSP.Diagnostic,
): boolean {
    if (isBareCommand(action)) {
        return true;
    }
    const related = action.diagnostics;
    if (!related || related.length === 0) {
        return true;
    }
    return related.some((d) => rangesOverlap(d.range, diagnostic.range));
}

/**
 * Lint diagnostic carrying the LSP diagnostic it was created from, so
 * codeAction requests can echo the server's diagnostic (with `code`/`data`)
 * back in their context.
 */
interface DiagnosticWithLSP extends Diagnostic {
    lspDiagnostic?: LSP.Diagnostic;
}

/**
 * StateEffect for setting or clearing the signature help tooltip
 */
export const setSignatureHelpTooltip = StateEffect.define<Tooltip | null>();

/**
 * StateField that manages the signature help tooltip state
 * Uses CodeMirror's showTooltip for proper lifecycle management
 */
export const signatureHelpTooltipField = StateField.define<Tooltip | null>({
    create: () => null,
    update(tooltip, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setSignatureHelpTooltip)) {
                return effect.value;
            }
        }
        // Map tooltip position through document changes to keep it anchored correctly
        if (tooltip && tr.docChanged) {
            const newPos = tr.changes.mapPos(tooltip.pos);
            const newEnd =
                tooltip.end != null
                    ? tr.changes.mapPos(tooltip.end)
                    : undefined;
            return { ...tooltip, pos: newPos, end: newEnd };
        }
        return tooltip;
    },
    provide: (field) => showTooltip.from(field),
});
export const suppressSignatureHelp = Annotation.define<boolean>();

const SIGNATURE_TOOLTIP_MAX_LINES_BACK = 20;

/**
 * Maps each editor view to the language server plugins attached to it so
 * hosts can reach plugin methods (e.g. `documentDidSave`) without the private
 * `ViewPlugin` token. Several language servers may attach to one view; the
 * list keeps every live plugin so destroying one still exposes the others.
 */
const pluginRegistry = new WeakMap<EditorView, LanguageServerPlugin[]>();

function registerPlugin(view: EditorView, plugin: LanguageServerPlugin) {
    const plugins = pluginRegistry.get(view);
    if (plugins) {
        plugins.push(plugin);
    } else {
        pluginRegistry.set(view, [plugin]);
    }
}

function unregisterPlugin(view: EditorView, plugin: LanguageServerPlugin) {
    const plugins = pluginRegistry.get(view);
    if (!plugins) {
        return;
    }
    const index = plugins.indexOf(plugin);
    if (index !== -1) {
        plugins.splice(index, 1);
    }
    if (plugins.length === 0) {
        pluginRegistry.delete(view);
    }
}

/**
 * Returns the language server plugin attached to a view, if any. Useful for
 * invoking host-driven actions such as {@link LanguageServerPlugin.documentDidSave}.
 * When multiple servers share a view, the most recently attached live plugin
 * is returned.
 */
export function getLanguageServerPlugin(
    view: EditorView,
): LanguageServerPlugin | undefined {
    const plugins = pluginRegistry.get(view);
    return plugins?.[plugins.length - 1];
}

export class LanguageServerPlugin implements PluginValue {
    private documentVersion: number;
    private pluginId: string;
    private pendingDocumentChanges = new Set<Promise<void>>();
    /**
     * The language server client instance.
     */
    public client: LanguageServerClient;
    /**
     * URI of the current document being edited. If not provided, must be passed via the documentUri facet.
     */
    public documentUri: string;
    /**
     * Language identifier (e.g., 'typescript', 'javascript', etc.). If not provided, must be passed via the languageId facet.
     */
    public languageId: string;
    /**
     * The editor view instance.
     */
    public view: EditorView;
    /**
     * Whether to allow HTML content in hover tooltips and other UI elements.
     */
    public allowHTMLContent: boolean;
    /**
     * Whether to prefer snippet insertion for completions when available.
     */
    public useSnippetOnCompletion: boolean;
    /**
     * Whether complete (`isIncomplete: false`) completion lists are filtered
     * client-side by CodeMirror instead of re-querying the server.
     */
    public clientSideFiltering: boolean;
    /**
     * Whether to send incremental changes to the language server.
     */
    public sendIncrementalChanges: boolean;
    /**
     * Feature options for the language server plugin.
     */
    public featureOptions: Required<FeatureOptions>;
    /**
     * Callback triggered when a go-to-definition action is performed.
     */
    public onGoToDefinition: ((result: DefinitionResult) => void) | undefined;
    /**
     * Callback to render markdown content.
     */
    public markdownRenderer: (markdown: string) => string;
    /**
     * Configuration for the code action menu.
     */
    public codeActionsConfig: CodeActionsConfig | undefined;
    private disposeListener?: () => void;
    private destroyed = false;
    private documentOpened = false;
    /** Dismisses the currently open code action menu, if any. */
    private closeCodeActionMenu?: () => void;

    constructor(opts: {
        client: LanguageServerClient;
        documentUri: string;
        languageId: string;
        view: EditorView;
        featureOptions: Required<FeatureOptions>;
        sendIncrementalChanges?: boolean;
        allowHTMLContent?: boolean;
        useSnippetOnCompletion?: boolean;
        clientSideFiltering?: boolean;
        onGoToDefinition?: (result: DefinitionResult) => void;
        markdownRenderer?: (markdown: string) => string;
        codeActionsConfig?: CodeActionsConfig;
    }) {
        const {
            client,
            documentUri,
            languageId,
            view,
            featureOptions,
            sendIncrementalChanges = true,
            allowHTMLContent = false,
            useSnippetOnCompletion = false,
            clientSideFiltering = false,
            onGoToDefinition,
            markdownRenderer = renderMarkdown,
            codeActionsConfig,
        } = opts;
        this.documentVersion = 0;
        this.pluginId = uniqueId();
        this.client = client;
        this.documentUri = documentUri;
        this.languageId = languageId;
        this.view = view;
        this.allowHTMLContent = allowHTMLContent;
        this.useSnippetOnCompletion = useSnippetOnCompletion;
        this.clientSideFiltering = clientSideFiltering;
        this.sendIncrementalChanges = sendIncrementalChanges;
        this.featureOptions = featureOptions;
        this.onGoToDefinition = onGoToDefinition;
        this.markdownRenderer = markdownRenderer;
        this.codeActionsConfig = codeActionsConfig;
        registerPlugin(view, this);
        this.disposeListener = client.onNotification(
            this.processNotification.bind(this),
        );

        this.initialize().catch((error) => {
            console.error("Language server initialization failed", error);
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

        const syncKind = this.resolveTextDocumentSyncKind();
        if (syncKind === TextDocumentSyncKind.None) {
            return;
        }
        if (
            this.sendIncrementalChanges &&
            syncKind === TextDocumentSyncKind.Incremental
        ) {
            this.trackDocumentChanges(eventsFromChangeSet(doc, changes));
        } else {
            this.trackDocumentChanges([{ text: state.doc.toString() }]);
        }
    }

    private trackDocumentChanges(
        contentChanges: LSP.TextDocumentContentChangeEvent[],
    ) {
        const pending = this.sendChanges(contentChanges);
        this.pendingDocumentChanges.add(pending);
        void pending.finally(() => this.pendingDocumentChanges.delete(pending));
    }

    public destroy() {
        this.destroyed = true;
        this.disposeListener?.();
        this.disposeListener = undefined;
        this.closeCodeActionMenu?.();
        unregisterPlugin(this.view, this);
        this.closeDocument();
    }

    /**
     * Sends `textDocument/didClose` for a document this plugin opened,
     * releasing its reference on the shared client's open-count. Safe to call
     * more than once and before the document was opened.
     */
    private closeDocument() {
        // Only close a document we actually opened - a view torn down during
        // its initial async tick may never have sent didOpen
        if (!(this.documentOpened && this.client.ready)) {
            return;
        }
        this.documentOpened = false;
        Promise.resolve(
            this.client.textDocumentDidClose({
                textDocument: { uri: this.documentUri },
            }),
        ).catch((error) => {
            console.error("Failed to send didClose", error);
        });
    }

    public async initialize({ documentText }: { documentText?: string } = {}) {
        if (this.client.initializePromise) {
            await this.client.initializePromise;
        }
        if (this.destroyed) {
            return;
        }
        await this.client.textDocumentDidOpen({
            textDocument: {
                uri: this.documentUri,
                languageId: this.languageId,
                // Read the document at didOpen time so edits made while the
                // server was still initializing are not lost
                text: documentText ?? this.view.state.doc.toString(),
                version: this.documentVersion,
            },
        });
        this.documentOpened = true;
        // If the view was torn down while didOpen was in flight, destroy() saw
        // documentOpened === false and could not close. Balance the open here
        // so we neither leak the server-side document nor the open ref-count.
        if (this.destroyed) {
            this.closeDocument();
        }
    }

    /**
     * The sync kind the server supports; incremental changes may only be
     * sent when the server announced Incremental sync.
     */
    private resolveTextDocumentSyncKind(): TextDocumentSyncKind {
        const sync = this.client.capabilities?.textDocumentSync;
        if (sync == null) {
            // Server did not advertise the capability; honor the
            // configured behavior
            return this.sendIncrementalChanges
                ? TextDocumentSyncKind.Incremental
                : TextDocumentSyncKind.Full;
        }
        if (typeof sync === "number") {
            return sync;
        }
        // Per the LSP spec, an omitted `change` in TextDocumentSyncOptions
        // means the server wants no change notifications
        return sync.change ?? TextDocumentSyncKind.None;
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

    /**
     * Notifies the language server that the document was (or is about to be)
     * saved. The library has no concept of "save" on its own, so hosts wire
     * this to their own save action.
     *
     * Follows the LSP save handshake, honoring the server's advertised
     * capabilities: willSave -> willSaveWaitUntil (applying returned edits) ->
     * didSave (including the document text when the server requested it).
     */
    public async documentDidSave(
        reason: LSP.TextDocumentSaveReason = TextDocumentSaveReason.Manual,
    ) {
        if (!this.client.ready) {
            return;
        }

        // The save must observe all preceding document updates, otherwise the
        // server may run the save against stale content.
        await Promise.all(this.pendingDocumentChanges);
        if (this.destroyed || !this.client.ready) {
            return;
        }

        const sync = this.client.capabilities?.textDocumentSync;
        // Save-related sub-capabilities only exist on the object form; a plain
        // sync-kind number carries no save information.
        const syncOptions =
            typeof sync === "object" && sync != null ? sync : undefined;

        if (syncOptions?.willSave) {
            try {
                await this.client.textDocumentWillSave({
                    textDocument: { uri: this.documentUri },
                    reason,
                });
            } catch (error) {
                console.error("Failed to send willSave", error);
            }
            if (this.destroyed || !this.client.ready) {
                return;
            }
        }

        if (syncOptions?.willSaveWaitUntil) {
            try {
                const edits = await this.client.textDocumentWillSaveWaitUntil({
                    textDocument: { uri: this.documentUri },
                    reason,
                });
                if (edits && edits.length > 0 && !this.destroyed) {
                    this.applyEdits(this.view, edits);
                    // The applied edits queue their own didChange; make sure
                    // the server sees them before we announce didSave.
                    await Promise.all(this.pendingDocumentChanges);
                }
            } catch (error) {
                console.error("Failed during willSaveWaitUntil", error);
            }
            if (this.destroyed || !this.client.ready) {
                return;
            }
        }

        // Only send didSave if the server registered for it.
        const save = syncOptions?.save;
        if (save == null || save === false) {
            return;
        }
        const includeText = typeof save === "object" && save.includeText;
        try {
            await this.client.textDocumentDidSave({
                textDocument: { uri: this.documentUri },
                text: includeText ? this.view.state.doc.toString() : undefined,
            });
        } catch (error) {
            console.error("Failed to send didSave", error);
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

        if (
            !(
                this.client.ready &&
                this.client.hasCapability("textDocument/hover")
            )
        ) {
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
        renderDocumentation(dom, contents, {
            allowHTMLContent: this.allowHTMLContent,
            markdownRenderer: this.markdownRenderer,
        });
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

        // Completion requests must observe all preceding document updates.
        await Promise.all(this.pendingDocumentChanges);

        if (
            !(
                this.client.ready &&
                this.client.hasCapability("textDocument/completion")
            )
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

        const completionList: LSP.CompletionList = isCompletionList(result)
            ? result
            : { isIncomplete: false, items: result };

        const items = completionList.items.map((item) =>
            resolveItemDefaults(item, completionList.itemDefaults),
        );

        // Incomplete lists must always be re-queried on further input
        const useClientSideFiltering =
            this.clientSideFiltering && !completionList.isIncomplete;

        // Match is undefined if there are no common prefixes
        const match = prefixMatch(items);

        const token = match
            ? // Try prefix-based match, then fall back to general word match
              (context.matchBefore(match) ??
              context.matchBefore(/[a-zA-Z0-9_]+/))
            : // Fallback to matching any word character
              context.matchBefore(/[a-zA-Z0-9_]+/);
        let { pos } = context;

        const sortedItems = sortCompletionItems(
            items,
            token?.text,
            this.languageId,
            !useClientSideFiltering,
        );

        // If we found a token that matches our completion pattern
        if (token) {
            // Set position to the start of the token
            pos = token.from;
        }

        const options = sortedItems.map((item) => {
            return convertCompletionItem(item, {
                allowHTMLContent: this.allowHTMLContent,
                useSnippetOnCompletion: this.useSnippetOnCompletion,
                hasResolveProvider:
                    this.client.capabilities?.completionProvider
                        ?.resolveProvider ?? false,
                resolveItem: this.client.completionItemResolve.bind(
                    this.client,
                ),
            });
        });

        if (useClientSideFiltering) {
            return {
                from: pos,
                options,
                validFor: /^\w*$/,
            };
        }

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
            !(
                this.client.ready &&
                this.client.hasCapability("textDocument/definition")
            )
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

        if (params.version != null) {
            // Ignore stale publishes delivered out of order
            if (params.version < this.lastSeenDiagnosticsVersion) {
                return;
            }
            this.lastSeenDiagnosticsVersion = params.version;
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

        // Snapshot the document so ranges are resolved against the text the
        // server published for, even while code actions load below
        const doc = this.view.state.doc;

        // One codeAction request for the whole publish; results are
        // distributed to diagnostics by range overlap
        let allActions: (LSP.Command | LSP.CodeAction)[] = [];
        try {
            allActions =
                (await this.requestCodeActionsForDiagnostics(
                    params.diagnostics,
                )) ?? [];
        } catch (error) {
            // Diagnostics are still worth showing without their quick fixes
            console.error("Failed to fetch code actions", error);
        }

        // Bail out if this publish is no longer current. Code actions are
        // awaited above, so by now the plugin may have been torn down, a newer
        // publish may have superseded this one, or the document may have
        // changed - in which case the snapshot offsets are stale and would
        // mark unrelated text.
        if (this.destroyed) {
            return;
        }
        if (
            params.version != null &&
            params.version < this.lastSeenDiagnosticsVersion
        ) {
            return;
        }
        if (this.view.state.doc !== doc) {
            return;
        }

        const diagnostics = params.diagnostics.map(
            (lspDiagnostic): Diagnostic | null => {
                const { range, message, severity, code, source } =
                    lspDiagnostic;
                const from = posToOffset(doc, range.start);
                const to = posToOffset(doc, range.end);
                if (from == null || to == null || from > to) {
                    // The range does not exist in this document (e.g. a
                    // stale publish); dropping it beats misplacing it
                    return null;
                }

                const codemirrorActions = allActions
                    .filter((action) =>
                        actionAppliesToDiagnostic(action, lspDiagnostic),
                    )
                    .map(
                        (action): Action => ({
                            name:
                                "command" in action &&
                                typeof action.command === "object"
                                    ? action.command?.title || action.title
                                    : action.title,
                            apply: () => {
                                void this.applyCodeAction(action);
                            },
                        }),
                    );

                const baseSource = source || this.languageId;
                const formattedSource =
                    code != null && code !== ""
                        ? `${baseSource}(${code})`
                        : baseSource;

                const diagnostic: DiagnosticWithLSP = {
                    from,
                    to,
                    severity: severityMap[severity ?? DiagnosticSeverity.Error],
                    message: message,
                    renderMessage: () => {
                        const dom = document.createElement("div");
                        if (this.allowHTMLContent) {
                            dom.innerHTML = this.markdownRenderer(message);
                        } else {
                            dom.textContent = message;
                        }
                        return dom;
                    },
                    source: formattedSource,
                    markClass: this.pluginId,
                    actions:
                        codemirrorActions.length > 0
                            ? codemirrorActions
                            : undefined,
                    lspDiagnostic,
                };

                return diagnostic;
            },
        );

        this.setOwnDiagnostics(
            diagnostics.filter(
                (diagnostic): diagnostic is Diagnostic => diagnostic != null,
            ),
        );
    }

    /**
     * Replaces this plugin's diagnostics while preserving diagnostics
     * added by other sources (e.g. other plugins or linters)
     */
    private setOwnDiagnostics(newDiagnostics: Diagnostic[]) {
        const state = this.view.state;

        const otherDiagnostics: Diagnostic[] = [];
        forEachDiagnostic(state, (diagnostic, from, to) => {
            if (diagnostic.markClass !== this.pluginId) {
                // Use the mapped positions in case the document changed
                otherDiagnostics.push({ ...diagnostic, from, to });
            }
        });

        this.view.dispatch(
            setDiagnostics(state, [...otherDiagnostics, ...newDiagnostics]),
        );
    }

    private clearDiagnostics() {
        this.setOwnDiagnostics([]);
    }

    /**
     * One codeAction request covering a whole publish: the range spans all
     * diagnostics and the context carries the server's diagnostics verbatim.
     */
    private async requestCodeActionsForDiagnostics(
        diagnostics: LSP.Diagnostic[],
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        const first = diagnostics[0];
        if (!first) {
            return null;
        }
        if (!this.featureOptions.codeActionsEnabled) {
            return null;
        }
        if (
            !(
                this.client.ready &&
                this.client.hasCapability("textDocument/codeAction")
            )
        ) {
            return null;
        }

        let start = first.range.start;
        let end = first.range.end;
        for (const diagnostic of diagnostics) {
            if (comparePosition(diagnostic.range.start, start) < 0) {
                start = diagnostic.range.start;
            }
            if (comparePosition(diagnostic.range.end, end) > 0) {
                end = diagnostic.range.end;
            }
        }

        return await this.client.textDocumentCodeAction({
            textDocument: { uri: this.documentUri },
            range: { start, end },
            context: { diagnostics },
        });
    }

    /**
     * Requests code actions for a range, with the overlapping diagnostics in
     * the request context. Hosts can build custom entry points with `only`,
     * e.g. an "Organize imports" button via `["source.organizeImports"]`.
     */
    public async requestCodeActions(
        view: EditorView,
        range: LSP.Range,
        only?: string[],
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        if (!this.featureOptions.codeActionsEnabled) {
            return null;
        }
        if (
            !(
                this.client.ready &&
                this.client.hasCapability("textDocument/codeAction")
            )
        ) {
            return null;
        }

        return await this.client.textDocumentCodeAction({
            textDocument: { uri: this.documentUri },
            range,
            context: {
                diagnostics: this.diagnosticsInRange(view, range),
                ...(only ? { only } : {}),
            },
        });
    }

    /**
     * Requests code actions for the current selection (or the empty range at
     * the cursor), with the overlapping diagnostics in the request context.
     */
    public async requestCodeActionsAtSelection(
        view: EditorView,
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        const { from, to } = view.state.selection.main;
        return await this.requestCodeActions(view, {
            start: offsetToPos(view.state.doc, from),
            end: offsetToPos(view.state.doc, to),
        });
    }

    /**
     * The diagnostics currently shown in the editor that overlap the given
     * range, as LSP diagnostics. Diagnostics this plugin created echo the
     * server's original diagnostic; others are converted from their
     * CodeMirror shape.
     */
    private diagnosticsInRange(
        view: EditorView,
        range: LSP.Range,
    ): LSP.Diagnostic[] {
        const doc = view.state.doc;
        const from = posToOffset(doc, range.start);
        const to = posToOffset(doc, range.end);
        if (from == null || to == null) {
            return [];
        }
        const severityBack: Record<
            NonNullable<Diagnostic["severity"]>,
            DiagnosticSeverity
        > = {
            error: DiagnosticSeverity.Error,
            warning: DiagnosticSeverity.Warning,
            info: DiagnosticSeverity.Information,
            hint: DiagnosticSeverity.Hint,
        };
        const results: LSP.Diagnostic[] = [];
        forEachDiagnostic(view.state, (diagnostic, dFrom, dTo) => {
            if (dFrom > to || dTo < from) {
                return;
            }
            const mappedRange: LSP.Range = {
                start: offsetToPos(doc, dFrom),
                end: offsetToPos(doc, dTo),
            };
            const original = (diagnostic as DiagnosticWithLSP).lspDiagnostic;
            if (original) {
                results.push({ ...original, range: mappedRange });
            } else {
                results.push({
                    range: mappedRange,
                    message: diagnostic.message,
                    severity: severityBack[diagnostic.severity],
                    source: diagnostic.source,
                });
            }
        });
        return results;
    }

    /**
     * Applies a code action: lazily resolves it via `codeAction/resolve` when
     * needed, then applies its workspace edit and/or executes its command.
     */
    public async applyCodeAction(
        action: LSP.Command | LSP.CodeAction,
    ): Promise<void> {
        const resolved = await this.resolveCodeAction(action);
        if (this.destroyed) {
            return;
        }

        if (isBareCommand(resolved)) {
            // TODO: Implement command execution
            logger("Executing command:", resolved);
            return;
        }
        if (resolved.edit) {
            await this.applyWorkspaceEdit(this.view, resolved.edit);
        }
        if (resolved.command) {
            // TODO: Implement command execution
            logger("Executing command:", resolved.command);
        } else if (!resolved.edit) {
            showErrorMessage(
                this.view,
                `Code action "${action.title}" has nothing to apply`,
            );
        }
    }

    /**
     * Resolves a code action via `codeAction/resolve` — only for literal
     * `CodeAction`s missing both `edit` and `command`, and only when the
     * server advertises `resolveProvider`. Falls back to the original action
     * if the request fails.
     */
    private async resolveCodeAction(
        action: LSP.Command | LSP.CodeAction,
    ): Promise<LSP.Command | LSP.CodeAction> {
        if (isBareCommand(action)) {
            return action;
        }
        if (action.edit || action.command) {
            return action;
        }
        if (!this.serverSupportsCodeActionResolve()) {
            return action;
        }
        try {
            return await this.client.codeActionResolve(action);
        } catch (error) {
            console.error("Failed to resolve code action", error);
            return action;
        }
    }

    /**
     * Whether the server can answer `codeAction/resolve`, announced either
     * statically or via a dynamic codeAction registration.
     */
    private serverSupportsCodeActionResolve(): boolean {
        const provider = this.client.capabilities?.codeActionProvider;
        if (typeof provider === "object" && provider.resolveProvider) {
            return true;
        }
        for (const registration of this.client.dynamicCapabilities.values()) {
            if (registration.method === "textDocument/codeAction") {
                const options = registration.registerOptions as
                    | LSP.CodeActionRegistrationOptions
                    | undefined;
                if (options?.resolveProvider) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Requests code actions for the current selection and presents them via
     * the host's `codeActionsConfig.renderMenu` or the built-in popup. Bound
     * to the `codeActions` keyboard shortcut.
     * @returns True when at least one action was shown
     */
    public async showCodeActionsMenu(view: EditorView): Promise<boolean> {
        const requestState = view.state;
        const actions = await this.requestCodeActionsAtSelection(view);
        if (this.destroyed) {
            return false;
        }
        // The document or selection may have moved while the request was in
        // flight; actions for the old context must not be shown
        if (
            view.state.doc !== requestState.doc ||
            !view.state.selection.main.eq(requestState.selection.main)
        ) {
            return false;
        }
        if (!actions || actions.length === 0) {
            showErrorMessage(view, "No code actions available");
            return false;
        }
        const apply = async (action: LSP.Command | LSP.CodeAction) => {
            await this.applyCodeAction(action);
        };
        if (this.codeActionsConfig?.renderMenu) {
            this.codeActionsConfig.renderMenu(actions, apply);
            return true;
        }
        this.showDefaultCodeActionsMenu(view, actions, apply);
        return true;
    }

    /**
     * The built-in code action menu: a small listbox at the cursor, keyboard
     * navigable (ArrowUp/Down, Enter, Escape), dismissed by outside clicks.
     */
    private showDefaultCodeActionsMenu(
        view: EditorView,
        actions: (LSP.Command | LSP.CodeAction)[],
        apply: (action: LSP.Command | LSP.CodeAction) => Promise<void>,
    ): void {
        // Only one menu at a time
        this.closeCodeActionMenu?.();

        const menu = document.createElement("div");
        menu.className = "cm-code-action-menu";
        menu.setAttribute("role", "listbox");
        menu.style.cssText =
            "position: absolute; display: flex; flex-direction: column; padding: 2px; background: white; border: 1px solid #ddd; box-shadow: 0 2px 8px rgba(0,0,0,.15); z-index: 99;";

        const handleOutsideMousedown = (event: MouseEvent) => {
            if (!menu.contains(event.target as Node)) {
                dismiss();
            }
        };
        const dismiss = () => {
            if (this.closeCodeActionMenu === dismiss) {
                this.closeCodeActionMenu = undefined;
            }
            menu.remove();
            document.removeEventListener("mousedown", handleOutsideMousedown);
        };
        this.closeCodeActionMenu = dismiss;

        const buttons = actions.map((action) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "cm-code-action-item";
            item.style.cssText =
                "display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border: none; background: none; text-align: left; cursor: pointer; font: inherit;";
            const title = document.createElement("span");
            title.textContent = action.title;
            item.appendChild(title);
            if (!isBareCommand(action) && action.kind) {
                const kind = document.createElement("span");
                kind.className = "cm-code-action-kind";
                kind.style.cssText =
                    "color: #888; font-size: 85%; margin-left: auto;";
                kind.textContent = action.kind;
                item.appendChild(kind);
            }
            if (!isBareCommand(action) && action.disabled) {
                item.disabled = true;
                item.title = action.disabled.reason;
                item.style.opacity = "0.5";
                item.style.cursor = "default";
            }
            item.addEventListener("click", () => {
                dismiss();
                view.focus();
                void apply(action);
            });
            menu.appendChild(item);
            return item;
        });

        // Roving focus keeps keystrokes out of the editor while the menu is
        // open
        let selected = buttons.findIndex((button) => !button.disabled);
        const focusItem = (index: number) => {
            selected = index;
            buttons[index]?.focus();
        };
        const move = (direction: 1 | -1) => {
            for (
                let i = selected + direction;
                i >= 0 && i < buttons.length;
                i += direction
            ) {
                if (!buttons[i]?.disabled) {
                    focusItem(i);
                    return;
                }
            }
        };
        menu.tabIndex = -1;
        menu.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                dismiss();
                view.focus();
            } else if (event.key === "ArrowDown") {
                move(1);
            } else if (event.key === "ArrowUp") {
                move(-1);
            } else if (event.key === "Enter") {
                const item = buttons[selected];
                if (item && !item.disabled) {
                    item.click();
                }
            } else {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        });

        // Coordinates may be unavailable (view not laid out); still open the
        // menu, just unpositioned
        const coords = view.coordsAtPos(view.state.selection.main.from);
        if (coords) {
            // coordsAtPos returns viewport coordinates; the menu is
            // absolutely positioned in the page
            menu.style.left = `${coords.left + window.scrollX}px`;
            menu.style.top = `${coords.bottom + window.scrollY + 5}px`;
        }

        document.addEventListener("mousedown", handleOutsideMousedown);
        document.body.appendChild(menu);
        if (selected === -1) {
            // Every action is disabled; focus the menu so Escape still works
            menu.focus();
        } else {
            focusItem(selected);
        }
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

        if (!this.client.hasCapability("textDocument/rename")) {
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

            if (!prepareResult) {
                showErrorMessage(view, "Cannot rename this symbol");
                return;
            }

            let renameRange:
                | LSP.Range
                | { range: LSP.Range; placeholder: string };
            if ("defaultBehavior" in prepareResult) {
                // defaultBehavior: true means rename IS possible, using the
                // client's default (word-at-cursor) range
                if (!prepareResult.defaultBehavior) {
                    showErrorMessage(view, "Cannot rename this symbol");
                    return;
                }
                const fallback = this.prepareRenameFallback(view, {
                    line,
                    character,
                });
                if (!fallback) {
                    showErrorMessage(view, "Cannot rename this symbol");
                    return;
                }
                renameRange = fallback;
            } else {
                renameRange = prepareResult;
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
                "range" in renameRange ? renameRange.range : renameRange;
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
                this.client.hasCapability("textDocument/signatureHelp")
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
                above:
                    this.featureOptions.signatureHelpOptions?.position ===
                    "above",
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

        if (this.destroyed) {
            return;
        }

        // Dispatch the tooltip (or null to clear) via StateEffect
        view.dispatch({
            effects: setSignatureHelpTooltip.of(tooltip),
        });
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
            // Find the parameter within the parameter list (after the opening
            // paren) so a label like "s" does not match inside the function
            // name, and highlight it without injecting the label as HTML.
            // When several parameters share the same label text, walk past the
            // earlier parameters so the active occurrence is the one chosen.
            let searchFrom = signatureText.indexOf("(") + 1;
            for (let i = 0; i < activeParameterIndex; i++) {
                const previousLabel = parameters[i]?.label;
                if (typeof previousLabel === "string") {
                    const previousIndex = signatureText.indexOf(
                        previousLabel,
                        searchFrom,
                    );
                    if (previousIndex !== -1) {
                        searchFrom = previousIndex + previousLabel.length;
                    }
                }
            }
            const paramIndex = signatureText.indexOf(paramLabel, searchFrom);
            if (paramIndex !== -1) {
                this.applyRangeHighlighting(
                    signatureElement,
                    signatureText,
                    paramIndex,
                    paramIndex + paramLabel.length,
                );
            } else {
                signatureElement.textContent = signatureText;
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

        renderDocumentation(docsElement, documentation, {
            allowHTMLContent: this.allowHTMLContent,
            markdownRenderer: this.markdownRenderer,
        });

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

        renderDocumentation(paramDocsElement, documentation, {
            allowHTMLContent: this.allowHTMLContent,
            markdownRenderer: this.markdownRenderer,
        });

        return paramDocsElement;
    }

    /**
     * Fallback implementation of prepareRename.
     * We try to find the word at the cursor position and return the range of the word.
     */
    private prepareRenameFallback(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): { range: LSP.Range; placeholder: string } | null {
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
     * Applies a set of LSP text edits to the view in a single transaction.
     * Edits with ranges that do not resolve in the current document are
     * skipped.
     * @returns True if any change was applied
     */
    private applyEdits(view: EditorView, edits: readonly LSP.TextEdit[]) {
        const doc = view.state.doc;
        const changes: { from: number; to: number; insert: string }[] = [];
        for (const edit of edits) {
            const from = posToOffset(doc, edit.range.start);
            const to = posToOffset(doc, edit.range.end);
            if (from == null || to == null || from > to) {
                continue;
            }
            changes.push({ from, to, insert: edit.newText });
        }
        if (changes.length === 0) {
            return false;
        }
        view.dispatch(view.state.update({ changes }));
        return true;
    }

    /**
     * Applies a workspace edit (from rename, code actions, etc.) to the
     * current document in a single transaction. Edits targeting other
     * documents and file create/rename/delete operations are not supported.
     * @param view The editor view
     * @param edit The workspace edit to apply
     * @returns True if changes were applied successfully
     */
    protected async applyWorkspaceEdit(
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
            // Collect every edit for this document so multi-entry edits apply
            // in one transaction; unsupported entries are skipped with a
            // message instead of dropping the whole edit
            const edits: LSP.TextEdit[] = [];
            let skipped: string | null = null;
            for (const docChange of documentChanges) {
                if ("textDocument" in docChange) {
                    if (docChange.textDocument.uri === this.documentUri) {
                        edits.push(...docChange.edits);
                    } else {
                        skipped = "Multi-file edits not supported yet";
                    }
                } else {
                    // CreateFile, RenameFile, or DeleteFile operation
                    skipped =
                        "File creation, deletion, or renaming operations not supported yet";
                }
            }
            if (skipped) {
                showErrorMessage(view, skipped);
            }
            if (edits.length === 0) {
                return false;
            }
            return this.applyEdits(view, edits);
        }

        // Fall back to changes if documentChanges is not available
        let applied = false;
        for (const [uri, changes] of Object.entries(changesMap)) {
            if (uri !== this.documentUri) {
                showErrorMessage(view, "Multi-file edits not supported yet");
                continue;
            }
            applied = this.applyEdits(view, changes) || applied;
        }
        return applied;
    }

    /** @deprecated Use {@link applyWorkspaceEdit}. */
    protected async applyRenameEdit(
        view: EditorView,
        edit: LSP.WorkspaceEdit | null,
    ): Promise<boolean> {
        return this.applyWorkspaceEdit(view, edit);
    }
}

export function languageServer(options: LanguageServerWebsocketOptions) {
    const { serverUri, ...rest } = options;
    return languageServerWithClient({
        ...rest,
        client: new LanguageServerClient({
            ...options,
            transport: new WebSocketTransport(serverUri),
        }),
    });
}

export function languageServerWithClient(options: LanguageServerOptions) {
    const shortcuts = {
        rename: "F2",
        goToDefinition: "F12",
        signatureHelp: "Mod-Shift-Space",
        codeActions: "Mod-.",
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
        signatureHelpOptions: {
            position: "below",
        },
        // Override defaults with provided options
        ...options,
    };

    // Each editor view gets its own plugin instance; look it up through the
    // view so that several views sharing these extensions do not interfere
    const lspViewPlugin = ViewPlugin.define(
        (view) =>
            new LanguageServerPlugin({
                client: lsClient,
                documentUri:
                    options.documentUri ?? view.state.facet(documentUri),
                languageId: options.languageId ?? view.state.facet(languageId),
                view,
                featureOptions: featuresOptions,
                sendIncrementalChanges: options.sendIncrementalChanges,
                allowHTMLContent: options.allowHTMLContent,
                useSnippetOnCompletion: options.useSnippetOnCompletion,
                clientSideFiltering: options.clientSideFiltering,
                onGoToDefinition: options.onGoToDefinition,
                markdownRenderer: options.markdownRenderer,
                codeActionsConfig: options.codeActionsConfig,
            }),
    );
    const getPlugin = (view: EditorView) => view.plugin(lspViewPlugin);

    // Create base extensions array
    const extensions: Extension[] = [lspViewPlugin];

    // Add shortcuts
    extensions.push(
        keymap.of([
            {
                key: shortcuts.signatureHelp,
                run: (view) => {
                    const plugin = getPlugin(view);
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
                    const plugin = getPlugin(view);
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
                key: shortcuts.codeActions,
                run: (view) => {
                    const plugin = getPlugin(view);
                    if (!(plugin && featuresOptions.codeActionsEnabled))
                        return false;

                    plugin
                        .showCodeActionsMenu(view)
                        .catch((error) =>
                            showErrorMessage(
                                view,
                                `Code actions failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                            ),
                        );
                    return true;
                },
            },
            {
                key: shortcuts.goToDefinition,
                run: (view) => {
                    const plugin = getPlugin(view);
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
                const plugin = getPlugin(view);
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
        extensions.push(signatureHelpTooltipField);

        const hideSignatureHelpTooltip = (view: EditorView): boolean => {
            const tooltip = view.state.field(signatureHelpTooltipField);
            if (tooltip) {
                view.dispatch({
                    effects: setSignatureHelpTooltip.of(null),
                });
                return true;
            }
            return false;
        };

        // Dismiss signature help on mousedown
        extensions.push(
            EditorView.domEventHandlers({
                mousedown: (_, view) => {
                    hideSignatureHelpTooltip(view);
                    // Return false to let the click proceed normally
                    return false;
                },
            }),
        );

        extensions.push(
            keymap.of([
                {
                    // Dismiss tooltip when closing paren is typed
                    key: ")",
                    run: (view) => {
                        hideSignatureHelpTooltip(view);
                        // Return false to let the character be inserted
                        return false;
                    },
                },
                {
                    // Or when Escape key is pressed
                    key: "Escape",
                    run: (view) => {
                        // Return what hideSignatureHelpTooltip returns
                        return hideSignatureHelpTooltip(view);
                    },
                },
            ]),
        );

        // Smart dismissal: detect when cursor moves outside the function call context
        // and dismiss the signature help tooltip.
        extensions.push(
            EditorView.updateListener.of((update) => {
                if (
                    !(
                        getPlugin(update.view) &&
                        featuresOptions.signatureActivateOnTyping
                    )
                )
                    return;

                const tooltip = update.state.field(signatureHelpTooltipField);
                if (!tooltip) return;

                // Only check when selection or doc changed
                const hasChange = update.selectionSet || update.docChanged;
                if (!hasChange) return;

                const cursorPos = update.state.selection.main.head;

                // If not inside any parentheses, dismiss
                if (!isCursorInsideFunctionCall(update.state.doc, cursorPos)) {
                    // Dispatching is not allowed while an update is in
                    // progress, so defer the dismissal
                    queueMicrotask(() => {
                        hideSignatureHelpTooltip(update.view);
                    });
                }
            }),
        );

        extensions.push(
            EditorView.updateListener.of(async (update) => {
                const plugin = getPlugin(update.view);
                if (!(plugin && update.docChanged)) return;

                if (
                    update.transactions.some((tr) =>
                        tr.annotation(suppressSignatureHelp),
                    )
                )
                    return;

                // Early exit if signature help capability is not supported
                if (!plugin.client.hasCapability("textDocument/signatureHelp"))
                    return;

                // Only proceed if signatureActivateOnTyping is enabled
                if (!featuresOptions.signatureActivateOnTyping) return;

                const triggerChars = plugin.client.capabilities
                    ?.signatureHelpProvider?.triggerCharacters || ["(", ","];

                // Check if changes include trigger characters
                const changes = update.changes;
                let triggerPos = -1;
                let triggerCharacter: string | undefined;

                changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
                    if (triggerPos >= 0) return; // Skip if already found a trigger

                    const result = getSignatureHelpTriggerPosition(
                        inserted.toString(),
                        fromB,
                        triggerChars,
                    );

                    if (result) {
                        triggerPos = result.triggerPos;
                        triggerCharacter = result.triggerCharacter;
                    }
                });

                if (triggerPos >= 0) {
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
        const userOptionClass = options.completionConfig?.optionClass;
        extensions.push(
            // Hosts can override via `.cm-tooltip-autocomplete li.cm-deprecated`
            EditorView.baseTheme({
                ".cm-tooltip-autocomplete li.cm-deprecated .cm-completionLabel":
                    {
                        textDecoration: "line-through",
                    },
            }),
            autocompletion({
                ...options.completionConfig,
                optionClass: (completion) =>
                    [
                        completionOptionClass(completion),
                        userOptionClass?.(completion) ?? "",
                    ]
                        .filter(Boolean)
                        .join(" "),
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
                        const plugin = context.view
                            ? getPlugin(context.view)
                            : null;
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
                    const plugin = getPlugin(view);
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
    // Implicit completion that wasn't caused by a trigger character requires a
    // matching prefix. Explicit completion may query with an empty prefix.
    if (
        !explicit &&
        triggerKind === CompletionTriggerKind.Invoked &&
        !context.matchBefore(matchBeforePattern || /(\w+|\w+\.|\/|,)$/)
    ) {
        return null;
    }

    return { triggerKind, triggerCharacter };
}

/**
 * Calculates the trigger position for signature help based on inserted text.
 *
 * This function finds the first trigger character in the inserted text and returns
 * the position right after it. This is important for handling auto-bracket completion
 * where "()" is inserted at once - we want the position after "(", not after ")".
 *
 * @param insertedText The text that was inserted
 * @param fromB The start position of the insertion in the document
 * @param triggerChars Array of characters that trigger signature help (e.g., ["(", ","])
 * @returns Object with triggerPos and triggerCharacter, or null if no trigger found
 */
export function getSignatureHelpTriggerPosition(
    insertedText: string,
    fromB: number,
    triggerChars: string[],
): { triggerPos: number; triggerCharacter: string } | null {
    if (!insertedText) return null;

    for (const char of triggerChars) {
        const charIndex = insertedText.indexOf(char);
        if (charIndex !== -1) {
            return {
                // Position right after the trigger character
                triggerPos: fromB + charIndex + 1,
                triggerCharacter: char,
            };
        }
    }

    return null;
}

/**
 * Calculates the parentheses balance in a string.
 * Used to determine if the cursor is inside a function call.
 *
 * @param text The text to scan for parentheses
 * @returns The balance: positive means inside parens, zero/negative means outside
 */
export function getParenthesesBalance(text: string): number {
    let balance = 0;
    for (const char of text) {
        if (char === "(") balance++;
        else if (char === ")") balance--;
    }
    return balance;
}

/**
 * Checks if the cursor is inside a function call by counting parentheses balance.
 * Scans backwards from cursor position up to maxLinesBack lines.
 *
 * @param doc The CodeMirror document
 * @param cursorPos The current cursor position
 * @param maxLinesBack Maximum number of lines to scan backwards (default: 20)
 * @returns true if cursor appears to be inside a function call
 */
export function isCursorInsideFunctionCall(
    doc: {
        lineAt: (pos: number) => { number: number; from: number };
        line: (n: number) => { from: number };
        sliceString: (from: number, to: number) => string;
    },
    cursorPos: number,
    maxLinesBack = SIGNATURE_TOOLTIP_MAX_LINES_BACK,
): boolean {
    const currentLine = doc.lineAt(cursorPos);
    const startLine = Math.max(1, currentLine.number - maxLinesBack);
    const startPos = doc.line(startLine).from;
    const textToScan = doc.sliceString(startPos, cursorPos);
    return getParenthesesBalance(textToScan) > 0;
}
