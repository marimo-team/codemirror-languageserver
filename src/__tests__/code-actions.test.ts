import { setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../lsp.js";
import type { FeatureOptions } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

const DOCUMENT_URI = "file:///test.ts";

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
    codeActions?: (LSP.Command | LSP.CodeAction)[] | null;
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
        textDocumentCodeAction: vi
            .fn()
            .mockResolvedValue(overrides.codeActions ?? null),
        codeActionResolve: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: partial stub of the client
    } as any as LanguageServerClient;
}

function createView(doc: string): EditorView {
    const view = new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
    return view;
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

function editReplacing(range: LSP.Range, newText: string): LSP.WorkspaceEdit {
    return { changes: { [DOCUMENT_URI]: [{ range, newText }] } };
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

async function flushTicks(count = 5) {
    for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("applyCodeAction / codeAction/resolve", () => {
    it("resolves an action with neither edit nor command before applying", async () => {
        const client = createFakeClient();
        client.codeActionResolve = vi.fn().mockResolvedValue({
            title: "Fix it",
            kind: "quickfix",
            edit: editReplacing(range(0, 0, 0, 5), "fixed"),
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        const lazyAction: LSP.CodeAction = {
            title: "Fix it",
            kind: "quickfix",
        };
        await plugin.applyCodeAction(lazyAction);

        expect(client.codeActionResolve).toHaveBeenCalledWith(lazyAction);
        expect(view.state.doc.toString()).toBe("fixed world");
    });

    it("does not resolve an action that already carries an edit", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.applyCodeAction({
            title: "Fix it",
            edit: editReplacing(range(0, 0, 0, 5), "fixed"),
        });

        expect(client.codeActionResolve).not.toHaveBeenCalled();
        expect(view.state.doc.toString()).toBe("fixed world");
    });

    it("does not resolve when the server lacks resolveProvider", async () => {
        const client = createFakeClient({
            capabilities: { codeActionProvider: true },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.applyCodeAction({ title: "Fix it" });

        expect(client.codeActionResolve).not.toHaveBeenCalled();
        expect(
            document.querySelector(".cm-error-message")?.textContent,
        ).toContain("Fix it");
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("never resolves bare commands", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.applyCodeAction({ title: "Run", command: "test.run" });

        expect(client.codeActionResolve).not.toHaveBeenCalled();
        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("falls back to the original action when resolve rejects", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const client = createFakeClient();
        client.codeActionResolve = vi.fn().mockRejectedValue(new Error("boom"));
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await expect(
            plugin.applyCodeAction({ title: "Fix it" }),
        ).resolves.toBeUndefined();

        expect(document.querySelector(".cm-error-message")).not.toBeNull();
        expect(view.state.doc.toString()).toBe("hello world");
        consoleSpy.mockRestore();
    });

    it("applies edits delivered via documentChanges", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.applyCodeAction({
            title: "Fix it",
            edit: {
                documentChanges: [
                    {
                        textDocument: { uri: DOCUMENT_URI, version: 1 },
                        edits: [
                            { range: range(0, 6, 0, 11), newText: "there" },
                        ],
                    },
                ],
            },
        });

        expect(view.state.doc.toString()).toBe("hello there");
    });
});

describe("requestCodeActionsAtSelection", () => {
    it("sends the selection range and overlapping diagnostics in context", async () => {
        const client = createFakeClient({ codeActions: [] });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        // Plugin-created diagnostics echo the original LSP diagnostic
        const lspDiagnostic: LSP.Diagnostic = {
            range: range(0, 0, 0, 5),
            message: "bad greeting",
            code: "E123",
            source: "tsserver",
        };
        view.dispatch(
            setDiagnostics(view.state, [
                {
                    from: 0,
                    to: 5,
                    severity: "error",
                    message: "bad greeting",
                    lspDiagnostic,
                    // biome-ignore lint/suspicious/noExplicitAny: extra field carried on the lint diagnostic
                } as any,
                {
                    // Outside the selection
                    from: 6,
                    to: 11,
                    severity: "warning",
                    message: "elsewhere",
                },
            ]),
        );
        view.dispatch({ selection: { anchor: 1, head: 3 } });

        await plugin.requestCodeActionsAtSelection(view);

        expect(client.textDocumentCodeAction).toHaveBeenCalledTimes(1);
        expect(client.textDocumentCodeAction).toHaveBeenCalledWith({
            textDocument: { uri: DOCUMENT_URI },
            range: range(0, 1, 0, 3),
            context: {
                diagnostics: [
                    expect.objectContaining({
                        code: "E123",
                        message: "bad greeting",
                        range: range(0, 0, 0, 5),
                    }),
                ],
            },
        });
    });

    it("passes the only filter through", async () => {
        const client = createFakeClient({ codeActions: [] });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.requestCodeActions(view, range(0, 0, 0, 11), [
            "source.organizeImports",
        ]);

        expect(client.textDocumentCodeAction).toHaveBeenCalledWith(
            expect.objectContaining({
                context: expect.objectContaining({
                    only: ["source.organizeImports"],
                }),
            }),
        );
    });

    it("returns null when code actions are disabled", async () => {
        const client = createFakeClient({ codeActions: [] });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        plugin.featureOptions.codeActionsEnabled = false;

        const result = await plugin.requestCodeActionsAtSelection(view);

        expect(result).toBeNull();
        expect(client.textDocumentCodeAction).not.toHaveBeenCalled();
    });
});

describe("batched diagnostics code actions", () => {
    it("sends exactly one codeAction request for N diagnostics", async () => {
        const diagnostics: LSP.Diagnostic[] = [
            { range: range(0, 0, 0, 5), message: "first" },
            { range: range(0, 6, 0, 11), message: "second" },
            { range: range(0, 2, 0, 4), message: "third" },
        ];
        const client = createFakeClient({ codeActions: [] });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.processDiagnostics({ uri: DOCUMENT_URI, diagnostics });

        expect(client.textDocumentCodeAction).toHaveBeenCalledTimes(1);
        expect(client.textDocumentCodeAction).toHaveBeenCalledWith({
            textDocument: { uri: DOCUMENT_URI },
            range: range(0, 0, 0, 11),
            context: { diagnostics },
        });
    });

    it("distributes actions to diagnostics by range overlap", async () => {
        const first: LSP.Diagnostic = {
            range: range(0, 0, 0, 5),
            message: "first",
        };
        const second: LSP.Diagnostic = {
            range: range(0, 6, 0, 11),
            message: "second",
        };
        const client = createFakeClient({
            codeActions: [
                {
                    title: "Fix first",
                    kind: "quickfix",
                    diagnostics: [first],
                },
            ],
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        // biome-ignore lint/suspicious/noExplicitAny: reach the private setter
        const setOwnDiagnostics = vi.spyOn(plugin as any, "setOwnDiagnostics");
        await plugin.processDiagnostics({
            uri: DOCUMENT_URI,
            diagnostics: [first, second],
        });

        const cmDiagnostics = setOwnDiagnostics.mock.calls[0][0] as {
            actions?: { name: string }[];
        }[];
        expect(cmDiagnostics).toHaveLength(2);
        expect(cmDiagnostics[0].actions?.map((a) => a.name)).toEqual([
            "Fix first",
        ]);
        expect(cmDiagnostics[1].actions).toBeUndefined();
    });

    it("still publishes diagnostics when the codeAction request fails", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const client = createFakeClient();
        client.textDocumentCodeAction = vi
            .fn()
            .mockRejectedValue(new Error("boom"));
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        // biome-ignore lint/suspicious/noExplicitAny: reach the private setter
        const setOwnDiagnostics = vi.spyOn(plugin as any, "setOwnDiagnostics");
        await plugin.processDiagnostics({
            uri: DOCUMENT_URI,
            diagnostics: [{ range: range(0, 0, 0, 5), message: "first" }],
        });

        expect(setOwnDiagnostics).toHaveBeenCalledTimes(1);
        expect(setOwnDiagnostics.mock.calls[0][0]).toHaveLength(1);
        consoleSpy.mockRestore();
    });
});

describe("code action menu", () => {
    const menuActions: LSP.CodeAction[] = [
        {
            title: "Fix greeting",
            kind: "quickfix",
            edit: editReplacing(range(0, 0, 0, 5), "howdy"),
        },
        {
            title: "Unavailable refactor",
            kind: "refactor.rewrite",
            disabled: { reason: "not applicable here" },
        },
    ];

    it("renders actions with kind suffixes and disabled state", async () => {
        const client = createFakeClient({ codeActions: menuActions });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        const shown = await plugin.showCodeActionsMenu(view);

        expect(shown).toBe(true);
        const menu = document.querySelector(".cm-code-action-menu");
        expect(menu).not.toBeNull();
        const items = [
            ...(menu?.querySelectorAll<HTMLButtonElement>(
                ".cm-code-action-item",
            ) ?? []),
        ];
        expect(items.map((i) => i.textContent)).toEqual([
            "Fix greetingquickfix",
            "Unavailable refactorrefactor.rewrite",
        ]);
        expect(items[0].disabled).toBe(false);
        expect(items[1].disabled).toBe(true);
        expect(items[1].title).toBe("not applicable here");
    });

    it("applies the selected action on Enter and closes the menu", async () => {
        const client = createFakeClient({ codeActions: menuActions });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.showCodeActionsMenu(view);
        const menu = document.querySelector(".cm-code-action-menu");
        menu?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        await flushTicks();

        expect(view.state.doc.toString()).toBe("howdy world");
        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
    });

    it("dismisses without applying on Escape", async () => {
        const client = createFakeClient({ codeActions: menuActions });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.showCodeActionsMenu(view);
        const menu = document.querySelector(".cm-code-action-menu");
        menu?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        await flushTicks();

        expect(view.state.doc.toString()).toBe("hello world");
        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
    });

    it("dismisses on outside mousedown", async () => {
        const client = createFakeClient({ codeActions: menuActions });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        await plugin.showCodeActionsMenu(view);
        document.body.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
        );

        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
    });

    it("hands the actions to a host renderMenu override instead of rendering", async () => {
        const client = createFakeClient({ codeActions: menuActions });
        const renderMenu = vi.fn();
        const view = createView("hello world");
        const plugin = createPlugin(view, client, {
            codeActionsConfig: { renderMenu },
        });

        const shown = await plugin.showCodeActionsMenu(view);

        expect(shown).toBe(true);
        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
        expect(renderMenu).toHaveBeenCalledTimes(1);
        const [actions, apply] = renderMenu.mock.calls[0];
        expect(actions).toEqual(menuActions);

        await apply(actions[0]);
        expect(view.state.doc.toString()).toBe("howdy world");
    });

    it("shows a message when no actions are available", async () => {
        const client = createFakeClient({ codeActions: [] });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);

        const shown = await plugin.showCodeActionsMenu(view);

        expect(shown).toBe(false);
        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
        expect(
            document.querySelector(".cm-error-message")?.textContent,
        ).toContain("No code actions available");
    });
});
