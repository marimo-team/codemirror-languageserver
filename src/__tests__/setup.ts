// jsdom does not implement Range.getClientRects / getBoundingClientRect, which
// CodeMirror calls from its asynchronous layout measurement. Tests that mount a
// real EditorView schedule a measure via requestAnimationFrame that fires after
// the test body finishes, so without these stubs the measure throws an
// unhandled error and fails the run even though every assertion passed.
if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
        Range.prototype.getClientRects = () =>
            ({
                length: 0,
                item: () => null,
                [Symbol.iterator]: function* () {},
                // biome-ignore lint/suspicious/noExplicitAny: minimal jsdom stub
            }) as any;
    }
    if (!Range.prototype.getBoundingClientRect) {
        Range.prototype.getBoundingClientRect = () =>
            ({
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                toJSON: () => ({}),
                // biome-ignore lint/suspicious/noExplicitAny: minimal jsdom stub
            }) as any;
    }
}
