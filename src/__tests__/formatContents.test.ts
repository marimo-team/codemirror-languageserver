import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { formatContents, renderDocumentation } from "../utils";

describe("formatContents", () => {
    it("returns empty string for undefined input", () => {
        expect(formatContents(undefined)).toBe("");
    });

    it("formats string content", () => {
        expect(formatContents("simple text")).toBe("simple text");
    });

    it("formats MarkupContent with plaintext", () => {
        const content: LSP.MarkupContent = {
            kind: "plaintext",
            value: "plain text content",
        };
        expect(formatContents(content)).toBe("plain text content");
    });

    it("formats MarkupContent with markdown", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "# Heading\n\nParagraph",
        };
        expect(formatContents(content)).toMatchInlineSnapshot(`
          "<h1>Heading</h1>
          <p>Paragraph</p>
          "
        `);
    });

    it("removes leading/trailing whitespace from MarkupContent", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "   \n# Heading\n\nParagraph   \n",
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`
          "<h1>Heading</h1>
          <p>Paragraph</p>
          "
        `);
    });

    it("formats MarkupContent with code block", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "```typescript\nconst x = 1;\n```",
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`
          "<pre><code class="language-typescript">const x = 1;
          </code></pre>
          "
        `);
    });

    it("formats MarkupContent with code block and additional text", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "Some text\n\n```typescript\nconst x = 1;\n```",
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`
          "<p>Some text</p>
          <pre><code class="language-typescript">const x = 1;
          </code></pre>
          "
        `);
    });

    it("formats MarkupContent with no language", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "```\nconst x = 1;\n```",
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`
          "<pre><code>const x = 1;
          </code></pre>
          "
        `);
    });

    it("removes empty codefences", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "```typescript\n\n```",
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`""`);
    });

    it("removes empty codefences complex", () => {
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: [
                "```python\ndef foo():\n    pass\n```",
                "```\n\n```",
                "```typescript\n\n```",
                "```typescript\nx = 10\n```",
            ].join("\n"),
        };
        const result = formatContents(content);
        expect(result).toMatchInlineSnapshot(`
          "<pre><code class="language-python">def foo():
              pass
          </code></pre>
          <pre><code class="language-typescript">x = 10
          </code></pre>
          "
        `);
    });

    it("formats array of MarkedString", () => {
        const contents: LSP.MarkedString[] = [
            "first string",
            { language: "typescript", value: "const x = 1;" },
        ];
        const result = formatContents(contents);
        expect(result).toContain("first string");
        expect(result).toContain('<code class="language-typescript">');
        expect(result).toContain("const x = 1;");
    });

    it("handles empty array", () => {
        expect(formatContents([])).toBe("");
    });

    it("handles MarkedString with language", () => {
        const content: LSP.MarkedString = {
            language: "javascript",
            value: "console.log('test');",
        };
        const result = formatContents(content);
        expect(result).toContain('<code class="language-javascript">');
        expect(result).toContain("console.log");
    });

    it("allows specifying a custom markdown renderer", () => {
        const customRenderer = (markdown: string) => `<p>${markdown}</p>`;
        const content: LSP.MarkupContent = {
            kind: "markdown",
            value: "Custom renderer test",
        };
        expect(formatContents(content, customRenderer)).toBe(
            "<p>Custom renderer test</p>",
        );
    });
});

describe("renderDocumentation", () => {
    const markdownContent: LSP.MarkupContent = {
        kind: "markdown",
        value: "**bold** text",
    };

    it("renders markdown as HTML when HTML content is allowed", () => {
        const el = document.createElement("div");
        renderDocumentation(el, markdownContent, { allowHTMLContent: true });
        expect(el.innerHTML).toContain("<strong>bold</strong>");
    });

    it("does not show HTML markup as literal text when HTML is not allowed", () => {
        const el = document.createElement("div");
        renderDocumentation(el, markdownContent, { allowHTMLContent: false });
        // The raw markdown source is shown, never rendered HTML tags as text
        expect(el.textContent).not.toContain("<p>");
        expect(el.textContent).not.toContain("<strong>");
        expect(el.textContent).toContain("bold");
        // No live HTML elements were created
        expect(el.querySelector("strong")).toBeNull();
    });

    it("renders plaintext content as-is in both modes", () => {
        const content: LSP.MarkupContent = {
            kind: "plaintext",
            value: "1 < 2 && 3 > 2",
        };
        const plain = document.createElement("div");
        renderDocumentation(plain, content, { allowHTMLContent: false });
        expect(plain.textContent).toBe("1 < 2 && 3 > 2");
    });

    it("shows MarkedString values in plaintext mode", () => {
        const el = document.createElement("div");
        renderDocumentation(
            el,
            { language: "python", value: "def foo(): ..." },
            { allowHTMLContent: false },
        );
        expect(el.textContent).toContain("def foo(): ...");
        expect(el.textContent).not.toContain("<code");
    });

    it("uses a custom markdown renderer when provided", () => {
        const el = document.createElement("div");
        renderDocumentation(el, markdownContent, {
            allowHTMLContent: true,
            markdownRenderer: (md) => `<custom>${md}</custom>`,
        });
        expect(el.innerHTML).toContain("<custom>");
    });
});
