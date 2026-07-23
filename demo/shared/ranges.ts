import type * as LSP from "vscode-languageserver-protocol";

export function rangesOverlap(a: LSP.Range, b: LSP.Range): boolean {
    return !(isBefore(a.end, b.start) || isBefore(b.end, a.start));
}

function isBefore(a: LSP.Position, b: LSP.Position): boolean {
    if (a.line !== b.line) {
        return a.line < b.line;
    }
    return a.character < b.character;
}
