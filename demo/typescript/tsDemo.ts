import { javascript } from "@codemirror/lang-javascript";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { languageServerWithClient } from "../../src";
import { createWorkerClient } from "../shared/workerTransport";

const DOCUMENT_URI = "file:///index.ts";

const SAMPLE = `// TypeScript · runs entirely in your browser (typescript + @typescript/vfs)
// hover · go-to-def (Ctrl/Cmd+Click) · completions (Ctrl/Cmd+Space) · F2 rename

interface User {
    name: string;
    age: number;
}

/** @deprecated Use greet() instead. */
function hi(user: User): string {          // deprecated → struck through on use
    return "hi " + user.name;
}

function greet(user: User): string {       // hover for its type · go-to-def target
    const unused = "never read";           // unused local variable → diagnostic
    return \`Hello, \${user.name} (\${user.age})\`;
}

const ada: User = { name: "Ada", age: 36 };

greet(ada);        // put the cursor inside (…) for signature help; F2 renames \`ada\`
hi(ada);           // deprecated call → struck through

ada.name;          // type \`ada.\` and press Ctrl/Cmd+Space for completions

const total: number = "oops";     // type error: string is not assignable to number
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
