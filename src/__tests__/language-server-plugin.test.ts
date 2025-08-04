import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionTriggerKind } from "vscode-languageserver-protocol";
import { type FeatureOptions, LanguageServerClient } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

// Note: jsdom environment provides document

// Mock utils functions
vi.mock("../utils.js", () => ({
    posToOffset: vi.fn().mockImplementation((_doc, pos) => {
        // Simple mock that returns character position for single line documents
        if (pos.line === 0) {
            return pos.character;
        }
        return null;
    }),
    posToOffsetOrZero: vi.fn().mockImplementation((_doc, pos) => {
        // Simple mock that returns character position for single line documents
        if (pos.line === 0) {
            return pos.character;
        }
        return 0;
    }),
    prefixMatch: vi.fn().mockReturnValue(undefined),
    formatContents: vi.fn().mockImplementation((contents) => {
        if (typeof contents === "string") return contents;
        if (typeof contents === "object" && contents.value)
            return contents.value;
        return String(contents);
    }),
    isEmptyDocumentation: vi.fn().mockImplementation((_contents) => {
        return false;
    }),
    offsetToPos: vi.fn().mockImplementation((_doc, offset) => {
        return { line: 0, character: offset };
    }),
    eventsFromChangeSet: vi.fn().mockReturnValue([]),
    renderMarkdown: vi.fn().mockReturnValue(""),
    showErrorMessage: vi.fn(),
}));

// Mock the Client from @open-rpc/client-js
vi.mock("@open-rpc/client-js", () => ({
    Client: vi.fn().mockImplementation(() => ({
        request: vi.fn().mockResolvedValue({}),
        notify: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        onNotification: vi.fn(),
        onRequest: vi.fn(),
    })),
    RequestManager: vi.fn().mockImplementation(() => ({
        requestTimeoutMs: 10000,
    })),
}));

// Create a simple mock transport
class MockTransport extends Transport {
    sendData = vi.fn().mockResolvedValue({});
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    connect = vi.fn().mockResolvedValue({});
    close = vi.fn();

    emit = vi.fn();
    addListener = vi.fn();
    on = vi.fn();
    once = vi.fn();
    removeListener = vi.fn();
    off = vi.fn();
    removeAllListeners = vi.fn();
    setMaxListeners = vi.fn();
    getMaxListeners = vi.fn();
    listeners = vi.fn();
    rawListeners = vi.fn();
    listenerCount = vi.fn();
    prependListener = vi.fn();
    prependOnceListener = vi.fn();
    eventNames = vi.fn();
}

