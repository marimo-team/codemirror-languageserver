import type { Text } from "@codemirror/state";
import type { ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { marked } from "marked";
import type * as LSP from "vscode-languageserver-protocol";

export function posToOffset(
    doc: Text,
    pos: { line: number; character: number },
): number | undefined {
    if (
        !(Number.isInteger(pos.line) && Number.isInteger(pos.character)) ||
        pos.line < 0 ||
        pos.character < 0
    ) {
        return;
    }
    if (pos.line >= doc.lines) {
        // Next line (implying the end of the document)
        if (pos.line === doc.lines && pos.character === 0) {
            return doc.length;
        }
        return;
    }
    const line = doc.line(pos.line + 1);
    // Per LSP spec, a character beyond the line length defaults back to the
    // line length, so clamp instead of spilling into the next line
    return Math.min(line.from + pos.character, line.to);
}

export function posToOffsetOrZero(
    doc: Text,
    pos: { line: number; character: number },
): number {
    return posToOffset(doc, pos) ?? 0;
}

export function offsetToPos(doc: Text, offset: number) {
    const clampedOffset = Number.isFinite(offset)
        ? Math.max(0, Math.min(offset, doc.length))
        : 0;
    const line = doc.lineAt(clampedOffset);
    return {
        character: clampedOffset - line.from,
        line: line.number - 1,
    };
}

// Add hook to remove empty code fences
const renderer = new marked.Renderer();
const prevCode = renderer.code;
renderer.code = (code) => {
    if (!code.text.trim()) return "";
    return prevCode.call(renderer, code);
};

/**
 * Render markdown to HTML
 */
export function renderMarkdown(markdown: string) {
    return marked(markdown, {
        async: false,
        gfm: true,
        breaks: true,
        renderer: renderer,
    });
}

function escapeHTML(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (character) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[character] ?? character,
    );
}

function isSafeDocumentationUrl(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.startsWith("//")) {
        return false;
    }
    try {
        const url = new URL(trimmed, "https://codemirror.invalid/");
        return (
            url.protocol === "http:" ||
            url.protocol === "https:" ||
            url.protocol === "mailto:"
        );
    } catch {
        return false;
    }
}

/**
 * Applies removal-only patterns until the value stops changing. Every pattern
 * only deletes, so the string strictly shrinks and the loop terminates.
 */
function stripUntilStable(value: string, patterns: RegExp[]): string {
    let current = value;
    for (;;) {
        let next = current;
        for (const pattern of patterns) {
            next = next.replace(pattern, "");
        }
        if (next === current) {
            return current;
        }
        current = next;
    }
}

/**
 * Removes active content from server-provided documentation HTML.
 *
 * Markdown renderers are host-configurable, so sanitization happens after
 * rendering rather than relying on the default renderer to be safe.
 */
