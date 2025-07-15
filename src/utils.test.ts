import { CompletionContext } from "@codemirror/autocomplete";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import {
    eventsFromChangeSet,
    isEmptyDocumentation,
    longestCommonPrefix,
    offsetToPos,
    posToOffset,
    posToOffsetOrZero,
    prefixMatch,
} from "./utils";

function createItems(labels: string[]): LSP.CompletionItem[] {
    return labels.map((label) => ({ label }));
}

function invariant(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function createMockContext(text: string) {
    return new CompletionContext(
        EditorState.create({ doc: text }),
        text.length,
        false,
    );
}

describe("prefixMatch", () => {
    it("should handle empty items array", () => {
        const pattern = prefixMatch([]);
        expect(pattern).toBeUndefined();
    });

    it("should handle no prefix", () => {
        const items = createItems(["foo", "bar"]);
        const pattern = prefixMatch(items);
        expect(pattern).toBeUndefined();
    });

    it("should match basic prefixes", () => {
        const items = createItems(["foo/", "foo.py", "foo.txt", "foo.md"]);
        const context = createMockContext("foo");
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(context.matchBefore(pattern)).toEqual({
            from: 0,
            to: 3,
            text: "foo",
        });
    });

    it("should when includes a slash", () => {
        const items = createItems(["foo/", "foo.py", "foo.txt", "foo.md"]);
        const context = createMockContext("path/to/foo");
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(context.matchBefore(pattern)).toEqual({
            from: 8,
            to: 11,
            text: "foo",
        });
    });

    it("should match when includes a dot", () => {
        const items = createItems(["foo.py", "foo.txt", "foo.md"]);
        const context = createMockContext("path/to/foo.");
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(context.matchBefore(pattern)).toEqual({
            from: 8,
            to: 12,
            text: "foo.",
        });
    });

    it("should match when contains multiple matches", () => {
        const items = createItems(["foo.py", "foo.txt", "foo.md"]);
        const context = createMockContext("foo/foo/foo");
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(context.matchBefore(pattern)).toEqual({
            from: 8,
            to: 11,
            text: "foo",
        });
    });

    it("should match when contains ends with a slash", () => {
        const items = createItems(["foo/", "foo.py", "foo.txt", "foo.md"]);
        const context = createMockContext("path/to/");
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(context.matchBefore(pattern)).toEqual(null);
    });

    it("should handle shared prefixes", () => {
        const items = createItems(["for", "function"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        const context = createMockContext("f");
        expect(context.matchBefore(pattern)).toEqual({
            from: 0,
            to: 1,
            text: "f",
        });
    });

    it("should handle shared prefixes with different match before", () => {
        const items = createItems(["for", "function"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        const context = createMockContext("for");
        expect(context.matchBefore(pattern)).toEqual(null);
    });

    it("should handle when common prefix is more than what was typed", () => {
        const items = createItems(["foobar", "foobaz"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("fo").matchBefore(pattern)).toEqual({
            from: 0,
            to: 2,
            text: "fo",
        });
        expect(createMockContext("f").matchBefore(pattern)).toEqual({
            from: 0,
            to: 1,
            text: "f",
        });
    });

    it("should handle mixed word and non-word characters", () => {
        const items = createItems(["user.name", "user.email"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("user").matchBefore(pattern)).toEqual({
            from: 0,
            to: 4,
            text: "user",
        });
        expect(createMockContext("user.").matchBefore(pattern)).toEqual({
            from: 0,
            to: 5,
            text: "user.",
        });
        expect(createMockContext("u").matchBefore(pattern)).toEqual({
            from: 0,
            to: 1,
            text: "u",
        });
        expect(createMockContext("foo/").matchBefore(pattern)).toEqual(null);
        expect(createMockContext("foo/us").matchBefore(pattern)).toEqual({
            from: 4,
            to: 6,
            text: "us",
        });
        expect(createMockContext("obj.property(").matchBefore(pattern)).toEqual(
            null,
        );
        expect(
            createMockContext("obj.property(us").matchBefore(pattern),
        ).toEqual({
            from: 13,
            to: 15,
            text: "us",
        });
    });

    it("should handle special characters", () => {
        const items = createItems(["$name", "$value"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("$").matchBefore(pattern)).toEqual({
            from: 0,
            to: 1,
            text: "$",
        });
        expect(createMockContext("$item.$").matchBefore(pattern)).toEqual({
            from: 6,
            to: 7,
            text: "$",
        });
        expect(createMockContext("$item.$name").matchBefore(pattern)).toEqual(
            null,
        );
    });

    it("should handle empty items array", () => {
        const items: LSP.CompletionItem[] = [];
        const pattern = prefixMatch(items);
        expect(pattern).toBeUndefined();
    });

    it("should handle items with no common prefix", () => {
        const items = createItems(["apple", "banana", "cherry"]);
        const pattern = prefixMatch(items);
        expect(pattern).toBeUndefined();
    });

    it("should handle items with partial common prefix", () => {
        const items = createItems(["prefix_one", "prefix_two", "prefix_three"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("prefix_").matchBefore(pattern)).toEqual({
            from: 0,
            to: 7,
            text: "prefix_",
        });
        expect(createMockContext("pre").matchBefore(pattern)).toEqual({
            from: 0,
            to: 3,
            text: "pre",
        });
    });

    it("should handle regex special characters in prefixes", () => {
        const items = createItems(["user.*", "user.+", "user.?"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("user.").matchBefore(pattern)).toEqual({
            from: 0,
            to: 5,
            text: "user.",
        });
        expect(createMockContext("user.*").matchBefore(pattern)).toEqual(null);
    });

    it("should match at different positions in text", () => {
        const items = createItems(["test"]);
        const pattern = prefixMatch(items);
        invariant(pattern !== undefined, "pattern should not be undefined");
        expect(createMockContext("some test").matchBefore(pattern)).toEqual({
            from: 5,
            to: 9,
            text: "test",
        });
        expect(createMockContext("function(te").matchBefore(pattern)).toEqual({
            from: 9,
            to: 11,
            text: "te",
        });
        expect(createMockContext("obj.function(").matchBefore(pattern)).toEqual(
            null,
        );
    });
});

describe("posToOffset", () => {
    it("should convert position to offset in single line", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 0, character: 5 })).toBe(5);
        expect(posToOffset(doc, { line: 0, character: 11 })).toBe(11);
    });

    it("should convert position to offset in multi-line document", () => {
        const doc = Text.of(["line1", "line2", "line3"]);
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 0, character: 5 })).toBe(5);
        expect(posToOffset(doc, { line: 1, character: 0 })).toBe(6); // after newline
        expect(posToOffset(doc, { line: 1, character: 5 })).toBe(11);
        expect(posToOffset(doc, { line: 2, character: 0 })).toBe(12);
    });

    it("should handle end of document", () => {
        const doc = Text.of(["hello"]);
        expect(posToOffset(doc, { line: 1, character: 0 })).toBe(5);
    });

    it("should return undefined for invalid line beyond document end", () => {
        const doc = Text.of(["hello"]);
        expect(posToOffset(doc, { line: 1, character: 1 })).toBeUndefined(); // Character > 0 on line beyond document
        expect(posToOffset(doc, { line: 2, character: 0 })).toBe(5); // Line far beyond document but character 0 returns doc.length
    });

    it("should return undefined for character beyond line length", () => {
        const doc = Text.of(["hello"]);
        expect(posToOffset(doc, { line: 0, character: 10 })).toBeUndefined();
    });

    it("should handle empty document", () => {
        const doc = Text.of([""]);
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 1, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 0, character: 1 })).toBeUndefined();
    });

    it("should handle empty lines", () => {
        const doc = Text.of(["", "hello", ""]);
        expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
        expect(posToOffset(doc, { line: 1, character: 0 })).toBe(1);
        expect(posToOffset(doc, { line: 1, character: 5 })).toBe(6);
        expect(posToOffset(doc, { line: 2, character: 0 })).toBe(7);
    });
});

