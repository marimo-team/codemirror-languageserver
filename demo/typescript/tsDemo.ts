import { javascript } from "@codemirror/lang-javascript";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { languageServerWithClient } from "../../src";
import { createWorkerClient } from "../shared/workerTransport";

const DOCUMENT_URI = "file:///index.ts";

const SAMPLE = `// TypeScript running entirely in your browser (typescript + @typescript/vfs).
// Try these features:
//  - Hover over 'greet' or 'user' to see inferred types
//  - Type 'user.' for completions
//  - Ctrl/Cmd+Click 'greet' to jump to its definition
//  - Put the cursor inside greet(...) for signature help
//  - Press F2 on 'user' to rename it
//  - The line below has a type error on purpose

interface User {
    name: string;
    age: number;
}

function greet(user: User): string {
    return \`Hello, \${user.name} (\${user.age})\`;
}

const user: User = { name: "Ada", age: 36 };
console.log(greet(user));

const wrong: number = "not a number";
`;

/**
 * Mounts a TypeScript editor backed by a TS language service (over
 * `@typescript/vfs`) running in a Web Worker. Exercises completion, hover,
 * go-to-definition, diagnostics, signature help, and rename.
 */
export function mountTypeScriptDemo(container: HTMLElement): () => void {
    const hint = document.createElement("p");
    hint.className = "demo-hint";
    hint.innerHTML =
        "Backed by <code>typescript</code> + <code>@typescript/vfs</code> in a " +
        "Web Worker. Type libraries stream from a CDN on first load, so give " +
        "diagnostics a moment to appear.";
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
                javascript({ typescript: true }),
                tooltips({ position: "absolute" }),
                lintGutter(),
                languageServerWithClient({
                    client,
                    documentUri: DOCUMENT_URI,
                    languageId: "typescript",
                    allowHTMLContent: true,
                    sendIncrementalChanges: false,
                    onGoToDefinition: (result) => {
                        console.debug("Go to definition", result);
                    },
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
