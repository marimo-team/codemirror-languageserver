import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import {
    formatContents,
    isEmptyDocumentation,
    isLSPMarkupContent,
    renderDocumentation,
} from "../utils.js";

/**
 * Documentation contents (hover, completion detail, signature help) come
 * straight off the wire from a language server. A malicious or compromised
 * server must not be able to run script in the editor host page, and
 * malformed payloads must not crash the editor.
 */

function renderHTML(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
): HTMLElement {
    const el = document.createElement("div");
    renderDocumentation(el, contents, { allowHTMLContent: true });
    return el;
}

function renderText(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
): HTMLElement {
    const el = document.createElement("div");
    renderDocumentation(el, contents, { allowHTMLContent: false });
    return el;
}

const IMG_PAYLOAD = "<img src=x onerror=alert(1)>";

describe("HTML injection through documentation", () => {
    // BUG: plaintext-kind MarkupContent should be escaped before it reaches
    // innerHTML — currently formatContents returns the value untouched and
    // renderDocumentation assigns it to innerHTML, so content the server
    // explicitly declared as PLAIN TEXT becomes live, executable HTML.
    it.fails("escapes HTML in plaintext-kind MarkupContent", () => {
        const el = renderHTML({ kind: "plaintext", value: IMG_PAYLOAD });
        expect(el.querySelector("img")).toBeNull();
        expect(el.textContent).toContain(IMG_PAYLOAD);
    });

    // BUG: markdown from the server should be sanitized so no event-handler
    // carrying element is created — currently `marked` runs with no sanitizer
    // and the raw HTML block becomes a live <img onerror> node.
    it.fails("does not create a live img element from server markdown", () => {
        const el = renderHTML({ kind: "markdown", value: IMG_PAYLOAD });
        const img = el.querySelector("img");
        expect(img).toBeNull();
        expect(img?.getAttribute("onerror")).toBeUndefined();
    });

    // BUG: javascript: URLs in markdown links should be stripped — currently
    // marked emits <a href="javascript:alert(1)"> verbatim.
    it.fails("strips javascript: hrefs from markdown links", () => {
        const el = renderHTML({
            kind: "markdown",
            value: "[c](javascript:alert(1))",
        });
        const href = el.querySelector("a")?.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*javascript:/i);
    });

    // BUG: data: URLs in markdown links should be stripped — currently marked
    // emits <a href="data:text/html,..."> verbatim, which navigates to
    // attacker controlled HTML in the editor's origin-less context.
    it.fails("strips data: URI hrefs from markdown links", () => {
        const el = renderHTML({
            kind: "markdown",
            value: "[c](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
        });
        const href = el.querySelector("a")?.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*data:/i);
    });

    // BUG: a bare-string MarkedString should be escaped or rendered as
    // markdown before hitting innerHTML — currently formatContents returns it
    // raw and unrendered, so it is injected as live HTML.
    it.fails("does not inject raw HTML from a bare-string MarkedString", () => {
        const el = renderHTML("<img src=x onerror=1>");
        expect(el.querySelector("img")).toBeNull();
    });

    it("does not inject HTML from a nested MarkedString array entry", () => {
        const el = renderHTML([
            "safe",
            { language: "js", value: "</code></pre><img src=x onerror=1>" },
        ]);
        expect(el.querySelector("img")).toBeNull();
    });

    // BUG: inline event handlers in markdown HTML blocks should be stripped —
    // currently the <div onclick=...> survives into the DOM with its handler
    // attribute intact.
    it.fails("strips inline event handlers from markdown HTML blocks", () => {
        const el = renderHTML({
            kind: "markdown",
            value: "<div onclick=alert(1)>x</div>",
        });
        const div = el.querySelector("div");
        expect(div?.getAttribute("onclick") ?? null).toBeNull();
    });

    // BUG: iframes from server markdown should be stripped — currently a live
    // <iframe src="javascript:..."> node is created.
    it.fails("does not create a live iframe from server markdown", () => {
        const el = renderHTML({
            kind: "markdown",
            value: '<iframe src="javascript:alert(1)"></iframe>',
        });
        expect(el.querySelector("iframe")).toBeNull();
    });

    it("renders every payload as inert text when allowHTMLContent is false", () => {
        const payloads: Array<
            LSP.MarkupContent | LSP.MarkedString | LSP.MarkedString[]
        > = [
            { kind: "plaintext", value: IMG_PAYLOAD },
            { kind: "markdown", value: IMG_PAYLOAD },
            { kind: "markdown", value: "[c](javascript:alert(1))" },
            "<img src=x onerror=1>",
            ["safe", { language: "js", value: "</code></pre><img src=x>" }],
            { kind: "markdown", value: "<div onclick=alert(1)>x</div>" },
            {
                kind: "markdown",
                value: '<iframe src="javascript:alert(1)"></iframe>',
            },
        ];
        for (const payload of payloads) {
            const el = renderText(payload);
            expect(el.querySelector("img")).toBeNull();
            expect(el.querySelector("iframe")).toBeNull();
            expect(el.querySelector("a")).toBeNull();
            expect(el.querySelector("div")).toBeNull();
            expect(el.children.length).toBe(0);
        }
    });

    it("escapes the legacy MarkedString language field", () => {
        const el = renderHTML({
            language: '"><img src=x onerror=1>',
            value: "x",
        });
        expect(el.querySelector("img")).toBeNull();
        expect(el.querySelector("code")).not.toBeNull();
    });
});

