import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
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
