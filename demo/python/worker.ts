import init, { PositionEncoding, Workspace } from "@astral-sh/ruff-wasm-web";
import type * as LSP from "vscode-languageserver-protocol";
import { publishDiagnostics, serve } from "../shared/workerRpc";
import { RuffServer } from "./ruffServer";

const RUFF_CONFIG = {
    "line-length": 88,
    "indent-width": 4,
    lint: {
        select: ["E", "F", "W", "I"],
    },
    format: {
        "quote-style": "double",
    },
};

// Load the WASM module once; handlers below await this before doing any work so
// messages that arrive during initialization aren't dropped.
const ready = (async () => {
    await init();
    return new RuffServer(new Workspace(RUFF_CONFIG, PositionEncoding.Utf16));
})();

serve({
    requests: {
        initialize: async () => (await ready).initializeResult(),
        "textDocument/codeAction": async (params) =>
            (await ready).codeAction(params as LSP.CodeActionParams),
    },
    notifications: {
        "textDocument/didOpen": async (params) => {
            const server = await ready;
            const { textDocument } = params as LSP.DidOpenTextDocumentParams;
            publishDiagnostics(
                server.setDocument(textDocument.uri, textDocument.text),
            );
        },
        "textDocument/didChange": async (params) => {
            const server = await ready;
            const { textDocument, contentChanges } =
                params as LSP.DidChangeTextDocumentParams;
            const change = contentChanges[0];
            if (change) {
                publishDiagnostics(
                    server.setDocument(textDocument.uri, change.text),
                );
            }
        },
    },
});
