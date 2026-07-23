import type { Completion } from "@codemirror/autocomplete";
import { insertCompletionText, snippet } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import {
    isEmptyDocumentation,
    isLSPTextEdit,
    posToOffset,
    renderDocumentation,
} from "./utils.js";

const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

interface ConvertCompletionOptions {
    allowHTMLContent: boolean;
    useSnippetOnCompletion: boolean;
    hasResolveProvider: boolean;
    resolveItem: (item: LSP.CompletionItem) => Promise<LSP.CompletionItem>;
    markdownRenderer?: (markdown: string) => string;
}

namespace InsertTextFormat {
    export const PlainText = 1;
    export const Snippet = 2;
}

/**
 * Converts an LSP snippet to a CodeMirror snippet.
 *
 * Handles LSP snippet escapes (`\\`, `\$`, `\}`, ...) and converts bare
 * tabstops like `$1` to CodeMirror's `${1}` (braces are required in CodeMirror
 * syntax). CodeMirror only treats `${...}` as a field, so an escaped `\$` that
 * precedes a `{` must have that brace escaped as well, otherwise the literal
 * text would turn into an active placeholder.
 */
export function convertSnippet(snippet: string): string {
    let result = "";
    let i = 0;
    while (i < snippet.length) {
        const ch = snippet[i];
        if (ch === "\\" && i + 1 < snippet.length) {
            const next = snippet[i + 1];
            if (next === "$") {
                // Literal `$`. Escape a following `{` so CodeMirror does not
                // read the sequence as a field.
                if (snippet[i + 2] === "{") {
                    result += "$\\{";
                    i += 3;
                } else {
                    result += "$";
                    i += 2;
                }
            } else if (next === "{" || next === "}") {
                // Keep as a CodeMirror brace escape
                result += `\\${next}`;
                i += 2;
            } else if (next === "\\") {
                // Escaped backslash -> a single literal backslash
                result += "\\";
                i += 2;
            } else {
                // Other escapes (e.g. `\,` `\|`) -> the literal character
                result += next;
                i += 2;
            }
        } else if (ch === "$") {
            const digits = /^\d+/.exec(snippet.slice(i + 1));
            if (digits) {
                result += `\${${digits[0]}}`;
                i += 1 + digits[0].length;
            } else {
                result += ch;
                i += 1;
            }
        } else {
            result += ch;
            i += 1;
        }
    }
    return result;
}

/**
 * Converts an LSP snippet to plain text by dropping tabstops and keeping
 * placeholder defaults. Used when snippet expansion is disabled. Parses the
 * LSP snippet directly (rather than the CodeMirror conversion) so escaped
 * sequences like `\${1:x}` render as their literal text.
 */
function convertSnippetToPlainText(snippet: string): string {
    let result = "";
    let i = 0;
    while (i < snippet.length) {
        const ch = snippet[i];
        if (ch === "\\" && i + 1 < snippet.length) {
            // LSP escape -> the literal character
            result += snippet[i + 1];
            i += 2;
        } else if (ch === "$") {
            const braced = /^\{(\d+)(?::([^}]*))?\}/.exec(snippet.slice(i + 1));
            if (braced) {
                // `${n:default}` -> default, `${n}` -> ""
                result += braced[2] ?? "";
                i += 1 + braced[0].length;
            } else {
                const bare = /^\d+/.exec(snippet.slice(i + 1));
                if (bare) {
                    // Bare tabstop `$n` -> ""
                    i += 1 + bare[0].length;
                } else {
                    result += ch;
                    i += 1;
                }
            }
        } else {
            result += ch;
            i += 1;
        }
    }
    return result;
}

/**
 * Converts an LSP completion item to a CodeMirror completion item
 */
