import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import {
    longestCommonPrefix,
    offsetToPos,
    posToOffset,
    posToOffsetOrZero,
    prefixMatch,
} from "../utils.js";

describe("posToOffset - malformed positions", () => {
    it("should return undefined for a negative line", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffset(doc, { line: -1, character: 0 })).toBeUndefined();
    });

    it("should never return a negative offset", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffset(doc, { line: 0, character: -5 })).toBeUndefined();
    });

    it("should return undefined for a fractional character", () => {
        // A fractional character would yield a fractional offset, which
        // breaks range-based decoration and tooltip positioning
        const doc = Text.of(["hello world"]);
        expect(posToOffset(doc, { line: 0, character: 1.5 })).toBeUndefined();
    });

    it("should return undefined for a NaN character", () => {
        const doc = Text.of(["hello world"]);
        expect(
            posToOffset(doc, { line: 0, character: Number.NaN }),
        ).toBeUndefined();
    });

    it("should not string-concatenate a non-numeric character", () => {
        const doc = Text.of(["hello", "world"]);
        const offset = posToOffset(doc, {
            line: 1,
            character: "2" as unknown as number,
        });
        expect(offset).toBeUndefined();
    });

    it("should return undefined for a NaN line", () => {
        const doc = Text.of(["hello world"]);
        expect(
            posToOffset(doc, { line: Number.NaN, character: 0 }),
        ).toBeUndefined();
    });
});

describe("posToOffsetOrZero - malformed positions", () => {
    it("should return zero for a negative character", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: -5 })).toBe(0);
    });

    it("should return zero for a NaN character", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: Number.NaN })).toBe(
            0,
        );
    });
});

describe("offsetToPos - out-of-range offsets", () => {
    it("should clamp an offset beyond the document length", () => {
        const doc = Text.of(["hello world"]);
        expect(offsetToPos(doc, doc.length + 5)).toEqual({
            line: 0,
            character: 11,
        });
    });

    it("should clamp a negative offset to the document start", () => {
        const doc = Text.of(["hello world"]);
        expect(offsetToPos(doc, -1)).toEqual({ line: 0, character: 0 });
    });
});

describe("posToOffset - document boundaries", () => {
    it("should map the position past the last line of a multi-line doc to the document length", () => {
        const doc = Text.of(["a", "b"]);
        expect(doc.lines).toBe(2);
        expect(doc.length).toBe(3);
        expect(posToOffset(doc, { line: 2, character: 0 })).toBe(doc.length);
        expect(posToOffset(doc, { line: 3, character: 0 })).toBeUndefined();
    });

    it("should clamp a character beyond the line length to the end of the line", () => {
        // Regression guard: per the LSP spec, "If the character value is
        // greater than the line length it defaults back to the line length."
        const doc = Text.of(["hello", "world"]);
        expect(posToOffset(doc, { line: 0, character: 99 })).toBe(5);
        expect(posToOffset(doc, { line: 1, character: 99 })).toBe(11);
    });
});

describe("posToOffset - UTF-16 code units", () => {
    // LSP positions are counted in UTF-16 code units, which is exactly what
    // JavaScript string indices (and CodeMirror offsets) use, so no conversion
    // is needed.
    const doc = Text.of(["a\u{1F600}b"]);

    it("should treat the document as UTF-16 code units", () => {
        // "a" + surrogate pair (2 units) + "b"
        expect(doc.length).toBe(4);
    });

    it("should map positions around an astral character", () => {
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        // Right before the emoji
        expect(posToOffset(doc, { line: 0, character: 1 })).toBe(1);
        // Right after the emoji
        expect(posToOffset(doc, { line: 0, character: 3 })).toBe(3);
        expect(posToOffset(doc, { line: 0, character: 4 })).toBe(4);
    });

    it("should map a position inside a surrogate pair to that code unit", () => {
        // Character 2 lands between the high and low surrogate. This is a
        // legitimate (if unusual) UTF-16 offset per the LSP spec, so the
        // correct answer is 2 -- the caller, not this helper, is responsible
        // for not splitting the pair.
        expect(posToOffset(doc, { line: 0, character: 2 })).toBe(2);
    });
});

describe("posToOffset - line endings and tabs", () => {
    it("documents that Text.of keeps a carriage return but EditorState normalizes it", () => {
        // `Text.of` splits on the array boundaries and keeps the "\r"
        const rawDoc = Text.of(["a\r", "b"]);
        expect(rawDoc.lines).toBe(2);
        expect(rawDoc.length).toBe(4); // "a", "\r", "\n", "b"
        expect(posToOffset(rawDoc, { line: 1, character: 0 })).toBe(3);

        // `EditorState.create` normalizes CRLF to a single "\n"
        const normalizedDoc = EditorState.create({ doc: "a\r\nb" }).doc;
        expect(normalizedDoc.lines).toBe(2);
        expect(normalizedDoc.length).toBe(3); // "a", "\n", "b"
        expect(posToOffset(normalizedDoc, { line: 1, character: 0 })).toBe(2);
    });

    it("should count a tab as a single character", () => {
        const doc = Text.of(["\t\tfoo"]);
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 0, character: 2 })).toBe(2);
        expect(posToOffset(doc, { line: 0, character: 5 })).toBe(5);
    });
});

describe("longestCommonPrefix - input mutation", () => {
    it("should not mutate the array it is given", () => {
        const strs = ["banana", "apple", "avocado"];
        longestCommonPrefix(strs);
        expect(strs).toEqual(["banana", "apple", "avocado"]);
    });

    it("should still compute the right prefix", () => {
        expect(longestCommonPrefix(["banana", "apple", "avocado"])).toBe("");
        expect(longestCommonPrefix(["avocado", "apple"])).toBe("a");
    });
});

describe("prefixMatch - empty newText", () => {
    function itemWithNewText(
        label: string,
        newText: string,
    ): LSP.CompletionItem {
        return {
            label,
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                },
                newText,
            },
        };
    }

    it("should respect an empty newText instead of using the label", () => {
        const items = [
            itemWithNewText("foobar", ""),
            itemWithNewText("foobaz", ""),
        ];
        expect(prefixMatch(items)).toBeUndefined();
    });

    it("should use newText when it is non-empty", () => {
        const items = [
            itemWithNewText("foobar", "barx"),
            itemWithNewText("foobaz", "bary"),
        ];
        const pattern = prefixMatch(items);
        expect(pattern).toBeDefined();
        expect(pattern?.source).toBe("(b|ba|bar)$");
    });
});
