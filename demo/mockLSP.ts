import * as LSP from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";

export class MockLSPServer {
    private documents: Map<string, string> = new Map();
    private diagnostics: Map<string, LSP.Diagnostic[]> = new Map();
    private onDiagnosticsCallback?: (
        params: LSP.PublishDiagnosticsParams,
    ) => void;

    constructor() {
        // Initialize with some example diagnostics
        this.diagnostics.set("file:///example.ts", []);
    }

    public setOnDiagnostics(
        callback: (params: LSP.PublishDiagnosticsParams) => void,
    ) {
        this.onDiagnosticsCallback = callback;
    }

    public addDiagnostic(uri: string, diagnostic: LSP.Diagnostic) {
        const current = this.diagnostics.get(uri) || [];
        current.push(diagnostic);
        this.diagnostics.set(uri, current);
        this.publishDiagnostics(uri);
    }

    public clearDiagnostics(uri: string) {
        this.diagnostics.set(uri, []);
        this.publishDiagnostics(uri);
    }

    private publishDiagnostics(uri: string) {
        if (this.onDiagnosticsCallback) {
            this.onDiagnosticsCallback({
                uri,
                diagnostics: this.diagnostics.get(uri) || [],
            });
        }
    }

    // LSP Methods
    public initialize(): LSP.InitializeResult {
        return {
            capabilities: {
                textDocumentSync: LSP.TextDocumentSyncKind.Full,
                completionProvider: {
                    triggerCharacters: ["."],
                    resolveProvider: true,
                },
                hoverProvider: true,
                definitionProvider: true,
                referencesProvider: true,
                documentSymbolProvider: true,
                codeActionProvider: {
                    codeActionKinds: [
                        "quickfix",
                        "refactor.rewrite",
                        "refactor.extract",
                    ],
                    resolveProvider: true,
                },
                renameProvider: {
                    prepareProvider: true,
                },
                signatureHelpProvider: {
                    triggerCharacters: ["(", ","],
                    retriggerCharacters: [","],
                },
            },
        };
    }

    public didOpenTextDocument(params: LSP.DidOpenTextDocumentParams) {
        this.documents.set(params.textDocument.uri, params.textDocument.text);
        this.publishDiagnostics(params.textDocument.uri);
    }

    public didChangeTextDocument(params: LSP.DidChangeTextDocumentParams) {
        if (params.contentChanges[0]) {
            this.documents.set(
                params.textDocument.uri,
                params.contentChanges[0].text,
            );
        }
    }

    public async completion(
        _params: LSP.CompletionParams,
    ): Promise<LSP.CompletionList> {
        // Mock completions
        return {
            isIncomplete: false,
            items: [
                {
                    label: "console",
                    kind: LSP.CompletionItemKind.Module,
                    detail: "Console object",
                    data: 1, // Used to identify item in resolve
                },
                {
                    label: "log",
                    kind: LSP.CompletionItemKind.Method,
                    detail: "Log to console",
                    data: 2,
                },
                {
                    label: "error",
                    kind: LSP.CompletionItemKind.Method,
                    detail: "Log error to console",
                    data: 3,
                },
                {
                    label: "warn",
                    kind: LSP.CompletionItemKind.Method,
                    detail: "Log warning to console",
                    data: 4,
                },
                {
                    label: "info",
                    kind: LSP.CompletionItemKind.Method,
                    detail: "Log info to console",
                    data: 5,
                },
            ],
        };
    }

