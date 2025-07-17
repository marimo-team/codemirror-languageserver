import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import {
    isLSPMarkupContent,
    isLSPTextEdit,
    prefixMatch,
    renderMarkdown,
    showErrorMessage,
} from "../utils.js";

describe("isLSPTextEdit", () => {
    it("should return true for valid LSP.TextEdit", () => {
        const textEdit: LSP.TextEdit = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            },
            newText: "test",
        };

        expect(isLSPTextEdit(textEdit)).toBe(true);
    });

    it("should return false for LSP.InsertReplaceEdit", () => {
        const insertReplaceEdit: LSP.InsertReplaceEdit = {
            insert: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            },
            replace: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            },
            newText: "test",
        };

        expect(isLSPTextEdit(insertReplaceEdit)).toBe(false);
    });

    it("should return false for undefined", () => {
        expect(isLSPTextEdit(undefined)).toBe(false);
    });

    it("should return false for object without range", () => {
        const invalidEdit = { newText: "test" };
        expect(isLSPTextEdit(invalidEdit as LSP.TextEdit)).toBe(false);
    });
});

describe("isLSPMarkupContent", () => {
    it("should return true for MarkupContent", () => {
        const markupContent: LSP.MarkupContent = {
            kind: "markdown",
            value: "**Bold text**",
        };

        expect(isLSPMarkupContent(markupContent)).toBe(true);
    });

    it("should return false for string MarkedString", () => {
        const markedString: LSP.MarkedString = "plain text";
        expect(isLSPMarkupContent(markedString)).toBe(false);
    });

    it("should return false for object MarkedString", () => {
        const markedString: LSP.MarkedString = {
            language: "javascript",
            value: "console.log('test')",
        };
        expect(isLSPMarkupContent(markedString)).toBe(false);
    });

    it("should return false for array of MarkedStrings", () => {
        const markedStrings: LSP.MarkedString[] = [
            "plain text",
            { language: "javascript", value: "console.log('test')" },
        ];
        expect(isLSPMarkupContent(markedStrings)).toBe(false);
    });
});

describe("showErrorMessage", () => {
    it("should create and display error tooltip", () => {
        // Mock DOM methods
        const mockElement = {
            className: "",
            style: {
                cssText: "",
                left: "",
                top: "",
                opacity: "",
                transition: "",
            },
            textContent: "",
            remove: vi.fn(),
        };

        const originalCreateElement = document.createElement;
        document.createElement = vi.fn().mockReturnValue(mockElement);

        const originalAppendChild = document.body.appendChild;
        document.body.appendChild = vi.fn();

        // Mock setTimeout
        const originalSetTimeout = setTimeout;
        global.setTimeout = vi.fn().mockImplementation((callback, delay) => {
            if (delay === 3000) {
                // Don't call the callback immediately for the 3-second timeout
                return 1;
            }
            // Call the callback immediately for the 200ms timeout
            callback();
            return 2;
        });

        // Create a minimal EditorView mock
        const mockView = {
            coordsAtPos: vi.fn().mockReturnValue({ left: 100, bottom: 200 }),
            state: {
                selection: {
                    main: { head: 0 },
                },
            },
        } as unknown as EditorView;

        showErrorMessage(mockView, "Test error message");

        expect(document.createElement).toHaveBeenCalledWith("div");
        expect(mockElement.className).toBe("cm-error-message");
        expect(mockElement.textContent).toBe("Test error message");
        expect(mockElement.style.left).toBe("100px");
        expect(mockElement.style.top).toBe("205px");
        expect(document.body.appendChild).toHaveBeenCalledWith(mockElement);

        // Restore original methods
        document.createElement = originalCreateElement;
        document.body.appendChild = originalAppendChild;
        global.setTimeout = originalSetTimeout;
    });

    it("should handle missing cursor coordinates", () => {
        const mockElement = {
            className: "",
            style: {
                cssText: "",
                left: "",
                top: "",
                opacity: "",
                transition: "",
            },
            textContent: "",
            remove: vi.fn(),
        };

        const originalCreateElement = document.createElement;
        document.createElement = vi.fn().mockReturnValue(mockElement);

        const originalAppendChild = document.body.appendChild;
        document.body.appendChild = vi.fn();

        const mockView = {
            coordsAtPos: vi.fn().mockReturnValue(null),
            state: {
                selection: {
                    main: { head: 0 },
                },
            },
        } as unknown as EditorView;

        showErrorMessage(mockView, "Test error");

        expect(mockElement.style.left).toBe("");
        expect(mockElement.style.top).toBe("");

        // Restore original methods
        document.createElement = originalCreateElement;
        document.body.appendChild = originalAppendChild;
    });
});

describe("prefixMatch", () => {
    it("should return undefined for empty items array", () => {
        expect(prefixMatch([])).toBe(undefined);
    });

    it("should return undefined for empty common prefix", () => {
        const items: LSP.CompletionItem[] = [
            { label: "alpha" },
            { label: "beta" },
            { label: "gamma" },
        ];

        expect(prefixMatch(items)).toBe(undefined);
    });

    it("should create regex for common prefix", () => {
        const items: LSP.CompletionItem[] = [
            { label: "test1" },
            { label: "test2" },
            { label: "testing" },
        ];

        const result = prefixMatch(items);
        expect(result).toBeInstanceOf(RegExp);
        expect(result?.toString()).toMatch(/test/);
    });

    it("should use textEdit.newText when available", () => {
        const items: LSP.CompletionItem[] = [
            {
                label: "display",
                textEdit: {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 },
                    },
                    newText: "prefix1",
                },
            },
            {
                label: "show",
                textEdit: {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 },
                    },
                    newText: "prefix2",
                },
            },
        ];

        const result = prefixMatch(items);
        expect(result).toBeInstanceOf(RegExp);
        expect(result?.toString()).toMatch(/prefix/);
    });

    it("should escape special regex characters", () => {
        const items: LSP.CompletionItem[] = [
            { label: "test.method" },
            { label: "test.property" },
        ];

        const result = prefixMatch(items);
        expect(result).toBeInstanceOf(RegExp);

        // Test that the regex works correctly with escaped characters
        expect("test.").toMatch(result as RegExp);
        expect("test").toMatch(result as RegExp);
    });

    it("should handle single character prefixes", () => {
        const items: LSP.CompletionItem[] = [{ label: "a1" }, { label: "a2" }];

        const result = prefixMatch(items);
        expect(result).toBeInstanceOf(RegExp);
        expect("a").toMatch(result as RegExp);
    });
});

describe("renderMarkdown", () => {
    it("should render basic markdown", () => {
        const result = renderMarkdown("**bold** text");
        expect(result).toContain("<strong>bold</strong>");
    });

    it("should handle empty input", () => {
        const result = renderMarkdown("");
        expect(result).toBe("");
    });

    it("should render code blocks", () => {
        const result = renderMarkdown(
            "```javascript\nconsole.log('test');\n```",
        );
        expect(result).toContain("<pre>");
        expect(result).toContain("code");
    });

    it("should render line breaks", () => {
        const result = renderMarkdown("Line 1\nLine 2");
        expect(result).toContain("<br>");
    });

    it("should handle links", () => {
        const result = renderMarkdown("[Link](https://example.com)");
        expect(result).toContain('<a href="https://example.com">Link</a>');
    });

    it("should remove empty code fences", () => {
        const result = renderMarkdown("```\n\n```");
        expect(result).toBe("");
    });

    it("should preserve non-empty code fences", () => {
        const result = renderMarkdown("```\ncode content\n```");
        expect(result).toContain("<pre>");
        expect(result).toContain("<code>");
    });
});
