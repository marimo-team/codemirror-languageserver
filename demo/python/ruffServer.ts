import type {
    Diagnostic as RuffDiagnostic,
    Workspace,
} from "@astral-sh/ruff-wasm-web";
import type * as LSP from "vscode-languageserver-protocol";
import {
    DiagnosticSeverity,
    TextDocumentSyncKind,
} from "vscode-languageserver-protocol";
import { rangesOverlap } from "../shared/ranges";

type RuffFix = NonNullable<RuffDiagnostic["fix"]>;

/**
 * A tiny LSP server around Ruff's WASM `Workspace`. Ruff only lints and formats,
 * so this advertises diagnostics + code actions (quick-fixes, fix-all, and a
 * whole-document "Format" action) and nothing else. Positions coming out of Ruff
 * are 1-based `{row, column}`; LSP is 0-based `{line, character}`.
 */
export class RuffServer {
    private documents = new Map<string, string>();
    // Cache the raw Ruff diagnostics per document so code actions can look up
    // the fix that belongs to a given range without re-running the linter.
    private diagnosticsCache = new Map<string, RuffDiagnostic[]>();

    constructor(private workspace: Workspace) {}

    initializeResult(): LSP.InitializeResult {
        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Full,
                codeActionProvider: {
                    codeActionKinds: ["quickfix", "source.fixAll", "source"],
                },
            },
        };
    }

    /** Store the latest text, re-lint, and return diagnostics to publish. */
    setDocument(uri: string, text: string): LSP.PublishDiagnosticsParams {
        this.documents.set(uri, text);
        const ruffDiagnostics = this.check(text);
        this.diagnosticsCache.set(uri, ruffDiagnostics);
        return {
            uri,
            diagnostics: ruffDiagnostics.map(toLspDiagnostic),
        };
    }

    codeAction(params: LSP.CodeActionParams): LSP.CodeAction[] {
        const uri = params.textDocument.uri;
        const text = this.documents.get(uri) ?? "";
        const cached = this.diagnosticsCache.get(uri) ?? [];
        const actions: LSP.CodeAction[] = [];

        // Quick-fix for the specific diagnostic the tooltip was opened on.
        const target = cached.find(
            (diagnostic) =>
                diagnostic.fix != null &&
                rangesOverlap(toRange(diagnostic), params.range),
        );
        if (target?.fix) {
            actions.push({
                title: target.fix.message || `Fix ${target.code ?? "issue"}`,
                kind: "quickfix",
                edit: { changes: { [uri]: fixToEdits(target.fix) } },
            });
        }

        // Fix-all: aggregate every fixable diagnostic in the document.
        const fixable = cached.filter((diagnostic) => diagnostic.fix != null);
        if (fixable.length > 1) {
            const edits = fixable.flatMap((diagnostic) =>
                diagnostic.fix ? fixToEdits(diagnostic.fix) : [],
            );
            actions.push({
                title: `Fix all auto-fixable (${fixable.length}) (Ruff)`,
                kind: "source.fixAll",
                edit: { changes: { [uri]: edits } },
            });
        }

        // Format the whole document via Ruff's formatter.
        actions.push({
            title: "Format document (Ruff)",
            kind: "source",
            edit: {
                changes: {
                    [uri]: [wholeDocumentEdit(text, this.format(text))],
                },
            },
        });

        return actions;
    }

    private check(text: string): RuffDiagnostic[] {
        try {
            return this.workspace.check(text) as RuffDiagnostic[];
        } catch (error) {
            console.error("Ruff check failed", error);
            return [];
        }
    }

    private format(text: string): string {
        try {
            return this.workspace.format(text);
        } catch (error) {
            console.error("Ruff format failed", error);
            return text;
        }
    }
}

function toLspDiagnostic(diagnostic: RuffDiagnostic): LSP.Diagnostic {
    return {
        range: toRange(diagnostic),
        message: diagnostic.message,
        code: diagnostic.code ?? undefined,
        severity: toSeverity(diagnostic.code),
        source: "ruff",
    };
}

function toRange(diagnostic: RuffDiagnostic): LSP.Range {
    return {
        start: toPosition(diagnostic.start_location),
        end: toPosition(diagnostic.end_location),
    };
}

function toPosition(location: { row: number; column: number }): LSP.Position {
    return { line: location.row - 1, character: location.column - 1 };
}

function toSeverity(code: string | null): LSP.DiagnosticSeverity {
    // Ruff has no severity concept; treat syntax errors (E9xx / null code) as
    // errors and every lint rule as a warning.
    if (code == null || code.startsWith("E9")) {
        return DiagnosticSeverity.Error;
    }
    return DiagnosticSeverity.Warning;
}

function fixToEdits(fix: RuffFix): LSP.TextEdit[] {
    return fix.edits.map((edit) => ({
        range: {
            start: toPosition(edit.location),
            end: toPosition(edit.end_location),
        },
        newText: edit.content ?? "",
    }));
}

function wholeDocumentEdit(text: string, newText: string): LSP.TextEdit {
    const lines = text.split("\n");
    const lastLine = lines.length - 1;
    return {
        range: {
            start: { line: 0, character: 0 },
            end: { line: lastLine, character: lines[lastLine].length },
        },
        newText,
    };
}