describe("offsetToPos", () => {
    it("should convert offset to position in single line", () => {
        const doc = Text.of(["hello world"]);
        expect(offsetToPos(doc, 0)).toEqual({ line: 0, character: 0 });
        expect(offsetToPos(doc, 5)).toEqual({ line: 0, character: 5 });
        expect(offsetToPos(doc, 11)).toEqual({ line: 0, character: 11 });
    });

    it("should convert offset to position in multi-line document", () => {
        const doc = Text.of(["line1", "line2", "line3"]);
        expect(offsetToPos(doc, 0)).toEqual({ line: 0, character: 0 });
        expect(offsetToPos(doc, 5)).toEqual({ line: 0, character: 5 });
        expect(offsetToPos(doc, 6)).toEqual({ line: 1, character: 0 });
        expect(offsetToPos(doc, 11)).toEqual({ line: 1, character: 5 });
        expect(offsetToPos(doc, 12)).toEqual({ line: 2, character: 0 });
    });

    it("should handle end of document", () => {
        const doc = Text.of(["hello"]);
        expect(offsetToPos(doc, 5)).toEqual({ line: 0, character: 5 });
    });

    it("should handle empty document", () => {
        const doc = Text.of([""]);
        expect(offsetToPos(doc, 0)).toEqual({ line: 0, character: 0 });
    });

    it("should handle empty lines", () => {
        const doc = Text.of(["", "hello", ""]);
        expect(offsetToPos(doc, 0)).toEqual({ line: 0, character: 0 });
        expect(offsetToPos(doc, 1)).toEqual({ line: 1, character: 0 });
        expect(offsetToPos(doc, 6)).toEqual({ line: 1, character: 5 });
        expect(offsetToPos(doc, 7)).toEqual({ line: 2, character: 0 });
    });

    it("should be inverse of posToOffset", () => {
        const doc = Text.of(["line1", "line2", "line3"]);
        const positions = [
            { line: 0, character: 0 },
            { line: 0, character: 3 },
            { line: 1, character: 0 },
            { line: 1, character: 2 },
            { line: 2, character: 5 },
        ];

        for (const pos of positions) {
            const offset = posToOffset(doc, pos);
            if (offset !== undefined) {
                expect(offsetToPos(doc, offset)).toEqual(pos);
            }
        }
    });
});

