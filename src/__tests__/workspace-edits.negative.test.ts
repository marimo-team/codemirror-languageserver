import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../lsp.js";
import type { FeatureOptions } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

const DOCUMENT_URI = "file:///test.ts";
const OTHER_URI = "file:///other.ts";

const featureOptions: Required<FeatureOptions> = {
    diagnosticsEnabled: true,
    hoverEnabled: true,
    completionEnabled: true,
    definitionEnabled: true,
    renameEnabled: true,
    codeActionsEnabled: true,
    signatureHelpEnabled: true,
    signatureActivateOnTyping: false,
    signatureHelpOptions: { position: "below" },
};

interface FakeClientOverrides {
    capabilities?: LSP.ServerCapabilities;
}

function createFakeClient(overrides: FakeClientOverrides = {}) {
    return {
        ready: true,
        capabilities: overrides.capabilities ?? {
            codeActionProvider: { resolveProvider: true },
        },
        dynamicCapabilities: new Map(),
        hasCapability: LanguageServerClient.prototype.hasCapability,
        initializePromise: Promise.resolve(),
        onNotification: vi.fn().mockReturnValue(() => {}),
        textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
        textDocumentDidChange: vi.fn().mockResolvedValue(undefined),
        textDocumentDidClose: vi.fn().mockResolvedValue(undefined),
        textDocumentCodeAction: vi.fn().mockResolvedValue(null),
        codeActionResolve: vi.fn(),
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
        documentUri: DOCUMENT_URI,
        languageId: "typescript",
        view,
        featureOptions: { ...featureOptions },
        ...options,
    });
}

const range = (
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
): LSP.Range => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
});

/** `applyWorkspaceEdit` is protected; tests reach it directly. */
function applyWorkspaceEdit(
    plugin: LanguageServerPlugin,
    view: EditorView,
    edit: unknown,
): Promise<boolean> {
    // biome-ignore lint/suspicious/noExplicitAny: accessing a protected member
    return (plugin as any).applyWorkspaceEdit(view, edit);
}

/**
 * Minimal ViewUpdate stub matching the one in plugin-behavior.test.ts, used to
 * drive the plugin's document-version counter.
 */
function fakeUpdate(view: EditorView, prevDoc: string, insert: string) {
    const prevState = EditorState.create({ doc: prevDoc });
    const changes = prevState.changes({ from: prevDoc.length, insert });
    return {
        state: view.state,
        docChanged: true,
        startState: prevState,
        changes,
        // biome-ignore lint/suspicious/noExplicitAny: minimal ViewUpdate stub
    } as any;
}

/** Types `insert` at the end of the document, bumping `documentVersion`. */
function typeAtEnd(
    view: EditorView,
    plugin: LanguageServerPlugin,
    insert: string,
) {
    const prevDoc = view.state.doc.toString();
    view.dispatch({ changes: { from: view.state.doc.length, insert } });
    plugin.update(fakeUpdate(view, prevDoc, insert));
}

function lastSentVersion(client: LanguageServerClient): number | undefined {
    const calls = (client.textDocumentDidChange as ReturnType<typeof vi.fn>)
        .mock.calls;
    return calls.at(-1)?.[0]?.textDocument?.version;
}

