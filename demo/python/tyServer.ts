import type * as LSP from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { rangesOverlap } from "../shared/ranges";

// Structural types for the subset of the ty_wasm module we use. ty positions
// are 1-indexed; LSP is 0-indexed.
interface TyPosition {
    line: number;
    column: number;
}
interface TyRange {
    start: TyPosition;
    end: TyPosition;
}
interface TyTextEdit {
    range: TyRange;
    new_text: string;
}
interface TyCodeAction {
    title: string;
    edits: TyTextEdit[];
    preferred: boolean;
}
interface TyDiagnostic {
    message(): string;
    id(): string;
    severity(): number;
    toRange(workspace: TyWorkspace): TyRange | undefined;
}
interface TyFileHandle {
    path(): string;
}
export interface TyWorkspace {
    openFile(path: string, contents: string): TyFileHandle;
    updateFile(handle: TyFileHandle, contents: string): void;
    checkFile(handle: TyFileHandle): TyDiagnostic[];
    // Superset of Diagnostic.codeAction: also returns workspace-derived actions
    // (e.g. import suggestions) that need whole-project analysis.
    codeActions(
        handle: TyFileHandle,
        diagnostic: TyDiagnostic,
    ): TyCodeAction[] | undefined;
}

enum TySeverity {
    Info = 0,
    Warning = 1,
    Error = 2,
    Fatal = 3,
}

const FILE_PATH = "main.py";

// Maps ty's type-check diagnostics and fixes onto LSP shapes.
export class TyServer {
    private handles = new Map<string, TyFileHandle>();

    constructor(private workspace: TyWorkspace) {}

    setDocument(uri: string, text: string): LSP.Diagnostic[] {
        const handle = this.handle(uri, text);
        return this.diagnostics(handle);
    }

    codeAction(params: LSP.CodeActionParams): LSP.CodeAction[] {
        const uri = params.textDocument.uri;
        const handle = this.handles.get(uri);
        if (!handle) {
            return [];
        }
        const actions: LSP.CodeAction[] = [];
        for (const diagnostic of this.workspace.checkFile(handle)) {
            const tyRange = diagnostic.toRange(this.workspace);
            if (!(tyRange && rangesOverlap(toRange(tyRange), params.range))) {
                continue;
            }
            for (const action of this.workspace.codeActions(
                handle,
                diagnostic,
            ) ?? []) {
                actions.push({
                    title: `${action.title} (ty)`,
                    kind: "quickfix",
                    isPreferred: action.preferred,
                    edit: {
                        changes: {
                            [uri]: action.edits.map((edit) => ({
                                range: toRange(edit.range),
                                newText: edit.new_text,
                            })),
                        },
                    },
                });
            }
        }
        return actions;
    }

    private handle(uri: string, text: string): TyFileHandle {
        const existing = this.handles.get(uri);
        if (existing) {
            this.workspace.updateFile(existing, text);
            return existing;
        }
        const handle = this.workspace.openFile(FILE_PATH, text);
        this.handles.set(uri, handle);
        return handle;
    }

    private diagnostics(handle: TyFileHandle): LSP.Diagnostic[] {
        const result: LSP.Diagnostic[] = [];
        for (const diagnostic of this.workspace.checkFile(handle)) {
            const tyRange = diagnostic.toRange(this.workspace);
            if (!tyRange) {
                continue;
            }
            result.push({
                range: toRange(tyRange),
                message: diagnostic.message(),
                code: diagnostic.id(),
                severity: toSeverity(diagnostic.severity()),
                source: "ty",
            });
        }
        return result;
    }
}

function toRange(range: TyRange): LSP.Range {
    return {
        start: toPosition(range.start),
        end: toPosition(range.end),
    };
}

function toPosition(position: TyPosition): LSP.Position {
    return { line: position.line - 1, character: position.column - 1 };
}

function toSeverity(severity: number): LSP.DiagnosticSeverity {
    switch (severity) {
        case TySeverity.Error:
        case TySeverity.Fatal:
            return DiagnosticSeverity.Error;
        case TySeverity.Warning:
            return DiagnosticSeverity.Warning;
        default:
            return DiagnosticSeverity.Information;
    }
}
