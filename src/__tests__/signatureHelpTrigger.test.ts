import { describe, expect, it } from "vitest";
import { getSignatureHelpTriggerPosition } from "../plugin";

describe("getSignatureHelpTriggerPosition", () => {
    const defaultTriggerChars = ["(", ","];

    describe("when auto-bracket completion inserts '()'", () => {
        it("should return position right after the opening bracket", () => {
            // When typing at position 5 and "()" is inserted, cursor ends up at position 6
            // We want signature help at position 6 (right after "("), not position 7 (after ")")
            const result = getSignatureHelpTriggerPosition(
                "()",
                5, // fromB: start of insertion
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 6, // 5 + 0 (index of "(") + 1 = 6
                triggerCharacter: "(",
            });
        });

        it("should handle insertion at the start of document", () => {
            const result = getSignatureHelpTriggerPosition(
                "()",
                0,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 1,
                triggerCharacter: "(",
            });
        });
    });

    describe("when only opening bracket is inserted", () => {
        it("should return position right after the bracket", () => {
            const result = getSignatureHelpTriggerPosition(
                "(",
                5,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 6,
                triggerCharacter: "(",
            });
        });
    });

    describe("when comma is inserted", () => {
        it("should return position right after the comma", () => {
            const result = getSignatureHelpTriggerPosition(
                ",",
                10,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 11,
                triggerCharacter: ",",
            });
        });

        it("should handle comma with trailing space", () => {
            const result = getSignatureHelpTriggerPosition(
                ", ",
                10,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 11, // Right after the comma
                triggerCharacter: ",",
            });
        });
    });

    describe("when trigger character is in the middle of inserted text", () => {
        it("should find the trigger character position correctly", () => {
            // Simulates pasting or completion that includes a function call
            const result = getSignatureHelpTriggerPosition(
                "foo(",
                0,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 4, // 0 + 3 (index of "(") + 1 = 4
                triggerCharacter: "(",
            });
        });

        it("should find first trigger character when multiple exist", () => {
            // If text contains both "(" and ",", should find "(" first
            const result = getSignatureHelpTriggerPosition(
                "foo(a, b)",
                0,
                defaultTriggerChars,
            );

            expect(result).toEqual({
                triggerPos: 4, // Position after first "("
                triggerCharacter: "(",
            });
        });
    });

    describe("when no trigger character is present", () => {
        it("should return null for regular text", () => {
            const result = getSignatureHelpTriggerPosition(
                "hello",
                0,
                defaultTriggerChars,
            );

            expect(result).toBeNull();
        });

        it("should return null for empty string", () => {
            const result = getSignatureHelpTriggerPosition(
                "",
                0,
                defaultTriggerChars,
            );

            expect(result).toBeNull();
        });

        it("should return null for closing bracket only", () => {
            const result = getSignatureHelpTriggerPosition(
                ")",
                5,
                defaultTriggerChars,
            );

            expect(result).toBeNull();
        });
    });

    describe("with custom trigger characters", () => {
        it("should work with angle brackets", () => {
            const result = getSignatureHelpTriggerPosition(
                "<>",
                10,
                ["<"],
            );

            expect(result).toEqual({
                triggerPos: 11,
                triggerCharacter: "<",
            });
        });

        it("should respect trigger character order", () => {
            // If trigger chars are [",", "("], comma should be found first
            const result = getSignatureHelpTriggerPosition(
                "foo(a, b)",
                0,
                [",", "("],
            );

            expect(result).toEqual({
                triggerPos: 6, // Position after first ","
                triggerCharacter: ",",
            });
        });
    });
});

