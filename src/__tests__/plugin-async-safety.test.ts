import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionTriggerKind } from "vscode-languageserver-protocol";
import type { LanguageServerClient } from "../lsp.js";
import {
    type LanguageServerPlugin,
    relatedLocationAnchors,
    signatureHelpTooltipField,
} from "../plugin.js";
import {
    createFakeClient,
    createPlugin,
    createView,
    fakeUpdate,
    featureOptions,
    flushTicks,
    stubClient,
} from "./test-utils.js";

function stubCoords(view: EditorView) {
    // jsdom cannot compute text coordinates
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    });
}

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function pressKey(element: HTMLElement, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** The range of "hello" in a document starting with "hello world". */
const helloRange: LSP.Range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
};

/**
 * Opens the rename popup for the given prepare-rename range and returns its
 * DOM. Throws when the popup was not created, so callers get a clear failure.
 */
async function openRenamePopup(
    view: EditorView,
    client: LanguageServerClient,
    plugin: LanguageServerPlugin,
    range: LSP.Range = helloRange,
) {
    stubClient(client, {
        textDocumentPrepareRename: vi.fn().mockResolvedValue(range),
    });
    await plugin.requestRename(view, { line: 0, character: 1 });
    const popup = document.querySelector<HTMLElement>(".cm-rename-popup");
    if (!popup) {
        throw new Error("rename popup was not created");
    }
    const input = popup.querySelector("input");
    if (!input) {
        throw new Error("rename input was not created");
    }
    return { popup, input };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("stale and post-destroy responses", () => {
    it("does not apply rename edits after the plugin is destroyed", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        const pendingRename = deferred<LSP.WorkspaceEdit>();
        const rename = vi.fn().mockReturnValue(pendingRename.promise);
        stubClient(client, { textDocumentRename: rename });

        const { input } = await openRenamePopup(view, client, plugin);
        input.value = "howdy";
        pressKey(input, "Enter");
        await flushTicks(1);
        expect(rename).toHaveBeenCalled();

        plugin.destroy();
        pendingRename.resolve({
            changes: {
                "file:///test.ts": [{ range: helloRange, newText: "howdy" }],
            },
        });
        await flushTicks();

        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("does not apply rename edits when the document changed while the request was in flight", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        const pendingRename = deferred<LSP.WorkspaceEdit>();
        stubClient(client, {
            textDocumentRename: vi.fn().mockReturnValue(pendingRename.promise),
        });

        const { input } = await openRenamePopup(view, client, plugin);
        input.value = "howdy";
        pressKey(input, "Enter");
        await flushTicks(1);

        // The user keeps typing while the rename is in flight
        view.dispatch({ changes: { from: 0, insert: "XX" } });
        pendingRename.resolve({
            changes: {
                "file:///test.ts": [{ range: helloRange, newText: "howdy" }],
            },
        });
        await flushTicks();

        expect(view.state.doc.toString()).toBe("XXhello world");
    });

    it("does not move the selection after the plugin is destroyed", async () => {
        const client = createFakeClient({
            capabilities: { definitionProvider: true },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        const pendingDefinition = deferred<LSP.Location[]>();
        stubClient(client, {
            textDocumentDefinition: vi
                .fn()
                .mockReturnValue(pendingDefinition.promise),
        });

        const pending = plugin.requestDefinition(view, {
            line: 0,
            character: 0,
        });
        plugin.destroy();
        pendingDefinition.resolve([
            {
                uri: "file:///test.ts",
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 11 },
                },
            },
        ]);
        await pending;

        expect(view.state.selection.main.from).toBe(0);
        expect(view.state.selection.main.to).toBe(0);
    });

    it("does not show a stale signature tooltip when a newer request already resolved", async () => {
        const client = createFakeClient({
            capabilities: { signatureHelpProvider: {} },
        });
        const view = new EditorView({
            state: EditorState.create({
                doc: "sum(",
                extensions: [signatureHelpTooltipField],
            }),
            parent: document.createElement("div"),
        });
        const plugin = createPlugin(view, client);
        const older = deferred<LSP.SignatureHelp>();
        const newer = deferred<LSP.SignatureHelp>();
        stubClient(client, {
            textDocumentSignatureHelp: vi
                .fn()
                .mockReturnValueOnce(older.promise)
                .mockReturnValueOnce(newer.promise),
        });

        const first = plugin.showSignatureHelpTooltip(view, 4);
        const second = plugin.showSignatureHelpTooltip(view, 4);

        // The newer request answers first; the older one straggles in
        newer.resolve({ signatures: [{ label: "newest(b)" }] });
        await second;
        older.resolve({ signatures: [{ label: "oldest(a)" }] });
        await first;

        const tooltip = view.state.field(signatureHelpTooltipField);
        const dom = tooltip?.create(view).dom;
        expect(dom?.textContent).toContain("newest(b)");
    });

    it("does not apply a code action after the plugin is destroyed", async () => {
        const client = createFakeClient({
            capabilities: { codeActionProvider: { resolveProvider: true } },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client, {
            featureOptions: { ...featureOptions, codeActionsEnabled: true },
        });
        const pendingResolve = deferred<LSP.CodeAction>();
        stubClient(client, {
            codeActionResolve: vi.fn().mockReturnValue(pendingResolve.promise),
        });

        const pending = plugin.applyCodeAction({ title: "Fix it" });
        plugin.destroy();
        pendingResolve.resolve({
            title: "Fix it",
            edit: {
                changes: {
                    "file:///test.ts": [
                        { range: helloRange, newText: "howdy" },
                    ],
                },
            },
        });
        await pending;

        expect(view.state.doc.toString()).toBe("hello world");
    });

    it("does not open the menu when the document or selection moved while the request was in flight", async () => {
        const client = createFakeClient({
            capabilities: { codeActionProvider: true },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client, {
            featureOptions: { ...featureOptions, codeActionsEnabled: true },
        });
        const pendingActions = deferred<LSP.CodeAction[]>();
        stubClient(client, {
            textDocumentCodeAction: vi
                .fn()
                .mockReturnValue(pendingActions.promise),
        });

        const pending = plugin.showCodeActionsMenu(view);
        // The document moves under the request
        view.dispatch({ changes: { from: 0, insert: "X" } });
        pendingActions.resolve([{ title: "Fix it" }]);

        expect(await pending).toBe(false);
        expect(document.querySelector(".cm-code-action-menu")).toBeNull();
    });
});

describe("request failure handling", () => {
    it("returns null when the hover request rejects", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        stubClient(client, {
            textDocumentHover: vi
                .fn()
                .mockRejectedValue(new Error("connection lost")),
        });

        await expect(
            plugin.requestHoverTooltip(view, { line: 0, character: 0 }),
        ).resolves.toBeNull();
    });

    it("returns null when the hover request times out", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        stubClient(client, {
            textDocumentHover: vi.fn(
                () =>
                    new Promise((_resolve, reject) => {
                        setTimeout(
                            () => reject(new Error("Request timed out")),
                            0,
                        );
                    }),
            ),
        });

        await expect(
            plugin.requestHoverTooltip(view, { line: 0, character: 0 }),
        ).resolves.toBeNull();
    });

    it("returns null when the completion request rejects", async () => {
        const client = createFakeClient({
            capabilities: { completionProvider: {} },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        stubClient(client, {
            textDocumentCompletion: vi
                .fn()
                .mockRejectedValue(new Error("connection lost")),
        });

        const context = new CompletionContext(view.state, 5, true, view);
        await expect(
            plugin.requestCompletion(
                context,
                { line: 0, character: 5 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            ),
        ).resolves.toBeNull();
    });

    it("returns null when the server sends a CompletionList without items", async () => {
        const client = createFakeClient({
            capabilities: { completionProvider: {} },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        stubClient(client, {
            textDocumentCompletion: vi
                .fn()
                .mockResolvedValue({ isIncomplete: true }),
        });

        const context = new CompletionContext(view.state, 5, true, view);
        await expect(
            plugin.requestCompletion(
                context,
                { line: 0, character: 5 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            ),
        ).resolves.toBeNull();
    });

    it("ignores a definition response that is an empty array", async () => {
        const client = createFakeClient({
            capabilities: { definitionProvider: true },
        });
        const view = createView("hello world");
        const onGoToDefinition = vi.fn();
        const plugin = createPlugin(view, client, { onGoToDefinition });
        stubClient(client, {
            textDocumentDefinition: vi.fn().mockResolvedValue([]),
        });

        await expect(
            plugin.requestDefinition(view, { line: 0, character: 0 }),
        ).resolves.toBeUndefined();
        expect(onGoToDefinition).not.toHaveBeenCalled();
        expect(view.state.selection.main.from).toBe(0);
    });

    it("ignores a definition response missing uri or range", async () => {
        const client = createFakeClient({
            capabilities: { definitionProvider: true },
        });
        const view = createView("hello world");
        const onGoToDefinition = vi.fn();
        const plugin = createPlugin(view, client, { onGoToDefinition });

        stubClient(client, {
            textDocumentDefinition: vi
                .fn()
                .mockResolvedValue([{ uri: "file:///test.ts" }]),
        });
        await expect(
            plugin.requestDefinition(view, { line: 0, character: 0 }),
        ).resolves.toBeUndefined();

        stubClient(client, {
            textDocumentDefinition: vi.fn().mockResolvedValue([
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                },
            ]),
        });
        await expect(
            plugin.requestDefinition(view, { line: 0, character: 0 }),
        ).resolves.toBeUndefined();

        expect(onGoToDefinition).not.toHaveBeenCalled();
        expect(view.state.selection.main.from).toBe(0);
    });

    it("does not collapse the selection to offset 0 for an out-of-range definition range", async () => {
        const client = createFakeClient({
            capabilities: { definitionProvider: true },
        });
        const view = createView("hello world");
        const plugin = createPlugin(view, client);
        view.dispatch({ selection: { anchor: 6 } });
        stubClient(client, {
            textDocumentDefinition: vi.fn().mockResolvedValue([
                {
                    uri: "file:///test.ts",
                    // Stale range from a longer version of the document
                    range: {
                        start: { line: 40, character: 3 },
                        end: { line: 40, character: 6 },
                    },
                },
            ]),
        });

        await plugin.requestDefinition(view, { line: 0, character: 0 });

        expect(view.state.selection.main.from).toBe(6);
    });
});

describe("document synchronization", () => {
    it("does not send didChange before didOpen has completed", async () => {
        const order: string[] = [];
        const init = deferred<void>();
        const client = createFakeClient({
            initializePromise: init.promise,
            capabilities: { textDocumentSync: 2 },
        });
        const didOpen = vi.fn(async () => {
            order.push("didOpen");
        });
        const didChange = vi.fn(async () => {
            order.push("didChange");
        });
        stubClient(client, {
            textDocumentDidOpen: didOpen,
            textDocumentDidChange: didChange,
        });
        const view = createView("hello");
        const plugin = createPlugin(view, client);

        // The user types while the handshake (and therefore didOpen) is pending
        view.dispatch({ changes: { from: 5, insert: "!" } });
        plugin.update(fakeUpdate(view, "hello", "!"));
        await flushTicks(1);
        expect(order).toEqual([]);

        init.resolve();
        await flushTicks();

        expect(order).toEqual(["didOpen", "didChange"]);
        expect(didOpen).toHaveBeenCalledWith({
            textDocument: expect.objectContaining({
                uri: "file:///test.ts",
                text: "hello!",
                version: 0,
            }),
        });
        expect(didChange).toHaveBeenCalledWith(
            expect.objectContaining({
                textDocument: { uri: "file:///test.ts", version: 1 },
            }),
        );
    });
});

describe("listener and DOM leaks", () => {
    it("removes the outside-click listener when the rename popup is dismissed with Escape", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        await flushTicks();

        const addSpy = vi.spyOn(document, "addEventListener");
        const removeSpy = vi.spyOn(document, "removeEventListener");

        const { input } = await openRenamePopup(view, client, plugin);
        pressKey(input, "Escape");

        expect(document.querySelector(".cm-rename-popup")).toBeNull();
        const added = addSpy.mock.calls.filter(
            ([type]) => type === "mousedown",
        ).length;
        const removed = removeSpy.mock.calls.filter(
            ([type]) => type === "mousedown",
        ).length;
        expect(added).toBeGreaterThan(0);
        expect(removed).toBe(added);
    });

    it("removes an open rename popup on destroy", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        await openRenamePopup(view, client, plugin);
        expect(document.querySelector(".cm-rename-popup")).not.toBeNull();

        plugin.destroy();

        expect(document.querySelector(".cm-rename-popup")).toBeNull();
    });

    it("clears its related-location anchors on destroy", async () => {
        const view = new EditorView({
            state: EditorState.create({
                doc: "hello world",
                extensions: [relatedLocationAnchors],
            }),
            parent: document.createElement("div"),
        });
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: helloRange,
                    message: "duplicate symbol",
                    relatedInformation: [
                        {
                            location: {
                                uri: "file:///test.ts",
                                range: {
                                    start: { line: 0, character: 6 },
                                    end: { line: 0, character: 11 },
                                },
                            },
                            message: "first defined here",
                        },
                    ],
                },
            ],
        });
        expect(view.state.field(relatedLocationAnchors).size).toBe(1);

        plugin.destroy();

        expect(view.state.field(relatedLocationAnchors).size).toBe(0);
    });
});

