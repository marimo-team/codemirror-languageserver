import { describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import { convertCompletionItem, convertSnippet } from "../completion.js";
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
        expect(info?.textContent).toContain(
            "<strong>Test</strong> documentation",
        );
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
    it("should remove backslashes", () => {
        const input = String.raw`filename\\/filename.txt`;
        const result = convertSnippet(input);
        expect(result).toBe("filename/filename.txt");

        // but not single
        const input2 = "filename\n/filename.txt";
        const result2 = convertSnippet(input2);
        expect(result2).toBe("filename\n/filename.txt");
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
});
