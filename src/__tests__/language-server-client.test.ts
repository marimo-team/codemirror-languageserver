import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageServerPlugin } from "../plugin.js";

import type * as LSP from "vscode-languageserver-protocol";
import type { JSONRPCClient } from "../jsonrpc.js";
import {
    LanguageServerClient,
    type LanguageServerClientOptions,
} from "../lsp.js";
import { FakeTransport } from "../testing/fakeTransport.js";

describe("LanguageServerClient", () => {
    let mockTransport: FakeTransport;

    beforeEach(() => {
        mockTransport = new FakeTransport();
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
        it("should process notifications to all listeners", () => {
            const options = {
                rootUri: "file:///test",
                workspaceFolders: null,
                transport: mockTransport,
            };

            const client = new LanguageServerClient(options);

            const test = vi.fn();
            const test2 = vi.fn();

            const dispose = client.onNotification(test);
            const dispose2 = client.onNotification(test2);

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

            expect(test).toHaveBeenCalledWith(notification);
            expect(test2).toHaveBeenCalledWith(notification);
            expect(test).toHaveBeenCalledTimes(1);
            expect(test2).toHaveBeenCalledTimes(1);

            // Clean up
            dispose();
            dispose2();

            // @ts-expect-error: Accessing private method for test purposes
            client.processNotification(notification);
            // Disposed listeners should not have been called again
            expect(test).toHaveBeenCalledTimes(1);
            expect(test2).toHaveBeenCalledTimes(1);
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
            } as unknown as JSONRPCClient;
            // @ts-expect-error: Accessing private method for test purposes
            client.client = mockInternalClient;

            client.close();

            expect(mockInternalClient.close).toHaveBeenCalled();
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
                dynamicRegistration: false,
                willSave: true,
                didSave: true,
                willSaveWaitUntil: true,
            });

            expect(caps.textDocument.completion).toEqual({
                dynamicRegistration: false,
                completionItem: {
                    snippetSupport: true,
                    commitCharactersSupport: true,
                    documentationFormat: ["markdown", "plaintext"],
                    deprecatedSupport: true,
                    preselectSupport: false,
                    insertReplaceSupport: true,
                    tagSupport: {
                        valueSet: [1],
                    },
                    resolveSupport: {
                        properties: [
                            "documentation",
                            "detail",
                            "additionalTextEdits",
                        ],
                    },
                },
                completionList: {
                    itemDefaults: [
                        "commitCharacters",
                        "editRange",
                        "insertTextFormat",
                        "insertTextMode",
                        "data",
                    ],
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
                dynamicRegistration: false,
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
                dynamicRegistration: false,
            });
        });
    });
});
