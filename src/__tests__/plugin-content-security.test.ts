import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerPlugin } from "../plugin.js";
import {
    createFakeClient,
    createPlugin,
    createView,
    flushTicks,
} from "./test-utils.js";

function collectDiagnostics(view: EditorView) {
    const found: import("@codemirror/lint").Diagnostic[] = [];
    forEachDiagnostic(view.state, (diagnostic) => {
        found.push(diagnostic);
    });
    return found;
}

afterEach(() => {
    document.body.innerHTML = "";
});

/** A payload a hostile/compromised language server could send. */
const HOSTILE_HTML = '<img src=x onerror="globalThis.__pwned = true">';

const DIAGNOSTIC_RANGE = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
};

/**
 * Drives the real hover path: fake `textDocument/hover` response -> tooltip ->
 * rendered DOM.
 */
async function renderHover(
    contents: LSP.MarkupContent,
    allowHTMLContent: boolean,
): Promise<HTMLElement> {
    const client = createFakeClient();
    // biome-ignore lint/suspicious/noExplicitAny: extending the partial stub
    (client as any).textDocumentHover = vi.fn().mockResolvedValue({ contents });
    const view = createView("hello");
    const plugin = createPlugin(view, client, { allowHTMLContent });
    await flushTicks();

    const tooltip = await plugin.requestHoverTooltip(view, {
        line: 0,
        character: 0,
    });
    expect(tooltip).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return tooltip!.create(view).dom as HTMLElement;
}

/**
 * Drives the real diagnostics path: publishDiagnostics -> CodeMirror
 * diagnostic -> `renderMessage`.
 */
async function renderDiagnostic(
    diagnostic: LSP.Diagnostic,
    allowHTMLContent: boolean,
): Promise<HTMLElement> {
    const view = createView("hello");
    const plugin = createPlugin(view, createFakeClient(), {
        allowHTMLContent,
    });

    await plugin.processDiagnostics({
        uri: "file:///test.ts",
        diagnostics: [diagnostic],
    });

    const [lintDiagnostic] = collectDiagnostics(view);
    return lintDiagnostic?.renderMessage?.(view) as HTMLElement;
}

/**
 * Drives the real signature help path: fake `textDocument/signatureHelp`
 * response -> tooltip -> rendered DOM.
 */
async function renderSignatureHelp(
    signature: LSP.SignatureInformation,
    allowHTMLContent: boolean,
): Promise<HTMLElement> {
    const client = createFakeClient({
        capabilities: { signatureHelpProvider: {} },
    });
    // biome-ignore lint/suspicious/noExplicitAny: extending the partial stub
    (client as any).textDocumentSignatureHelp = vi.fn().mockResolvedValue({
        signatures: [signature],
        activeSignature: 0,
        activeParameter: 0,
    });
    const view = createView("f(x)");
    const plugin = createPlugin(view, client, { allowHTMLContent });
    await flushTicks();

    const tooltip = await plugin.requestSignatureHelp(view, {
        line: 0,
        character: 2,
    });
    expect(tooltip).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return tooltip!.create(view).dom as HTMLElement;
}

describe("hover contents", () => {
    it("does not create a live img element from hover contents", async () => {
        const dom = await renderHover(
            { kind: "markdown", value: HOSTILE_HTML },
            true,
        );

        expect(dom.querySelector("img")).toBeNull();
        expect(dom.innerHTML).not.toContain("onerror");
    });

    it("renders hover HTML as inert text when allowHTMLContent is false", async () => {
        const dom = await renderHover(
            { kind: "markdown", value: HOSTILE_HTML },
            false,
        );

        expect(dom.querySelector("img")).toBeNull();
        expect(dom.textContent).toContain("<img");
    });
});

describe("diagnostic messages", () => {
    it("does not create a live img element from a diagnostic message", async () => {
        const dom = await renderDiagnostic(
            { range: DIAGNOSTIC_RANGE, message: HOSTILE_HTML },
            true,
        );

        expect(dom.querySelector("img")).toBeNull();
        expect(dom.innerHTML).not.toContain("onerror");
    });

    it("renders a diagnostic message as inert text when allowHTMLContent is false", async () => {
        const dom = await renderDiagnostic(
            { range: DIAGNOSTIC_RANGE, message: HOSTILE_HTML },
            false,
        );

        expect(dom.querySelector("img")).toBeNull();
        expect(dom.textContent).toContain("<img");
    });

    it("rejects a data: URL in codeDescription", async () => {
        const unsafeHrefs = [
            "data:text/html,<script>alert(1)</script>",
            "vbscript:alert(1)",
            // Protocol-relative: would inherit the page scheme and navigate off-site
            "//evil.com",
            // Malformed / not an absolute URL at all
            "http://[not a url",
        ];

        for (const href of unsafeHrefs) {
            const dom = await renderDiagnostic(
                {
                    range: DIAGNOSTIC_RANGE,
                    message: "sketchy",
                    code: "x",
                    codeDescription: { href } as LSP.CodeDescription,
                },
                false,
            );
            expect(
                dom.querySelector("a.cm-diagnostic-code-link"),
                `href should have been rejected: ${href}`,
            ).toBeNull();
        }

        // Regression guard: a normal https URL is still rendered
        const safeDom = await renderDiagnostic(
            {
                range: DIAGNOSTIC_RANGE,
                message: "documented",
                code: "x",
                codeDescription: { href: "https://example.com/rule" },
            },
            false,
        );
        const link = safeDom.querySelector<HTMLAnchorElement>(
            "a.cm-diagnostic-code-link",
        );
        expect(link?.href).toBe("https://example.com/rule");
    });
});

describe("signature help documentation", () => {
    it("does not create a live img element from signature documentation", async () => {
        const dom = await renderSignatureHelp(
            {
                label: "f(x)",
                documentation: { kind: "markdown", value: HOSTILE_HTML },
                parameters: [{ label: "x" }],
            },
            true,
        );

        const docs = dom.querySelector(".cm-signature-docs");
        expect(docs).not.toBeNull();
        expect(docs?.querySelector("img")).toBeNull();
        expect(docs?.innerHTML).not.toContain("onerror");
    });

    it("does not create a live img element from parameter documentation", async () => {
        const dom = await renderSignatureHelp(
            {
                label: "f(x)",
                documentation: "safe signature docs",
                parameters: [
                    {
                        label: "x",
                        documentation: {
                            kind: "markdown",
                            value: HOSTILE_HTML,
                        },
                    },
                ],
            },
            true,
        );

        const paramDocs = dom.querySelector(".cm-parameter-docs");
        expect(paramDocs).not.toBeNull();
        expect(paramDocs?.querySelector("img")).toBeNull();
        expect(paramDocs?.innerHTML).not.toContain("onerror");
    });

    it("renders signature documentation as inert text when allowHTMLContent is false", async () => {
        const dom = await renderSignatureHelp(
            {
                label: "f(x)",
                documentation: { kind: "markdown", value: HOSTILE_HTML },
                parameters: [
                    {
                        label: "x",
                        documentation: {
                            kind: "markdown",
                            value: HOSTILE_HTML,
                        },
                    },
                ],
            },
            false,
        );

        expect(dom.querySelector("img")).toBeNull();
        const docs = dom.querySelector(".cm-signature-docs");
        expect(docs?.textContent).toContain("<img");
        const paramDocs = dom.querySelector(".cm-parameter-docs");
        expect(paramDocs?.textContent).toContain("<img");
    });
});
