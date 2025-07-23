import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import { describe, expect, it, vi } from "vitest";
import type {
    ClientCapabilities,
    WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../plugin";
import { LanguageServerPlugin } from "../plugin";
import type { FeatureOptions } from "../plugin";

class MockTransport extends Transport {
    sendData = vi.fn().mockResolvedValue({});
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    connect = vi.fn().mockResolvedValue({});
    close = vi.fn();
}

const transport = new MockTransport();

class MockLanguageServerPlugin extends LanguageServerPlugin {
    public applyRenameEdit(
        view: EditorView,
        edit: WorkspaceEdit | null,
    ): Promise<boolean> {
        return super.applyRenameEdit(view, edit);
    }
}

const featuresOptions: Required<FeatureOptions> = {
    diagnosticsEnabled: true,
    hoverEnabled: true,
    completionEnabled: true,
    definitionEnabled: true,
    renameEnabled: true,
    codeActionsEnabled: true,
    signatureHelpEnabled: true,
    signatureActivateOnTyping: false,
};
describe("LanguageServerClient initialization options", () => {
    it("uses default capabilities when none provided", async () => {
        const client = new LanguageServerClient({
            transport,
            rootUri: "file:///root",
            workspaceFolders: [{ uri: "file:///root", name: "root" }],
        });

        // biome-ignore lint/suspicious/noExplicitAny: tests
        const initParams = await (client as any).getInitializationOptions();

        // Verify default capabilities are present
        expect(initParams.capabilities.textDocument.hover).toBeDefined();
        expect(
            initParams.capabilities.workspace.didChangeConfiguration,
        ).toBeDefined();
    });

    it("allows overriding capabilities with object", async () => {
        const customCapabilities: ClientCapabilities = {
            textDocument: {
                hover: {
                    dynamicRegistration: false,
                    contentFormat: ["plaintext"],
                },
            },
        };

        const client = new LanguageServerClient({
            transport,
            rootUri: "file:///root",
            workspaceFolders: [{ uri: "file:///root", name: "root" }],
            capabilities: customCapabilities,
        });

        // biome-ignore lint/suspicious/noExplicitAny: tests
        const initParams = await (client as any).getInitializationOptions();

        expect(initParams.capabilities).toEqual(customCapabilities);
    });

    it("allows modifying capabilities with function", async () => {
        const client = new LanguageServerClient({
            transport,
            rootUri: "file:///root",
            workspaceFolders: [{ uri: "file:///root", name: "root" }],
            capabilities: (defaultCaps) => ({
                ...defaultCaps,
                textDocument: {
                    ...defaultCaps.textDocument,
                    hover: {
                        dynamicRegistration: false,
                        contentFormat: ["plaintext"],
                    },
                },
            }),
        });

        // biome-ignore lint/suspicious/noExplicitAny: tests
        const initParams = await (client as any).getInitializationOptions();

        expect(initParams.capabilities.textDocument.hover).toEqual({
            dynamicRegistration: false,
            contentFormat: ["plaintext"],
        });
        // Other capabilities should remain unchanged
        expect(
            initParams.capabilities.workspace.didChangeConfiguration,
        ).toBeDefined();
    });

    it("allows setting custom initializationOptions", async () => {
        const customInitOptions = {
            customSetting: true,
            maxNumberOfProblems: 100,
        };

        const client = new LanguageServerClient({
            transport,
            rootUri: "file:///root",
            workspaceFolders: [{ uri: "file:///root", name: "root" }],
            initializationOptions: customInitOptions,
        });

        // biome-ignore lint/suspicious/noExplicitAny: tests
        const initParams = await (client as any).getInitializationOptions();

        expect(initParams.initializationOptions).toEqual(customInitOptions);
    });
});

it("handles rename preparation and execution", async () => {
    const client = new LanguageServerClient({
        transport,
        rootUri: "file:///root",
        workspaceFolders: [{ uri: "file:///root", name: "root" }],
    });

    // Mock the client's methods for rename
    // biome-ignore lint/suspicious/noExplicitAny: tests
    (client as any).client.request = vi.fn().mockImplementation((request) => {
        if (request.method === "textDocument/prepareRename") {
            return Promise.resolve({
                range: {
                    start: { line: 1, character: 5 },
                    end: { line: 1, character: 12 },
                },
            });
        }
        if (request.method === "textDocument/rename") {
            return Promise.resolve({
                changes: {
                    "file:///root/file.ts": [
                        {
                            range: {
                                start: { line: 1, character: 5 },
                                end: { line: 1, character: 12 },
                            },
                            newText: "newName",
                        },
                        {
                            range: {
                                start: { line: 3, character: 10 },
                                end: { line: 3, character: 17 },
                            },
                            newText: "newName",
                        },
                    ],
                },
            });
        }
        return Promise.resolve({});
    });

    // Set capabilities to include rename support
    client.capabilities = {
        renameProvider: true,
    };
    client.ready = true;

    // Test prepare rename
    const prepareResult = await client.textDocumentPrepareRename({
        textDocument: { uri: "file:///root/file.ts" },
        position: { line: 1, character: 5 },
    });

    expect(prepareResult).toEqual({
        range: {
            start: { line: 1, character: 5 },
            end: { line: 1, character: 12 },
        },
    });

    // Test rename execution
    const renameResult = await client.textDocumentRename({
        textDocument: { uri: "file:///root/file.ts" },
        position: { line: 1, character: 5 },
        newName: "newName",
    });

    expect(renameResult).toEqual({
        changes: {
            "file:///root/file.ts": [
                {
                    range: {
                        start: { line: 1, character: 5 },
                        end: { line: 1, character: 12 },
                    },
                    newText: "newName",
                },
                {
                    range: {
                        start: { line: 3, character: 10 },
                        end: { line: 3, character: 17 },
                    },
                    newText: "newName",
                },
            ],
        },
    });

    // Verify the correct methods were called
    // biome-ignore lint/suspicious/noExplicitAny: tests
    expect((client as any).client.request).toHaveBeenCalledWith(
        {
            method: "textDocument/prepareRename",
            params: {
                textDocument: { uri: "file:///root/file.ts" },
                position: { line: 1, character: 5 },
            },
        },
        10000,
    );

    // biome-ignore lint/suspicious/noExplicitAny: tests
    expect((client as any).client.request).toHaveBeenCalledWith(
        {
            method: "textDocument/rename",
            params: {
                textDocument: { uri: "file:///root/file.ts" },
                position: { line: 1, character: 5 },
                newName: "newName",
            },
        },
        10000,
    );
});

it("applies rename changes correctly to a document", async () => {
    const mockView = new EditorView(
        EditorState.create({
            doc: "function oldName() {\n  return oldName();\n}",
        }),
    );

    const client = new LanguageServerClient({
        transport,
        rootUri: "file:///root",
        workspaceFolders: [{ uri: "file:///root", name: "root" }],
    });

    // Mock the client's methods for rename
    // biome-ignore lint/suspicious/noExplicitAny: tests
    (client as any).client.request = vi
        .fn()
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        .mockImplementation((request: any) => {
            if (request.method === "textDocument/rename") {
                return Promise.resolve<WorkspaceEdit>({
                    documentChanges: [
                        {
                            textDocument: {
                                uri: "file:///root/file.ts",
                                version: 1,
                            },
                            edits: [
                                {
                                    range: {
                                        start: { line: 0, character: 9 },
                                        end: { line: 0, character: 16 },
                                    },
                                    newText: "newName",
                                },
                                {
                                    range: {
                                        start: { line: 1, character: 9 },
                                        end: { line: 1, character: 16 },
                                    },
                                    newText: "newName",
                                },
                            ],
                        },
                    ],
                });
            }
            return Promise.resolve({});
        });

    // Create a mock plugin with access to the rename functionality
    const mockPlugin = new MockLanguageServerPlugin({
        client: client,
        documentUri: "file:///root/file.ts",
        languageId: "typescript",
        view: mockView,
        featureOptions: featuresOptions,
    });

    // Set capabilities to include rename support
    client.capabilities = {
        renameProvider: true,
    };
    client.ready = true;

    // Create a mock rename result
    const renameResult = await client.textDocumentRename({
        textDocument: { uri: "file:///root/file.ts" },
        position: { line: 0, character: 9 },
        newName: "newName",
    });

    const result = await mockPlugin.applyRenameEdit(mockView, renameResult);

    expect(result).toBe(true);
    expect(mockView.state.doc.toString()).toMatchInlineSnapshot(`
          "function newName() {
            return newName();
          }"
        `);
});

it("applies rename the whole cell", async () => {
    const mockView = new EditorView(
        EditorState.create({
            doc: "function oldName() {\n  return oldName();\n}",
        }),
    );

    const client = new LanguageServerClient({
        transport,
        rootUri: "file:///root",
        workspaceFolders: [{ uri: "file:///root", name: "root" }],
    });

    // Mock the client's methods for rename
    // biome-ignore lint/suspicious/noExplicitAny: tests
    (client as any).client.request = vi.fn().mockImplementation((request) => {
        if (request.method === "textDocument/rename") {
            return Promise.resolve<WorkspaceEdit>({
                documentChanges: [
                    {
                        textDocument: {
                            uri: "file:///root/file.ts",
                            version: 1,
                        },
                        edits: [
                            {
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 3, character: 0 },
                                },
                                newText:
                                    "function newName() {\n  return newName();\n}",
                            },
                        ],
                    },
                ],
            });
        }
        return Promise.resolve({});
    });

    // Create a mock plugin with access to the rename functionality
    const mockPlugin = new MockLanguageServerPlugin({
        client,
        documentUri: "file:///root/file.ts",
        languageId: "typescript",
        view: mockView,
        featureOptions: featuresOptions,
    });

    // Set capabilities to include rename support
    client.capabilities = {
        renameProvider: true,
    };
    client.ready = true;

    // Create a mock rename result
    const renameResult = await client.textDocumentRename({
        textDocument: { uri: "file:///root/file.ts" },
        position: { line: 0, character: 9 },
        newName: "newName",
    });

    const result = await mockPlugin.applyRenameEdit(mockView, renameResult);

    expect(result).toBe(true);
    expect(mockView.state.doc.toString()).toMatchInlineSnapshot(`
          "function newName() {
            return newName();
          }"
        `);
});