export function convertCompletionItem(
    item: LSP.CompletionItem,
    options: ConvertCompletionOptions,
): Completion {
    const {
        detail,
        labelDetails,
        label,
        kind,
        textEdit,
        insertText,
        documentation,
        additionalTextEdits,
        insertTextFormat,
    } = item;

    const completion: Completion = {
        label,
        detail: labelDetails?.detail || detail,
        apply(
            view: EditorView,
            _completion: Completion,
            from: number,
            to: number,
        ) {
            const state = view.state;

            // Resolve the main edit range and text. If the server-provided
            // textEdit range does not resolve to a valid range in the current
            // document (e.g. it is stale), fall back to the token range
            // CodeMirror computed.
            let mainFrom = from;
            let mainTo = to;
            let newText = insertText || label;
            if (textEdit && isLSPTextEdit(textEdit)) {
                newText = textEdit.newText;
                const start = posToOffset(state.doc, textEdit.range.start);
                const end = posToOffset(state.doc, textEdit.range.end);
                if (start != null && end != null && start <= end) {
                    mainFrom = start;
                    mainTo = end;
                }
            }

            // additionalTextEdits refer to the document as it was before the
            // completion is applied, so resolve their offsets now. Skip edits
            // that are invalid or overlap the main edit.
            const additionalChanges: {
                from: number;
                to: number;
                insert: string;
            }[] = [];
            for (const edit of additionalTextEdits ?? []) {
                const editFrom = posToOffset(state.doc, edit.range.start);
                const editTo = posToOffset(state.doc, edit.range.end);
                if (editFrom == null || editTo == null || editFrom > editTo) {
                    continue;
                }
                if (editTo > mainFrom && editFrom < mainTo) {
                    continue;
                }
                additionalChanges.push({
                    from: editFrom,
                    to: editTo,
                    insert: edit.newText,
                });
            }

            if (
                insertTextFormat === InsertTextFormat.Snippet &&
                options.useSnippetOnCompletion
            ) {
                let snippetFrom = mainFrom;
                let snippetTo = mainTo;
                if (additionalChanges.length > 0) {
                    // Apply the additional edits first, then map the snippet
                    // range through them
                    const changeSet = state.changes(additionalChanges);
                    view.dispatch({ changes: changeSet });
                    snippetFrom = changeSet.mapPos(snippetFrom, 1);
                    snippetTo = changeSet.mapPos(snippetTo, 1);
                }
                const applySnippet = snippet(convertSnippet(newText));
                applySnippet(view, null, snippetFrom, snippetTo);
                return;
            }

            if (insertTextFormat === InsertTextFormat.Snippet) {
                // Snippet-format text must never be inserted verbatim; keep
                // the placeholder defaults and drop the tabstop syntax
                newText = convertSnippetToPlainText(newText);
            }

            if (additionalChanges.length === 0) {
                view.dispatch(
                    insertCompletionText(state, newText, mainFrom, mainTo),
                );
                return;
            }

            // Apply the main edit and all additional edits in one transaction
            const changes = state.changes([
                { from: mainFrom, to: mainTo, insert: newText },
                ...additionalChanges,
            ]);
            view.dispatch({
                changes,
                selection: {
                    // Map with association -1 so the anchor is the start of the
                    // inserted text (mapPos(_, 1) would already skip past the
                    // insertion, double-counting its length); add newText.length
                    // to land the cursor right after the completion
                    anchor: changes.mapPos(mainFrom, -1) + newText.length,
                },
                userEvent: "input.complete",
            });
        },
        type: kind ? CompletionItemKindMap[kind]?.toLowerCase() : undefined,
    };

    const createDocumentationDom = (
        content: NonNullable<LSP.CompletionItem["documentation"]>,
    ) => {
        const dom = document.createElement("div");
        dom.classList.add("documentation");
        renderDocumentation(dom, content, {
            allowHTMLContent: options.allowHTMLContent,
            markdownRenderer: options.markdownRenderer,
        });
        return dom;
    };

    // Support lazy loading of documentation through completionItem/resolve
    if (options.hasResolveProvider && options.resolveItem) {
        completion.info = async () => {
            try {
                const resolved = await options.resolveItem?.(item);
                const content = resolved?.documentation || documentation;
                if (!content || isEmptyDocumentation(content)) {
                    return null;
                }
                return createDocumentationDom(content);
            } catch (e) {
                console.error("Failed to resolve completion item:", e);
                // Fallback to existing documentation if resolve fails
                if (!documentation || isEmptyDocumentation(documentation)) {
                    return null;
                }
                return createDocumentationDom(documentation);
            }
        };
    } else if (documentation) {
        // Fallback for servers without resolve support
        completion.info = () => createDocumentationDom(documentation);
    }

    return completion;
}

export function sortCompletionItems(
    items: LSP.CompletionItem[],
    matchBefore: string | undefined,
    language: string,
): LSP.CompletionItem[] {
    const sortFunctions = [
        matchBefore ? prefixSortCompletion(matchBefore) : nameSortCompletion,
        language === "python" ? pythonSortCompletion : undefined,
    ].filter(Boolean);

    let result = items;

    // If we found a token that matches our completion pattern
    if (matchBefore) {
        const word = matchBefore.toLowerCase();
        // Only filter and sort for word characters
        if (/^\w+$/.test(word)) {
            // Filter items to only include those that start with the current word
            result = result.filter(({ label, filterText }) => {
                const text = filterText ?? label;
                return text.toLowerCase().startsWith(word);
            });
        }
    }

    for (const sortFunction of sortFunctions) {
        result.sort(sortFunction);
    }

    return result;
}

function prefixSortCompletion(prefix: string) {
    // Sort completion items:
    // 1. Prioritize items whose visible text starts with the exact token
    //    text (sortText is an opaque server-side sort key, so the prefix is
    //    matched against filterText/label instead)
    // 2. Otherwise order by sortText (falling back to label)
    return (a: LSP.CompletionItem, b: LSP.CompletionItem) => {
        const aMatches = (a.filterText ?? a.label).startsWith(prefix);
        const bMatches = (b.filterText ?? b.label).startsWith(prefix);
        if (aMatches && !bMatches) {
            return -1;
        }
        if (!aMatches && bMatches) {
            return 1;
        }
        const aText = a.sortText ?? a.label;
        const bText = b.sortText ?? b.label;
        return aText.localeCompare(bText);
    };
}

function nameSortCompletion(a: LSP.CompletionItem, b: LSP.CompletionItem) {
    const aText = a.sortText ?? a.label;
    const bText = b.sortText ?? b.label;
    return aText.localeCompare(bText);
}

function pythonSortCompletion(a: LSP.CompletionItem, b: LSP.CompletionItem) {
    // For python, if label ends with `=`, it should be sorted first
    const aIsAssignment = a.label.endsWith("=");
    const bIsAssignment = b.label.endsWith("=");
    if (aIsAssignment && !bIsAssignment) {
        return -1;
    }
    if (!aIsAssignment && bIsAssignment) {
        return 1;
    }
    return 0;
}
