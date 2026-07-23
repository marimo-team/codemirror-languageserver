import type { Completion } from "@codemirror/autocomplete";
import { insertCompletionText, snippet } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type * as LSP from "vscode-languageserver-protocol";
import {
    CompletionItemKind,
    CompletionItemTag,
} from "vscode-languageserver-protocol";
import {
    isEmptyDocumentation,
    isInsertReplaceEdit,
    isLSPTextEdit,
    posToOffset,
    renderDocumentation,
} from "./utils.js";

const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

/**
 * A CodeMirror completion with LSP-specific metadata attached.
 */
export interface LSPCompletion extends Completion {
    /** Set when the server marked the item deprecated */
    deprecated?: boolean;
}

/**
 * Whether the server marked the item deprecated, via tags or the legacy
 * `deprecated` flag.
 */
export function isDeprecatedItem(
    item: Pick<LSP.CompletionItem, "deprecated" | "tags">,
): boolean {
    return Boolean(
        item.deprecated || item.tags?.includes(CompletionItemTag.Deprecated),
    );
}

/**
 * CSS class for a rendered completion option: `cm-deprecated` for items the
 * server marked deprecated.
 */
export function completionOptionClass(completion: Completion): string {
    return (completion as LSPCompletion).deprecated ? "cm-deprecated" : "";
}

function isInsertReplaceRange(
    editRange: LSP.Range | { insert: LSP.Range; replace: LSP.Range },
): editRange is { insert: LSP.Range; replace: LSP.Range } {
    return "insert" in editRange;
}

/**
 * Applies `CompletionList.itemDefaults` (LSP 3.17) to an item. Item fields
 * win over defaults; a default `editRange` becomes a per-item `textEdit`
 * whose text is `textEditText ?? label` (per spec).
 */
export function resolveItemDefaults(
    item: LSP.CompletionItem,
    defaults: LSP.CompletionList["itemDefaults"],
): LSP.CompletionItem {
    if (!defaults) {
        return item;
    }
    const resolved: LSP.CompletionItem = { ...item };
    if (resolved.commitCharacters == null) {
        resolved.commitCharacters = defaults.commitCharacters;
    }
    if (resolved.insertTextFormat == null) {
        resolved.insertTextFormat = defaults.insertTextFormat;
    }
    if (resolved.insertTextMode == null) {
        resolved.insertTextMode = defaults.insertTextMode;
    }
    if (resolved.data === undefined) {
        resolved.data = defaults.data;
    }
    if (resolved.textEdit == null && defaults.editRange) {
        const newText = resolved.textEditText ?? resolved.label;
        resolved.textEdit = isInsertReplaceRange(defaults.editRange)
            ? {
                  newText,
                  insert: defaults.editRange.insert,
                  replace: defaults.editRange.replace,
              }
            : { newText, range: defaults.editRange };
    }
    return resolved;
}

/**
 * Resolves a completion's primary edit into document offsets and text.
 * Uses the item's `textEdit` (the `replace` range of an InsertReplaceEdit),
 * falling back to the token range CodeMirror computed when the server range
 * is stale.
 */
export function resolveMainEdit(
    doc: Text,
    item: Pick<LSP.CompletionItem, "textEdit" | "insertText" | "label">,
    fallbackFrom: number,
    fallbackTo: number,
): { from: number; to: number; newText: string } {
    const { textEdit, insertText, label } = item;
    let from = fallbackFrom;
    let to = fallbackTo;
    let newText = insertText || label;
    if (textEdit) {
        const range = isLSPTextEdit(textEdit)
            ? textEdit.range
            : isInsertReplaceEdit(textEdit)
              ? textEdit.replace
              : undefined;
        if (range) {
            newText = textEdit.newText;
            const start = posToOffset(doc, range.start);
            const end = posToOffset(doc, range.end);
            if (start != null && end != null && start <= end) {
                from = start;
                to = end;
            }
        }
    }
    return { from, to, newText };
}

/**
 * Converts `additionalTextEdits` into CodeMirror changes against `doc` (the
 * document the edits refer to), dropping edits that are invalid or overlap
 * the main edit.
 */
export function convertAdditionalTextEdits(
    doc: Text,
    edits: readonly LSP.TextEdit[],
    mainFrom: number,
    mainTo: number,
): { from: number; to: number; insert: string }[] {
    const changes: { from: number; to: number; insert: string }[] = [];
    for (const edit of edits) {
        const from = posToOffset(doc, edit.range.start);
        const to = posToOffset(doc, edit.range.end);
        if (from == null || to == null || from > to) {
            continue;
        }
        if (to > mainFrom && from < mainTo) {
            continue;
        }
        changes.push({ from, to, insert: edit.newText });
    }
    return changes;
}

/**
 * Maps positions through a single replacement of `[from, to)` by
 * `insertedLength` characters. Positions inside the replaced range are
 * unsupported; drop overlapping edits first.
 */
