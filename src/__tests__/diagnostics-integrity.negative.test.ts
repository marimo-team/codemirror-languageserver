import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { LanguageServerClient } from "../lsp.js";
import type { FeatureOptions } from "../lsp.js";
import { LanguageServerPlugin } from "../plugin.js";

const featureOptions: Required<FeatureOptions> = {
    diagnosticsEnabled: true,
    hoverEnabled: true,
    completionEnabled: true,
    definitionEnabled: true,
    renameEnabled: true,
    codeActionsEnabled: false,
    signatureHelpEnabled: true,
    signatureActivateOnTyping: false,
    signatureHelpOptions: { position: "below" },
};

interface FakeClientOverrides {
    ready?: boolean;
    capabilities?: LSP.ServerCapabilities;
    initializePromise?: Promise<void>;
}

function createFakeClient(overrides: FakeClientOverrides = {}) {
    return {
        ready: overrides.ready ?? true,
        capabilities: overrides.capabilities ?? {
            hoverProvider: true,
            renameProvider: true,
        },
        dynamicCapabilities: new Map(),
        hasCapability: LanguageServerClient.prototype.hasCapability,
        initializePromise: overrides.initializePromise ?? Promise.resolve(),
        onNotification: vi.fn().mockReturnValue(() => {}),
        textDocumentDidOpen: vi.fn().mockResolvedValue(undefined),
        textDocumentDidChange: vi.fn().mockResolvedValue(undefined),
        textDocumentDidClose: vi.fn().mockResolvedValue(undefined),
        textDocumentWillSave: vi.fn().mockResolvedValue(undefined),
        textDocumentWillSaveWaitUntil: vi.fn().mockResolvedValue(null),
        textDocumentDidSave: vi.fn().mockResolvedValue(undefined),
        textDocumentCodeAction: vi.fn().mockResolvedValue(null),
        textDocumentPrepareRename: vi.fn(),
        textDocumentRename: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: partial stub of the client
    } as any as LanguageServerClient;
}

function createView(doc: string): EditorView {
    return new EditorView({
        state: EditorState.create({ doc }),
        parent: document.createElement("div"),
    });
}

function createPlugin(
    view: EditorView,
    client = createFakeClient(),
    options: Partial<
        ConstructorParameters<typeof LanguageServerPlugin>[0]
    > = {},
) {
    return new LanguageServerPlugin({
        client,
        documentUri: "file:///test.ts",
        languageId: "typescript",
        view,
        featureOptions,
        ...options,
    });
}

async function flushTicks(count = 5) {
    for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

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

/**
 * Wraps `processDiagnostics` so the promise `processNotification` throws away
 * is observed instead of escaping as an unhandled rejection.
 *
 * A bare `process.on("unhandledRejection", ...)` listener does not work here:
 * vitest installs its own listener that stays registered, so a real unhandled
 * rejection is reported as a file-level "Unhandled Error" and turns the whole
 * run red regardless of `it.fails`. Attaching a handler to the actual promise
 * both detects the rejection and keeps it from escaping.
 */
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

/** Puts one well-formed diagnostic in the state to detect later clobbering. */
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
    // BUG: a publish whose `diagnostics` is not an array should be ignored —
    // currently `params.diagnostics.map(...)` throws a TypeError inside the
    // async processDiagnostics, which escapes as an unhandled rejection
    it.fails(
        "ignores a publish whose diagnostics member is not an array",
        async () => {
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
        },
    );

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

    // BUG: a negative line should drop that diagnostic and leave the rest of
    // the publish alone — currently posToOffset calls doc.line(0) and throws
    // RangeError "Invalid line number 0 in 1-line document", rejecting the
    // whole publish as an unhandled rejection
    it.fails("survives a publish with a negative line number", async () => {
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

    // BUG: a diagnostic with no range should be dropped — currently
    // `range.start` throws TypeError "Cannot read properties of undefined
    // (reading 'start')" and the whole publish rejects
    it.fails("survives a publish whose range is missing entirely", async () => {
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

    // BUG: a negative character should drop the diagnostic — currently
    // posToOffset returns line.from + character = -5 and the diagnostic is
    // published at from: -5, which setDiagnostics accepts silently
    it.fails(
        "drops diagnostics whose range has a negative character",
        async () => {
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
            // A negative offset is not a position in the document
            for (const { from } of countDiagnostics(view)) {
                expect(from).toBeGreaterThanOrEqual(0);
            }
        },
    );

    // BUG: a non-numeric character should drop the diagnostic — currently
    // posToOffset produces NaN, the diagnostic is published at from/to NaN,
    // and reading the range set back throws "Cannot read properties of null
    // (reading 'endSide')"
    it.fails(
        "drops diagnostics whose range has a non-numeric character",
        async () => {
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
            // A NaN offset corrupts the range set: reading it back must not throw
            expect(() => countDiagnostics(view)).not.toThrow();
            expect(countDiagnostics(view)).toHaveLength(0);
        },
    );

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
    // BUG: one publish carrying an absurd version must not wedge the plugin
    // forever — currently lastSeenDiagnosticsVersion is set to
    // Number.MAX_SAFE_INTEGER and every subsequent publish is dropped as stale
    it.fails(
        "does not permanently suppress diagnostics after a bogus version",
        async () => {
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
        },
    );

    // BUG: a non-numeric version is not a version and the publish should be
    // ignored — currently it is applied and the string is stored as
    // lastSeenDiagnosticsVersion, poisoning every later ordering comparison
    it.fails("ignores a publish with a non-numeric version", async () => {
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

        // Ordering still works afterwards
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

    // BUG: an unversioned publish must not clobber diagnostics from a newer
    // versioned publish — currently the version guard is skipped entirely when
    // params.version is null/undefined, so the older payload wins
    it.fails(
        "does not let an unversioned publish overwrite a newer versioned one",
        async () => {
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
        },
    );

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

    // BUG: a notification with no params must be ignored — currently
    // processDiagnostics reads params.uri and throws asynchronously, and
    // processNotification's synchronous try/catch cannot catch it, so it
    // escapes as an unhandled rejection
    it.fails("ignores a notification with no params", async () => {
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
    // BUG: an unknown severity should fall back to a valid CodeMirror severity
    // — currently severityMap[99] is undefined and the diagnostic is published
    // with severity: undefined, which CodeMirror cannot style or filter
    it.fails(
        "defaults to a severity for an unknown severity value",
        async () => {
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
        },
    );

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