function errorMessages(): string[] {
    return [...document.querySelectorAll(".cm-error-message")].map(
        (element) => element.textContent ?? "",
    );
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("edit atomicity", () => {
    // BUG: overlapping text edits must be rejected as a unit (LSP requires the
    // client to refuse a WorkspaceEdit whose ranges overlap) — currently both
    // edits are pushed into one ChangeSet, garbling "hello world" into
    // "AAABBBrld" with no error.
    it.fails("rejects a workspace edit whose text edits overlap", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        const applied = await applyWorkspaceEdit(plugin, view, {
            changes: {
                [DOCUMENT_URI]: [
                    { range: range(0, 0, 0, 5), newText: "AAA" },
                    { range: range(0, 3, 0, 8), newText: "BBB" },
                ],
            },
        } satisfies LSP.WorkspaceEdit);

        expect(view.state.doc.toString()).toBe("hello world");
        expect(applied).toBe(false);
        expect(errorMessages().join(" ")).toMatch(/overlap/i);
    });

    // BUG: a changes map naming a file we cannot edit must be rejected whole,
    // leaving the document untouched — currently the foreign URI only produces
    // a "Multi-file edits not supported yet" message while this document's
    // edits are applied, producing a half-completed cross-file rename.
    it.fails(
        "does not partially apply a changes map that also touches another file",
        async () => {
            const view = createView("hello world");
            const plugin = createPlugin(view);

            const applied = await applyWorkspaceEdit(plugin, view, {
                changes: {
                    [DOCUMENT_URI]: [
                        { range: range(0, 0, 0, 5), newText: "howdy" },
                    ],
                    [OTHER_URI]: [
                        { range: range(0, 0, 0, 5), newText: "howdy" },
                    ],
                },
            } satisfies LSP.WorkspaceEdit);

            expect(view.state.doc.toString()).toBe("hello world");
            expect(applied).toBe(false);
        },
    );

    // BUG: documentChanges spanning several files must be rejected whole —
    // currently the unsupported entry only shows a message while this
    // document's edits are still applied ("howdy world").
    it.fails(
        "does not partially apply documentChanges spanning several files",
        async () => {
            const view = createView("hello world");
            const plugin = createPlugin(view);

            const applied = await applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: null },
                        edits: [{ range: range(0, 0, 0, 5), newText: "howdy" }],
                    },
                    {
                        textDocument: { uri: OTHER_URI, version: null },
                        edits: [{ range: range(0, 0, 0, 5), newText: "howdy" }],
                    },
                ],
            } satisfies LSP.WorkspaceEdit);

            expect(view.state.doc.toString()).toBe("hello world");
            expect(applied).toBe(false);
        },
    );

    it("applies reverse-ordered non-overlapping edits correctly", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        // Servers conventionally emit edits last-to-first so offsets stay valid
        const applied = await applyWorkspaceEdit(plugin, view, {
            changes: {
                [DOCUMENT_URI]: [
                    { range: range(0, 6, 0, 11), newText: "there" },
                    { range: range(0, 0, 0, 5), newText: "howdy" },
                ],
            },
        } satisfies LSP.WorkspaceEdit);

        expect(applied).toBe(true);
        expect(view.state.doc.toString()).toBe("howdy there");
    });

    it("applies a single-file changes map", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        const applied = await applyWorkspaceEdit(plugin, view, {
            changes: {
                [DOCUMENT_URI]: [
                    { range: range(0, 0, 0, 5), newText: "howdy" },
                ],
            },
        } satisfies LSP.WorkspaceEdit);

        expect(applied).toBe(true);
        expect(view.state.doc.toString()).toBe("howdy world");
    });
});

describe("document version safety", () => {
    // BUG: an OptionalVersionedTextDocumentIdentifier carrying a version older
    // than the document's current version describes text the server has since
    // been told about; the edit must be refused — currently the version field
    // is read for the URI check only and never compared against
    // `documentVersion`, so the stale edit is applied to newer text.
    it.fails(
        "refuses a documentChanges edit whose textDocument.version is stale",
        async () => {
            const client = createFakeClient();
            const view = createView("hello world");
            const plugin = createPlugin(view, client);

            // Three keystrokes take the document to version 3
            typeAtEnd(view, plugin, "!");
            typeAtEnd(view, plugin, "!");
            typeAtEnd(view, plugin, "!");
            expect(lastSentVersion(client)).toBe(3);

            const before = view.state.doc.toString();
            const applied = await applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: 1 },
                        edits: [{ range: range(0, 0, 0, 5), newText: "howdy" }],
                    },
                ],
            } satisfies LSP.WorkspaceEdit);

            expect(view.state.doc.toString()).toBe(before);
            expect(applied).toBe(false);
        },
    );

    it("applies a documentChanges edit whose version matches or is null", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        typeAtEnd(view, plugin, "!");
        expect(lastSentVersion(client)).toBe(1);

        expect(
            await applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: 1 },
                        edits: [{ range: range(0, 0, 0, 5), newText: "howdy" }],
                    },
                ],
            } satisfies LSP.WorkspaceEdit),
        ).toBe(true);
        expect(view.state.doc.toString()).toBe("howdy world!");

        // A null version means "don't care" per the LSP spec
        expect(
            await applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: null },
                        edits: [
                            { range: range(0, 6, 0, 11), newText: "there" },
                        ],
                    },
                ],
            } satisfies LSP.WorkspaceEdit),
        ).toBe(true);
        expect(view.state.doc.toString()).toBe("howdy there!");
    });
});

