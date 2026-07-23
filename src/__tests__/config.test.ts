import { EditorState, Prec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createUseFirstOrThrow, documentUri, languageId } from "../config.js";

describe("createUseFirstOrThrow", () => {
    it("should return the first (highest-precedence) value from an array", () => {
        // CodeMirror passes facet inputs ordered highest-precedence first
        const useFirstOrThrow = createUseFirstOrThrow("Test error");
        const values = ["first", "second", "third"];

        expect(useFirstOrThrow(values)).toBe("first");
    });

    it("should return the only value from single-item array", () => {
        const useFirstOrThrow = createUseFirstOrThrow("Test error");
        const values = ["single"];

        expect(useFirstOrThrow(values)).toBe("single");
    });

    it("should throw custom error for empty array when accessed", () => {
        const customMessage = "Custom error message";
        const useFirstOrThrow = createUseFirstOrThrow(customMessage);

        const result = useFirstOrThrow([]);
        // The result is a proxy, accessing any property should throw
        expect(() => result.anyProperty).toThrow(customMessage);
    });

    it("should handle undefined values correctly", () => {
        const useFirstOrThrow = createUseFirstOrThrow("Test error");
        const values = [undefined, "value", undefined];

        const result = useFirstOrThrow(values);
        // undefined triggers the fallback proxy
        expect(() => result.anyProperty).toThrow("Test error");
    });

    it("should handle null values correctly", () => {
        const useFirstOrThrow = createUseFirstOrThrow("Test error");
        const values = [null, "value", null];

        const result = useFirstOrThrow(values);
        // null triggers the fallback proxy
        expect(() => result.anyProperty).toThrow("Test error");
    });

    it("should work with different types", () => {
        const useFirstOrThrow = createUseFirstOrThrow("Test error");
        const numberValues = [1, 2, 3];
        const objectValues = [{ a: 1 }, { b: 2 }];

        expect(useFirstOrThrow(numberValues)).toBe(1);
        expect(useFirstOrThrow(objectValues)).toEqual({ a: 1 });
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

    it("should let a high-precedence value override a default one", () => {
        const state = EditorState.create({
            extensions: [
                documentUri.of("file:///default.ts"),
                Prec.high(documentUri.of("file:///override.ts")),
            ],
        });
        expect(state.facet(documentUri)).toBe("file:///override.ts");
    });

    it("should use the first value with equal precedence", () => {
        // Matches the behavior of built-in facets like EditorState.tabSize
        const state = EditorState.create({
            extensions: [
                documentUri.of("file:///first.ts"),
                documentUri.of("file:///second.ts"),
            ],
        });
        expect(state.facet(documentUri)).toBe("file:///first.ts");
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

    it("should let a high-precedence value override a default one", () => {
        const state = EditorState.create({
            extensions: [
                languageId.of("javascript"),
                Prec.high(languageId.of("typescript")),
            ],
        });
        expect(state.facet(languageId)).toBe("typescript");
    });
});
