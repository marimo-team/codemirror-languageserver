import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export type ThemeMode = "light" | "dark";

/**
 * A single, self-contained place to describe how both the editor chrome *and*
 * every LSP surface (hover tooltips, diagnostics, signature help, completion,
 * code actions, rename) should look in light and dark mode. Everything here is
 * expressed with `EditorView.theme` so it composes cleanly with the library's
 * `baseTheme` defaults — hosts style exactly like this in the real world.
 */
interface Palette {
    dark: boolean;
    // Editor chrome
    bg: string;
    fg: string;
    faintFg: string;
    gutterFg: string;
    activeLine: string;
    selection: string;
    cursor: string;
    border: string;
    // Floating surfaces (tooltips, menus, popups)
    surface: string;
    surfaceBorder: string;
    surfaceShadow: string;
    code: string;
    accent: string;
    accentSoft: string;
    // Diagnostics
    error: string;
    errorSoft: string;
    warning: string;
    warningSoft: string;
    info: string;
    hint: string;
    // Syntax
    comment: string;
    keyword: string;
    string: string;
    number: string;
    fn: string;
    type: string;
    variable: string;
    operator: string;
    property: string;
}

const LIGHT: Palette = {
    dark: false,
    bg: "#ffffff",
    fg: "#1f2328",
    faintFg: "#57606a",
    gutterFg: "#8c959f",
    activeLine: "#f6f8fa",
    selection: "#b6d5fc",
    cursor: "#0969da",
    border: "#d0d7de",
    surface: "#ffffff",
    surfaceBorder: "#d0d7de",
    surfaceShadow: "0 8px 24px rgba(31, 35, 40, 0.16)",
    code: "#f6f8fa",
    accent: "#0969da",
    accentSoft: "#ddf4ff",
    error: "#cf222e",
    errorSoft: "#ffebe9",
    warning: "#bf8700",
    warningSoft: "#fff8c5",
    info: "#0969da",
    hint: "#6e7781",
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    fn: "#8250df",
    type: "#953800",
    variable: "#1f2328",
    operator: "#0550ae",
    property: "#0550ae",
};

const DARK: Palette = {
    dark: true,
    bg: "#0d1117",
    fg: "#e6edf3",
    faintFg: "#9198a1",
    gutterFg: "#6e7681",
    activeLine: "#161b22",
    selection: "#2d4f76",
    cursor: "#58a6ff",
    border: "#30363d",
    surface: "#161b22",
    surfaceBorder: "#30363d",
    surfaceShadow: "0 8px 24px rgba(1, 4, 9, 0.7)",
    code: "#1f2733",
    accent: "#58a6ff",
    accentSoft: "#193356",
    error: "#ff7b72",
    errorSoft: "#3a1a1c",
    warning: "#d29922",
    warningSoft: "#3a2c10",
    info: "#58a6ff",
    hint: "#8b949e",
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    fn: "#d2a8ff",
    type: "#ffa657",
    variable: "#e6edf3",
    operator: "#79c0ff",
    property: "#79c0ff",
};

function editorTheme(p: Palette): Extension {
    return EditorView.theme(
        {
            "&": {
                color: p.fg,
                backgroundColor: p.bg,
                fontSize: "13.5px",
            },
            ".cm-content": {
                caretColor: p.cursor,
                fontFamily:
                    'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace',
                padding: "8px 0",
            },
            ".cm-scroller": { lineHeight: "1.6" },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.cursor },
            "&.cm-focused .cm-cursor": { borderLeftColor: p.cursor },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
                { backgroundColor: p.selection },
            ".cm-activeLine": { backgroundColor: p.activeLine },
            ".cm-activeLineGutter": {
                backgroundColor: p.activeLine,
                color: p.fg,
            },
            ".cm-gutters": {
                backgroundColor: p.bg,
                color: p.gutterFg,
                border: "none",
                borderRight: `1px solid ${p.border}`,
            },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
            ".cm-foldPlaceholder": {
                backgroundColor: p.accentSoft,
                border: "none",
                color: p.faintFg,
                padding: "0 6px",
                borderRadius: "4px",
            },
            // Matching-bracket highlight
            "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
                backgroundColor: p.accentSoft,
                outline: `1px solid ${p.accent}55`,
            },
            ".cm-nonmatchingBracket": { color: p.error },
            // Search
            ".cm-searchMatch": {
                backgroundColor: `${p.warning}44`,
                outline: `1px solid ${p.warning}88`,
            },
            ".cm-searchMatch.cm-searchMatch-selected": {
                backgroundColor: `${p.accent}55`,
            },
            ".cm-selectionMatch": { backgroundColor: `${p.accent}22` },
        },
        { dark: p.dark },
    );
}

