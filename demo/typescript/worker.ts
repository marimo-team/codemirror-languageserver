import {
    createDefaultMapFromCDN,
    createSystem,
    createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import * as ts from "typescript";
import type * as LSP from "vscode-languageserver-protocol";
import { publishDiagnostics, serve } from "../shared/workerRpc";
import { TsServer } from "./tsServer";

// Must be an absolute path: the vfs System's cwd is "/", so TypeScript resolves
// root files against it — a bare "index.ts" becomes "/index.ts" and isn't found.
const FILE_NAME = "/index.ts";

const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
};

// Building the environment fetches the TypeScript lib .d.ts files from a CDN
// (~1-2 MB), so it's async. Handlers await this; `initialize` does not, so the
// client can finish its handshake while the libs stream in.
const ready = (async () => {
    const fsMap = await createDefaultMapFromCDN(
        COMPILER_OPTIONS,
        ts.version,
        // cache=false: no localStorage inside a worker.
        false,
        ts,
    );
    // Seed with non-empty content: vfs's getScriptSnapshot treats "" as falsy
    // and reports the file missing. didOpen replaces this immediately.
    fsMap.set(FILE_NAME, "\n");
    const env = createVirtualTypeScriptEnvironment(
        createSystem(fsMap),
        [FILE_NAME],
        ts,
        COMPILER_OPTIONS,
    );
    return new TsServer(env, FILE_NAME);
})();

serve({
    requests: {
        initialize: () => TsServer.initializeResult(),
        "textDocument/completion": async (params) =>
            (await ready).completion(params as LSP.CompletionParams),
        "completionItem/resolve": async (params) =>
            (await ready).completionResolve(params as LSP.CompletionItem),
        "textDocument/hover": async (params) =>
            (await ready).hover(params as LSP.HoverParams),
        "textDocument/definition": async (params) =>
            (await ready).definition(params as LSP.DefinitionParams),
        "textDocument/signatureHelp": async (params) =>
            (await ready).signatureHelp(params as LSP.SignatureHelpParams),
        "textDocument/prepareRename": async (params) =>
            (await ready).prepareRename(params as LSP.PrepareRenameParams),
        "textDocument/rename": async (params) =>
            (await ready).rename(params as LSP.RenameParams),
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