    public async completionResolve(
        item: LSP.CompletionItem,
    ): Promise<LSP.CompletionItem> {
        const resolvedItem = { ...item };
        // Add detailed documentation based on the item
        switch (item.data) {
            case 1:
                resolvedItem.documentation = {
                    kind: "markdown",
                    value: [
                        "# Console Object",
                        "",
                        "The console object provides access to the browser's debugging console.",
                        "",
                        "## Methods",
                        "- `log()`: Output a message to the console",
                        "- `error()`: Output an error message",
                        "- `warn()`: Output a warning message",
                        "- `info()`: Output an informational message",
                    ].join("\n"),
                };
                break;
            case 2:
                resolvedItem.documentation = {
                    kind: "markdown",
                    value: [
                        "# console.log()",
                        "",
                        "Outputs a message to the console.",
                        "",
                        "```typescript",
                        "console.log(obj1 [, obj2, ..., objN])",
                        "console.log(msg [, subst1, ..., substN])",
                        "```",
                        "",
                        "## Parameters",
                        "- `obj1...objN`: A list of objects to output",
                        "- `msg`: A JavaScript string containing zero or more substitution strings",
                        "- `subst1...substN`: JavaScript objects with which to replace substitution strings",
                    ].join("\n"),
                };
                break;
            case 3:
                resolvedItem.documentation = {
                    kind: "markdown",
                    value: [
                        "# console.error()",
                        "",
                        "Outputs an error message to the console.",
                        "",
                        "```typescript",
                        "console.error(obj1 [, obj2, ..., objN])",
                        "```",
                        "",
                        "Messages are also written to stderr in Node.js.",
                        "",
                        "## Parameters",
                        "- `obj1...objN`: A list of objects to output",
                    ].join("\n"),
                };
                break;
            case 4:
                resolvedItem.documentation = {
                    kind: "markdown",
                    value: [
                        "# console.warn()",
                        "",
                        "Outputs a warning message to the console.",
                        "",
                        "```typescript",
                        "console.warn(obj1 [, obj2, ..., objN])",
                        "```",
                        "",
                        "## Parameters",
                        "- `obj1...objN`: A list of objects to output",
                    ].join("\n"),
                };
                break;
            case 5:
                resolvedItem.documentation = {
                    kind: "markdown",
                    value: [
                        "# console.info()",
                        "",
                        "Outputs an informational message to the console.",
                        "",
                        "```typescript",
                        "console.info(obj1 [, obj2, ..., objN])",
                        "```",
                        "",
                        "## Parameters",
                        "- `obj1...objN`: A list of objects to output",
                    ].join("\n"),
                };
                break;
        }
        return resolvedItem;
    }

    public async hover(_params: LSP.HoverParams): Promise<LSP.Hover> {
        return {
            contents: {
                kind: "markdown",
                value: "**Mock Hover**\nThis is a mock hover tooltip.",
            },
        };
    }

    public async definition(
        params: LSP.DefinitionParams,
    ): Promise<LSP.Definition> {
        const random = Math.random();
        // Half the time, return a location in the document
        if (random < 0.5) {
            // Return mock definition at start of document
            return {
                uri: params.textDocument.uri,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                },
            };
        }