describe("posToOffsetOrZero", () => {
    it("should return offset when position is valid", () => {
        const doc = Text.of(["hello world"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: 5 })).toBe(5);
    });

    it("should return zero when position is invalid", () => {
        const doc = Text.of(["hello"]);
        expect(posToOffsetOrZero(doc, { line: 0, character: 10 })).toBe(0);
        expect(posToOffsetOrZero(doc, { line: 1, character: 5 })).toBe(0);
    });
});

describe("isEmptyDocumentation", () => {
    it("should return true for null/undefined", () => {
        expect(isEmptyDocumentation(null)).toBe(true);
        expect(isEmptyDocumentation(undefined)).toBe(true);
    });

    it("should return true for empty string", () => {
        expect(isEmptyDocumentation("")).toBe(true);
        expect(isEmptyDocumentation("   ")).toBe(true);
        expect(isEmptyDocumentation("\n\t  ")).toBe(true);
    });

    it("should return true for strings with only backticks", () => {
        expect(isEmptyDocumentation("`")).toBe(true);
        expect(isEmptyDocumentation("```")).toBe(true);
        expect(isEmptyDocumentation(" ` \n `  ")).toBe(true);
    });

    it("should return false for non-empty strings", () => {
        expect(isEmptyDocumentation("Hello")).toBe(false);
        expect(isEmptyDocumentation("   text   ")).toBe(false);
        expect(isEmptyDocumentation("`code`")).toBe(false);
    });

    it("should handle MarkupContent", () => {
        expect(isEmptyDocumentation({ kind: "markdown", value: "" })).toBe(
            true,
        );
        expect(isEmptyDocumentation({ kind: "markdown", value: "   " })).toBe(
            true,
        );
        expect(isEmptyDocumentation({ kind: "markdown", value: "Hello" })).toBe(
            false,
        );
        expect(isEmptyDocumentation({ kind: "plaintext", value: "Text" })).toBe(
            false,
        );
    });

    it("should handle array of MarkedString", () => {
        expect(isEmptyDocumentation([])).toBe(true);
        expect(isEmptyDocumentation(["", "   "])).toBe(true);
        expect(isEmptyDocumentation(["Hello"])).toBe(false);
        expect(isEmptyDocumentation(["", "World"])).toBe(false);
        expect(isEmptyDocumentation([{ language: "js", value: "" }])).toBe(
            true,
        );
        expect(isEmptyDocumentation([{ language: "js", value: "code" }])).toBe(
            false,
        );
    });

    it("should handle mixed array content", () => {
        expect(
            isEmptyDocumentation(["Hello", { language: "js", value: "code" }]),
        ).toBe(false);
        expect(isEmptyDocumentation(["", { language: "js", value: "" }])).toBe(
            true,
        );
    });
});

