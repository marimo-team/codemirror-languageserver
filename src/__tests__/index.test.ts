import { Text } from "@codemirror/state";
import { WebSocketTransport } from "@open-rpc/client-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageServerClient, languageServer } from "../index";
import { offsetToPos, posToOffset } from "../utils";

// Mock WebSocket transport
vi.mock("@open-rpc/client-js", () => ({
    WebSocketTransport: vi.fn(),
    Client: vi.fn(() => ({
        request: vi.fn().mockResolvedValue({}),
        notify: vi.fn(),
        onNotification: vi.fn(),
        close: vi.fn(),
    })),
    RequestManager: vi.fn(),
}));

describe("LanguageServer", () => {
    describe("Utility Functions", () => {
        let doc: Text;

        beforeEach(() => {
            // Create a sample document with known content
            doc = Text.of(["first line", "second line", "third line"]);
        });

        it("should convert position to offset correctly", async () => {
            // Test valid positions
            expect(posToOffset(doc, { line: 0, character: 0 })).toBe(0);
            expect(posToOffset(doc, { line: 0, character: 5 })).toBe(5);
            expect(posToOffset(doc, { line: 1, character: 0 })).toBe(11);

            // Test invalid positions
            expect(posToOffset(doc, { line: 5, character: 0 })).toBeUndefined();
            expect(
                posToOffset(doc, { line: 0, character: 50 }),
            ).toBeUndefined();
        });

        it("should convert offset to position correctly", async () => {
            // Test various offsets
            expect(offsetToPos(doc, 0)).toEqual({ line: 0, character: 0 });
            expect(offsetToPos(doc, 5)).toEqual({ line: 0, character: 5 });
            expect(offsetToPos(doc, 11)).toEqual({ line: 1, character: 0 });
        });
    });

    describe("LanguageServerClient", () => {
        let client: LanguageServerClient;
        const mockTransport = new WebSocketTransport("ws://test");

        beforeEach(() => {
            client = new LanguageServerClient({
                transport: mockTransport,
                rootUri: "file:///test",
                workspaceFolders: [{ uri: "file:///test", name: "test" }],
                documentUri: "file:///test/file.ts",
                languageId: "typescript",
            });
        });

        it("should initialize with correct capabilities", async () => {
            const initResult = {
                capabilities: {
                    textDocumentSync: 1,
                    completionProvider: {
                        triggerCharacters: ["."],
                        resolveProvider: true,
                    },
                    hoverProvider: true,
                },
            };

            // biome-ignore lint/suspicious/noExplicitAny: <explanation>
            (client as any).client.request.mockResolvedValueOnce(initResult);

            await client.initialize();

            expect(client.capabilities).toEqual(initResult.capabilities);
            expect(client.ready).toBe(true);
        });

        it("should handle completion item resolution", async () => {
            await client.initialize();

            const mockCompletionItem = {
                label: "test",
                kind: 1,
                data: 1,
            };

            const resolvedItem = {
                ...mockCompletionItem,
                documentation: {
                    kind: "markdown",
                    value: "Test documentation",
                },
            };

            // biome-ignore lint/suspicious/noExplicitAny: <explanation>
            (client as any).client.request.mockResolvedValueOnce(resolvedItem);

            const result =
                await client.completionItemResolve(mockCompletionItem);

            // biome-ignore lint/suspicious/noExplicitAny: <explanation>
            expect((client as any).client.request).toHaveBeenCalledWith(
                {
                    method: "completionItem/resolve",
                    params: mockCompletionItem,
                },
                10000,
            );
            expect(result).toEqual(resolvedItem);
        });

        it("should handle text document changes", async () => {
            await client.initialize();

            const params = {
                textDocument: {
                    uri: "file:///test/file.ts",
                    version: 1,
                },
                contentChanges: [{ text: "new content" }],
            };

            await client.textDocumentDidChange(params);

            // biome-ignore lint/suspicious/noExplicitAny: <explanation>
            expect((client as any).client.notify).toHaveBeenCalledWith({
                method: "textDocument/didChange",
                params,
            });
        });
    });

    describe("languageServer integration", () => {
        it("should create extension array with correct components", () => {
            const extensions = languageServer({
                serverUri: "ws://test",
                rootUri: "file:///test",
                workspaceFolders: [{ uri: "file:///test", name: "test" }],
                documentUri: "file:///test/file.ts",
                languageId: "typescript",
            });

            expect(Array.isArray(extensions)).toBe(true);
            expect(extensions.length).toBeGreaterThan(0);
        });
    });
});

describe("exports", () => {
    it("should maintain stable exports", async () => {
        const exports = await import("../index");
        expect(Object.keys(exports).sort()).toMatchInlineSnapshot(`
          [
            "LanguageServerClient",
            "languageServer",
            "languageServerWithTransport",
          ]
        `);
    });
});
