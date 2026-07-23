import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { convertCompletionItem, sortCompletionItems } from "../completion.js";

function createView(doc: string): EditorView {
    return new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
}

const defaultOptions = {
    allowHTMLContent: false,
    useSnippetOnCompletion: false,
    hasResolveProvider: false,
    resolveItem: vi.fn(),
};

describe("convertCompletionItem type mapping", () => {
    it("does not crash on non-standard completion item kinds", () => {
        const item: LSP.CompletionItem = {
            label: "custom",
            // Servers may send kind values outside the standard 1-25 enum
            kind: 99 as LSP.CompletionItemKind,
        };
        const completion = convertCompletionItem(item, defaultOptions);
        expect(completion.type).toBeUndefined();
        expect(completion.label).toBe("custom");
    });
});

describe("convertCompletionItem apply", () => {
    it("applies a plain textEdit", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "foobar",
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 2 },
                },
                newText: "foobar",
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("foobar");
    });

    it("expands snippet-format textEdits instead of inserting raw snippet syntax", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "foo",
            insertTextFormat: 2, // Snippet
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 2 },
                },
                newText: "foo(${1:arg})",
            },
        };
        const completion = convertCompletionItem(item, {
            ...defaultOptions,
            useSnippetOnCompletion: true,
        });
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("foo(arg)");
        expect(view.state.doc.toString()).not.toContain("${");
    });

    it("strips snippet syntax from textEdits when snippet expansion is disabled", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "foo",
            insertTextFormat: 2, // Snippet
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 2 },
                },
                newText: "foo(${1:arg})$0",
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("foo(arg)");
    });

    it("falls back to the completion token range when the textEdit range is invalid", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "foobar",
            textEdit: {
                range: {
                    // Stale range pointing beyond the current document
                    start: { line: 0, character: 0 },
                    end: { line: 5, character: 3 },
                },
                newText: "foobar",
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("foobar");
    });

    it("applies additionalTextEdits against the pre-completion document", () => {
        // "f x" -> main edit replaces "f" (0-1) with "foobar" (+5 chars),
        // additional edit replaces "x" (2-3, pre-insert coordinates) with "imported"
        const view = createView("f x");
        const item: LSP.CompletionItem = {
            label: "foobar",
            insertText: "foobar",
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 2 },
                        end: { line: 0, character: 3 },
                    },
                    newText: "imported",
                },
            ],
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 1);
        expect(view.state.doc.toString()).toBe("foobar imported");
    });

    it("applies the main edit and additionalTextEdits in a single transaction", () => {
        const view = createView("f x");
        const dispatchSpy = vi.spyOn(view, "dispatch");
        const item: LSP.CompletionItem = {
            label: "foobar",
            insertText: "foobar",
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 2 },
                        end: { line: 0, character: 3 },
                    },
                    newText: "y",
                },
                {
                    range: {
                        start: { line: 0, character: 1 },
                        end: { line: 0, character: 1 },
                    },
                    newText: "!",
                },
            ],
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 1);
        expect(view.state.doc.toString()).toBe("foobar! y");
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });

    it("inserts an escaped snippet dollar as literal text (snippet mode)", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "price",
            insertTextFormat: 2, // Snippet
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 2 },
                },
                // Escaped dollar: literal text, not a tabstop
                newText: String.raw`\${1:price}`,
            },
        };
        const completion = convertCompletionItem(item, {
            ...defaultOptions,
            useSnippetOnCompletion: true,
        });
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("${1:price}");
    });

    it("inserts an escaped snippet dollar as literal text (plain mode)", () => {
        const view = createView("fo");
        const item: LSP.CompletionItem = {
            label: "price",
            insertTextFormat: 2, // Snippet
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 2 },
                },
                newText: String.raw`\${1:price}`,
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 2);
        expect(view.state.doc.toString()).toBe("${1:price}");
    });

    it("places the cursor right after the completion with additionalTextEdits", () => {
        const view = createView("f x");
        const item: LSP.CompletionItem = {
            label: "foobar",
            insertText: "foobar",
            additionalTextEdits: [
                {
                    // Import edit before the main edit shifts the main offset
                    range: {
                        start: { line: 0, character: 2 },
                        end: { line: 0, character: 3 },
                    },
                    newText: "imported",
                },
            ],
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 1);
        // "foobar imported" - cursor sits right after "foobar" (offset 6)
        expect(view.state.doc.toString()).toBe("foobar imported");
        expect(view.state.selection.main.head).toBe(6);
    });

    it("applies additionalTextEdits before a snippet expansion", () => {
        const view = createView("f x");
        const item: LSP.CompletionItem = {
            label: "foo",
            insertText: "foo($1)",
            insertTextFormat: 2, // Snippet
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 2 },
                        end: { line: 0, character: 3 },
                    },
                    newText: "import",
                },
            ],
        };
        const completion = convertCompletionItem(item, {
            ...defaultOptions,
            useSnippetOnCompletion: true,
        });
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 1);
        expect(view.state.doc.toString()).toBe("foo() import");
    });

    it("skips additionalTextEdits with invalid ranges instead of editing offset 0", () => {
        const view = createView("f x");
        const item: LSP.CompletionItem = {
            label: "foobar",
            insertText: "foobar",
            additionalTextEdits: [
                {
                    range: {
                        // Stale range beyond the document
                        start: { line: 9, character: 4 },
                        end: { line: 9, character: 8 },
                    },
                    newText: "bad",
                },
            ],
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 0, 1);
        expect(view.state.doc.toString()).toBe("foobar x");
    });
});

describe("sortCompletionItems with opaque sortText", () => {
    it("boosts prefix matches by label/filterText, not by sortText", () => {
        // Pyright-style servers send opaque sort keys; prefix boosting must
        // compare against what the user actually typed (label/filterText)
        const items: LSP.CompletionItem[] = [
            { label: "temp", sortText: "1" },
            { label: "Test", sortText: "9" },
        ];
        const sorted = sortCompletionItems(items, "Te", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["Test", "temp"]);
    });

    it("breaks ties between prefix matches using sortText", () => {
        const items: LSP.CompletionItem[] = [
            { label: "test", sortText: "2" },
            { label: "temp", sortText: "1" },
        ];
        const sorted = sortCompletionItems(items, "te", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["temp", "test"]);
    });
});