describe("LanguageServerPlugin", () => {
    let mockClient: LanguageServerClient;
    let mockTransport: MockTransport;
    let mockView: EditorView;
    let featureOptions: Required<FeatureOptions>;

    beforeEach(() => {
        mockTransport = new MockTransport();

        // Create a mock client
        mockClient = new LanguageServerClient({
            rootUri: "file:///test",
            workspaceFolders: null,
            transport: mockTransport,
        });

        // Mock client methods
        mockClient.ready = true;
        mockClient.capabilities = {
            hoverProvider: true,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ["."],
            },
            definitionProvider: true,
            renameProvider: true,
            codeActionProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ["(", ","],
            },
        };

        mockClient.initializePromise = Promise.resolve();
        mockClient.textDocumentDidOpen = vi.fn().mockResolvedValue(undefined);
        mockClient.textDocumentDidChange = vi.fn().mockResolvedValue(undefined);
        mockClient.textDocumentHover = vi.fn();
        mockClient.textDocumentCompletion = vi.fn();
        mockClient.textDocumentDefinition = vi.fn();
        mockClient.completionItemResolve = vi.fn();
        mockClient.onNotification = vi.fn().mockReturnValue(() => {});

        // Create a mock view
        mockView = new EditorView({
            state: EditorState.create({
                doc: "console.log('test');",
            }),
        });

        // Default feature options
        featureOptions = {
            diagnosticsEnabled: true,
            hoverEnabled: true,
            completionEnabled: true,
            definitionEnabled: true,
            renameEnabled: true,
            codeActionsEnabled: true,
            signatureHelpEnabled: true,
            signatureActivateOnTyping: false,
        };
    });

    describe("constructor", () => {
        it("should initialize with default values", async () => {
            const plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            expect(plugin.client).toBe(mockClient);
            expect(plugin.documentUri).toBe("file:///test.ts");
            expect(plugin.languageId).toBe("typescript");
            expect(plugin.view).toBe(mockView);
            expect(plugin.allowHTMLContent).toBe(false);
            expect(plugin.useSnippetOnCompletion).toBe(false);
            expect(plugin.sendIncrementalChanges).toBe(true);
            expect(plugin.featureOptions).toBe(featureOptions);
            expect(plugin.onGoToDefinition).toBeUndefined();
            expect(mockClient.onNotification).toHaveBeenCalled();

            // Wait for async initialization
            await plugin.initialize({
                documentText: mockView.state.doc.toString(),
            });
            expect(mockClient.textDocumentDidOpen).toHaveBeenCalled();
        });

        it("should initialize with custom options", () => {
            const onGoToDefinition = vi.fn();

            const plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.py",
                languageId: "python",
                view: mockView,
                featureOptions,
                sendIncrementalChanges: false,
                allowHTMLContent: true,
                useSnippetOnCompletion: false,
                onGoToDefinition,
            });

            expect(plugin.documentUri).toBe("file:///test.py");
            expect(plugin.languageId).toBe("python");
            expect(plugin.allowHTMLContent).toBe(true);
            expect(plugin.useSnippetOnCompletion).toBe(false);
            expect(plugin.sendIncrementalChanges).toBe(false);
            expect(plugin.onGoToDefinition).toBe(onGoToDefinition);
        });

        it("should initialize with useSnippetOnCompletion option", () => {
            const plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.js",
                languageId: "javascript",
                view: mockView,
                featureOptions,
                sendIncrementalChanges: true,
                allowHTMLContent: false,
                useSnippetOnCompletion: true,
            });

            expect(plugin.useSnippetOnCompletion).toBe(true);
            expect(plugin.allowHTMLContent).toBe(false);
        });
    });

    describe("update", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            // Reset mocks after initialization
            vi.clearAllMocks();
        });

        it("should handle document changes with incremental updates", () => {
            const mockChanges = {
                length: 1,
                iterChanges: vi.fn((callback) => {
                    callback(0, 5, 0, 5, { toString: () => "hello" });
                }),
            };

            plugin.update({
                state: EditorState.create({ doc: "hello world" }),
                docChanged: true,
                startState: EditorState.create({ doc: mockView.state.doc }),
                changes: mockChanges as unknown as ViewUpdate["changes"],
            } as ViewUpdate);

            expect(mockClient.textDocumentDidChange).toHaveBeenCalled();
        });

        it("should handle document changes with full text updates", () => {
            plugin.sendIncrementalChanges = false;

            const newState = EditorState.create({ doc: "hello world" });

            plugin.update({
                state: newState,
                docChanged: true,
                startState: EditorState.create({ doc: mockView.state.doc }),
                changes: {} as unknown as ViewUpdate["changes"],
            } as ViewUpdate);

            expect(mockClient.textDocumentDidChange).toHaveBeenCalledWith({
                textDocument: {
                    uri: "file:///test.ts",
                    version: 1,
                },
                contentChanges: [{ text: "hello world" }],
            });
        });

        it("should not send changes when document unchanged", () => {
            plugin.update({
                state: mockView.state,
                docChanged: false,
                startState: EditorState.create({ doc: mockView.state.doc }),
                changes: {} as unknown as ViewUpdate["changes"],
            } as ViewUpdate);

            expect(mockClient.textDocumentDidChange).not.toHaveBeenCalled();
        });
    });

    describe("sendChanges", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should send changes when client is ready", async () => {
            const changes: LSP.TextDocumentContentChangeEvent[] = [
                { text: "new content" },
            ];

            await plugin.sendChanges(changes);

            expect(mockClient.textDocumentDidChange).toHaveBeenCalledWith({
                textDocument: {
                    uri: "file:///test.ts",
                    version: 1,
                },
                contentChanges: changes,
            });
        });

        it("should not send changes when client is not ready", async () => {
            mockClient.ready = false;

            const changes: LSP.TextDocumentContentChangeEvent[] = [
                { text: "new content" },
            ];

            await plugin.sendChanges(changes);

            expect(mockClient.textDocumentDidChange).not.toHaveBeenCalled();
        });

        it("should handle errors gracefully", async () => {
            mockClient.textDocumentDidChange = vi
                .fn()
                .mockRejectedValue(new Error("Network error"));

            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            const changes: LSP.TextDocumentContentChangeEvent[] = [
                { text: "new content" },
            ];

            await plugin.sendChanges(changes);

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("requestDiagnostics", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should request diagnostics", () => {
            const sendChangesSpy = vi.spyOn(plugin, "sendChanges");

            plugin.requestDiagnostics(mockView);

            expect(sendChangesSpy).toHaveBeenCalledWith([
                { text: mockView.state.doc.toString() },
            ]);
        });
    });

    describe("requestHoverTooltip", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should return null when hover is disabled", async () => {
            plugin.featureOptions.hoverEnabled = false;

            const result = await plugin.requestHoverTooltip(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeNull();
        });

        it("should return null when client is not ready", async () => {
            mockClient.ready = false;

            const result = await plugin.requestHoverTooltip(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeNull();
        });

        it("should return null when hover provider is not available", async () => {
            mockClient.capabilities = {};

            const result = await plugin.requestHoverTooltip(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeNull();
        });

        it("should return null when hover result is empty", async () => {
            mockClient.textDocumentHover = vi.fn().mockResolvedValue(null);

            const result = await plugin.requestHoverTooltip(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeNull();
        });
    });

    describe("requestCompletion", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should return null when completion is disabled", async () => {
            plugin.featureOptions.completionEnabled = false;

            const result = await plugin.requestCompletion(
                {} as any,
                { line: 0, character: 0 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            );

            expect(result).toBeNull();
        });

        it("should return null when client is not ready", async () => {
            mockClient.ready = false;

            const result = await plugin.requestCompletion(
                {} as any,
                { line: 0, character: 0 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            );

            expect(result).toBeNull();
        });

        it("should return null when completion provider is not available", async () => {
            mockClient.capabilities = {};

            const result = await plugin.requestCompletion(
                {} as any,
                { line: 0, character: 0 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            );

            expect(result).toBeNull();
        });

        it("should return null when no completion results", async () => {
            mockClient.textDocumentCompletion = vi.fn().mockResolvedValue(null);

            const result = await plugin.requestCompletion(
                {} as any,
                { line: 0, character: 0 },
                {
                    triggerKind: CompletionTriggerKind.Invoked,
                    triggerCharacter: undefined,
                },
            );

            expect(result).toBeNull();
        });
    });

    describe("requestDefinition", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should return early when definition is disabled", async () => {
            plugin.featureOptions.definitionEnabled = false;

            const result = await plugin.requestDefinition(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeUndefined();
        });

        it("should return early when client is not ready", async () => {
            mockClient.ready = false;

            const result = await plugin.requestDefinition(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeUndefined();
        });

        it("should return early when definition provider is not available", async () => {
            mockClient.capabilities = {};

            const result = await plugin.requestDefinition(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeUndefined();
        });

        it("should return early when no definition results", async () => {
            mockClient.textDocumentDefinition = vi.fn().mockResolvedValue(null);

            const result = await plugin.requestDefinition(mockView, {
                line: 0,
                character: 0,
            });

            expect(result).toBeUndefined();
        });
    });

    describe("processNotification", () => {
        let plugin: LanguageServerPlugin;

        beforeEach(() => {
            plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });

            vi.clearAllMocks();
        });

        it("should process diagnostics notification", () => {
            const processDiagnosticsSpy = vi.spyOn(
                plugin as any,
                "processDiagnostics",
            );

            const notification = {
                jsonrpc: "2.0" as const,
                method: "textDocument/publishDiagnostics" as const,
                params: {
                    uri: "file:///test.ts",
                    diagnostics: [],
                },
            };

            plugin.processNotification(notification);

            expect(processDiagnosticsSpy).toHaveBeenCalledWith(
                notification.params,
            );
        });

        it("should handle unknown notification methods", () => {
            const notification = {
                jsonrpc: "2.0" as const,
                method: "unknown/method" as any,
                params: {},
            };

            // Should not throw
            expect(() =>
                // @ts-expect-error
                plugin.processNotification(notification),
            ).not.toThrow();
        });

        it("should handle errors gracefully", () => {
            // Mock processDiagnostics to throw an error
            vi.spyOn(plugin as any, "processDiagnostics").mockImplementation(
                () => {
                    throw new Error("Test error");
                },
            );

            const notification = {
                jsonrpc: "2.0" as const,
                method: "textDocument/publishDiagnostics" as const,
                params: {
                    uri: "file:///test.ts",
                    diagnostics: [],
                },
            };

            // Should not throw, error should be caught and logged
            expect(() =>
                plugin.processNotification(notification),
            ).not.toThrow();
        });
    });

    describe("markdownRenderer", () => {
        it("should render markdown using custom renderer", () => {
            const plugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
                markdownRenderer: (markdown) => `<div>${markdown}</div>`,
            });
            const markdown = "This is **bold** text";
            const rendered = plugin.markdownRenderer(markdown);
            expect(rendered).toBe("<div>This is **bold** text</div>");
        });

        it("should use default renderer if none provided", () => {
            const defaultPlugin = new LanguageServerPlugin({
                client: mockClient,
                documentUri: "file:///test.ts",
                languageId: "typescript",
                view: mockView,
                featureOptions,
            });
            const markdown = "This is **bold** text";
            const rendered = defaultPlugin.markdownRenderer(markdown);
            expect(rendered).toBe("");
        });
    });
});