it("handles prepareRenameFallback", async () => {
    const mockView = new EditorView(
        EditorState.create({
            doc: "function oldName() {\n  return oldName();\n}",
        }),
    );

    const client = new LanguageServerClient({
        transport,
        rootUri: "file:///root",
        workspaceFolders: [{ uri: "file:///root", name: "root" }],
    });

    const plugin = new MockLanguageServerPlugin({
        client,
        documentUri: "file:///root/file.ts",
        languageId: "typescript",
        view: mockView,
        featureOptions: featuresOptions,
    });

    const prepare = (opts: { line: number; character: number }) => {
        // biome-ignore lint/suspicious/noExplicitAny: private method
        return (plugin as any).prepareRenameFallback(mockView, opts);
    };

    // Start of word
    expect(prepare({ line: 0, character: 0 })).toMatchInlineSnapshot(`
      {
        "placeholder": "function",
        "range": {
          "end": {
            "character": 8,
            "line": 0,
          },
          "start": {
            "character": 0,
            "line": 0,
          },
        },
      }
    `);

    // Middle of word
    expect(prepare({ line: 0, character: 3 })).toMatchInlineSnapshot(`
      {
        "placeholder": "function",
        "range": {
          "end": {
            "character": 8,
            "line": 0,
          },
          "start": {
            "character": 0,
            "line": 0,
          },
        },
      }
    `);

    // End of word
    expect(prepare({ line: 0, character: 8 })).toMatchInlineSnapshot(`
      {
        "placeholder": "function",
        "range": {
          "end": {
            "character": 8,
            "line": 0,
          },
          "start": {
            "character": 0,
            "line": 0,
          },
        },
      }
    `);

    // After word
    expect(prepare({ line: 0, character: 9 })).toMatchInlineSnapshot(`
      {
        "placeholder": "oldName",
        "range": {
          "end": {
            "character": 16,
            "line": 0,
          },
          "start": {
            "character": 9,
            "line": 0,
          },
        },
      }
    `);

    // In parentheses
    expect(
        prepare({ line: 0, character: "function oldName(".length }),
    ).toBeNull();
});
