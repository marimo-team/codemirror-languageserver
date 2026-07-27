import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import type { LanguageServerPlugin } from "../plugin.js";
import {
    createFakeClient,
    createPlugin,
    createView,
    flushTicks,
} from "./test-utils.js";

function countDiagnostics(view: EditorView): { from: number; to: number }[] {
    const found: { from: number; to: number }[] = [];
    forEachDiagnostic(view.state, (_d, from, to) => {
        found.push({ from, to });
    });
    return found;
}

function collectDiagnostics(view: EditorView) {
    const found: import("@codemirror/lint").Diagnostic[] = [];
    forEachDiagnostic(view.state, (diagnostic) => {
        found.push(diagnostic);
    });
    return found;
}

afterEach(() => {
    document.body.innerHTML = "";
});

const DOC = "hello world";
const VALID_RANGE = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
};

/** Captures diagnostic-processing failures without leaking rejections to Vitest. */
function trackRejections(plugin: LanguageServerPlugin): unknown[] {
    const rejections: unknown[] = [];
    const original = plugin.processDiagnostics.bind(plugin);
    vi.spyOn(plugin, "processDiagnostics").mockImplementation((params) =>
        original(params).catch((error) => {
            rejections.push(error);
        }),
    );
    return rejections;
}

async function seedDiagnostic(plugin: LanguageServerPlugin) {
    await plugin.processDiagnostics({
        uri: "file:///test.ts",
        diagnostics: [{ range: VALID_RANGE, message: "existing" }],
    });
}

function publish(plugin: LanguageServerPlugin, params: unknown): void {
    plugin.processNotification({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed payloads
        params: params as any,
    });
}

describe("document isolation", () => {
    it("ignores publishDiagnostics for a URI other than this plugin's document", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///other.ts",
            diagnostics: [
                { range: VALID_RANGE, message: "belongs to another file" },
            ],
        });

        expect(countDiagnostics(view)).toHaveLength(0);
    });

    it("does not treat a percent-encoding variant of the URI as the same document", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view, createFakeClient(), {
            documentUri: "file:///my%20doc.ts",
        });

        await plugin.processDiagnostics({
            uri: "file:///my doc.ts",
            diagnostics: [
                { range: VALID_RANGE, message: "decoded uri variant" },
            ],
        });

        expect(countDiagnostics(view)).toHaveLength(0);
    });

    it("does not treat a case variant of the URI as the same document", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///Test.ts",
            diagnostics: [{ range: VALID_RANGE, message: "case variant" }],
        });

        expect(countDiagnostics(view)).toHaveLength(0);
    });

    it("applies a publish for the plugin's own document uri", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [{ range: VALID_RANGE, message: "mine" }],
        });

        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });
});

describe("malformed publishDiagnostics payloads", () => {
    it("ignores a publish whose diagnostics member is not an array", async () => {
        for (const diagnostics of [undefined, null, "not-an-array"]) {
            const view = createView(DOC);
            const plugin = createPlugin(view);
            await seedDiagnostic(plugin);
            const rejections = trackRejections(plugin);

            expect(() =>
                publish(plugin, { uri: "file:///test.ts", diagnostics }),
            ).not.toThrow();
            await flushTicks();

            expect(rejections).toEqual([]);
            expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
        }
    });

    it("ignores a publish with a missing uri", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        await seedDiagnostic(plugin);
        const rejections = trackRejections(plugin);

        expect(() =>
            publish(plugin, {
                diagnostics: [{ range: VALID_RANGE, message: "no uri" }],
            }),
        ).not.toThrow();
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });

    it("survives a publish with a negative line number", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        await seedDiagnostic(plugin);
        const rejections = trackRejections(plugin);

        expect(() =>
            publish(plugin, {
                uri: "file:///test.ts",
                diagnostics: [
                    {
                        range: {
                            start: { line: -1, character: 0 },
                            end: { line: -1, character: 3 },
                        },
                        message: "negative line",
                    },
                ],
            }),
        ).not.toThrow();
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });

    it("survives a publish whose range is missing entirely", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        await seedDiagnostic(plugin);
        const rejections = trackRejections(plugin);

        expect(() =>
            publish(plugin, {
                uri: "file:///test.ts",
                diagnostics: [{ message: "no range at all" }],
            }),
        ).not.toThrow();
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });

    it("drops diagnostics whose range has a negative character", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        const rejections = trackRejections(plugin);

        publish(plugin, {
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: -5 },
                        end: { line: 0, character: 2 },
                    },
                    message: "negative character",
                },
            ],
        });
        await flushTicks();

        expect(rejections).toEqual([]);
        for (const { from } of countDiagnostics(view)) {
            expect(from).toBeGreaterThanOrEqual(0);
        }
    });

    it("drops diagnostics whose range has a non-numeric character", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        const rejections = trackRejections(plugin);

        publish(plugin, {
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: "oops" },
                        end: { line: 0, character: "oops" },
                    },
                    message: "non-numeric character",
                },
            ],
        });
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(() => countDiagnostics(view)).not.toThrow();
        expect(countDiagnostics(view)).toHaveLength(0);
    });

    it("drops a diagnostic whose end precedes its start", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        const rejections = trackRejections(plugin);

        publish(plugin, {
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 5 },
                        end: { line: 0, character: 1 },
                    },
                    message: "inverted range",
                },
            ],
        });
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(countDiagnostics(view)).toHaveLength(0);
    });
});

