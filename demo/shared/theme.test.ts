import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { registerEditor, setThemeMode, themeExtension } from "./theme.js";

it("reuses demo styles across editors and theme toggles", () => {
    const views = [0, 1].map(
        () =>
            new EditorView({
                state: EditorState.create({ extensions: themeExtension() }),
            }),
    );
    const unregister = views.map(registerEditor);
    const modules = () =>
        views.map((view) => view.state.facet(EditorView.styleModule));
    try {
        setThemeMode("light");
        const light = modules();
        setThemeMode("dark");
        const dark = modules();
        setThemeMode("light");
        const restored = modules();
        for (const pair of [light, dark, restored]) {
            expect(pair[0].length).toBeGreaterThan(0);
            expect(pair[1]).toHaveLength(pair[0].length);
            pair[0].forEach((module, index) =>
                expect(pair[1][index]).toBe(module),
            );
        }
        light[0].forEach((module, index) =>
            expect(restored[0][index]).toBe(module),
        );
    } finally {
        for (const dispose of unregister) dispose();
        for (const view of views) view.destroy();
    }
});
