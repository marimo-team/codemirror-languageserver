import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vi } from "vitest";

export const defaultCompletionOptions = {
    allowHTMLContent: false,
    useSnippetOnCompletion: false,
    hasResolveProvider: false,
    resolveItem: vi.fn(),
};

export function createCompletionView(doc: string): EditorView {
    return new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
}
