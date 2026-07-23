import { forEachDiagnostic, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import type { FeatureOptions, LanguageServerClient } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

const featureOptions: Required<FeatureOptions> = {
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

function createFakeClient(overrides: FakeClientOverrides = {}) {
    return {
        ready: overrides.ready ?? true,
        capabilities: overrides.capabilities ?? {
            hoverProvider: true,
            renameProvider: true,
        },
        initializePromise: overrides.initializePromise ?? Promise.resolve(),
        onNotification: vi.fn().mockReturnValue(() => {}),
        textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
        textDocumentDidChange: vi.fn().mockResolvedValue(undefined),
        textDocumentDidClose: vi.fn().mockResolvedValue(undefined),
        textDocumentCodeAction: vi.fn().mockResolvedValue(null),
        textDocumentPrepareRename: vi.fn(),
        textDocumentRename: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: partial stub of the client
    } as any as LanguageServerClient;
}

function createView(doc: string): EditorView {
    return new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
}

function createPlugin(
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
        featureOptions,
        ...options,
    });
}

async function flushTicks(count = 5) {
    for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function countDiagnostics(view: EditorView): { from: number; to: number }[] {
    const found: { from: number; to: number }[] = [];
    forEachDiagnostic(view.state, (_d, from, to) => {
        found.push({ from, to });
    });
    return found;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("document open synchronization", () => {
    it("sends the current document text at didOpen time, not a stale snapshot", async () => {
        let resolveInit: () => void = () => {};
        const initializePromise = new Promise<void>((resolve) => {
            resolveInit = resolve;
        });
        const client = createFakeClient({ ready: false, initializePromise });
        const view = createView("hello");
        createPlugin(view, client);

        // User types while the server is still initializing
        view.dispatch({ changes: { from: 5, insert: " world" } });

        // biome-ignore lint/suspicious/noExplicitAny: mutating stub state
        (client as any).ready = true;
        resolveInit();
        await flushTicks();

        expect(client.textDocumentDidOpen).toHaveBeenCalledWith({
            textDocument: expect.objectContaining({
                uri: "file:///test.ts",
                text: "hello world",
            }),
        });
    });
});

describe("destroy lifecycle", () => {
    it("sends textDocument/didClose on destroy once the document was opened", async () => {
        const client = createFakeClient();
        const view = createView("hello");
        const plugin = createPlugin(view, client);
        // Let the initial didOpen complete
        await flushTicks();

        plugin.destroy();

        expect(client.textDocumentDidClose).toHaveBeenCalledWith({
            textDocument: { uri: "file:///test.ts" },
        });
    });

    it("does not send didClose when destroyed before the document was opened", async () => {
        let resolveInit: () => void = () => {};
        const initializePromise = new Promise<void>((resolve) => {
            resolveInit = resolve;
        });
        const client = createFakeClient({ initializePromise });
        const view = createView("hello");
        const plugin = createPlugin(view, client);

        // Destroy before initialize (and therefore didOpen) has resolved
        plugin.destroy();
        resolveInit();
        await flushTicks();

        expect(client.textDocumentDidOpen).not.toHaveBeenCalled();
        expect(client.textDocumentDidClose).not.toHaveBeenCalled();
    });

    it("does not dispatch diagnostics after destroy", async () => {
        const client = createFakeClient();
        const view = createView("hello");
        const plugin = createPlugin(view, client);
        const dispatchSpy = vi.spyOn(view, "dispatch");

        const pending = plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 5 },
                    },
                    message: "late diagnostic",
                },
            ],
        });
        plugin.destroy();
        await pending;

        expect(dispatchSpy).not.toHaveBeenCalled();
    });
});

