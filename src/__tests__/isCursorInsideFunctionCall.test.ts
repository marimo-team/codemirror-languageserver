import { describe, expect, it } from "vitest";

import {
    getParenthesesBalance,
    isCursorInsideFunctionCall,
} from "../plugin.js";

describe("getParenthesesBalance", () => {
    it("should return 0 for empty string", () => {
        expect(getParenthesesBalance("")).toBe(0);
    });

    it("should return 1 for single open paren", () => {
        expect(getParenthesesBalance("(")).toBe(1);
    });

    it("should return 0 for matched parens", () => {
        expect(getParenthesesBalance("()")).toBe(0);
    });

    it("should return -1 for single close paren", () => {
        expect(getParenthesesBalance(")")).toBe(-1);
    });

    it("should count nested parens correctly", () => {
        expect(getParenthesesBalance("((")).toBe(2);
        expect(getParenthesesBalance("(()")).toBe(1);
        expect(getParenthesesBalance("(())")).toBe(0);
    });

    it("should handle text with parens", () => {
        expect(getParenthesesBalance("func(")).toBe(1);
        expect(getParenthesesBalance("func(arg")).toBe(1);
        expect(getParenthesesBalance("func(arg)")).toBe(0);
    });

    it("should handle complex expressions", () => {
        expect(getParenthesesBalance("func(a, b, c")).toBe(1);
        expect(getParenthesesBalance("func(a, (b, c)")).toBe(1);
        expect(getParenthesesBalance("func(a, (b, c))")).toBe(0);
    });

    it("should ignore other brackets", () => {
        expect(getParenthesesBalance("func([1,2,3]")).toBe(1);
        expect(getParenthesesBalance("func({a: 1}")).toBe(1);
        expect(getParenthesesBalance("func([1,2,3])")).toBe(0);
    });
});

// Helper to create a mock document for testing
function createMockDoc(content: string) {
    const lines = content.split("\n");
    return {
        lineAt: (pos: number) => {
            let currentPos = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineLength = lines[i].length + 1; // +1 for newline
                if (pos < currentPos + lineLength || i === lines.length - 1) {
                    return { number: i + 1, from: currentPos };
                }
                currentPos += lineLength;
            }
            return { number: lines.length, from: currentPos };
        },
        line: (n: number) => {
            let from = 0;
            for (let i = 0; i < n - 1 && i < lines.length; i++) {
                from += lines[i].length + 1;
            }
            return { from };
        },
        sliceString: (from: number, to: number) => content.slice(from, to),
    };
}