        // Otherwise, return a location in a random file
        return {
            uri: `file:///${random}.ts`,
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            },
        };
    }

    public async prepareRename(
        params: LSP.PrepareRenameParams,
    ): Promise<LSP.Range> {
        const text = this.documents.get(params.textDocument.uri) || "";
        const lines = text.split("\n");
        const line = lines[params.position.line];

        // Find word boundaries around the cursor position
        const lineUpToCursor = line.slice(0, params.position.character);
        const lineAfterCursor = line.slice(params.position.character);

        const beforeMatch = lineUpToCursor.match(/\w*$/);
        const afterMatch = lineAfterCursor.match(/^\w*/);

        if (!(beforeMatch && afterMatch)) {
            throw new Error("No valid symbol at position");
        }

        return {
            start: {
                line: params.position.line,
                character: params.position.character - beforeMatch[0].length,
            },
            end: {
                line: params.position.line,
                character: params.position.character + afterMatch[0].length,
            },
        };
    }

    public async rename(params: LSP.RenameParams): Promise<LSP.WorkspaceEdit> {
        const text = this.documents.get(params.textDocument.uri) || "";
        const lines = text.split("\n");

        // Get the word at the cursor position
        const line = lines[params.position.line];
        const range = await this.prepareRename(params);
        const oldName = line.slice(range.start.character, range.end.character);

        if (!oldName) {
            throw new Error("No valid symbol at position");
        }

        // Find all occurrences of the word in the entire document
        const changes: LSP.TextEdit[] = [];
        lines.forEach((line, lineNum) => {
            let pos = 0;
            while (true) {
                const index = line.indexOf(oldName, pos);
                if (index === -1) break;

                // Verify it's a whole word match
                const beforeChar = index > 0 ? line[index - 1] : "";
                const afterChar =
                    index + oldName.length < line.length
                        ? line[index + oldName.length]
                        : "";

                if (
                    !(
                        (beforeChar && /\w/.test(beforeChar)) ||
                        (afterChar && /\w/.test(afterChar))
                    )
                ) {
                    changes.push({
                        range: {
                            start: { line: lineNum, character: index },
                            end: {
                                line: lineNum,
                                character: index + oldName.length,
                            },
                        },
                        newText: params.newName,
                    });
                }
                pos = index + 1;
            }
        });

        return {
            changes: {
                [params.textDocument.uri]: changes,
            },
            documentChanges: [
                {
                    textDocument: {
                        uri: params.textDocument.uri,
                        version: 1,
                    },
                    edits: changes,
                },
            ],
        };
    }

    public async codeAction(
        params: LSP.CodeActionParams,
    ): Promise<LSP.CodeAction[]> {
        const quickFixes: LSP.CodeAction[] = params.context.diagnostics.map(
            (diagnostic) => ({
                title: `Fix: ${diagnostic.message}`,
                kind: "quickfix",
                diagnostics: [diagnostic],
                edit: {
                    changes: {
                        [params.textDocument.uri]: [
                            {
                                range: diagnostic.range,
                                newText: "/* Fixed */",
                            },
                        ],
                    },
                },
            }),
        );

        // Refactors not tied to any diagnostic
        const refactors: LSP.CodeAction[] = [
            {
                title: "Convert line to uppercase",
                kind: "refactor.rewrite",
                // No edit here: the client must call codeAction/resolve
                data: {
                    uri: params.textDocument.uri,
                    line: params.range.start.line,
                },
            },
            {
                title: "Extract function",
                kind: "refactor.extract",
                disabled: { reason: "Not extractable in the mock server" },
            },
        ];

        const actions = [...quickFixes, ...refactors];
        const only = params.context.only;
        if (only && only.length > 0) {
            return actions.filter(
                (action) =>
                    action.kind &&
                    only.some(
                        (kind) =>
                            action.kind === kind ||
                            action.kind?.startsWith(`${kind}.`),
                    ),
            );
        }
        return actions;
    }

    public async codeActionResolve(
        action: LSP.CodeAction,
    ): Promise<LSP.CodeAction> {
        const data = action.data as { uri?: string; line?: number } | undefined;
        if (!data?.uri || data.line == null) {
            return action;
        }
        const text = this.documents.get(data.uri) ?? "";
        const lineText = text.split("\n")[data.line] ?? "";
        return {
            ...action,
            edit: {
                changes: {
                    [data.uri]: [
                        {
                            range: {
                                start: { line: data.line, character: 0 },
                                end: {
                                    line: data.line,
                                    character: lineText.length,
                                },
                            },
                            newText: lineText.toUpperCase(),
                        },
                    ],
                },
            },
        };
    }

    // Default signature help data that can be reused
    private defaultSignatureHelpData = {
        signatures: [
            {
                label: "function example(param1: string, param2: number, param3: boolean): void",
                documentation: {
                    kind: "markdown",
                    value: "A demo function that shows signature help capabilities.\n\nThis will display parameter information as you type.",
                },
                parameters: [
                    {
                        label: "param1: string",
                        documentation: {
                            kind: "markdown",
                            value: "The first parameter - a string value.\n\nExample: `'hello'`",
                        },
                    },
                    {
                        label: "param2: number",
                        documentation: {
                            kind: "markdown",
                            value: "The second parameter - a numeric value.\n\nExample: `42`",
                        },
                    },
                    {
                        label: "param3: boolean",
                        documentation: {
                            kind: "markdown",
                            value: "The third parameter - a boolean value.\n\nExample: `true`",
                        },
                    },
                ],
            },
            {
                label: "function example(config: { name: string, value: any }): void",
                documentation: {
                    kind: "markdown",
                    value: "Alternative signature with a configuration object parameter.",
                },
                parameters: [
                    {
                        label: "config: { name: string, value: any }",
                        documentation: {
                            kind: "markdown",
                            value: "A configuration object with name and value properties.",
                        },
                    },
                ],
            },
        ],
    };

    /**
     * Provides signature help information for function calls
     *
     * @param _params - The signature help parameters from the client
     * @returns A SignatureHelp object containing information about function signatures
     */
    public async signatureHelp(
        _params: LSP.SignatureHelpParams,
    ): Promise<LSP.SignatureHelp> {
        // Return the default signature help data with the default active positions
        return {
            ...this.defaultSignatureHelpData,
            activeSignature: 0,
            activeParameter: 0,
        };
    }

    // Helper methods for demo
    public addErrorDiagnostic(uri: string, line: number) {
        this.addDiagnostic(uri, {
            range: {
                start: { line, character: 0 },
                end: { line, character: 10 },
            },
            message: "Mock error diagnostic",
            severity: DiagnosticSeverity.Error,
            source: "mock-lsp",
        });
    }

    public addWarningDiagnostic(uri: string, line: number) {
        this.addDiagnostic(uri, {
            range: {
                start: { line, character: 0 },
                end: { line, character: 10 },
            },
            message: "Mock warning diagnostic",
            severity: DiagnosticSeverity.Warning,
            source: "mock-lsp",
        });
    }

    // Add a method to simulate external document definition
    public setExternalDefinitionTarget(targetUri: string) {
        // Override the definition method to return an external document
        this.definition = async (
            params: LSP.DefinitionParams,
        ): Promise<LSP.Definition> => {
            // Use params for logging or other purposes if needed
            console.debug(
                `Definition requested for ${params.textDocument.uri} at position ${params.position.line}:${params.position.character}`,
            );

            return {
                uri: targetUri, // External document URI
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                },
            };
        };
    }

    // Reset to default behavior (same document definition)
    public resetDefinitionTarget() {
        this.definition = async (
            params: LSP.DefinitionParams,
        ): Promise<LSP.Definition> => {
            return {
                uri: params.textDocument.uri,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                },
            };
        };
    }

    /**
     * Updates the active parameter in signature help
     *
     * @param paramIndex - The index of the parameter to make active (0-based)
     */
    public setSignatureHelpActiveParameter(paramIndex: number) {
        this.signatureHelp = async (
            _params: LSP.SignatureHelpParams,
        ): Promise<LSP.SignatureHelp> => {
            return {
                ...this.defaultSignatureHelpData,
                activeSignature: 0,
                activeParameter: Math.min(paramIndex, 2), // Clamp to valid parameter indices
            };
        };
    }

    /**
     * Updates which signature is active in signature help
     *
     * @param signatureIndex - The index of the signature to make active (0-based)
     */
    public setActiveSignature(signatureIndex: number) {
        this.signatureHelp = async (
            _params: LSP.SignatureHelpParams,
        ): Promise<LSP.SignatureHelp> => {
            return {
                ...this.defaultSignatureHelpData,
                activeSignature: Math.min(signatureIndex, 1), // Clamp to valid signature indices
                activeParameter: 0,
            };
        };
    }

    /**
     * Resets signature help behavior to default
     */
    public resetSignatureHelp() {
        this.signatureHelp = async (
            _params: LSP.SignatureHelpParams,
        ): Promise<LSP.SignatureHelp> => {
            return {
                ...this.defaultSignatureHelpData,
                activeSignature: 0,
                activeParameter: 0,
            };
        };
    }
}
