import { describe, expect, it } from "vitest";
import { createUseLastOrThrow, documentUri, languageId } from "../config.js";

describe("createUseLastOrThrow", () => {
    it("should return the last value from an array", () => {
        const useLastOrThrow = createUseLastOrThrow("Test error");
        const values = ["first", "second", "third"];

        expect(useLastOrThrow(values)).toBe("third");
    });

    it("should return the only value from single-item array", () => {
        const useLastOrThrow = createUseLastOrThrow("Test error");
        const values = ["single"];

        expect(useLastOrThrow(values)).toBe("single");
    });

    it("should throw custom error for empty array when accessed", () => {
        const customMessage = "Custom error message";
        const useLastOrThrow = createUseLastOrThrow(customMessage);

        const result = useLastOrThrow([]);
        // The result is a proxy, accessing any property should throw
        expect(() => result.anyProperty).toThrow(customMessage);
    });

    it("should handle undefined values correctly", () => {
        const useLastOrThrow = createUseLastOrThrow("Test error");
        const values = [undefined, "value", undefined];

        const result = useLastOrThrow(values);
        // undefined triggers the fallback proxy
        expect(() => result.anyProperty).toThrow("Test error");
    });

    it("should handle null values correctly", () => {
        const useLastOrThrow = createUseLastOrThrow("Test error");
        const values = [null, "value", null];

        const result = useLastOrThrow(values);
        // null triggers the fallback proxy
        expect(() => result.anyProperty).toThrow("Test error");
    });

    it("should work with different types", () => {
        const useLastOrThrow = createUseLastOrThrow("Test error");
        const numberValues = [1, 2, 3];
        const objectValues = [{ a: 1 }, { b: 2 }];

        expect(useLastOrThrow(numberValues)).toBe(3);
        expect(useLastOrThrow(objectValues)).toEqual({ b: 2 });
    });
});

describe("documentUri facet", () => {
    it("should have correct combine function", () => {
        // Test that the facet has the expected configuration
        expect(documentUri.combine).toBeDefined();
        expect(typeof documentUri.combine).toBe("function");
    });

    it("should throw error when no values provided and accessed", () => {
        const result = documentUri.combine([]);
        expect(() => result.anyProperty).toThrow(
            "No document URI provided. Either pass a one into the extension or use documentUri.of().",
        );
    });

    it("should return last value when multiple values provided", () => {
        const values = [
            "file:///first.ts",
            "file:///second.ts",
            "file:///third.ts",
        ];
        expect(documentUri.combine(values)).toBe("file:///third.ts");
    });
});

describe("languageId facet", () => {
    it("should have correct combine function", () => {
        // Test that the facet has the expected configuration
        expect(languageId.combine).toBeDefined();
        expect(typeof languageId.combine).toBe("function");
    });

    it("should throw error when no values provided and accessed", () => {
        const result = languageId.combine([]);
        expect(() => result.anyProperty).toThrow(
            "No language ID provided. Either pass a one into the extension or use languageId.of().",
        );
    });

    it("should return last value when multiple values provided", () => {
        const values = ["javascript", "typescript", "python"];
        expect(languageId.combine(values)).toBe("python");
    });
});
