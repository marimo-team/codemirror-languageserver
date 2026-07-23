import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
    // ESM module workers so the demo workers can use top-level await / imports.
    worker: { format: "es" },
    build: {
        // Top-level await in the ruff/typescript workers.
        target: "esnext",
    },
    optimizeDeps: {
        // ruff-wasm-web resolves its .wasm via import.meta.url; pre-bundling
        // breaks that, so keep it external during dev.
        exclude: ["@astral-sh/ruff-wasm-web"],
        esbuildOptions: { target: "esnext" },
    },
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: ["./src/__tests__/setup.ts"],
        coverage: {
            enabled: true,
            reporter: ["text", "html", "json-summary", "json"],
            reportOnFailure: true,
            exclude: [
                "coverage/**",
                "dist/**",
                "demo/**",
                "**/*.d.ts",
                "**/*.test.ts",
                "src/__tests__/setup.ts",
                "vite.config.ts",
            ],
            include: ["src/**/*.ts"],
        },
    },
    base: "/codemirror-languageserver/",
});
