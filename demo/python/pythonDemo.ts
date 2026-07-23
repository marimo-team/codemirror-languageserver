import { python } from "@codemirror/lang-python";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { languageServerWithClient } from "../../src";
import { createWorkerClient } from "../shared/workerTransport";

const DOCUMENT_URI = "file:///main.py";

const SAMPLE = `import os
import sys


def greet(name: str) -> str:
    return "Hello, " + name


# Ruff flags the unused imports above; ty flags the type error below.
message: int = greet("world")
print( message )
`;

/**
 * Mounts a Python editor backed by Ruff (WASM) running in a Web Worker, plus
 * ty (Astral's type checker) when its WASM build has been vendored in.
 * Exercises diagnostics (lint + type errors), quick-fix / fix-all code actions,
 * and formatting (the latter surface as actions in each diagnostic's tooltip).
 */
export function mountPythonDemo(container: HTMLElement): () => void {
    const hint = document.createElement("p");
    hint.className = "demo-hint";
    hint.innerHTML =
        "Backed by <code>@astral-sh/ruff-wasm-web</code> (lint + format) in a " +
        "Web Worker, plus <code>ty</code> type-checking when built via " +
        "<code>pnpm build:ty-wasm</code>. Hover a diagnostic for quick-fix, " +
        "<em>Fix all</em>, and <em>Format document</em> actions.";
    container.appendChild(hint);

    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
    });
    const client = createWorkerClient(worker, { rootUri: "file:///" });

    const view = new EditorView({
        state: EditorState.create({
            doc: SAMPLE,
            extensions: [
                basicSetup,
                python(),
                tooltips({ position: "absolute" }),
                lintGutter(),
                languageServerWithClient({
                    client,
                    documentUri: DOCUMENT_URI,
                    languageId: "python",
                    allowHTMLContent: true,
                    sendIncrementalChanges: false,
                }),
            ],
        }),
        parent: container,
    });

    return () => {
        view.destroy();
        client.close();
    };
}
