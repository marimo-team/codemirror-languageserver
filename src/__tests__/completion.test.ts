import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import {
    completionOptionClass,
    convertAdditionalTextEdits,
    convertCompletionItem,
    convertSnippet,
    isDeprecatedItem,
    mapThroughReplacement,
    resolveItemDefaults,
    resolveMainEdit,
} from "../completion.js";
import { sortCompletionItems } from "../completion.js";

describe("convertCompletionItem", () => {
    it("should convert a basic completion item", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            kind: CompletionItemKind.Text,
            detail: "Test detail",
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion).toEqual({
            label: "test",
            detail: "Test detail",
            type: "text",
            apply: expect.any(Function),
        });
    });

    it("should handle textEdit", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 4 },
                },
                newText: "test",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
        // Note: We can't easily test the apply function here since it requires a view
    });

    it("should handle snippet insertion", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            insertText: "test${1:arg}",
            insertTextFormat: 2, // Snippet format
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
    });

    it("should handle documentation", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: "Test documentation",
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
    });

    it("should handle HTML documentation when allowed", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "**Bold** text",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: true,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
    });

    it("should handle resolve provider", async () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
        };

        const mockResolve = vi.fn().mockResolvedValue({
            ...lspItem,
            documentation: "Resolved documentation",
        });

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: true,
            resolveItem: mockResolve,
        });

        expect(completion.info).toBeDefined();
        if (completion.info) {
            // @ts-expect-error
            await completion.info();
            expect(mockResolve).toHaveBeenCalledWith(lspItem);
        }
    });

    it("should handle labelDetails", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            labelDetails: {
                detail: "Label detail",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.detail).toBe("Label detail");
    });

    it("should handle documentation with HTML content", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "<strong>Test</strong> documentation",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: true,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = completion.info?.();
        expect(info).toBeDefined();
        expect(info?.classList.contains("documentation")).toBe(true);
        expect(info?.innerHTML).toContain(
            "<strong>Test</strong> documentation",
        );
    });

    it("should handle documentation without HTML content", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "**Test** documentation",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = completion.info?.();
        expect(info).toBeDefined();
        expect(info?.classList.contains("documentation")).toBe(true);
        // Raw markdown is shown as text; rendered HTML tags must not leak in
        expect(info?.textContent).toContain("**Test** documentation");
        expect(info?.textContent).not.toContain("<strong>");
    });

    it("should handle completion item resolution", async () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "Initial documentation",
            },
        };

        const resolvedItem: LSP.CompletionItem = {
            ...lspItem,
            documentation: {
                kind: "markdown",
                value: "Resolved documentation",
            },
        };

        const resolveItem = vi.fn().mockResolvedValue(resolvedItem);

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: true,
            resolveItem,
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = await completion.info?.();
        expect(info).toBeDefined();
        expect(info?.textContent).toContain("Resolved documentation");
        expect(resolveItem).toHaveBeenCalledWith(lspItem);
    });

    it("should handle resolution failure gracefully", async () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "Initial documentation",
            },
        };

        const resolveItem = vi
            .fn()
            .mockRejectedValue(new Error("Resolution failed"));

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: true,
            resolveItem,
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = await completion.info?.();
        expect(info).toBeDefined();
        expect(info?.textContent).toContain("Initial documentation");
    });

    it("should handle additional text edits", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 4 },
                    },
                    newText: "test",
                },
            ],
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
    });

    it("should prefer snippet insertion when useSnippetOnCompletion is true", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            insertText: "test${1:arg}",
            // No insertTextFormat specified (undefined)
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: true,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
        // The apply function should treat insertText as a snippet when useSnippetOnCompletion is true
    });

    it("should not use snippet when useSnippetOnCompletion is true but insertTextFormat is PlainText", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            insertText: "test${1:arg}",
            insertTextFormat: 1, // PlainText format
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: true,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
        // The apply function should NOT treat insertText as a snippet when insertTextFormat is explicitly PlainText
    });

    it("should use snippet when insertTextFormat is explicitly Snippet regardless of useSnippetOnCompletion", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            insertText: "test${1:arg}",
            insertTextFormat: 2, // Snippet format
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            useSnippetOnCompletion: false, // Even with useSnippetOnCompletion false, should still use snippet
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
        // The apply function should treat insertText as a snippet when insertTextFormat is explicitly Snippet
    });
});

