import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageServerClient } from "../lsp.js";
import type { FeatureOptions } from "../lsp.js";
import {
    LanguageServerPlugin,
    signatureHelpTooltipField,
    setSignatureHelpTooltip,
} from "../plugin.js";

// Mock utils functions
vi.mock("../utils.js", () => ({
    posToOffset: vi.fn().mockImplementation((_doc, pos) => {
        if (pos.line === 0) return pos.character;
        return null;
    }),
    posToOffsetOrZero: vi.fn().mockImplementation((_doc, pos) => {
        if (pos.line === 0) return pos.character;
        return 0;
    }),
    prefixMatch: vi.fn().mockReturnValue(undefined),
    formatContents: vi.fn().mockImplementation((contents) => {
        if (typeof contents === "string") return contents;
        if (typeof contents === "object" && contents.value) return contents.value;
        return String(contents);
    }),
    isEmptyDocumentation: vi.fn().mockReturnValue(false),
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

const createMockClient = (): LanguageServerClient => {
    const mockClient = {
        ready: true,
        capabilities: {
            hoverProvider: true,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ["."],
            },
            definitionProvider: true,
            renameProvider: true,
            codeActionsProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ["(", ","],
            },
        },
        clientCapabilities: {},
        initializePromise: Promise.resolve(),
        initialize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        onNotification: vi.fn().mockReturnValue(() => {}),
        textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
        textDocumentDidChange: vi.fn().mockResolvedValue(undefined),
        textDocumentHover: vi.fn().mockResolvedValue(null),
        textDocumentCompletion: vi.fn().mockResolvedValue(null),
        textDocumentDefinition: vi.fn().mockResolvedValue(null),
        textDocumentCodeAction: vi.fn().mockResolvedValue(null),
        textDocumentRename: vi.fn().mockResolvedValue(null),
        textDocumentPrepareRename: vi.fn().mockResolvedValue(null),
        completionItemResolve: vi.fn().mockResolvedValue(null),
        textDocumentSignatureHelp: vi.fn().mockResolvedValue({
            signatures: [
                {
                    label: "DataFrame(data, columns, index)",
                    documentation: "Create a new DataFrame",
                    parameters: [
                        { label: "data", documentation: "The data" },
                        { label: "columns", documentation: "Column names" },
                        { label: "index", documentation: "Row labels" },
                    ],
                },
            ],
            activeSignature: 0,
            activeParameter: 0,
        }),
    };
    return mockClient as unknown as LanguageServerClient;
};

describe("Signature Help Tooltip Dismissal", () => {
    let mockClient: LanguageServerClient;
    let mockView: EditorView;
    let plugin: LanguageServerPlugin;
    let featureOptions: Required<FeatureOptions>;

    beforeEach(() => {
        // Clear any existing tooltips
        document.body.innerHTML = "";

        mockClient = createMockClient();

        // Create a mock view with the signatureHelpTooltipField extension
        const container = document.createElement("div");
        document.body.appendChild(container);

        mockView = new EditorView({
            state: EditorState.create({
                doc: "pl.DataFrame(data=[1,2,3], )",
                extensions: [signatureHelpTooltipField],
            }),
            parent: container,
        });

        // Mock coordsAtPos to return valid coordinates (jsdom doesn't do layout)
        vi.spyOn(mockView, "coordsAtPos").mockReturnValue({
            left: 100,
            right: 200,
            top: 50,
            bottom: 70,
        });

        featureOptions = {
            diagnosticsEnabled: true,
            hoverEnabled: true,
            completionEnabled: true,
            definitionEnabled: true,
            renameEnabled: true,
            codeActionsEnabled: true,
            signatureHelpEnabled: true,
            signatureActivateOnTyping: true,
        };

        plugin = new LanguageServerPlugin({
            client: mockClient,
            documentUri: "file:///test.py",
            languageId: "python",
            view: mockView,
            featureOptions,
        });
    });

    afterEach(() => {
        mockView.destroy();
        document.body.innerHTML = "";
        vi.clearAllMocks();
    });

    const getTooltipFromState = () =>
        mockView.state.field(signatureHelpTooltipField);

    const dispatchDismiss = () => {
        mockView.dispatch({
            effects: setSignatureHelpTooltip.of(null),
        });
    };

    describe("tooltip state management", () => {
        it("should show tooltip via showSignatureHelpTooltip", async () => {
            // Initially no tooltip
            expect(getTooltipFromState()).toBeNull();

            // Show the tooltip
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");

            // Tooltip should now be in state
            expect(getTooltipFromState()).not.toBeNull();
        });

        it("should hide tooltip via hideSignatureHelpTooltip", async () => {
            // Show the tooltip
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");
            expect(getTooltipFromState()).not.toBeNull();

            // Hide the tooltip
            plugin.hideSignatureHelpTooltip(mockView);

            // Tooltip should be gone
            expect(getTooltipFromState()).toBeNull();
        });

        it("should replace tooltip when called multiple times", async () => {
            // Show first tooltip
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");
            const firstTooltip = getTooltipFromState();
            expect(firstTooltip).not.toBeNull();

            // Show second tooltip
            await plugin.showSignatureHelpTooltip(mockView, 26, ",");
            const secondTooltip = getTooltipFromState();
            expect(secondTooltip).not.toBeNull();

            // Should still only be one tooltip (state is replaced, not accumulated)
            // The tooltip position should be different
            expect(secondTooltip?.pos).not.toBe(firstTooltip?.pos);
        });
    });

    describe("dismissal via StateEffect", () => {
        it("should dismiss tooltip when setSignatureHelpTooltip.of(null) is dispatched", async () => {
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");
            expect(getTooltipFromState()).not.toBeNull();

            dispatchDismiss();

            expect(getTooltipFromState()).toBeNull();
        });

        it("should handle multiple dismiss calls gracefully", async () => {
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");

            dispatchDismiss();
            dispatchDismiss();
            dispatchDismiss();

            expect(getTooltipFromState()).toBeNull();
        });
    });

    describe("CodeMirror managed lifecycle", () => {
        it("should properly manage tooltip through state field", async () => {
            // State field starts as null
            expect(getTooltipFromState()).toBeNull();

            // Show tooltip
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");

            // Verify state contains tooltip with correct structure
            const tooltip = getTooltipFromState();
            expect(tooltip).not.toBeNull();
            expect(tooltip).toHaveProperty("pos");
            expect(tooltip).toHaveProperty("create");
        });

        it("tooltip should have proper structure for CodeMirror", async () => {
            await plugin.showSignatureHelpTooltip(mockView, 25, ",");

            const tooltip = getTooltipFromState();
            expect(tooltip).toMatchObject({
                pos: expect.any(Number),
                end: expect.any(Number),
                above: false,
            });
            expect(typeof tooltip?.create).toBe("function");
        });
    });
});
