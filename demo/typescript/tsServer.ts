import type { VirtualTypeScriptEnvironment } from "@typescript/vfs";
import * as ts from "typescript";
import type * as LSP from "vscode-languageserver-protocol";
import {
    CompletionItemKind,
    DiagnosticSeverity,
    TextDocumentSyncKind,
} from "vscode-languageserver-protocol";

interface CompletionData {
    offset: number;
    name: string;
    source?: string;
}

/**
 * An LSP server backed by a TypeScript `LanguageService` running over an
 * in-memory virtual file system (`@typescript/vfs`). A single virtual file holds
 * the editor's content; every request maps LSP positions (0-based line/char) to
 * TypeScript offsets via the current `SourceFile`.
 */
export class TsServer {
    private documentUri = "file:///index.ts";

    constructor(
        private env: VirtualTypeScriptEnvironment,
        private fileName: string,
    ) {}

    private get ls(): ts.LanguageService {
        return this.env.languageService;
    }

    static initializeResult(): LSP.InitializeResult {
        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Full,
                completionProvider: {
                    resolveProvider: true,
                    triggerCharacters: ["."],
                },
                hoverProvider: true,
                definitionProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ["(", ","],
                    retriggerCharacters: [","],
                },
                renameProvider: { prepareProvider: true },
            },
        };
    }

    setDocument(uri: string, text: string): LSP.PublishDiagnosticsParams {
        this.documentUri = uri;
        this.env.updateFile(this.fileName, text);
        return this.getDiagnostics(uri);
    }

    getDiagnostics(uri: string): LSP.PublishDiagnosticsParams {
        const raw = [
            ...this.ls.getSyntacticDiagnostics(this.fileName),
            ...this.ls.getSemanticDiagnostics(this.fileName),
        ];
        return {
            uri,
            diagnostics: raw.map((diagnostic) =>
                this.toLspDiagnostic(diagnostic),
            ),
        };
    }

    completion(params: LSP.CompletionParams): LSP.CompletionList {
        const offset = this.offsetAt(params.position);
        const info = this.ls.getCompletionsAtPosition(
            this.fileName,
            offset,
            {},
        );
        if (!info) {
            return { isIncomplete: false, items: [] };
        }
        const items = info.entries.map((entry): LSP.CompletionItem => {
            const data: CompletionData = {
                offset,
                name: entry.name,
                source: entry.source,
            };
            return {
                label: entry.name,
                kind: mapCompletionKind(entry.kind),
                sortText: entry.sortText,
                insertText: entry.insertText,
                data,
            };
        });
        return { isIncomplete: false, items };
    }

    completionResolve(item: LSP.CompletionItem): LSP.CompletionItem {
        const data = item.data as CompletionData | undefined;
        if (!data) {
            return item;
        }
        const details = this.ls.getCompletionEntryDetails(
            this.fileName,
            data.offset,
            data.name,
            undefined,
            data.source,
            undefined,
            undefined,
        );
        if (!details) {
            return item;
        }
        const detail = ts.displayPartsToString(details.displayParts);
        const documentation = ts.displayPartsToString(details.documentation);
        return {
            ...item,
            detail: detail || item.detail,
            documentation: documentation
                ? { kind: "markdown", value: documentation }
                : item.documentation,
        };
    }

    hover(params: LSP.HoverParams): LSP.Hover | null {
        const offset = this.offsetAt(params.position);
        const info = this.ls.getQuickInfoAtPosition(this.fileName, offset);
        if (!info) {
            return null;
        }
        const display = ts.displayPartsToString(info.displayParts);
        const documentation = ts.displayPartsToString(info.documentation);
        const value = ["```typescript", display, "```", documentation]
            .filter(Boolean)
            .join("\n");
        return {
            contents: { kind: "markdown", value },
            range: this.rangeFromSpan(this.fileName, info.textSpan),
        };
    }

    definition(params: LSP.DefinitionParams): LSP.Location[] {
        const offset = this.offsetAt(params.position);
        const definitions = this.ls.getDefinitionAtPosition(
            this.fileName,
            offset,
        );
        if (!definitions) {
            return [];
        }
        return definitions.map((definition) => ({
            uri:
                definition.fileName === this.fileName
                    ? this.documentUri
                    : `file:///${definition.fileName}`,
            range: this.rangeFromSpan(definition.fileName, definition.textSpan),
        }));
    }

    signatureHelp(params: LSP.SignatureHelpParams): LSP.SignatureHelp | null {
        const offset = this.offsetAt(params.position);
        const help = this.ls.getSignatureHelpItems(
            this.fileName,
            offset,
            undefined,
        );
        if (!help) {
            return null;
        }
        const signatures = help.items.map((item): LSP.SignatureInformation => {
            const separator = ts.displayPartsToString(
                item.separatorDisplayParts,
            );
            const label =
                ts.displayPartsToString(item.prefixDisplayParts) +
                item.parameters
                    .map((parameter) =>
                        ts.displayPartsToString(parameter.displayParts),
                    )
                    .join(separator) +
                ts.displayPartsToString(item.suffixDisplayParts);
            return {
                label,
                documentation: partsToMarkdown(item.documentation),
                parameters: item.parameters.map((parameter) => ({
                    label: ts.displayPartsToString(parameter.displayParts),
                    documentation: partsToMarkdown(parameter.documentation),
                })),
            };
        });
        return {
            signatures,
            activeSignature: help.selectedItemIndex,
            activeParameter: help.argumentIndex,
        };
    }

    prepareRename(
        params: LSP.PrepareRenameParams,
    ): LSP.Range | { defaultBehavior: boolean } | null {
        const offset = this.offsetAt(params.position);
        const info = this.ls.getRenameInfo(this.fileName, offset, {
            allowRenameOfImportPath: false,
        });
        if (!info.canRename) {
            return null;
        }
        return this.rangeFromSpan(this.fileName, info.triggerSpan);
    }

    rename(params: LSP.RenameParams): LSP.WorkspaceEdit {
        const offset = this.offsetAt(params.position);
        const locations = this.ls.findRenameLocations(
            this.fileName,
            offset,
            false,
            false,
            {},
        );
        const edits = (locations ?? [])
            .filter((location) => location.fileName === this.fileName)
            .map((location) => ({
                range: this.rangeFromSpan(this.fileName, location.textSpan),
                newText: params.newName,
            }));
        return { changes: { [this.documentUri]: edits } };
    }

    private toLspDiagnostic(diagnostic: ts.Diagnostic): LSP.Diagnostic {
        const start = diagnostic.start ?? 0;
        const length = diagnostic.length ?? 0;
        return {
            range: this.rangeFromSpan(this.fileName, { start, length }),
            message: ts.flattenDiagnosticMessageText(
                diagnostic.messageText,
                "\n",
            ),
            code: diagnostic.code,
            severity: mapCategory(diagnostic.category),
            source: "ts",
        };
    }

    private offsetAt(position: LSP.Position): number {
        const sourceFile = this.env.getSourceFile(this.fileName);
        if (!sourceFile) {
            return 0;
        }
        return sourceFile.getPositionOfLineAndCharacter(
            position.line,
            position.character,
        );
    }

    private rangeFromSpan(fileName: string, span: ts.TextSpan): LSP.Range {
        const sourceFile = this.env.getSourceFile(fileName);
        if (!sourceFile) {
            const zero = { line: 0, character: 0 };
            return { start: zero, end: zero };
        }
        return {
            start: sourceFile.getLineAndCharacterOfPosition(span.start),
            end: sourceFile.getLineAndCharacterOfPosition(
                span.start + span.length,
            ),
        };
    }
}