describe("malformed workspace edits", () => {
    // BUG: a null edit list should be ignored — currently `applyEdits`
    // for-of's over it and throws "edits is not iterable", rejecting the
    // promise.
    it.fails("ignores a changes map whose value is null", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                changes: { [DOCUMENT_URI]: null },
            }),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    // BUG: a non-array edit list should be ignored — currently `applyEdits`
    // for-of's over it and throws because a plain object is not iterable.
    it.fails("ignores a changes map whose value is not an array", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                changes: {
                    [DOCUMENT_URI]: {
                        range: range(0, 0, 0, 5),
                        newText: "howdy",
                    },
                },
            }),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    // BUG: negative line/character values must be treated as unresolvable and
    // skipped — currently a negative line makes `posToOffset` call
    // `doc.line(0)` (RangeError) and a negative character yields a negative
    // offset that CodeMirror rejects when the transaction is dispatched.
    it.fails(
        "skips text edits with negative positions instead of throwing",
        async () => {
            const view = createView("hello world");
            const plugin = createPlugin(view);

            await expect(
                applyWorkspaceEdit(plugin, view, {
                    changes: {
                        [DOCUMENT_URI]: [
                            { range: range(0, -5, 0, 2), newText: "X" },
                        ],
                    },
                } satisfies LSP.WorkspaceEdit),
            ).resolves.toBe(false);
            expect(view.state.doc.toString()).toBe("hello world");

            await expect(
                applyWorkspaceEdit(plugin, view, {
                    changes: {
                        [DOCUMENT_URI]: [
                            { range: range(-1, 0, -1, 2), newText: "X" },
                        ],
                    },
                } satisfies LSP.WorkspaceEdit),
            ).resolves.toBe(false);
            expect(view.state.doc.toString()).toBe("hello world");
        },
    );

    // BUG: non-numeric positions must be treated as unresolvable and skipped —
    // currently they flow through `posToOffset` as NaN, pass the `from > to`
    // guard (NaN comparisons are false) and reach `view.dispatch`.
    it.fails(
        "skips text edits with non-numeric positions instead of throwing",
        async () => {
            const view = createView("hello world");
            const plugin = createPlugin(view);

            await expect(
                applyWorkspaceEdit(plugin, view, {
                    changes: {
                        [DOCUMENT_URI]: [
                            {
                                range: {
                                    start: { line: "0", character: "abc" },
                                    end: { line: "0", character: "def" },
                                },
                                newText: "X",
                            },
                        ],
                    },
                }),
            ).resolves.toBe(false);
            expect(view.state.doc.toString()).toBe("hello world");
        },
    );

    it("skips a text edit whose range end precedes its start", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                changes: {
                    [DOCUMENT_URI]: [
                        { range: range(0, 8, 0, 2), newText: "X" },
                    ],
                },
            } satisfies LSP.WorkspaceEdit),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("reports an error when the workspace edit is null", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(applyWorkspaceEdit(plugin, view, null)).resolves.toBe(
            false,
        );
        expect(errorMessages().join(" ")).toContain("No edit returned");
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("reports an error when the workspace edit has neither changes nor documentChanges", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(applyWorkspaceEdit(plugin, view, {})).resolves.toBe(false);
        expect(errorMessages().join(" ")).toContain("No changes to apply");
        expect(view.state.doc.toString()).toBe("hello world");
    });
});

describe("code action resolution", () => {
    // BUG: `codeAction/resolve` returning null should fall back to the
    // original action (the same way a rejected resolve does) — currently
    // `isBareCommand(null)` dereferences `null.command` and applyCodeAction
    // rejects with a TypeError.
    it.fails(
        "falls back to the original action when codeAction/resolve returns null",
        async () => {
            const client = createFakeClient();
            client.codeActionResolve = vi.fn().mockResolvedValue(null);
            const view = createView("hello world");
            const plugin = createPlugin(view, client);

            await expect(
                plugin.applyCodeAction({ title: "Fix it" }),
            ).resolves.toBeUndefined();

            expect(client.codeActionResolve).toHaveBeenCalled();
            expect(errorMessages().join(" ")).toContain("Fix it");
            expect(view.state.doc.toString()).toBe("hello world");
        },
    );

    // BUG: `codeAction/resolve` returning undefined should fall back to the
    // original action — currently `isBareCommand(undefined)` throws.
    it.fails(
        "falls back to the original action when codeAction/resolve returns undefined",
        async () => {
            const client = createFakeClient();
            client.codeActionResolve = vi.fn().mockResolvedValue(undefined);
            const view = createView("hello world");
            const plugin = createPlugin(view, client);

            await expect(
                plugin.applyCodeAction({ title: "Fix it" }),
            ).resolves.toBeUndefined();

            expect(client.codeActionResolve).toHaveBeenCalled();
            expect(errorMessages().join(" ")).toContain("Fix it");
            expect(view.state.doc.toString()).toBe("hello world");
        },
    );

    it("does not throw when an applied code action has an empty edit", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await expect(
            plugin.applyCodeAction({ title: "Fix it", edit: {} }),
        ).resolves.toBeUndefined();

        expect(client.codeActionResolve).not.toHaveBeenCalled();
        expect(errorMessages().join(" ")).toContain("No changes to apply");
        expect(view.state.doc.toString()).toBe("hello world");
    });
});
