import { python } from "@codemirror/lang-python";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { languageServerWithClient } from "../../src";
import { createWorkerClient } from "../shared/workerTransport";

const DOCUMENT_URI = "file:///main.py";

const SAMPLE = `# Python · Ruff (lint + format) + ty (types) — both WASM, in a Web Worker
# Hover a squiggle for a quick-fix · "Fix all" · "Format document"

import os                      # unused import → Ruff F401
import sys                     # unused import → "Fix all" removes both
from typing import List


def greet(name: str) -> str:
    greeting = "Hi"            # F841: local assigned but never used
    return "Hello, " + name


message: int = greet("world")  # ty: str is not assignable to int

items: List[int] = [1, 2, 3]
print( items )                 # extra spaces → "Format document" tidies them
print(mesage)                  # Ruff F821: undefined name (typo of "message")
`;

// Python editor backed by Ruff (and ty, when its WASM build is vendored in),
// both in a Web Worker.
export function mountPythonDemo(container: HTMLElement): () => void {
    const hint = document.createElement("p");
    hint.className = "demo-hint";
    hint.innerHTML =
        "Backed by <code>@astral-sh/ruff-wasm-web</code> (lint + format) and " +
        "<code>ty</code> (type-checking), both WASM in a Web Worker. Hover a " +
        "diagnostic for quick-fix, <em>Fix all</em>, and <em>Format document</em> " +
        "actions. Locally, run <code>pnpm build:ty-wasm</code> to enable ty; " +
        "the deployed demo builds it in CI.";
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
