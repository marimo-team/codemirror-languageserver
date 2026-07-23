import init, { PositionEncoding, Workspace } from "@astral-sh/ruff-wasm-web";
import type * as LSP from "vscode-languageserver-protocol";
import { publishDiagnostics, serve } from "../shared/workerRpc";
import { RuffServer } from "./ruffServer";
import { TyServer, type TyWorkspace } from "./tyServer";

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

interface TyModule {
    default: (moduleOrPath?: unknown) => Promise<unknown>;
    Workspace: new (
        root: string,
        positionEncoding: number,
        options: unknown,
    ) => TyWorkspace;
    PositionEncoding: { Utf16: number };
}

interface PythonServers {
    ruff: RuffServer;
    ty: TyServer | null;
}

// ty_wasm isn't published to npm. import.meta.glob resolves to an empty map when
// demo/vendor/ty_wasm/ is absent, so the demo falls back to Ruff-only without a
// Rust toolchain. Run `pnpm build:ty-wasm` to enable it.
async function loadTy(): Promise<TyServer | null> {
    const modules = import.meta.glob("../vendor/ty_wasm/ty_wasm.js");
    const loader = modules["../vendor/ty_wasm/ty_wasm.js"];
    if (!loader) {
        return null;
    }
    try {
        const ty = (await loader()) as unknown as TyModule;
        await ty.default();
        const workspace = new ty.Workspace("/", ty.PositionEncoding.Utf16, {});
        return new TyServer(workspace);
    } catch (error) {
        console.error("Failed to load ty; continuing with Ruff only", error);
        return null;
    }
}

const ready = (async (): Promise<PythonServers> => {
    await init();
    const ruff = new RuffServer(
        new Workspace(RUFF_CONFIG, PositionEncoding.Utf16),
    );
    const ty = await loadTy();
    return { ruff, ty };
})();

function publish(servers: PythonServers, uri: string, text: string): void {
    const ruffParams = servers.ruff.setDocument(uri, text);
    const tyDiagnostics = servers.ty?.setDocument(uri, text) ?? [];
    publishDiagnostics({
        uri,
        diagnostics: [...ruffParams.diagnostics, ...tyDiagnostics],
    });
}

serve({
    requests: {
        initialize: async () => (await ready).ruff.initializeResult(),
        "textDocument/codeAction": async (params) => {
            const servers = await ready;
            const codeActionParams = params as LSP.CodeActionParams;
            return [
                ...servers.ruff.codeAction(codeActionParams),
                ...(servers.ty?.codeAction(codeActionParams) ?? []),
            ];
        },
    },
    notifications: {
        "textDocument/didOpen": async (params) => {
            const servers = await ready;
            const { textDocument } = params as LSP.DidOpenTextDocumentParams;
            publish(servers, textDocument.uri, textDocument.text);
        },
        "textDocument/didChange": async (params) => {
            const servers = await ready;
            const { textDocument, contentChanges } =
                params as LSP.DidChangeTextDocumentParams;
            const change = contentChanges[0];
            if (change) {
                publish(servers, textDocument.uri, change.text);
            }
        },
    },
});