describe("sortCompletionItems", () => {
    const createItem = (
        label: string,
        sortText?: string,
    ): LSP.CompletionItem => ({
        label,
        sortText,
    });

    it("should sort by prefix match when matchBefore is provided", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
            createItem("testing"),
        ];

        const filtered = sortCompletionItems(items, "te", "javascript");
        expect(filtered.map((i) => i.label)).toEqual(["test", "testing"]);

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual([
            "alpha",
            "test",
            "testing",
            "zebra",
        ]);
    });

    it("should use sortText over label when available", () => {
        const items = [
            createItem("zebra", "1"),
            createItem("alpha", "2"),
            createItem("test", "0"),
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["test", "zebra", "alpha"]);
    });

    it("should filter out non-matching items for word characters", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
            createItem("testing"),
        ];

        const sorted = sortCompletionItems(items, "al", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha"]);
    });

    it("should not filter for non-word characters", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
        ];

        const sorted = sortCompletionItems(items, "@", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "test", "zebra"]);
    });

    it("should prioritize Python assignments", () => {
        const items = [
            createItem("value"),
            createItem("name="),
            createItem("test"),
            createItem("id="),
        ];

        const sorted = sortCompletionItems(items, undefined, "python");
        expect(sorted.map((i) => i.label)).toEqual([
            "id=",
            "name=",
            "test",
            "value",
        ]);
    });

    it("should handle filterText in prefix matching", () => {
        const items = [
            { label: "display", filterText: "_display" },
            { label: "test", filterText: "_test" },
            { label: "alpha", filterText: "_alpha" },
        ];

        const sorted = sortCompletionItems(items, "_t", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["test"]);
    });

    it("should handle empty matchBefore", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "test", "zebra"]);
    });

    it("should handle case insensitive matching", () => {
        const items = [
            createItem("Zebra"),
            createItem("alpha"),
            createItem("Test"),
        ];

        const filtered = sortCompletionItems(items, "te", "javascript");
        expect(filtered.map((i) => i.label)).toEqual(["Test"]);

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "Test", "Zebra"]);
    });

    it("should sort underscores last", () => {
        const items = [
            { label: "alpha", sortText: "alpha" },
            { label: "_hidden", sortText: "z_hidden" },
            { label: "beta", sortText: "beta" },
            { label: "__private", sortText: "zz__private" },
            { label: "gamma", sortText: "gamma" },
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual([
            "alpha",
            "beta",
            "gamma",
            "_hidden",
            "__private",
        ]);
    });
});