describe("eventsFromChangeSet", () => {
    it("should handle full document replacement", () => {
        const doc = Text.of(["old content"]);
        const changes = ChangeSet.of(
            [{ from: 0, to: doc.length, insert: "new content" }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            text: "new content",
        });
    });

    it("should handle incremental changes", () => {
        const doc = Text.of(["hello world"]);
        const changes = ChangeSet.of(
            [{ from: 0, to: 5, insert: "Hi" }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            },
            text: "Hi",
        });
    });

    it("should handle insertions", () => {
        const doc = Text.of(["hello world"]);
        const changes = ChangeSet.of(
            [{ from: 6, to: 6, insert: "beautiful " }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 6 },
            },
            text: "beautiful ",
        });
    });

    it("should handle deletions", () => {
        const doc = Text.of(["hello world"]);
        const changes = ChangeSet.of(
            [{ from: 6, to: 11, insert: "" }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
            },
            text: "",
        });
    });

    it("should handle multi-line changes", () => {
        const doc = Text.of(["line1", "line2", "line3"]);
        const changes = ChangeSet.of(
            [{ from: 6, to: 12, insert: "NEW LINE" }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            range: {
                start: { line: 1, character: 0 },
                end: { line: 2, character: 0 },
            },
            text: "NEW LINE",
        });
    });

    it("should handle empty document", () => {
        const doc = Text.of([""]);
        const changes = ChangeSet.of(
            [{ from: 0, to: 0, insert: "content" }],
            doc.length,
        );
        const events = eventsFromChangeSet(doc, changes);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            text: "content",
        });
    });
});

describe("longestCommonPrefix", () => {
    it("should return empty string for empty array", () => {
        expect(longestCommonPrefix([])).toBe("");
    });

    it("should return the string itself for single element array", () => {
        expect(longestCommonPrefix(["hello"])).toBe("hello");
        expect(longestCommonPrefix([""])).toBe("");
    });

    it("should return empty string when no common prefix", () => {
        expect(longestCommonPrefix(["apple", "banana", "cherry"])).toBe("");
        expect(longestCommonPrefix(["abc", "def"])).toBe("");
    });

    it("should find common prefix for multiple strings", () => {
        expect(
            longestCommonPrefix(["prefix_one", "prefix_two", "prefix_three"]),
        ).toBe("prefix_");
        expect(longestCommonPrefix(["hello", "help", "helmet"])).toBe("hel");
    });

    it("should find full common prefix when strings start the same", () => {
        expect(longestCommonPrefix(["test", "test"])).toBe("test");
        expect(longestCommonPrefix(["abc", "abc", "abc"])).toBe("abc");
    });

    it("should handle case where one string is prefix of another", () => {
        expect(longestCommonPrefix(["test", "testing", "tester"])).toBe("test");
        expect(longestCommonPrefix(["a", "abc", "ab"])).toBe("a");
    });

    it("should handle empty strings in array", () => {
        expect(longestCommonPrefix(["", "hello", "help"])).toBe("");
        expect(longestCommonPrefix(["hello", "", "help"])).toBe("");
    });

    it("should handle special characters", () => {
        expect(
            longestCommonPrefix(["user.name", "user.email", "user.id"]),
        ).toBe("user.");
        expect(longestCommonPrefix(["$var1", "$var2", "$var3"])).toBe("$var");
    });

    it("should handle single character differences", () => {
        expect(longestCommonPrefix(["a", "b"])).toBe("");
        expect(longestCommonPrefix(["aa", "ab"])).toBe("a");
    });

    it("should handle mixed case properly", () => {
        expect(longestCommonPrefix(["Hello", "hello"])).toBe("");
        expect(longestCommonPrefix(["TEST", "Test"])).toBe("T");
    });

    it("should work with file paths", () => {
        expect(
            longestCommonPrefix([
                "src/utils.ts",
                "src/index.ts",
                "src/plugin.ts",
            ]),
        ).toBe("src/");
        expect(
            longestCommonPrefix(["/path/to/file1.txt", "/path/to/file2.txt"]),
        ).toBe("/path/to/file");
    });

    it("should handle undefined/null values gracefully", () => {
        expect(longestCommonPrefix(["test", null as any])).toBe("");
        expect(longestCommonPrefix(["test", undefined as any])).toBe("");
    });

    it("should be stable regardless of input order", () => {
        const strings1 = ["abc", "abcd", "ab"];
        const strings2 = ["abcd", "ab", "abc"];
        const strings3 = ["ab", "abc", "abcd"];

        const result1 = longestCommonPrefix(strings1);
        const result2 = longestCommonPrefix(strings2);
        const result3 = longestCommonPrefix(strings3);

        expect(result1).toBe("ab");
        expect(result2).toBe("ab");
        expect(result3).toBe("ab");
    });
});
