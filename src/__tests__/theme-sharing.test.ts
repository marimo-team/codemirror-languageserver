import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { languageServerWithClient } from "../plugin.js";
import { createFakeClient } from "./test-utils.js";

it.each([
    { diagnosticsEnabled: true, completionEnabled: false },
    { diagnosticsEnabled: false, completionEnabled: true },
    { diagnosticsEnabled: true, completionEnabled: true },
])("shares style modules with %j", (features) => {
    const createModules = () =>
        EditorState.create({
            extensions: languageServerWithClient({
                client: createFakeClient(),
                documentUri: "file:///test.py",
                languageId: "python",
                ...features,
            }),
        }).facet(EditorView.styleModule);
    const first = createModules();
    const second = createModules();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(first.length);
    first.forEach((module, index) => expect(second[index]).toBe(module));
});
