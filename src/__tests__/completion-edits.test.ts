import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import {
    convertAdditionalTextEdits,
    convertCompletionItem,
    resolveItemDefaults,
    resolveMainEdit,
    sortCompletionItems,
} from "../completion.js";
import {
    createView,
    defaultCompletionOptions as defaultOptions,
} from "./test-utils.js";

describe("resolveMainEdit", () => {
    const doc = Text.of(["hello world"]);

    it("rejects a textEdit range with a negative character", () => {
        const result = resolveMainEdit(
            doc,
            {
                label: "hello",
                textEdit: {
                    range: {
                        start: { line: 0, character: -5 },
                        end: { line: 0, character: -1 },
                    },
                    newText: "goodbye",
                },
            },
            0,
            3,
        );
        expect(result.from).toBeGreaterThanOrEqual(0);
        expect(result).toEqual({ from: 0, to: 3, newText: "goodbye" });
    });

    it("falls back to the token range for a non-numeric textEdit range", () => {
        const result = resolveMainEdit(
            doc,
            {
                label: "hello",
                textEdit: {
                    range: {
                        start: { line: 0, character: Number.NaN },
                        end: { line: 0, character: Number.NaN },
                    },
                    newText: "goodbye",
                },
            },
            0,
            3,
        );
        expect(Number.isNaN(result.from)).toBe(false);
        expect(Number.isNaN(result.to)).toBe(false);
        expect(result).toEqual({ from: 0, to: 3, newText: "goodbye" });
    });

    it("rejects a textEdit range whose end precedes its start", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        range: {
                            start: { line: 0, character: 5 },
                            end: { line: 0, character: 2 },
                        },
                        newText: "goodbye",
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 3, newText: "goodbye" });
    });

    it("rejects a textEdit range that starts past the end of the document", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        range: {
                            start: { line: 4, character: 0 },
                            end: { line: 4, character: 0 },
                        },
                        newText: "goodbye",
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 3, newText: "goodbye" });
    });

    it("prefers a valid textEdit range over insertText", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    insertText: "ignored",
                    textEdit: {
                        range: {
                            start: { line: 0, character: 6 },
                            end: { line: 0, character: 11 },
                        },
                        newText: "goodbye",
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 6, to: 11, newText: "goodbye" });
    });

    it("uses the replace range of an InsertReplaceEdit, not the insert range", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        newText: "goodbye",
                        insert: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 2 },
                        },
                        replace: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 5 },
                        },
                    },
                },
                0,
                2,
            ),
        ).toEqual({ from: 0, to: 5, newText: "goodbye" });
    });

    it("prefers insertText over label when there is no textEdit", () => {
        expect(
            resolveMainEdit(
                doc,
                { label: "hello", insertText: "hello()" },
                0,
                5,
            ).newText,
        ).toBe("hello()");
    });
});

describe("convertAdditionalTextEdits", () => {
    const doc = Text.of(["hello world"]);
    const edit = (
        startChar: number,
        endChar: number,
        newText: string,
        line = 0,
    ): LSP.TextEdit => ({
        range: {
            start: { line, character: startChar },
            end: { line, character: endChar },
        },
        newText,
    });

    it("drops additionalTextEdits with non-numeric ranges", () => {
        const changes = convertAdditionalTextEdits(
            doc,
            [edit(Number.NaN, Number.NaN, "boom")],
            0,
            5,
        );
        expect(changes).toEqual([]);
    });

    it("drops additionalTextEdits with negative ranges", () => {
        const changes = convertAdditionalTextEdits(
            doc,
            [edit(-5, -1, "boom")],
            0,
            5,
        );
        expect(changes).toEqual([]);
    });

    it("keeps an additionalTextEdit that only touches the main edit boundary", () => {
        // Per LSP, additionalTextEdits must not *overlap* the main edit; a
        // zero-width insertion exactly at either boundary only touches it
        expect(
            convertAdditionalTextEdits(doc, [edit(4, 4, "x")], 4, 9),
        ).toEqual([{ from: 4, to: 4, insert: "x" }]);
        expect(
            convertAdditionalTextEdits(doc, [edit(9, 9, "x")], 4, 9),
        ).toEqual([{ from: 9, to: 9, insert: "x" }]);
    });
});

describe("sortCompletionItems", () => {
    it("does not throw for an item with no label", () => {
        // A single malformed item must not take down the whole response
        const items = [
            { label: "foo" },
            {} as LSP.CompletionItem,
        ] as LSP.CompletionItem[];
        let sorted: LSP.CompletionItem[] = [];
        expect(() => {
            sorted = sortCompletionItems(items, "fo", "python");
        }).not.toThrow();
        expect(sorted.map((i) => i.label)).toContain("foo");
    });

    it("does not throw for an item whose label is not a string", () => {
        const items = [
            { label: "foo" },
            { label: 42 as unknown as string },
        ] as LSP.CompletionItem[];
        let sorted: LSP.CompletionItem[] = [];
        expect(() => {
            sorted = sortCompletionItems(items, "fo", "python");
        }).not.toThrow();
        expect(sorted.map((i) => i.label)).toContain("foo");
    });

    it("does not mutate the caller's item array", () => {
        const items: LSP.CompletionItem[] = [
            { label: "b" },
            { label: "a" },
            { label: "c" },
        ];
        sortCompletionItems(items, undefined, "javascript");
        expect(items.map((i) => i.label)).toEqual(["b", "a", "c"]);
    });

    it("handles an empty items array", () => {
        expect(sortCompletionItems([], "fo", "python")).toEqual([]);
        expect(sortCompletionItems([], undefined, "javascript")).toEqual([]);
    });

    it("keeps a stable order for duplicate labels with identical sortText", () => {
        const items: LSP.CompletionItem[] = [
            { label: "dup", sortText: "0", detail: "first" },
            { label: "dup", sortText: "0", detail: "second" },
            { label: "dup", sortText: "0", detail: "third" },
        ];
        expect(
            sortCompletionItems(items, "du", "python").map((i) => i.detail),
        ).toEqual(["first", "second", "third"]);
    });
});

describe("completion item defaults", () => {
    const range: LSP.Range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
    };

    it("falls back to insertText when a default editRange has no textEditText", () => {
        // Without itemDefaults the item would insert `test()`; the default
        // editRange must not silently throw the server's insertText away
        const resolved = resolveItemDefaults(
            { label: "test", insertText: "test()" },
            { editRange: range },
        );
        expect(resolved.textEdit).toEqual({ range, newText: "test()" });
    });
});

describe("applying completions", () => {
    it("applies a textEdit range that does not cover the cursor", () => {
        // Per LSP the edit range must contain the requested position; a range
        // sitting elsewhere in the line is stale and must be ignored
        const view = createView("let a = fo");
        const item: LSP.CompletionItem = {
            label: "foobar",
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 3 },
                },
                newText: "foobar",
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 8, 10);
        expect(view.state.doc.toString()).toBe("let a = foobar");
    });

    it("applies a textEdit spanning multiple lines", () => {
        const view = createView("foo\nbar");
        const item: LSP.CompletionItem = {
            label: "baz",
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 3 },
                },
                newText: "baz",
            },
        };
        const completion = convertCompletionItem(item, defaultOptions);
        // biome-ignore lint/suspicious/noExplicitAny: test invokes apply directly
        (completion.apply as any)(view, completion, 4, 7);
        expect(view.state.doc.toString()).toBe("baz");
        expect(view.state.selection.main.head).toBe(3);
    });
});
