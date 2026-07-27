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
    // BUG: a negative line should be rejected and return undefined — currently
    // `pos.line >= doc.lines` is false so `doc.line(0)` throws a RangeError
    it.fails("should return undefined for a negative line", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffset(doc, { line: -1, character: 0 })).toBeUndefined();
    });

    // BUG: a negative character should return undefined (or clamp to the start
    // of the line) — currently it returns -5, a negative document offset that
    // blows up downstream `view.dispatch` calls
    it.fails("should never return a negative offset", () => {
        const doc = Text.of(["hello world"]);
        const offset = posToOffset(doc, { line: 0, character: -5 });
        expect([undefined, 0]).toContain(offset);
    });

    // BUG: NaN character should return undefined — currently `Math.min(0 + NaN,
    // 11)` returns NaN, which passes every `!= null` / `!== undefined` guard
    // downstream and silently corrupts ranges
    it.fails("should return undefined for a NaN character", () => {
        const doc = Text.of(["hello world"]);
        expect(
            posToOffset(doc, { line: 0, character: Number.NaN }),
        ).toBeUndefined();
    });

    // BUG: a string character should be rejected or numerically coerced —
    // currently `line.from + "2"` string-concatenates to "62", which clamps to
    // the end of the line (11) instead of the correct offset 8
    it.fails("should not string-concatenate a non-numeric character", () => {
        const doc = Text.of(["hello", "world"]);
        const offset = posToOffset(doc, {
            line: 1,
            character: "2" as unknown as number,
        });
        expect([undefined, 8]).toContain(offset);
    });

    // BUG: a NaN line should return undefined — currently `NaN >= doc.lines` is
    // false so `doc.line(NaN)` throws a TypeError
    it.fails("should return undefined for a NaN line", () => {
        const doc = Text.of(["hello world"]);
        expect(
            posToOffset(doc, { line: Number.NaN, character: 0 }),
        ).toBeUndefined();
    });
});

describe("posToOffsetOrZero - malformed positions", () => {
    // BUG: the whole point of `posToOffsetOrZero` is to always yield a usable
    // offset, so a negative character should produce 0 — currently the `|| 0`
    // fallback does not catch -5 (it is truthy) and -5 is returned
    it.fails("should return zero for a negative character", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: -5 })).toBe(0);
    });

    // This one happens to work: `posToOffset` returns NaN, and NaN is falsy so
    // the `|| 0` fallback catches it. Negative offsets (above) are truthy and
    // slip through, which is the real hazard.
    it("should return zero for a NaN character", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: Number.NaN })).toBe(
            0,
        );
    });
});

describe("offsetToPos - out-of-range offsets", () => {
    // BUG: an offset past the end of the document should clamp to the last
    // position — currently `doc.lineAt` throws a RangeError
    it.fails("should clamp an offset beyond the document length", () => {
        const doc = Text.of(["hello world"]);
        expect(offsetToPos(doc, doc.length + 5)).toEqual({
            line: 0,
            character: 11,
        });
    });

    // BUG: a negative offset should clamp to the start of the document —
    // currently `doc.lineAt(-1)` throws a RangeError
    it.fails("should clamp a negative offset to the document start", () => {
        const doc = Text.of(["hello world"]);
        expect(offsetToPos(doc, -1)).toEqual({ line: 0, character: 0 });
    });
});

describe("posToOffset - document boundaries", () => {
    it("should map the position past the last line of a multi-line doc to the document length", () => {
        const doc = Text.of(["a", "b"]);
        expect(doc.lines).toBe(2);
        expect(doc.length).toBe(3);
        // The "next line (implying the end of the document)" branch
        expect(posToOffset(doc, { line: 2, character: 0 })).toBe(doc.length);
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
    // BUG: `longestCommonPrefix` should not mutate its argument — currently it
    // calls `strs.sort()`, which sorts the caller's array in place
    it.fails("should not mutate the array it is given", () => {
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

    // BUG: an explicit empty `newText` means the completion inserts nothing and
    // should be respected (yielding no common prefix, hence no pattern) —
    // currently `item.textEdit?.newText || item.label` treats "" as absent and
    // falls back to the labels, producing /(f|fo|foo|foob|fooba)$/
    it.fails(
        "should respect an empty newText instead of using the label",
        () => {
            const items = [
                itemWithNewText("foobar", ""),
                itemWithNewText("foobaz", ""),
            ];
            expect(prefixMatch(items)).toBeUndefined();
        },
    );

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