export function sanitizeDocumentationHTML(html: string): string {
    if (typeof document === "undefined") {
        // Each removal can splice together text that forms a fresh match
        // (`<scr<script>ipt>`), so strip repeatedly until the input stops
        // shrinking rather than in a single pass.
        const stripped = stripUntilStable(html, [
            /<\s*\/?\s*(?:script|style|iframe|object|embed|img)\b[^>]*>/gi,
            /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
            /\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
        ]);
        return stripped.replace(
            /\s+((?:xlink:)?href|src)\s*=\s*(["'])(.*?)\2/gi,
            (attribute, name: string, quote: string, value: string) =>
                isSafeDocumentationUrl(value)
                    ? attribute
                    : ` ${name}=${quote}${quote}`,
        );
    }

    const template = document.createElement("template");
    template.innerHTML = html;
    for (const element of template.content.querySelectorAll(
        "script, style, iframe, object, embed, img",
    )) {
        element.remove();
    }
    for (const element of template.content.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            if (
                name.startsWith("on") ||
                name === "srcdoc" ||
                // `xlink:href` is the SVG-namespaced form of `href` and is
                // just as capable of carrying a `javascript:` URL.
                ((name === "href" || name === "src" || name === "xlink:href") &&
                    !isSafeDocumentationUrl(attribute.value))
            ) {
                element.removeAttribute(attribute.name);
            }
        }
    }
    return template.innerHTML;
}

export function formatContents(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
    markdownRenderer = renderMarkdown,
): string {
    return formatContentsInner(contents, markdownRenderer, new WeakSet());
}

function formatContentsInner(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
    markdownRenderer: (markdown: string) => string,
    seen: WeakSet<object>,
): string {
    if (!contents) {
        return "";
    }
    if (typeof contents === "object") {
        if (seen.has(contents)) {
            return "";
        }
        seen.add(contents);
    }
    if (isLSPMarkupContent(contents)) {
        const rawValue = contents.value;
        if (typeof rawValue !== "string") {
            return "";
        }
        let value = escapeHTML(rawValue);
        if (contents.kind === "markdown") {
            value = markdownRenderer(rawValue.trim());
        }
        return value;
    }
    if (Array.isArray(contents)) {
        return contents
            .map((c) => formatContentsInner(c, markdownRenderer, seen))
            .filter(Boolean)
            .join("\n\n");
    }
    if (typeof contents === "string") {
        return escapeHTML(contents);
    }
    if (isLSPMarkedStringObject(contents)) {
        // Legacy MarkedString form: render as a fenced code block. A
        // malformed `language` must not break rendering of the value.
        const language =
            typeof contents.language === "string"
                ? contents.language.replace(/[^\w+-]/g, "")
                : "";
        return markdownRenderer(
            `\`\`\`${language}\n${contents.value ?? ""}\n\`\`\``,
        );
    }
    return "";
}

/**
 * Extract the raw text of documentation contents, without rendering
 * markdown to HTML. Used when HTML content is not allowed.
 */
export function formatPlainTextContents(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
): string {
    if (!contents) {
        return "";
    }
    if (isLSPMarkupContent(contents)) {
        return contents.value;
    }
    if (Array.isArray(contents)) {
        return contents
            .map((c) => formatPlainTextContents(c))
            .filter(Boolean)
            .join("\n\n");
    }
    if (typeof contents === "string") {
        return contents;
    }
    if (isLSPMarkedStringObject(contents)) {
        return contents.value;
    }
    return "";
}

/**
 * Render documentation contents into an element, as HTML when allowed and
 * as plain text otherwise (never showing HTML markup as literal text).
 */
export function renderDocumentation(
    element: HTMLElement,
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
    options: {
        allowHTMLContent: boolean;
        markdownRenderer?: (markdown: string) => string;
    },
): void {
    if (options.allowHTMLContent) {
        element.innerHTML = sanitizeDocumentationHTML(
            formatContents(contents, options.markdownRenderer),
        );
    } else {
        element.textContent = formatPlainTextContents(contents);
    }
}

/**
 * Finds the longest common prefix among an array of strings.
 *
 * @param strs - Array of strings to analyze
 * @returns The longest common prefix string
 */
export function longestCommonPrefix(strs: string[]): string {
    if (strs.length === 0) return "";
    if (strs.length === 1) return strs[0] || "";

    // Sort the array
    const sorted = [...strs].sort();

    // Get the first and last string after sorting
    const firstStr = sorted[0] || "";
    const lastStr = sorted[sorted.length - 1] || "";

    // Find the common prefix between the first and last string
    let i = 0;
    while (i < firstStr.length && firstStr[i] === lastStr[i]) {
        i++;
    }

    return firstStr.substring(0, i);
}

/**
 * Analyzes completion items to generate a regex pattern for matching prefixes.
 * Used to determine what text should be considered part of the current token
 * when filtering completion items.
 *
 * @param items - Array of LSP completion items to analyze
 * @returns A RegExp object that matches anywhere in a string
 */
export function prefixMatch(items: LSP.CompletionItem[]) {
    if (items.length === 0) {
        return undefined;
    }

    const labels = items.map((item) => item.textEdit?.newText ?? item.label);
    const prefix = longestCommonPrefix(labels);

    if (prefix === "") {
        return undefined;
    }

    const explodedPrefixes: string[] = [];
    for (let i = 0; i < prefix.length; i++) {
        const slice = prefix.slice(0, i + 1);
        if (slice.length > 0) {
            // Escape special regex characters to avoid pattern errors
            const escapedSlice = slice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            explodedPrefixes.push(escapedSlice);
        }
    }
    const orPattern = explodedPrefixes.join("|");
    // Create regex pattern that matches the common prefix for each possible prefix by dropping the last character
    const pattern = new RegExp(`(${orPattern})$`);

    return pattern;
}

export function isLSPTextEdit(
    textEdit?: LSP.TextEdit | LSP.InsertReplaceEdit,
): textEdit is LSP.TextEdit {
    return (textEdit as LSP.TextEdit)?.range !== undefined;
}

export function isCompletionList(
    result: LSP.CompletionItem[] | LSP.CompletionList,
): result is LSP.CompletionList {
    return !Array.isArray(result);
}

export function isInsertReplaceEdit(
    textEdit?: LSP.TextEdit | LSP.InsertReplaceEdit,
): textEdit is LSP.InsertReplaceEdit {
    return (
        (textEdit as LSP.InsertReplaceEdit)?.insert !== undefined &&
        (textEdit as LSP.InsertReplaceEdit)?.replace !== undefined
    );
}

export function isLSPMarkupContent(
    contents: LSP.MarkupContent | LSP.MarkedString | LSP.MarkedString[],
): contents is LSP.MarkupContent {
    return (
        typeof contents === "object" &&
        contents !== null &&
        !Array.isArray(contents) &&
        "kind" in contents
    );
}

/**
 * Normalizes a diagnostic message to a plain string. LSP 3.18 widened
 * `Diagnostic.message` to `string | MarkupContent`; we only render plain
 * strings, so unwrap the `.value` when a MarkupContent is provided.
 */
export function diagnosticMessageToString(
    message: string | LSP.MarkupContent,
): string {
    return typeof message === "string" ? message : message.value;
}

function isLSPMarkedStringObject(
    contents: LSP.MarkupContent | LSP.MarkedString | LSP.MarkedString[],
): contents is { language: string; value: string } {
    return (
        typeof contents === "object" &&
        contents !== null &&
        "language" in contents &&
        "value" in contents
    );
}

export function showErrorMessage(view: EditorView, message: string) {
    const tooltip = document.createElement("div");
    tooltip.className = "cm-error-message";
    tooltip.style.cssText = `
  position: absolute;
  padding: 8px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  font-size: 14px;
  z-index: 100;
  max-width: 300px;
  box-shadow: 0 2px 8px rgba(0,0,0,.15);
`;
    tooltip.textContent = message;

    // Position near the cursor
    const cursor = view.coordsAtPos(view.state.selection.main.head);
    if (cursor) {
        tooltip.style.left = `${cursor.left}px`;
        tooltip.style.top = `${cursor.bottom + 5}px`;
    }

    document.body.appendChild(tooltip);

    // Remove after 3 seconds
    setTimeout(() => {
        tooltip.style.opacity = "0";
        tooltip.style.transition = "opacity 0.2s";
        setTimeout(() => tooltip.remove(), 200);
    }, 3000);
}

export function isEmptyDocumentation(
    documentation:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
) {
    return isEmptyDocumentationInner(documentation, new WeakSet());
}

function isEmptyDocumentationInner(
    documentation:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
    seen: WeakSet<object>,
): boolean {
    if (documentation == null) {
        return true;
    }
    if (Array.isArray(documentation)) {
        if (seen.has(documentation)) {
            return true;
        }
        seen.add(documentation);
        return (
            documentation.length === 0 ||
            documentation.every((value) =>
                isEmptyDocumentationInner(value, seen),
            )
        );
    }
    if (typeof documentation === "string") {
        return isEmptyIshValue(documentation);
    }
    const value = documentation.value;
    if (typeof value === "string") {
        return isEmptyIshValue(value);
    }
    return true;
}

function isEmptyIshValue(value: unknown) {
    if (value == null) {
        return true;
    }
    if (typeof value === "string") {
        // Empty string or string with only whitespace or backticks
        return value.trim() === "" || /^[\s\n`]*$/.test(value);
    }
    return false;
}

/**
 * Map a `ChangeSet` into `TextDocumentContentChangeEvent[]` to be applied by an LSP
 * @param doc The doc before applying the ChangeSet
 * @param changes The `ChangeSet` to map
 */
export function eventsFromChangeSet(
    doc: Text,
    changes: ChangeSet,
): LSP.TextDocumentContentChangeEvent[] {
    const events: {
        range?: LSP.Range;
        text: string;
    }[] = [];

    changes.iterChanges((fromA, toA, _, __, inserted) => {
        const text = inserted.toString();
        // Represents a full document change
        if (fromA === 0 && toA === doc.length) {
            events.push({ text });
            return;
        }

        // An incremental change event, converting (index) to (line, col)
        const start = offsetToPos(doc, fromA);
        const end = offsetToPos(doc, toA);
        events.push({ range: { start, end }, text });
    });

    // Sort in reverse order to prevent index shift
    events.sort((a, b) => {
        if (!a.range) return 1; // Sort `a` after `b`.
        if (!b.range) return -1; // Sort `b` after `a`.

        const aLine = a.range.start.line ?? -1;
        const bLine = b.range.start.line ?? -1;

        if (aLine !== bLine) {
            return bLine - aLine; // Sort by line in descending order.
        }

        const aChar = a.range.start.character ?? -1;
        const bChar = b.range.start.character ?? -1;

        return bChar - aChar; // If lines are the same, sort by character in descending order.
    });
    return events;
}
