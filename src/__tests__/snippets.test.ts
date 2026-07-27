import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { convertCompletionItem } from "../completion.js";
import {
    createCompletionView as createView,
    defaultCompletionOptions as defaultOptions,
} from "./completion-test-utils.js";

/**
 * Applies a snippet-format completion over the whole document through the
 * real `snippet()` pipeline (`convertSnippetToPlainText` is not exported, so
 * plain mode is exercised the same way).
 */
function applySnippet(
    doc: string,
    newText: string,
    useSnippetOnCompletion = true,
): EditorView {
    const view = createView(doc);
    const item: LSP.CompletionItem = {
        label: "item",
        insertTextFormat: 2, // Snippet
        textEdit: {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: doc.length },
            },
            newText,
        },
    };
    const completion = convertCompletionItem(item, {
        ...defaultOptions,
        useSnippetOnCompletion,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
    (completion.apply as any)(view, completion, 0, doc.length);
    return view;
}

describe("convertSnippet through the snippet apply path", () => {
    it("places the final tabstop last, not first", () => {
        // LSP `$0` is the *final* cursor position; CodeMirror sorts fields by
        // number ascending, so `${0}` must not be visited before `${1}`
        const view = applySnippet("fo", "foo(${1:arg})$0");
        expect(view.state.doc.toString()).toBe("foo(arg)");
        const { from, to } = view.state.selection.main;
        expect(view.state.sliceDoc(from, to)).toBe("arg");
    });

    it("does not turn a literal #{...} into a snippet field", () => {
        // `#{...}` is CodeMirror field syntax but plain text in LSP snippets
        const view = applySnippet("fo", "#{foo}");
        expect(view.state.doc.toString()).toBe("#{foo}");
    });

    it("keeps snippet choice syntax literal", () => {
        // LSP choice syntax: the first choice is the default placeholder text.
        const view = applySnippet("fo", "${1|a,b|}");
        expect(view.state.doc.toString()).not.toContain("|");
        expect(view.state.doc.toString()).toBe("a");
    });

    it("handles nested placeholder defaults", () => {
        const view = applySnippet("fo", "${1:${2:inner}}");
        expect(view.state.doc.toString()).toBe("inner");
    });

    it("does not insert LSP variable names as literal text", () => {
        // An unresolved variable expands to the empty string, not its name
        expect(applySnippet("fo", "x${TM_FILENAME}").state.doc.toString()).toBe(
            "x",
        );
        expect(applySnippet("fo", "x$TM_FILENAME").state.doc.toString()).toBe(
            "x",
        );
    });

    it("keeps escaped braces and backslashes literal", () => {
        expect(applySnippet("fo", String.raw`\{a\}`).state.doc.toString()).toBe(
            "{a}",
        );
        expect(
            applySnippet("fo", String.raw`C:\\Users`).state.doc.toString(),
        ).toBe(String.raw`C:\Users`);
    });

    it("expands a plain numbered tabstop and selects it", () => {
        const view = applySnippet("fo", "foo(${1:arg})");
        expect(view.state.doc.toString()).toBe("foo(arg)");
        const { from, to } = view.state.selection.main;
        expect(view.state.sliceDoc(from, to)).toBe("arg");
    });
});

describe("plain-text snippet conversion (snippets disabled)", () => {
    it("drops tabstops in plain mode for choice and variable syntax", () => {
        // Neither the choice syntax nor an unresolved variable may leak raw
        // `${...}` text into the document
        expect(
            applySnippet("fo", "${1|a,b|}", false).state.doc.toString(),
        ).toBe("a");
        expect(applySnippet("fo", "x${TM_X}", false).state.doc.toString()).toBe(
            "x",
        );
    });

    it("keeps placeholder defaults and drops bare tabstops", () => {
        expect(
            applySnippet("fo", "foo(${1:arg})$0", false).state.doc.toString(),
        ).toBe("foo(arg)");
    });

    it("keeps escaped snippet syntax literal in plain mode", () => {
        expect(
            applySnippet("fo", String.raw`\{a\}`, false).state.doc.toString(),
        ).toBe("{a}");
    });
});
