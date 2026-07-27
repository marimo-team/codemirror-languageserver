import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import type { LanguageServerClient } from "../lsp.js";
import type { LanguageServerPlugin } from "../plugin.js";
import {
    featureOptions as baseFeatureOptions,
    createFakeClient as createBaseFakeClient,
    createPlugin as createBasePlugin,
    createView,
    fakeUpdate,
    flushTicks,
} from "./test-utils.js";

const DOCUMENT_URI = "file:///test.ts";
const OTHER_URI = "file:///other.ts";

const featureOptions = {
    ...baseFeatureOptions,
    codeActionsEnabled: true,
};

interface FakeClientOverrides {
    capabilities?: LSP.ServerCapabilities;
}

function createFakeClient(overrides: FakeClientOverrides = {}) {
    return createBaseFakeClient({
        capabilities: overrides.capabilities ?? {
            codeActionProvider: { resolveProvider: true },
        },
    });
}

function createPlugin(
    view: EditorView,
    client = createFakeClient(),
    options: Partial<
        ConstructorParameters<typeof LanguageServerPlugin>[0]
    > = {},
) {
    return createBasePlugin(view, client, {
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

describe("malformed workspace edits", () => {
    it("rejects a primitive documentChanges entry instead of throwing", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                documentChanges: ["nope", 7, null],
            } as unknown as LSP.WorkspaceEdit),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("rejects a documentChanges entry whose textDocument is not an object", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    { textDocument: "file:///test.ts", edits: [] },
                ],
            } as unknown as LSP.WorkspaceEdit),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("rejects a primitive edit inside documentChanges", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: null },
                        edits: ["howdy"],
                    },
                ],
            } as unknown as LSP.WorkspaceEdit),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });
});

describe("edit atomicity", () => {
    it("rejects a workspace edit whose text edits overlap", async () => {
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

    it("does not partially apply a changes map that also touches another file", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        const applied = await applyWorkspaceEdit(plugin, view, {
            changes: {
                [DOCUMENT_URI]: [
                    { range: range(0, 0, 0, 5), newText: "howdy" },
                ],
                [OTHER_URI]: [{ range: range(0, 0, 0, 5), newText: "howdy" }],
            },
        } satisfies LSP.WorkspaceEdit);

        expect(view.state.doc.toString()).toBe("hello world");
        expect(applied).toBe(false);
    });

    it("does not partially apply documentChanges spanning several files", async () => {
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
    });

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
    it("refuses a documentChanges edit whose textDocument.version is stale", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        // Changes racing didOpen are carried by didOpen, so let it settle
        await flushTicks();

        // Three keystrokes take the document to version 3
        typeAtEnd(view, plugin, "!");
        typeAtEnd(view, plugin, "!");
        typeAtEnd(view, plugin, "!");
        await flushTicks();
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
    });

    it("applies a documentChanges edit whose version matches or is null", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        await flushTicks();

        typeAtEnd(view, plugin, "!");
        await flushTicks();
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
    it("ignores a changes map whose value is null", async () => {
        const view = createView("hello world");
        const plugin = createPlugin(view);

        await expect(
            applyWorkspaceEdit(plugin, view, {
                changes: { [DOCUMENT_URI]: null },
            }),
        ).resolves.toBe(false);
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("ignores a changes map whose value is not an array", async () => {
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

    it("skips text edits with negative positions instead of throwing", async () => {
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
    });

    it("skips text edits with non-numeric positions instead of throwing", async () => {
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
    });

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
    it("falls back to the original action when codeAction/resolve returns null", async () => {
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
    });

    it("falls back to the original action when codeAction/resolve returns undefined", async () => {
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
    });

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