describe("convertSnippet", () => {
    it("should unescape double backslashes to a single backslash", () => {
        // Per the LSP snippet grammar, `\\` is an escaped literal backslash
        const input = String.raw`C:\\Users\\name`;
        const result = convertSnippet(input);
        expect(result).toBe(String.raw`C:\Users\name`);

        // but literal text is untouched
        const input2 = "filename\n/filename.txt";
        const result2 = convertSnippet(input2);
        expect(result2).toBe("filename\n/filename.txt");
    });

    it("should treat escaped dollar signs as literal text, not tabstops", () => {
        const input = String.raw`echo \$1`;
        const result = convertSnippet(input);
        expect(result).toBe("echo $1");
    });

    it("should convert $1 to ${1}", () => {
        const input = "function($1) { $2 }";
        const result = convertSnippet(input);
        expect(result).toBe("function(${1}) { ${2} }");
    });

    it("should handle multiple placeholders", () => {
        const input = "for (let $1 = 0; $1 < $2; $1++) {\n\t$3\n}";
        const result = convertSnippet(input);
        expect(result).toBe(
            "for (let ${1} = 0; ${1} < ${2}; ${1}++) {\n\t${3}\n}",
        );
    });

    it("should handle complex snippets", () => {
        const input =
            "try {\n\t$1\n} catch (error$2) {\n\t$3\n} finally {\n\t$4\n}";
        const result = convertSnippet(input);
        expect(result).toBe(
            "try {\n\t${1}\n} catch (error${2}) {\n\t${3}\n} finally {\n\t${4}\n}",
        );
    });

    it("should not modify existing braced placeholders", () => {
        const input = "function() { ${1:default} }";
        const result = convertSnippet(input);
        expect(result).toBe("function() { ${1:default} }");
    });

    it("keeps an escaped dollar before a brace from becoming a field", () => {
        // LSP `\${1:price}` is literal text, not a tabstop. CodeMirror only
        // treats `${...}` as a field, so the brace must be escaped so the
        // sequence renders as the literal `${1:price}`.
        const input = String.raw`\${1:price}`;
        const result = convertSnippet(input);
        expect(result).toBe(String.raw`$\{1:price}`);
    });
});

describe("resolveItemDefaults", () => {
    const range: LSP.Range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
    };

    it("returns the item unchanged when there are no defaults", () => {
        const item: LSP.CompletionItem = { label: "test" };
        expect(resolveItemDefaults(item, undefined)).toBe(item);
    });

    it("fills commitCharacters, insertTextFormat, insertTextMode and data from defaults", () => {
        const resolved = resolveItemDefaults(
            { label: "test" },
            {
                commitCharacters: ["."],
                insertTextFormat: 2,
                insertTextMode: 1,
                data: { id: 1 },
            },
        );
        expect(resolved).toEqual({
            label: "test",
            commitCharacters: ["."],
            insertTextFormat: 2,
            insertTextMode: 1,
            data: { id: 1 },
        });
    });

    it("prefers fields set on the item over defaults", () => {
        const resolved = resolveItemDefaults(
            {
                label: "test",
                commitCharacters: ["("],
                insertTextFormat: 1,
                data: { id: 2 },
                textEdit: { range, newText: "own" },
            },
            {
                commitCharacters: ["."],
                insertTextFormat: 2,
                data: { id: 1 },
                editRange: range,
            },
        );
        expect(resolved.commitCharacters).toEqual(["("]);
        expect(resolved.insertTextFormat).toBe(1);
        expect(resolved.data).toEqual({ id: 2 });
        expect(resolved.textEdit).toEqual({ range, newText: "own" });
    });

    it("converts a plain default editRange into a textEdit", () => {
        const resolved = resolveItemDefaults(
            { label: "test" },
            { editRange: range },
        );
        expect(resolved.textEdit).toEqual({ range, newText: "test" });
    });

    it("uses textEditText over label for a default editRange", () => {
        const resolved = resolveItemDefaults(
            { label: "test", textEditText: "test()" },
            { editRange: range },
        );
        expect(resolved.textEdit).toEqual({ range, newText: "test()" });
    });

    it("converts an insert/replace default editRange into an InsertReplaceEdit", () => {
        const insert: LSP.Range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 2 },
        };
        const resolved = resolveItemDefaults(
            { label: "test" },
            { editRange: { insert, replace: range } },
        );
        expect(resolved.textEdit).toEqual({
            insert,
            replace: range,
            newText: "test",
        });
    });
});

