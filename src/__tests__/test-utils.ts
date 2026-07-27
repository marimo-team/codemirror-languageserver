import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../lsp.js";
import type { FeatureOptions } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

export const featureOptions: Required<FeatureOptions> = {
    diagnosticsEnabled: true,
    hoverEnabled: true,
    completionEnabled: true,
    definitionEnabled: true,
    renameEnabled: true,
    codeActionsEnabled: false,
    signatureHelpEnabled: true,
    signatureActivateOnTyping: false,
    signatureHelpOptions: { position: "below" },
};

interface FakeClientOverrides {
    ready?: boolean;
    capabilities?: LSP.ServerCapabilities;
    initializePromise?: Promise<void>;
}

export function createFakeClient(overrides: FakeClientOverrides = {}) {
    return {
        ready: overrides.ready ?? true,
        capabilities: overrides.capabilities ?? {
            hoverProvider: true,
            renameProvider: true,
        },
        dynamicCapabilities: new Map(),
        hasCapability: LanguageServerClient.prototype.hasCapability,
        initializePromise: overrides.initializePromise ?? Promise.resolve(),
        onNotification: vi.fn().mockReturnValue(() => {}),
        textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
        textDocumentDidChange: vi.fn().mockResolvedValue(undefined),
        textDocumentDidClose: vi.fn().mockResolvedValue(undefined),
        textDocumentWillSave: vi.fn().mockResolvedValue(undefined),
        textDocumentWillSaveWaitUntil: vi.fn().mockResolvedValue(null),
        textDocumentDidSave: vi.fn().mockResolvedValue(undefined),
        textDocumentCodeAction: vi.fn().mockResolvedValue(null),
        codeActionResolve: vi.fn(),
        textDocumentPrepareRename: vi.fn(),
        textDocumentRename: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: partial test stub
    } as any as LanguageServerClient;
}

export const defaultCompletionOptions = {
    allowHTMLContent: false,
    useSnippetOnCompletion: false,
    hasResolveProvider: false,
    resolveItem: vi.fn(),
};

export function createView(doc: string): EditorView {
    return new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
}

export function createPlugin(
    view: EditorView,
    client = createFakeClient(),
    options: Partial<
        ConstructorParameters<typeof LanguageServerPlugin>[0]
    > = {},
) {
    return new LanguageServerPlugin({
        client,
        documentUri: "file:///test.ts",
        languageId: "typescript",
        view,
        featureOptions: { ...featureOptions },
        ...options,
    });
}

export async function flushTicks(count = 5) {
    for (let index = 0; index < count; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

export function stubClient(
    client: LanguageServerClient,
    methods: Record<string, unknown>,
): void {
    Object.assign(client, methods);
}

export function fakeUpdate(
    view: EditorView,
    previousDoc: string,
    insert: string,
) {
    const previousState = EditorState.create({ doc: previousDoc });
    const changes = previousState.changes({
        from: previousDoc.length,
        insert,
    });
    return {
        state: view.state,
        docChanged: true,
        startState: previousState,
        changes,
        // biome-ignore lint/suspicious/noExplicitAny: minimal ViewUpdate stub
    } as any;
}
