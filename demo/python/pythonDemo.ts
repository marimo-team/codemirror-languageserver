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


def greet(name):
    message = "Hello, " + name
    print( message )


greet("world")
`;

/**
 * Mounts a Python editor backed by Ruff (WASM) running in a Web Worker.
 * Exercises diagnostics, quick-fix / fix-all code actions, and formatting
 * (the latter two surface as actions in each diagnostic's tooltip).
 */
export function mountPythonDemo(container: HTMLElement): () => void {
    const hint = document.createElement("p");
    hint.className = "demo-hint";
    hint.innerHTML =
        "Backed by <code>@astral-sh/ruff-wasm-web</code> in a Web Worker. " +
        "Hover a diagnostic to see quick-fix, <em>Fix all</em>, and " +
        "<em>Format document</em> actions.";
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