describe("isCursorInsideFunctionCall", () => {
    describe("single line cases", () => {
        it("should return true when cursor is inside function call", () => {
            const doc = createMockDoc("func(");
            expect(isCursorInsideFunctionCall(doc, 5)).toBe(true);
        });

        it("should return true when cursor is inside with arguments", () => {
            const doc = createMockDoc("func(arg1, arg2");
            expect(isCursorInsideFunctionCall(doc, 15)).toBe(true);
        });

        it("should return false when cursor is after closing paren", () => {
            const doc = createMockDoc("func()");
            expect(isCursorInsideFunctionCall(doc, 6)).toBe(false);
        });

        it("should return false when cursor is before any parens", () => {
            const doc = createMockDoc("func");
            expect(isCursorInsideFunctionCall(doc, 4)).toBe(false);
        });

        it("should return false for empty document", () => {
            const doc = createMockDoc("");
            expect(isCursorInsideFunctionCall(doc, 0)).toBe(false);
        });
    });

    describe("backspace scenarios", () => {
        it("should return false after backspacing the opening paren", () => {
            // User typed "bool(" then backspaced to "bool"
            const doc = createMockDoc("bool");
            expect(isCursorInsideFunctionCall(doc, 4)).toBe(false);
        });

        it("should return true when backspacing inside parens", () => {
            // User typed "bool(x" then backspaced to "bool("
            const doc = createMockDoc("bool(");
            expect(isCursorInsideFunctionCall(doc, 5)).toBe(true);
        });
    });

    describe("arrow key scenarios", () => {
        it("should return false when cursor moves past closing paren", () => {
            // Cursor moved from inside () to after )
            const doc = createMockDoc("bool()");
            expect(isCursorInsideFunctionCall(doc, 6)).toBe(false);
        });

        it("should return true when cursor is still inside", () => {
            const doc = createMockDoc("bool()");
            expect(isCursorInsideFunctionCall(doc, 5)).toBe(true);
        });
    });

    describe("multi-line function calls", () => {
        it("should return true when cursor is inside multi-line call", () => {
            const content = "pl.DataFrame(\n    data=[1, 2, 3],";
            const doc = createMockDoc(content);
            // Cursor at end of second line
            expect(isCursorInsideFunctionCall(doc, content.length)).toBe(true);
        });

        it("should return true when deep inside multi-line call", () => {
            const content =
                "pl.DataFrame(\n    data=[1, 2, 3],\n    strict=False,";
            const doc = createMockDoc(content);
            // Cursor at end
            expect(isCursorInsideFunctionCall(doc, content.length)).toBe(true);
        });

        it("should return false after closing multi-line call", () => {
            const content = "pl.DataFrame(\n    data=[1, 2, 3],\n)";
            const doc = createMockDoc(content);
            // Cursor after closing paren (at end of string)
            expect(isCursorInsideFunctionCall(doc, content.length)).toBe(false);
        });

        it("should handle nested brackets in multi-line call", () => {
            const content =
                "pl.DataFrame(\n    data=[1, 2, 3],\n    index=['a', 'b'],";
            const doc = createMockDoc(content);
            expect(isCursorInsideFunctionCall(doc, content.length)).toBe(true);
        });
    });

    describe("nested function calls", () => {
        it("should return true when inside nested call", () => {
            const doc = createMockDoc("outer(inner(");
            expect(isCursorInsideFunctionCall(doc, 12)).toBe(true);
        });

        it("should return true after closing inner but still in outer", () => {
            const doc = createMockDoc("outer(inner()");
            expect(isCursorInsideFunctionCall(doc, 13)).toBe(true);
        });

        it("should return false after closing all calls", () => {
            const doc = createMockDoc("outer(inner())");
            expect(isCursorInsideFunctionCall(doc, 14)).toBe(false);
        });
    });

    describe("complex expressions", () => {
        it("should handle list comprehensions", () => {
            const doc = createMockDoc("func([x for x in range(10)");
            expect(isCursorInsideFunctionCall(doc, 26)).toBe(true);
        });

        it("should handle dictionary literals", () => {
            const doc = createMockDoc("func({key: value}");
            expect(isCursorInsideFunctionCall(doc, 17)).toBe(true);
        });

        it("should handle string with parens (not perfect but acceptable)", () => {
            // Note: This is a known limitation - we don't parse strings
            const doc = createMockDoc('func("hello (world)"');
            // Balance would be 1 + 1 - 1 = 1, so still inside (acceptable)
            expect(isCursorInsideFunctionCall(doc, 20)).toBe(true);
        });
    });

    describe("maxLinesBack parameter", () => {
        it("should respect maxLinesBack limit", () => {
            // Create a doc with opening paren on line 1, cursor on line 10
            const lines = ["func(", ...Array(8).fill("  arg,"), "  final"];
            const content = lines.join("\n");
            const doc = createMockDoc(content);
            const cursorPos = content.length;

            // With default (20 lines back), should find the paren
            expect(isCursorInsideFunctionCall(doc, cursorPos)).toBe(true);

            // With only 2 lines back, won't see the opening paren
            expect(isCursorInsideFunctionCall(doc, cursorPos, 2)).toBe(false);
        });

        it("should handle very long function calls up to 20 lines", () => {
            // Create a doc with opening paren on line 1, cursor on line 15
            const lines = ["func(", ...Array(13).fill("  arg,"), "  final"];
            const content = lines.join("\n");
            const doc = createMockDoc(content);
            const cursorPos = content.length;

            // Should still find it within 20 lines
            expect(isCursorInsideFunctionCall(doc, cursorPos)).toBe(true);
        });
    });

    describe("performance", () => {
        const expectedPerformanceInMs = 0.1;

        it("should handle typical function call quickly (<1ms)", () => {
            const content =
                "pl.DataFrame(\n    data=[1, 2, 3],\n    index=['a', 'b', 'c'],";
            const doc = createMockDoc(content);
            const cursorPos = content.length;

            const iterations = 1000;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                isCursorInsideFunctionCall(doc, cursorPos);
            }
            const elapsed = performance.now() - start;
            const avgMs = elapsed / iterations;

            expect(avgMs).toBeLessThan(expectedPerformanceInMs);
        });

        it("should handle 20 lines of content efficiently", () => {
            const lines = [
                "pl.DataFrame(",
                ...Array(18).fill("    some_argument='value',"),
                "    final_arg",
            ];
            const content = lines.join("\n");
            const doc = createMockDoc(content);
            const cursorPos = content.length;

            const iterations = 1000;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                isCursorInsideFunctionCall(doc, cursorPos);
            }
            const elapsed = performance.now() - start;
            const avgMs = elapsed / iterations;

            expect(avgMs).toBeLessThan(expectedPerformanceInMs);
        });

        it("should handle long lines efficiently", () => {
            // Simulate a line with a very long list
            const longList = Array(100).fill("item").join(", ");
            const content = `func([${longList}],`;
            const doc = createMockDoc(content);
            const cursorPos = content.length;

            const iterations = 1000;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                isCursorInsideFunctionCall(doc, cursorPos);
            }
            const elapsed = performance.now() - start;
            const avgMs = elapsed / iterations;

            expect(avgMs).toBeLessThan(expectedPerformanceInMs);
        });
    });
});