describe("malformed MarkupContent", () => {
    // BUG: a MarkupContent missing `value` should be treated as empty —
    // currently formatContents throws
    // "TypeError: Cannot read properties of undefined (reading 'trim')".
    it.fails("does not throw for MarkupContent with a missing value", () => {
        expect(() =>
            formatContents({ kind: "markdown" } as LSP.MarkupContent),
        ).not.toThrow();
    });

    // BUG: formatContents should always return a string — currently it returns
    // `undefined` for a value-less plaintext MarkupContent.
    it.fails("returns a string for MarkupContent with a missing value", () => {
        expect(formatContents({ kind: "plaintext" } as LSP.MarkupContent)).toBe(
            "",
        );
    });

    // BUG: a value-less plaintext MarkupContent should render nothing —
    // currently `innerHTML = undefined` paints the literal text "undefined"
    // into the hover tooltip.
    it.fails(
        'renderDocumentation does not render the literal text "undefined"',
        () => {
            const el = renderHTML({ kind: "plaintext" } as LSP.MarkupContent);
            expect(el.textContent).not.toContain("undefined");
        },
    );

    it("does not throw for a null entry in a contents array", () => {
        expect(() =>
            formatContents([
                "ok",
                null,
                undefined,
            ] as unknown as LSP.MarkedString[]),
        ).not.toThrow();
        expect(
            formatContents([
                "ok",
                null,
                undefined,
            ] as unknown as LSP.MarkedString[]),
        ).toBe("ok");
    });

    // BUG: isLSPMarkupContent is exported and should be a safe type guard —
    // currently it dereferences `.kind` on its argument and throws a TypeError
    // for null.
    it.fails("isLSPMarkupContent does not throw for null", () => {
        expect(() =>
            isLSPMarkupContent(null as unknown as LSP.MarkupContent),
        ).not.toThrow();
    });

    it("ignores non-string values in a contents array", () => {
        expect(
            formatContents(["ok", 42, true] as unknown as LSP.MarkedString[]),
        ).toBe("ok");
    });

    // BUG: a MarkupContent whose `value` is not a string carries no
    // documentation and should be reported as empty — currently
    // isEmptyDocumentation returns false, which is exactly what lets the
    // value-less/typed-wrong payload reach formatContents and throw.
    it.fails("treats MarkupContent with a non-string value as empty", () => {
        expect(
            isEmptyDocumentation({
                kind: "markdown",
                value: {},
            } as unknown as LSP.MarkupContent),
        ).toBe(true);
    });

    it("handles a MarkedString with a missing value", () => {
        const el = renderHTML({ language: "js" } as LSP.MarkedString);
        expect(el.textContent).not.toContain("undefined");
    });

    // BUG: cyclic contents should be handled, not blow the stack — currently
    // both helpers recurse unboundedly and throw a RangeError.
    it.fails(
        "does not stack-overflow on a self-referential contents array",
        () => {
            const a: unknown[] = [];
            a.push(a);
            expect(() =>
                formatContents(a as unknown as LSP.MarkedString[]),
            ).not.toThrow();
            expect(() =>
                isEmptyDocumentation(a as unknown as LSP.MarkedString[]),
            ).not.toThrow();
        },
    );
});
