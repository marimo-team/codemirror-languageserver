import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    LanguageServerClient,
    type LanguageServerClientOptions,
    type LanguageServerPlugin,
} from "../plugin.js";
import { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type * as LSP from "vscode-languageserver-protocol";
import type Client from "@open-rpc/client-js";

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
    parseData = vi.fn();
}

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

describe("LanguageServerClient", () => {
    let mockTransport: MockTransport;

    beforeEach(() => {
        mockTransport = new MockTransport();
    });

    describe("constructor", () => {
        it("should initialize with default values", () => {
            const options: LanguageServerClientOptions = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport as unknown as Transport,
            };

            const client = new LanguageServerClient(options);

            expect(client.ready).toBe(false);
            expect(client.capabilities).toBe(null);
            expect(client.initializePromise).toBeDefined();
        });

        it("should initialize with custom timeout", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
                timeout: 5000,
            };

            const client = new LanguageServerClient(options);

            expect(client).toBeDefined();
            expect(client.ready).toBe(false);
        });

        it("should initialize with workspace folders", () => {
            const workspaceFolders: LSP.WorkspaceFolder[] = [
                {
                    uri: "file:///workspace1",
                    name: "workspace1",
                },
                {
                    uri: "file:///workspace2",
                    name: "workspace2",
                },
            ];

            const options = {
                rootUri: "file:///test",
                workspaceFolders,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);

            expect(client).toBeDefined();
            expect(client.ready).toBe(false);
        });
    });

    describe("getInitializationOptions", () => {
        it("should return default capabilities when none provided", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);

            // @ts-expect-error: Accessing private method for test purposes
            const initOptions = client.getInitializationOptions();

            expect(initOptions.rootUri).toBe("file:///test");
            expect(initOptions.workspaceFolders).toBe(null);
            expect(initOptions.processId).toBe(null);
            expect(initOptions.capabilities).toBeDefined();
            expect(initOptions.capabilities.textDocument).toBeDefined();
            expect(initOptions.capabilities.textDocument.hover).toBeDefined();
            expect(
                initOptions.capabilities.textDocument.completion,
            ).toBeDefined();
            expect(initOptions.capabilities.workspace).toBeDefined();
        });

        it("should use custom capabilities when provided as object", () => {
            const customCapabilities: LSP.ClientCapabilities = {
                textDocument: {
                    hover: {
                        dynamicRegistration: false,
                        contentFormat: ["plaintext"],
                    },
                },
            };

            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
                capabilities: customCapabilities,
            };

            const client = new LanguageServerClient(options);

            // @ts-expect-error: Accessing private method for test purposes
            const initOptions = client.getInitializationOptions();

            expect(initOptions.capabilities).toBe(customCapabilities);
        });

        it("should use custom capabilities when provided as function", () => {
            const capabilitiesFunction: LanguageServerClientOptions["capabilities"] =
                (defaultCaps: LSP.ClientCapabilities) => ({
                    ...defaultCaps,
                    textDocument: {
                        ...defaultCaps.textDocument,
                        hover: {
                            dynamicRegistration: false,
                            contentFormat: ["plaintext"],
                        },
                    },
                });

            const options: LanguageServerClientOptions = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
                capabilities: capabilitiesFunction,
            };

            const client = new LanguageServerClient(options);

            // @ts-expect-error: Accessing private method for test purposes
            const initOptions = client.getInitializationOptions();

            expect(initOptions.capabilities.textDocument.hover).toEqual({
                dynamicRegistration: false,
                contentFormat: ["plaintext"],
            });
            // Should preserve other default capabilities
            expect(
                initOptions.capabilities.textDocument.completion,
            ).toBeDefined();
            expect(initOptions.capabilities.workspace).toBeDefined();
        });

        it("should include custom initialization options", () => {
            const customInitOptions = {
                customSetting: true,
                maxNumberOfProblems: 100,
            };

            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
                initializationOptions: customInitOptions,
            };

            const client = new LanguageServerClient(options);

            // @ts-expect-error: Accessing private method for test purposes
            const initOptions = client.getInitializationOptions();

            expect(initOptions.initializationOptions).toBe(customInitOptions);
        });
    });

    describe("plugin management", () => {
        it("should attach and detach plugins", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);
            const mockPlugin = {
                processNotification: vi.fn(),
            } as unknown as LanguageServerPlugin;

            // Attach plugin
            client.attachPlugin(mockPlugin);

            // Verify plugin was added by checking internal plugins array
            // @ts-expect-error: Accessing private method for test purposes
            expect(client.plugins).toContain(mockPlugin);

            // Detach plugin
            client.detachPlugin(mockPlugin);

            // Verify plugin was removed
            // @ts-expect-error: Accessing private method for test purposes
            expect(client.plugins).not.toContain(mockPlugin);
        });

        it("should handle detaching non-existent plugin", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);
            const nonExistentPlugin = {
                processNotification: vi.fn(),
            } as unknown as LanguageServerPlugin;

            // Should not throw
            expect(() => client.detachPlugin(nonExistentPlugin)).not.toThrow();
        });

        it("should process notifications to all attached plugins", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);
            const mockPlugin1 = {
                notify: vi.fn(),
                processNotification: vi.fn(),
            } as unknown as LanguageServerPlugin;
            const mockPlugin2 = {
                notify: vi.fn(),
                processNotification: vi.fn(),
            } as unknown as LanguageServerPlugin;

            client.attachPlugin(mockPlugin1);
            client.attachPlugin(mockPlugin2);

            const notification = {
                jsonrpc: "2.0" as const,
                method: "textDocument/publishDiagnostics" as const,
                params: {
                    uri: "file:///test.ts",
                    diagnostics: [],
                },
            };

            // Call protected method
            // @ts-expect-error: Accessing private method for test purposes
            client.processNotification(notification);

            expect(mockPlugin1.processNotification).toHaveBeenCalledWith(
                notification,
            );
            expect(mockPlugin2.processNotification).toHaveBeenCalledWith(
                notification,
            );
        });
    });

    describe("client lifecycle", () => {
        it("should close client", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);

            // Mock the internal client
            const mockInternalClient = {
                close: vi.fn(),
                notify: vi.fn(),
            } as unknown as Client;
            // @ts-expect-error: Accessing private method for test purposes
            client.client = mockInternalClient;

            client.close();

            expect(mockInternalClient.close).toHaveBeenCalled();
        });

        it("should auto-close when detaching plugin if autoClose is true", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
                autoClose: true,
            };

            const client = new LanguageServerClient(options);

            // Mock the internal client
            const mockInternalRPCClient = {
                close: vi.fn(),
                notify: vi.fn(),
            } as unknown as Client;
            // @ts-expect-error: Accessing private method for test purposes
            client.client = mockInternalRPCClient;

            const mockPlugin = {
                notify: vi.fn(),
                processNotification: vi.fn(),
            } as unknown as LanguageServerPlugin;

            client.attachPlugin(mockPlugin);
            client.detachPlugin(mockPlugin);

            expect(mockInternalRPCClient.close).toHaveBeenCalled();
        });
    });

    describe("default capabilities", () => {
        it("should have comprehensive default capabilities", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);
            // @ts-expect-error: Accessing private method for test purposes
            const initOptions = client.getInitializationOptions();
            const caps = initOptions.capabilities;

            // Test text document capabilities
            expect(caps.textDocument.hover).toEqual({
                dynamicRegistration: true,
                contentFormat: ["markdown", "plaintext"],
            });

            expect(caps.textDocument.synchronization).toEqual({
                dynamicRegistration: true,
                willSave: false,
                didSave: false,
                willSaveWaitUntil: false,
            });

            expect(caps.textDocument.completion).toEqual({
                dynamicRegistration: true,
                completionItem: {
                    snippetSupport: true,
                    commitCharactersSupport: true,
                    documentationFormat: ["markdown", "plaintext"],
                    deprecatedSupport: false,
                    preselectSupport: false,
                },
                contextSupport: false,
            });

            expect(caps.textDocument.codeAction).toEqual({
                dynamicRegistration: true,
                codeActionLiteralSupport: {
                    codeActionKind: {
                        valueSet: [
                            "",
                            "quickfix",
                            "refactor",
                            "refactor.extract",
                            "refactor.inline",
                            "refactor.rewrite",
                            "source",
                            "source.organizeImports",
                        ],
                    },
                },
                resolveSupport: {
                    properties: ["edit"],
                },
            });

            expect(caps.textDocument.signatureHelp).toEqual({
                dynamicRegistration: true,
                signatureInformation: {
                    documentationFormat: ["markdown", "plaintext"],
                },
            });

            expect(caps.textDocument.definition).toEqual({
                dynamicRegistration: true,
                linkSupport: true,
            });

            expect(caps.textDocument.rename).toEqual({
                dynamicRegistration: true,
                prepareSupport: true,
            });

            // Test workspace capabilities
            expect(caps.workspace.didChangeConfiguration).toEqual({
                dynamicRegistration: true,
            });
        });
    });
});
