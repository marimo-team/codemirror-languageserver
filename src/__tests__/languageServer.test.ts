import { describe, it, expect, vi } from "vitest";
import { LanguageServerClient } from "../index";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import type { ClientCapabilities } from "vscode-languageserver-protocol";

class MockTransport extends Transport {
    sendData = vi.fn().mockResolvedValue({});
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    connect = vi.fn().mockResolvedValue({});
    close = vi.fn();
}

const transport = new MockTransport();

describe("LanguageServerClient initialization options", () => {
    it("uses default capabilities when none provided", async () => {
        const client = new LanguageServerClient({
            transport,
            rootUri: "file:///root",
            workspaceFolders: [{ uri: "file:///root", name: "root" }],
            documentUri: "file:///root/file.ts",
            languageId: "typescript",
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
            documentUri: "file:///root/file.ts",
            languageId: "typescript",
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
            documentUri: "file:///root/file.ts",
            languageId: "typescript",
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
            documentUri: "file:///root/file.ts",
            languageId: "typescript",
            initializationOptions: customInitOptions,
        });

        // biome-ignore lint/suspicious/noExplicitAny: tests
        const initParams = await (client as any).getInitializationOptions();

        expect(initParams.initializationOptions).toEqual(customInitOptions);
    });
});
