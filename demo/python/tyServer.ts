import type * as LSP from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";

/**
 * Minimal structural types for the `ty_wasm` module. `ty_wasm` is not published
 * to npm — it must be built from the crate with
 * `wasm-pack build crates/ty_wasm --target web` (see scripts/build-ty-wasm.sh)
 * and vendored into demo/vendor/ty_wasm/. We type only what we use so the demo
 * still type-checks/builds when the artifact isn't present.
 *
 * ty's `Position` is 1-indexed for both line and column; LSP is 0-indexed.
 */
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
    codeAction(workspace: TyWorkspace): TyCodeAction | undefined;
}
interface TyFileHandle {
    path(): string;
}
export interface TyWorkspace {
    openFile(path: string, contents: string): TyFileHandle;
    updateFile(handle: TyFileHandle, contents: string): void;
    checkFile(handle: TyFileHandle): TyDiagnostic[];
}

// The `Severity` wasm enum: Info=0, Warning=1, Error=2, Fatal=3.
enum TySeverity {
    Info = 0,
    Warning = 1,
    Error = 2,
    Fatal = 3,
}

const FILE_PATH = "main.py";

/**
 * Wraps a `ty` (Astral's type checker) WASM workspace and maps its type-check
 * diagnostics and fixes onto LSP shapes, so they can be merged with Ruff's lint
 * output in the same Python document.
 */
export class TyServer {
    private handles = new Map<string, TyFileHandle>();

    constructor(private workspace: TyWorkspace) {}

    /** Update the file in ty's workspace and return its diagnostics. */
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
            const action = diagnostic.codeAction(this.workspace);
            if (!action) {
                continue;
            }
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
    // ty positions are 1-indexed; LSP is 0-indexed.
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

function rangesOverlap(a: LSP.Range, b: LSP.Range): boolean {
    return !(isBefore(a.end, b.start) || isBefore(b.end, a.start));
}

function isBefore(a: LSP.Position, b: LSP.Position): boolean {
    if (a.line !== b.line) {
        return a.line < b.line;
    }
    return a.character < b.character;
}