describe("diagnostics processing", () => {
    it("ignores stale publishes with an older version", async () => {
        const view = createView("hello");
        const plugin = createPlugin(view);
        const range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
        };

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 5,
            diagnostics: [{ range, message: "current" }],
        });
        expect(countDiagnostics(view)).toHaveLength(1);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 3,
            diagnostics: [
                { range, message: "stale one" },
                { range, message: "stale two" },
            ],
        });
        // The stale publish must not replace the newer diagnostics
        expect(countDiagnostics(view)).toHaveLength(1);
    });

    it("drops diagnostics with ranges outside the document instead of anchoring at 0", async () => {
        const view = createView("hello");
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        // Stale range from before the doc shrank
                        start: { line: 5, character: 2 },
                        end: { line: 5, character: 8 },
                    },
                    message: "stale",
                },
                {
                    range: {
                        start: { line: 0, character: 1 },
                        end: { line: 0, character: 3 },
                    },
                    message: "valid",
                },
            ],
        });

        const diagnostics = countDiagnostics(view);
        expect(diagnostics).toEqual([{ from: 1, to: 3 }]);
    });

    it("drops a batch when the document changes while it is resolving", async () => {
        const view = createView("hello");
        const plugin = createPlugin(view);
        const range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
        };

        const pending = plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 1,
            diagnostics: [{ range, message: "resolved against old doc" }],
        });
        // The user edits before the batch commits, invalidating the snapshot
        // offsets the diagnostics were resolved against
        view.dispatch({ changes: { from: 0, to: 5, insert: "hi" } });
        await pending;

        // Stale batch is dropped rather than marking unrelated text
        expect(countDiagnostics(view)).toHaveLength(0);
    });

    it("preserves diagnostics from other sources", async () => {
        const view = createView("hello");
        const plugin = createPlugin(view);

        // Another linter's diagnostic already in the editor
        view.dispatch(
            setDiagnostics(view.state, [
                {
                    from: 0,
                    to: 2,
                    severity: "warning",
                    message: "from another linter",
                    source: "other-linter",
                },
            ]),
        );

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 1,
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 3 },
                        end: { line: 0, character: 5 },
                    },
                    message: "from lsp",
                },
            ],
        });
        expect(countDiagnostics(view)).toHaveLength(2);

        // A new publish replaces only this plugin's diagnostics
        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 2,
            diagnostics: [],
        });
        const remaining = countDiagnostics(view);
        expect(remaining).toEqual([{ from: 0, to: 2 }]);
    });
});

function stubCoords(view: EditorView) {
    // jsdom cannot compute text coordinates
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    });
}

describe("rename", () => {
    it("proceeds with the fallback word range when prepareRename returns defaultBehavior", async () => {
        const client = createFakeClient();
        // biome-ignore lint/suspicious/noExplicitAny: stub
        (client.textDocumentPrepareRename as any).mockResolvedValue({
            defaultBehavior: true,
        });
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);

        await plugin.requestRename(view, { line: 0, character: 1 });

        const popup = document.querySelector(".cm-rename-popup");
        expect(popup).not.toBeNull();
        const input = popup?.querySelector("input");
        expect(input?.value).toBe("hello");
    });

    it("reports an error when prepareRename returns defaultBehavior: false", async () => {
        const client = createFakeClient();
        // biome-ignore lint/suspicious/noExplicitAny: stub
        (client.textDocumentPrepareRename as any).mockResolvedValue({
            defaultBehavior: false,
        });
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);

        await plugin.requestRename(view, { line: 0, character: 1 });

        expect(document.querySelector(".cm-rename-popup")).toBeNull();
    });

    it("returns true after applying a WorkspaceEdit using the changes map", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        // biome-ignore lint/suspicious/noExplicitAny: accessing protected member in test
        const applied = await (plugin as any).applyRenameEdit(view, {
            changes: {
                "file:///test.ts": [
                    {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 5 },
                        },
                        newText: "howdy",
                    },
                ],
            },
        });

        expect(applied).toBe(true);
        expect(view.state.doc.toString()).toBe("howdy world");
    });
});