describe("completion item metadata", () => {
    const defaultOptions = {
        allowHTMLContent: false,
        useSnippetOnCompletion: false,
        hasResolveProvider: false,
        resolveItem: vi.fn(),
    };

    it("passes commitCharacters through to the CodeMirror completion", () => {
        const completion = convertCompletionItem(
            { label: "test", commitCharacters: [".", "("] },
            defaultOptions,
        );
        expect(completion.commitCharacters).toEqual([".", "("]);
    });

    it("marks items deprecated via tags", () => {
        const completion = convertCompletionItem(
            { label: "test", tags: [1] },
            defaultOptions,
        );
        expect(completion.deprecated).toBe(true);
    });

    it("marks items deprecated via the legacy deprecated flag", () => {
        const completion = convertCompletionItem(
            { label: "test", deprecated: true },
            defaultOptions,
        );
        expect(completion.deprecated).toBe(true);
    });

    it("leaves non-deprecated items unmarked", () => {
        const completion = convertCompletionItem(
            { label: "test" },
            defaultOptions,
        );
        expect(completion.deprecated).toBeUndefined();
    });
});

describe("sortCompletionItems client-side filtering mode", () => {
    it("keeps non-matching items when filtering is disabled", () => {
        const items: LSP.CompletionItem[] = [
            { label: "foo" },
            { label: "bar" },
        ];
        const sorted = sortCompletionItems(items, "fo", "javascript", false);
        expect(sorted.map((i) => i.label)).toEqual(["foo", "bar"]);
    });

    it("still filters by default", () => {
        const items: LSP.CompletionItem[] = [
            { label: "foo" },
            { label: "bar" },
        ];
        const sorted = sortCompletionItems(items, "fo", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["foo"]);
    });
});

describe("resolveMainEdit", () => {
    const doc = Text.of(["hello world"]);

    it("falls back to the token range and insertText without a textEdit", () => {
        expect(
            resolveMainEdit(
                doc,
                { label: "hello", insertText: "hello()" },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 3, newText: "hello()" });
    });

    it("uses a TextEdit's range and text", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 5 },
                        },
                        newText: "goodbye",
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 5, newText: "goodbye" });
    });

    it("uses the replace range of an InsertReplaceEdit", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        newText: "goodbye",
                        insert: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 3 },
                        },
                        replace: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 5 },
                        },
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 5, newText: "goodbye" });
    });

    it("keeps the edit text but falls back to the token range when the edit range is stale", () => {
        expect(
            resolveMainEdit(
                doc,
                {
                    label: "hello",
                    textEdit: {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 9, character: 9 },
                        },
                        newText: "goodbye",
                    },
                },
                0,
                3,
            ),
        ).toEqual({ from: 0, to: 3, newText: "goodbye" });
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

    it("converts edits to offset changes", () => {
        expect(
            convertAdditionalTextEdits(doc, [edit(6, 11, "there")], 0, 5),
        ).toEqual([{ from: 6, to: 11, insert: "there" }]);
    });

    it("drops edits overlapping the main edit", () => {
        expect(
            convertAdditionalTextEdits(doc, [edit(4, 7, "x")], 0, 5),
        ).toEqual([]);
    });

    it("drops edits with stale ranges", () => {
        expect(
            convertAdditionalTextEdits(doc, [edit(0, 4, "x", 9)], 6, 11),
        ).toEqual([]);
    });
});

describe("mapThroughReplacement", () => {
    // Replacement of [2, 5) by 7 characters
    const mapPos = mapThroughReplacement(2, 5, 7);

    it("keeps positions before the replacement", () => {
        expect(mapPos(0)).toBe(0);
        expect(mapPos(2)).toBe(2);
    });

    it("shifts positions after the replacement by the length delta", () => {
        expect(mapPos(5)).toBe(9);
        expect(mapPos(10)).toBe(14);
    });
});

describe("isDeprecatedItem / completionOptionClass", () => {
    it("detects deprecation via tags and legacy flag", () => {
        expect(isDeprecatedItem({ tags: [1] })).toBe(true);
        expect(isDeprecatedItem({ deprecated: true })).toBe(true);
        expect(isDeprecatedItem({})).toBe(false);
    });

    it("returns cm-deprecated only for deprecated completions", () => {
        expect(completionOptionClass({ label: "a", deprecated: true })).toBe(
            "cm-deprecated",
        );
        expect(completionOptionClass({ label: "a" })).toBe("");
    });
});