describe("rename input handling", () => {
    it("does not send a rename request when the name is unchanged", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        const rename = vi.fn().mockResolvedValue(null);
        stubClient(client, { textDocumentRename: rename });

        const { input } = await openRenamePopup(view, client, plugin);
        expect(input.value).toBe("hello");
        pressKey(input, "Enter");
        await flushTicks();

        expect(rename).not.toHaveBeenCalled();
    });

    it("does not prefill the rename input with the rest of the document", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);

        const { input } = await openRenamePopup(view, client, plugin, {
            start: { line: 0, character: 0 },
            // Stale end position that does not exist in this document
            end: { line: 7, character: 3 },
        });

        expect(input.value).not.toBe("hello world");
    });

    it("rejects a new name that is only whitespace", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        const rename = vi.fn().mockResolvedValue(null);
        stubClient(client, { textDocumentRename: rename });

        const { input } = await openRenamePopup(view, client, plugin);
        input.value = "   ";
        pressKey(input, "Enter");
        await flushTicks();

        expect(rename).not.toHaveBeenCalled();
        expect(document.querySelector(".cm-error-message")).not.toBeNull();
        expect(document.querySelector(".cm-rename-popup")).toBeNull();
    });

    it("rejects a new name containing a newline", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        const rename = vi.fn().mockResolvedValue(null);
        stubClient(client, { textDocumentRename: rename });

        const { input } = await openRenamePopup(view, client, plugin);
        input.value = "foo\nbar";
        pressKey(input, "Enter");
        await flushTicks();

        // A multi-line identifier must never reach the server
        const sent = rename.mock.calls[0]?.[0] as LSP.RenameParams | undefined;
        expect(sent?.newName ?? "").not.toMatch(/[\r\n]/);
    });

    it("reports an error instead of throwing when the rename line is outside the document", async () => {
        const client = createFakeClient();
        const view = createView("hello world");
        stubCoords(view);
        const plugin = createPlugin(view, client);
        // No prepareRename support, so the plugin falls back to the local
        // word-at-cursor lookup
        stubClient(client, {
            textDocumentPrepareRename: vi
                .fn()
                .mockRejectedValue(new Error("Method not found")),
        });

        await expect(
            plugin.requestRename(view, { line: 12, character: 2 }),
        ).resolves.toBeUndefined();

        expect(document.querySelector(".cm-rename-popup")).toBeNull();
        expect(document.querySelector(".cm-error-message")).not.toBeNull();
    });
});

