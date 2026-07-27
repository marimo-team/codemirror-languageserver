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

const useDocumentUri = createUseFirstOrThrow(
    "No document URI provided. Pass one to the extension or use documentUri.of().",
);
const useLanguageId = createUseFirstOrThrow(
    "No language ID provided. Pass one to the extension or use languageId.of().",
);

function isAbsoluteUri(value: string): boolean {
    try {
        const uri = new URL(value);
        return Boolean(uri.protocol);
    } catch {
        return false;
    }
}

export const documentUri = Facet.define<string, string>({
    combine(values) {
        if (values.length === 0) {
            return useDocumentUri<string>(values);
        }
        const value = useDocumentUri<string>(values);
        if (!(value && isAbsoluteUri(value))) {
            throw new Error("Document URI must be a non-empty absolute URI");
        }
        return value;
    },
});

export const languageId = Facet.define<string, string>({
    combine(values) {
        if (values.length === 0) {
            return useLanguageId<string>(values);
        }
        const value = useLanguageId<string>(values);
        if (!value.trim()) {
            throw new Error("Language ID must be a non-empty string");
        }
        return value;
    },
});
