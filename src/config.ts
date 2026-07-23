import { Facet } from "@codemirror/state";

export function createUseFirstOrThrow(message: string) {
    const fallback = new Proxy(
        {},
        {
            get() {
                throw new Error(message);
            },
        },
    );

    return function useFirstOrThrow<T>(values: readonly T[]): T {
        // CodeMirror passes facet inputs ordered highest-precedence first,
        // so the first value wins (matching built-ins like EditorState.tabSize)
        return values[0] ?? (fallback as T);
    };
}

export const documentUri = Facet.define<string, string>({
    combine: createUseFirstOrThrow(
        "No document URI provided. Either pass a one into the extension or use documentUri.of().",
    ),
});

export const languageId = Facet.define<string, string>({
    combine: createUseFirstOrThrow(
        "No language ID provided. Either pass a one into the extension or use languageId.of().",
    ),
});