describe("signature help rendering", () => {
    function createSignatureElement(
        plugin: LanguageServerPlugin,
        signature: unknown,
        activeParameterIndex: number,
    ): HTMLElement {
        // biome-ignore lint/suspicious/noExplicitAny: accessing private member in test
        return (plugin as any).createSignatureElement(
            signature,
            activeParameterIndex,
        );
    }

    it("falls back to the first signature when activeSignature is out of range", async () => {
        const client = createFakeClient({
            capabilities: { signatureHelpProvider: {} },
        });
        const view = createView("sum(");
        const plugin = createPlugin(view, client);
        stubClient(client, {
            textDocumentSignatureHelp: vi.fn().mockResolvedValue({
                signatures: [{ label: "first(a)" }],
                activeSignature: 5,
            }),
        });

        const tooltip = await plugin.requestSignatureHelp(view, {
            line: 0,
            character: 4,
        });

        expect(tooltip?.create(view).dom.textContent).toContain("first(a)");
    });

    it("handles a parameter label range that is reversed", () => {
        const view = createView("sum(1, 2)");
        const plugin = createPlugin(view);

        const element = createSignatureElement(
            plugin,
            {
                label: "sum(a, b)",
                // Reversed: the correct range for "a" is [4, 5]
                parameters: [{ label: [5, 4] }],
            },
            0,
        );

        expect(element.textContent).toBe("sum(a, b)");
    });

    it("handles a parameter label range that is out of bounds", () => {
        const view = createView("sum(1, 2)");
        const plugin = createPlugin(view);

        const element = createSignatureElement(
            plugin,
            {
                label: "sum(a, b)",
                parameters: [{ label: [-1, 999] }],
            },
            0,
        );

        expect(element.textContent).toBe("sum(a, b)");
        const highlighted = element.querySelector(".cm-signature-active-param");
        expect(highlighted?.textContent).not.toBe("sum(a, b)");
    });

    it("handles a parameter label tuple that is not length 2", () => {
        const view = createView("sum(1, 2)");
        const plugin = createPlugin(view);

        const element = createSignatureElement(
            plugin,
            {
                label: "sum(a, b)",
                parameters: [{ label: [0] }],
            },
            0,
        );

        expect(element.textContent).toBe("sum(a, b)");
        expect(element.querySelector(".cm-signature-active-param")).toBeNull();
    });

    it("shows a placeholder when the signature label is not a string", () => {
        const view = createView("sum(1, 2)");
        const plugin = createPlugin(view);

        const element = createSignatureElement(
            plugin,
            {
                label: { value: "sum(a, b)" },
                parameters: [{ label: "a" }],
            },
            0,
        );

        expect(element.textContent).toBe("Signature information unavailable");
    });
});
