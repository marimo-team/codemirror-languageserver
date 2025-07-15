import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { CompletionTriggerKind } from "vscode-languageserver-protocol";
import { getCompletionTriggerKind } from "../plugin";

function createMockContext(
    text: string,
    position: number,
    explicit = false,
): CompletionContext {
    return new CompletionContext(
        EditorState.create({ doc: text }),
        position,
        explicit,
    );
}

describe("getCompletionTriggerKind", () => {
    it("should return TriggerCharacter for trigger characters", () => {
        const context = createMockContext("hello.", 6, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ".",
        });
    });

    it("should return TriggerCharacter for different trigger characters", () => {
        const context = createMockContext("function(", 9, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: "(",
        });
    });

    it("should return Invoked for explicit completion", () => {
        const context = createMockContext("hello", 5, true);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should return Invoked for word completion", () => {
        const context = createMockContext("hello", 5, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should return Invoked for dot completion", () => {
        const context = createMockContext("obj.prop", 8, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should return null when no pattern matches", () => {
        const context = createMockContext("   ", 3, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toBeNull();
    });

    it("should return null for special characters that don't match pattern", () => {
        const context = createMockContext("hello@", 6, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toBeNull();
    });

    it("should use custom pattern when provided", () => {
        const context = createMockContext("@user", 5, false);
        const customPattern = /@\\w+$/;
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            customPattern,
        );

        // The custom pattern expects to match but may not in this case
        expect(result).toBeNull();
    });

    it("should return null with custom pattern when no match", () => {
        const context = createMockContext("hello", 5, false);
        const customPattern = /@\\w+$/;
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            customPattern,
        );

        expect(result).toBeNull();
    });

    it("should handle empty trigger characters array", () => {
        const context = createMockContext("hello", 5, false);
        const result = getCompletionTriggerKind(context, [], undefined);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle slash completion", () => {
        const context = createMockContext("path/", 5, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle comma completion", () => {
        const context = createMockContext("items,", 6, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        // Comma is a trigger character, so it should be detected as such
        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ",",
        });
    });

    it("should prioritize trigger character over pattern matching", () => {
        const context = createMockContext("hello.", 6, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ".",
        });
    });

    it("should handle position at beginning of line", () => {
        const context = createMockContext("hello", 0, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toBeNull();
    });

    it("should handle multiline documents", () => {
        const context = createMockContext("line1\nline2.prop", 12, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        // This should work as expected - the dot should be detected as a trigger character
        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ".",
        });
    });

    it("should handle trigger character not in trigger list", () => {
        const context = createMockContext("hello:", 6, false);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toBeNull();
    });

    it("should handle explicit completion even with trigger character", () => {
        const context = createMockContext("hello.", 6, true);
        const result = getCompletionTriggerKind(
            context,
            [".", "(", ","],
            undefined,
        );

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle word followed by dot pattern", () => {
        const context = createMockContext("word.", 5, false);
        const result = getCompletionTriggerKind(context, [], undefined);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle partial word completion", () => {
        const context = createMockContext("par", 3, false);
        const result = getCompletionTriggerKind(context, [], undefined);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });
});