describe("signature help parameter highlighting", () => {
    it("highlights the active parameter, not an earlier substring match", () => {
        const view = createView("sum(1, 2)");
        const plugin = createPlugin(view);

        // biome-ignore lint/suspicious/noExplicitAny: accessing private member in test
        const element: HTMLElement = (plugin as any).createSignatureElement(
            {
                label: "sum(a, s)",
                parameters: [{ label: "a" }, { label: "s" }],
            },
            1,
        );

        expect(element.textContent).toBe("sum(a, s)");
        const highlighted = element.querySelector(".cm-signature-active-param");
        expect(highlighted?.textContent).toBe("s");
        // The "s" of "sum" must not be the highlighted one: everything before
        // the highlight must still contain the full function name
        expect(element.innerHTML.indexOf("sum(a, ")).toBe(0);
    });

    it("does not inject HTML from parameter labels", () => {
        const view = createView("f(x)");
        const plugin = createPlugin(view, createFakeClient(), {
            allowHTMLContent: true,
        });

        // biome-ignore lint/suspicious/noExplicitAny: accessing private member in test
        const element: HTMLElement = (plugin as any).createSignatureElement(
            {
                label: "f(<img src=x onerror=alert(1)>)",
                parameters: [{ label: "<img src=x onerror=alert(1)>" }],
            },
            0,
        );

        expect(element.querySelector("img")).toBeNull();
    });
});

describe("document change synchronization", () => {
    function fakeUpdate(view: EditorView, prevDoc: string, insert: string) {
        const prevState = EditorState.create({ doc: prevDoc });
        const changes = prevState.changes({
            from: prevDoc.length,
            insert,
        });
        return {
            state: view.state,
            docChanged: true,
            startState: prevState,
            changes,
            // biome-ignore lint/suspicious/noExplicitAny: minimal ViewUpdate stub
        } as any;
    }

    it("sends full text when the server only supports full sync", () => {
        const client = createFakeClient({
            capabilities: { textDocumentSync: 1 },
        });
        const view = createView("hello!");
        const plugin = createPlugin(view, client, {
            sendIncrementalChanges: true,
        });

        plugin.update(fakeUpdate(view, "hello", "!"));

        expect(client.textDocumentDidChange).toHaveBeenCalledWith(
            expect.objectContaining({
                contentChanges: [{ text: "hello!" }],
            }),
        );
    });

    it("sends incremental changes when the server supports them", () => {
        const client = createFakeClient({
            capabilities: { textDocumentSync: 2 },
        });
        const view = createView("hello!");
        const plugin = createPlugin(view, client, {
            sendIncrementalChanges: true,
        });

        plugin.update(fakeUpdate(view, "hello", "!"));

        expect(client.textDocumentDidChange).toHaveBeenCalledWith(
            expect.objectContaining({
                contentChanges: [
                    {
                        range: {
                            start: { line: 0, character: 5 },
                            end: { line: 0, character: 5 },
                        },
                        text: "!",
                    },
                ],
            }),
        );
    });

    it("sends nothing when the server disables sync", () => {
        const client = createFakeClient({
            capabilities: { textDocumentSync: 0 },
        });
        const view = createView("hello!");
        const plugin = createPlugin(view, client, {
            sendIncrementalChanges: true,
        });

        plugin.update(fakeUpdate(view, "hello", "!"));

        expect(client.textDocumentDidChange).not.toHaveBeenCalled();
    });

    it("sends nothing when TextDocumentSyncOptions omits change", () => {
        // Per spec, an omitted `change` means the server wants no change
        // notifications, even if it opts into openClose
        const client = createFakeClient({
            capabilities: { textDocumentSync: { openClose: true } },
        });
        const view = createView("hello!");
        const plugin = createPlugin(view, client, {
            sendIncrementalChanges: true,
        });

        plugin.update(fakeUpdate(view, "hello", "!"));

        expect(client.textDocumentDidChange).not.toHaveBeenCalled();
    });

    it("honors the change kind from TextDocumentSyncOptions", () => {
        const client = createFakeClient({
            capabilities: { textDocumentSync: { openClose: true, change: 2 } },
        });
        const view = createView("hello!");
        const plugin = createPlugin(view, client, {
            sendIncrementalChanges: true,
        });

        plugin.update(fakeUpdate(view, "hello", "!"));

        expect(client.textDocumentDidChange).toHaveBeenCalledWith(
            expect.objectContaining({
                contentChanges: [
                    {
                        range: {
                            start: { line: 0, character: 5 },
                            end: { line: 0, character: 5 },
                        },
                        text: "!",
                    },
                ],
            }),
        );
    });
});