describe("diagnostic version tracking", () => {
    it("does not permanently suppress diagnostics after a bogus version", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: Number.MAX_SAFE_INTEGER,
            diagnostics: [{ range: VALID_RANGE, message: "bogus version" }],
        });

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 2,
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    message: "normal publish",
                },
            ],
        });

        expect(countDiagnostics(view)).toEqual([{ from: 6, to: 11 }]);
    });

    it("ignores a publish with a non-numeric version", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 1,
            diagnostics: [{ range: VALID_RANGE, message: "first" }],
        });

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed payload
            version: "abc" as any,
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    message: "bad version",
                },
            ],
        });

        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 2,
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    message: "second",
                },
            ],
        });
        expect(countDiagnostics(view)).toEqual([{ from: 6, to: 11 }]);
    });

    it("does not let an unversioned publish overwrite a newer versioned one", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 5,
            diagnostics: [{ range: VALID_RANGE, message: "current" }],
        });

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    message: "unversioned straggler",
                },
            ],
        });

        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });

    it("ignores an older versioned publish after a newer one", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 7,
            diagnostics: [{ range: VALID_RANGE, message: "newer" }],
        });

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            version: 6,
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    message: "older",
                },
            ],
        });

        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });
});

describe("notification routing", () => {
    it("ignores unknown notification methods without throwing", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        await seedDiagnostic(plugin);

        for (const method of [
            "$/progress",
            "window/logMessage",
            "telemetry/event",
            "totally/madeUp",
        ]) {
            expect(() =>
                plugin.processNotification({
                    jsonrpc: "2.0",
                    method,
                    params: { anything: true },
                    // biome-ignore lint/suspicious/noExplicitAny: methods outside LSPEventMap
                } as any),
            ).not.toThrow();
        }
        await flushTicks();

        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });

    it("ignores a notification with no params", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);
        await seedDiagnostic(plugin);
        const rejections = trackRejections(plugin);

        expect(() =>
            plugin.processNotification({
                jsonrpc: "2.0",
                method: "textDocument/publishDiagnostics",
                // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed payload
            } as any),
        ).not.toThrow();
        await flushTicks();

        expect(rejections).toEqual([]);
        expect(countDiagnostics(view)).toEqual([{ from: 0, to: 5 }]);
    });
});

describe("diagnostic severity", () => {
    it("defaults to a severity for an unknown severity value", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [
                {
                    range: VALID_RANGE,
                    message: "unknown severity",
                    // biome-ignore lint/suspicious/noExplicitAny: outside DiagnosticSeverity
                    severity: 99 as any,
                },
            ],
        });

        const [diagnostic] = collectDiagnostics(view);
        expect(["error", "warning", "info", "hint"]).toContain(
            diagnostic?.severity,
        );
    });

    it("defaults to a severity when severity is omitted", async () => {
        const view = createView(DOC);
        const plugin = createPlugin(view);

        await plugin.processDiagnostics({
            uri: "file:///test.ts",
            diagnostics: [{ range: VALID_RANGE, message: "no severity" }],
        });

        const [diagnostic] = collectDiagnostics(view);
        expect(["error", "warning", "info", "hint"]).toContain(
            diagnostic?.severity,
        );
    });
});