export function mapThroughReplacement(
    from: number,
    to: number,
    insertedLength: number,
): (pos: number) => number {
    return (pos) => (pos <= from ? pos : pos - (to - from) + insertedLength);
}

/**
 * Resolves the item after the main edit was applied and dispatches any
 * `additionalTextEdits` it brings (commonly auto-imports), mapping their
 * pre-completion offsets through the main replacement.
 */
function applyLazyAdditionalTextEdits(opts: {
    view: EditorView;
    /** The document as it was before the completion was applied */
    originalDoc: Text;
    mainFrom: number;
    mainTo: number;
    /** Length of the text the main edit inserted */
    insertedLength: number;
    resolveItem: () => Promise<LSP.CompletionItem>;
}): void {
    const { view, originalDoc, mainFrom, mainTo, insertedLength, resolveItem } =
        opts;
    // Snapshot to detect edits racing the resolve round-trip (Text is
    // immutable, so identity means unchanged)
    const docAfterMainEdit = view.state.doc;
    const mapPos = mapThroughReplacement(mainFrom, mainTo, insertedLength);
    resolveItem()
        .then((resolved) => {
            const edits = resolved?.additionalTextEdits;
            if (!edits?.length) {
                return;
            }
            // The mapped offsets are only valid against the document as the
            // main edit left it; drop the edits if the user typed since
            if (view.state.doc !== docAfterMainEdit) {
                return;
            }
            const changes = convertAdditionalTextEdits(
                originalDoc,
                edits,
                mainFrom,
                mainTo,
            ).map((change) => ({
                ...change,
                from: mapPos(change.from),
                to: mapPos(change.to),
            }));
            if (changes.length === 0) {
                return;
            }
            view.dispatch({ changes, userEvent: "input.complete" });
        })
        .catch((e) => {
            console.error("Failed to resolve completion item:", e);
        });
}

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
): LSPCompletion {
    const {
        detail,
        labelDetails,
        label,
        kind,
        documentation,
        additionalTextEdits,
        insertTextFormat,
        commitCharacters,
        filterText,
    } = item;

    // Resolve at most once; shared by the info panel and apply
    let resolvedItemPromise: Promise<LSP.CompletionItem> | null = null;
    const resolveItemOnce = () => {
        resolvedItemPromise ??= options.resolveItem(item);
        return resolvedItemPromise;
    };

    const completion: LSPCompletion = {
        label,
        detail: labelDetails?.detail || detail,
        apply(
            view: EditorView,
            _completion: Completion,
            from: number,
            to: number,
        ) {
            const state = view.state;

            const {
                from: mainFrom,
                to: mainTo,
                newText: mainText,
            } = resolveMainEdit(state.doc, item, from, to);
            let newText = mainText;

            // additionalTextEdits refer to the document as it was before the
            // completion is applied, so resolve their offsets now
            const additionalChanges = convertAdditionalTextEdits(
                state.doc,
                additionalTextEdits ?? [],
                mainFrom,
                mainTo,
            );

            const scheduleLazyAdditionalTextEdits = (
                insertedLength: number,
            ) => {
                if (additionalTextEdits || !options.hasResolveProvider) {
                    return;
                }
                applyLazyAdditionalTextEdits({
                    view,
                    originalDoc: state.doc,
                    mainFrom,
                    mainTo,
                    insertedLength,
                    resolveItem: resolveItemOnce,
                });
            };

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
                const lengthBeforeSnippet = view.state.doc.length;
                const applySnippet = snippet(convertSnippet(newText));
                applySnippet(view, null, snippetFrom, snippetTo);
                scheduleLazyAdditionalTextEdits(
                    view.state.doc.length -
                        lengthBeforeSnippet +
                        (snippetTo - snippetFrom),
                );
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
                scheduleLazyAdditionalTextEdits(newText.length);
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

    // CodeMirror matches typed input against `label`, but LSP defines
    // matching against `filterText`; keep the LSP label for display
    if (filterText != null && filterText !== label) {
        completion.label = filterText;
        completion.displayLabel = label;
    }

    if (commitCharacters?.length) {
        completion.commitCharacters = commitCharacters;
    }

    if (isDeprecatedItem(item)) {
        completion.deprecated = true;
    }

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
    if (options.hasResolveProvider) {
        completion.info = async () => {
            try {
                const resolved = await resolveItemOnce();
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
    // false keeps every item, for when CodeMirror filters client-side
    filter = true,
): LSP.CompletionItem[] {
    const sortFunctions = [
        matchBefore ? prefixSortCompletion(matchBefore) : nameSortCompletion,
        language === "python" ? pythonSortCompletion : undefined,
    ].filter(Boolean);

    let result = items;

    // If we found a token that matches our completion pattern
    if (matchBefore && filter) {
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
