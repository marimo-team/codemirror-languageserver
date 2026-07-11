import {
    completionStatus,
    currentCompletions,
    startCompletion,
} from "@codemirror/autocomplete";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { CompletionTriggerKind } from "vscode-languageserver-protocol";
import type { LanguageServerClient } from "../lsp.js";
import { languageServerWithClient } from "../plugin.js";

describe("completion request ordering", () => {
    it("waits for pending document changes before requesting completion", async () => {
        const initialText = "from dataclasses import";
        const text = `${initialText} `;
        let resolveDocumentChange: (() => void) | undefined;
        const documentChange = new Promise<void>((resolve) => {
            resolveDocumentChange = resolve;
        });
        const textDocumentCompletion = vi.fn().mockResolvedValue({
            isIncomplete: false,
            items: [{ label: "dataclass" }, { label: "field" }],
        });
        const client = {
            ready: true,
            capabilities: { completionProvider: {} },
            initializePromise: Promise.resolve(),
            onNotification: vi.fn().mockReturnValue(() => {}),
            textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
            textDocumentDidChange: vi.fn().mockReturnValue(documentChange),
            textDocumentDidClose: vi.fn().mockResolvedValue(undefined),
            textDocumentCompletion,
            completionItemResolve: vi.fn(),
        } as unknown as LanguageServerClient;
        const view = new EditorView({
            state: EditorState.create({
                doc: initialText,
                selection: { anchor: initialText.length },
                extensions: languageServerWithClient({
                    client,
                    documentUri: "file:///test.py",
                    languageId: "python",
                    completionConfig: { activateOnTyping: false },
                    diagnosticsEnabled: false,
                    hoverEnabled: false,
                    signatureHelpEnabled: false,
                }),
            }),
        });

        view.dispatch({
            changes: { from: initialText.length, insert: " " },
            selection: { anchor: text.length },
            annotations: Transaction.userEvent.of("input.type"),
        });
        expect(startCompletion(view)).toBe(true);
        await vi.waitFor(() => {
            expect(client.textDocumentDidChange).toHaveBeenCalledOnce();
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(textDocumentCompletion).not.toHaveBeenCalled();

        resolveDocumentChange?.();
        await vi.waitFor(() => {
            expect(textDocumentCompletion).toHaveBeenCalledWith({
                textDocument: { uri: "file:///test.py" },
                position: { line: 0, character: text.length },
                context: {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            });
            expect(completionStatus(view.state)).toBe("active");
        });
        expect(
            currentCompletions(view.state).map(({ label }) => label),
        ).toEqual(["dataclass", "field"]);

        view.destroy();
    });
});