function partsToMarkdown(
    parts: ts.SymbolDisplayPart[] | undefined,
): LSP.MarkupContent | undefined {
    const value = ts.displayPartsToString(parts);
    return value ? { kind: "markdown", value } : undefined;
}

function mapCategory(category: ts.DiagnosticCategory): LSP.DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Error:
            return DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning:
            return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Suggestion:
            return DiagnosticSeverity.Hint;
        default:
            return DiagnosticSeverity.Information;
    }
}

function mapCompletionKind(kind: ts.ScriptElementKind): LSP.CompletionItemKind {
    switch (kind) {
        case ts.ScriptElementKind.memberFunctionElement:
        case ts.ScriptElementKind.functionElement:
        case ts.ScriptElementKind.localFunctionElement:
            return CompletionItemKind.Function;
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return CompletionItemKind.Field;
        case ts.ScriptElementKind.constructorImplementationElement:
            return CompletionItemKind.Constructor;
        case ts.ScriptElementKind.enumElement:
            return CompletionItemKind.Enum;
        case ts.ScriptElementKind.enumMemberElement:
            return CompletionItemKind.EnumMember;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.localVariableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.constElement:
            return CompletionItemKind.Variable;
        case ts.ScriptElementKind.classElement:
            return CompletionItemKind.Class;
        case ts.ScriptElementKind.interfaceElement:
            return CompletionItemKind.Interface;
        case ts.ScriptElementKind.moduleElement:
            return CompletionItemKind.Module;
        case ts.ScriptElementKind.keyword:
            return CompletionItemKind.Keyword;
        case ts.ScriptElementKind.typeParameterElement:
            return CompletionItemKind.TypeParameter;
        default:
            return CompletionItemKind.Text;
    }
}