function highlightStyle(p: Palette): Extension {
    return syntaxHighlighting(
        HighlightStyle.define([
            { tag: t.comment, color: p.comment, fontStyle: "italic" },
            {
                tag: [t.lineComment, t.blockComment],
                color: p.comment,
                fontStyle: "italic",
            },
            {
                tag: [
                    t.keyword,
                    t.modifier,
                    t.controlKeyword,
                    t.operatorKeyword,
                ],
                color: p.keyword,
            },
            { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
            { tag: [t.number, t.bool, t.null, t.atom], color: p.number },
            {
                tag: [t.function(t.variableName), t.function(t.propertyName)],
                color: p.fn,
            },
            { tag: [t.typeName, t.className, t.namespace], color: p.type },
            { tag: [t.definition(t.typeName)], color: p.type },
            { tag: [t.variableName, t.self], color: p.variable },
            { tag: [t.propertyName, t.attributeName], color: p.property },
            {
                tag: [t.operator, t.derefOperator, t.punctuation],
                color: p.operator,
            },
            { tag: [t.bracket, t.brace, t.paren], color: p.faintFg },
            { tag: [t.definitionKeyword, t.moduleKeyword], color: p.keyword },
            { tag: [t.tagName], color: p.type },
            { tag: [t.meta, t.documentMeta], color: p.faintFg },
            {
                tag: [t.link, t.url],
                color: p.accent,
                textDecoration: "underline",
            },
            { tag: t.strong, fontWeight: "bold" },
            { tag: t.emphasis, fontStyle: "italic" },
            { tag: t.strikethrough, textDecoration: "line-through" },
            { tag: t.invalid, color: p.error },
        ]),
    );
}

/**
 * Styling for every LSP overlay the plugin renders. Kept separate from the
 * editor theme so it reads as "here's how we make LSP surfaces nice".
 */
function lspTheme(p: Palette): Extension {
    return EditorView.theme({
        // ---- Generic floating surfaces -----------------------------------
        ".cm-tooltip": {
            backgroundColor: p.surface,
            color: p.fg,
            border: `1px solid ${p.surfaceBorder}`,
            borderRadius: "8px",
            boxShadow: p.surfaceShadow,
            overflow: "hidden",
        },
        ".cm-tooltip .cm-tooltip-arrow:before": {
            borderTopColor: p.surfaceBorder,
            borderBottomColor: p.surfaceBorder,
        },
        ".cm-tooltip .cm-tooltip-arrow:after": {
            borderTopColor: p.surface,
            borderBottomColor: p.surface,
        },

        // ---- Hover tooltip -----------------------------------------------
        ".cm-tooltip.cm-lsp-hover-tooltip, .cm-lsp-hover-tooltip": {
            padding: "10px 12px",
            maxWidth: "460px",
            maxHeight: "340px",
            overflow: "auto",
            fontSize: "12.5px",
            lineHeight: "1.55",
        },
        ".cm-lsp-hover-tooltip p": { margin: "0 0 6px" },
        ".cm-lsp-hover-tooltip p:last-child": { margin: "0" },
        ".cm-lsp-hover-tooltip pre": {
            background: p.code,
            border: `1px solid ${p.border}`,
            borderRadius: "6px",
            padding: "8px 10px",
            margin: "6px 0",
            overflow: "auto",
            fontSize: "12px",
        },
        ".cm-lsp-hover-tooltip code": {
            fontFamily:
                'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: "12px",
        },
        ".cm-lsp-hover-tooltip :not(pre) > code": {
            background: p.code,
            borderRadius: "4px",
            padding: "1px 5px",
        },
        ".cm-lsp-hover-tooltip pre code": {
            background: "transparent",
            padding: "0",
        },
        ".cm-lsp-hover-tooltip a": { color: p.accent, textDecoration: "none" },
        ".cm-lsp-hover-tooltip a:hover": { textDecoration: "underline" },
        ".cm-lsp-hover-tooltip hr": {
            border: "none",
            borderTop: `1px solid ${p.border}`,
            margin: "8px 0",
        },
        ".cm-lsp-hover-tooltip h1, .cm-lsp-hover-tooltip h2, .cm-lsp-hover-tooltip h3, .cm-lsp-hover-tooltip h4":
            {
                fontSize: "13px",
                margin: "4px 0",
                fontWeight: "600",
            },

        // ---- Diagnostics: underlines -------------------------------------
        ".cm-lintRange": {
            backgroundImage: "none",
            paddingBottom: "1px",
        },
        ".cm-lintRange-error": {
            backgroundImage: `linear-gradient(${p.error}, ${p.error})`,
            backgroundRepeat: "repeat-x",
            backgroundPosition: "left bottom",
            backgroundSize: "100% 2px",
        },
        ".cm-lintRange-warning": {
            backgroundImage: `linear-gradient(${p.warning}, ${p.warning})`,
            backgroundRepeat: "repeat-x",
            backgroundPosition: "left bottom",
            backgroundSize: "100% 2px",
        },
        ".cm-lintRange-info, .cm-lintRange-hint": {
            backgroundImage: `linear-gradient(${p.info}, ${p.info})`,
            backgroundRepeat: "repeat-x",
            backgroundPosition: "left bottom",
            backgroundSize: "100% 2px",
        },

        // ---- Diagnostics: lint gutter markers ----------------------------
        ".cm-lint-marker": {
            width: "0.9em",
            height: "0.9em",
            cursor: "pointer",
        },
        ".cm-lint-marker-error": { content: '""' },

        // ---- Diagnostics: tooltip / panel entries ------------------------
        ".cm-tooltip-lint": { padding: "0" },
        ".cm-diagnostic": {
            padding: "8px 12px 8px 14px",
            margin: "0",
            borderLeft: "4px solid transparent",
            fontSize: "12.5px",
            lineHeight: "1.5",
        },
        ".cm-diagnostic + .cm-diagnostic": {
            borderTop: `1px solid ${p.border}`,
        },
        ".cm-diagnostic-error": {
            borderLeftColor: p.error,
            background: p.errorSoft,
        },
        ".cm-diagnostic-warning": {
            borderLeftColor: p.warning,
            background: p.warningSoft,
        },
        ".cm-diagnostic-info": { borderLeftColor: p.info },
        ".cm-diagnostic-hint": { borderLeftColor: p.hint },
        ".cm-diagnosticText": { fontWeight: "500" },
        ".cm-diagnosticSource": {
            fontSize: "11px",
            opacity: "0.7",
            marginLeft: "6px",
        },
        ".cm-lsp-diagnostic-message code": {
            fontFamily:
                'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
            background: p.code,
            borderRadius: "4px",
            padding: "1px 5px",
            fontSize: "11.5px",
        },
        ".cm-diagnostic-code-link": {
            color: p.accent,
            fontSize: "11.5px",
            textDecoration: "none",
        },
        ".cm-diagnostic-code-link:hover": { textDecoration: "underline" },
        ".cm-diagnostic-related": {
            fontSize: "11.5px",
            paddingTop: "2px",
            borderTop: `1px dashed ${p.border}`,
            marginTop: "6px",
        },
        ".cm-diagnostic-related-clickable .cm-diagnostic-related-message": {
            color: p.accent,
        },
        ".cm-diagnostic-related-clickable:hover .cm-diagnostic-related-message":
            { textDecoration: "underline" },
        // Quick-fix action buttons inside diagnostics
        ".cm-diagnosticAction": {
            color: p.accent,
            background: "transparent",
            border: `1px solid ${p.accent}`,
            borderRadius: "5px",
            padding: "2px 8px",
            margin: "6px 8px 0 0",
            fontSize: "11.5px",
            cursor: "pointer",
        },
        ".cm-diagnosticAction:hover": {
            background: p.accent,
            color: p.bg,
        },

        // ---- Completion popup --------------------------------------------
        ".cm-tooltip-autocomplete": { padding: "4px" },
        ".cm-tooltip-autocomplete > ul": {
            fontFamily:
                'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: "12.5px",
            maxHeight: "16em",
        },
        ".cm-tooltip-autocomplete > ul > li": {
            padding: "3px 8px",
            borderRadius: "5px",
            lineHeight: "1.5",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
            background: p.accent,
            color: p.dark ? "#0d1117" : "#ffffff",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail":
            { color: p.dark ? "#0d1117cc" : "#ffffffcc" },
        ".cm-completionIcon": { opacity: "0.7", paddingRight: "10px" },
        ".cm-completionLabel": { color: "inherit" },
        ".cm-completionDetail": {
            color: p.faintFg,
            fontStyle: "normal",
            marginLeft: "8px",
        },
        ".cm-completionMatchedText": {
            textDecoration: "none",
            fontWeight: "700",
            color: "inherit",
        },
        ".cm-completionInfo": {
            background: p.surface,
            border: `1px solid ${p.surfaceBorder}`,
            borderRadius: "8px",
            boxShadow: p.surfaceShadow,
            padding: "8px 10px",
            maxWidth: "360px",
            fontSize: "12px",
            lineHeight: "1.5",
        },

        // ---- Signature help ----------------------------------------------
        ".cm-signature-help": {
            padding: "8px 12px",
            fontSize: "12.5px",
            lineHeight: "1.55",
            maxWidth: "460px",
        },
        ".cm-signature": {
            fontFamily:
                'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
        },
        ".cm-signature-active-param": {
            fontWeight: "700",
            color: p.accent,
            textDecoration: "underline",
            textUnderlineOffset: "3px",
        },
        ".cm-signature-docs": {
            marginTop: "6px",
            paddingTop: "6px",
            borderTop: `1px solid ${p.border}`,
            color: p.faintFg,
        },
        ".cm-parameter-docs": { marginTop: "4px", color: p.faintFg },

        // ---- Code action menu --------------------------------------------
        ".cm-code-action-menu": {
            background: p.surface,
            border: `1px solid ${p.surfaceBorder}`,
            borderRadius: "8px",
            boxShadow: p.surfaceShadow,
            padding: "4px",
            minWidth: "220px",
            fontSize: "12.5px",
        },
        ".cm-code-action-item": {
            padding: "6px 10px",
            borderRadius: "5px",
            cursor: "pointer",
            display: "flex",
            gap: "8px",
            alignItems: "center",
        },
        ".cm-code-action-item:hover, .cm-code-action-item[aria-selected='true'], .cm-code-action-item.cm-code-action-selected":
            { background: p.accent, color: p.dark ? "#0d1117" : "#ffffff" },
        ".cm-code-action-kind": {
            fontSize: "10.5px",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            opacity: "0.6",
        },

        // ---- Rename popup ------------------------------------------------
        ".cm-rename-popup": {
            background: p.surface,
            border: `1px solid ${p.surfaceBorder}`,
            borderRadius: "8px",
            boxShadow: p.surfaceShadow,
            padding: "6px",
        },
        ".cm-rename-popup input": {
            background: p.bg,
            color: p.fg,
            border: `1px solid ${p.border}`,
            borderRadius: "5px",
            padding: "5px 8px",
            fontFamily:
                'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
            outline: "none",
        },
        ".cm-rename-popup input:focus": {
            borderColor: p.accent,
            boxShadow: `0 0 0 2px ${p.accentSoft}`,
        },

        // ---- Deprecated / unnecessary tags -------------------------------
        ".cm-lsp-deprecated": { textDecoration: "line-through" },
        ".cm-lsp-unnecessary": { opacity: "0.55" },

        // ---- Inline error message (utils.ts) -----------------------------
        ".cm-error-message": {
            background: p.error,
            color: "#ffffff",
            padding: "4px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            boxShadow: p.surfaceShadow,
        },
    });
}

function themeFor(mode: ThemeMode): Extension {
    const p = mode === "dark" ? DARK : LIGHT;
    return [editorTheme(p), highlightStyle(p), lspTheme(p)];
}

// ---------------------------------------------------------------------------
// Runtime theme management: one shared compartment, reconfigured across every
// live editor when the user toggles light/dark.
// ---------------------------------------------------------------------------

const THEME_KEY = "cm-lsp-demo-theme";
const themeCompartment = new Compartment();
const editors = new Set<EditorView>();
let currentMode: ThemeMode = readInitialMode();
const listeners = new Set<(mode: ThemeMode) => void>();

function readInitialMode(): ThemeMode {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored === "light" || stored === "dark") {
            return stored;
        }
    } catch {
        // localStorage may be unavailable; fall through to media query.
    }
    return typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
}

/** The editor extension that carries the (reconfigurable) theme. */
export function themeExtension(): Extension {
    return themeCompartment.of(themeFor(currentMode));
}

/**
 * Register a live editor so it re-themes on toggle. Returns an unregister fn to
 * call from the demo's dispose callback.
 */
export function registerEditor(view: EditorView): () => void {
    editors.add(view);
    return () => {
        editors.delete(view);
    };
}

export function getThemeMode(): ThemeMode {
    return currentMode;
}

export function onThemeChange(listener: (mode: ThemeMode) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function setThemeMode(mode: ThemeMode): void {
    currentMode = mode;
    try {
        localStorage.setItem(THEME_KEY, mode);
    } catch {
        // ignore persistence failures
    }
    document.documentElement.dataset.theme = mode;
    for (const view of editors) {
        view.dispatch({
            effects: themeCompartment.reconfigure(themeFor(mode)),
        });
    }
    for (const listener of listeners) {
        listener(mode);
    }
}

export function toggleThemeMode(): void {
    setThemeMode(currentMode === "dark" ? "light" : "dark");
}

/** Apply the current mode to the page chrome. Call once on startup. */
export function initPageTheme(): void {
    document.documentElement.dataset.theme = currentMode;
}
