import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
    test: {
        globals: true,
        environment: "jsdom",
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
                "vite.config.ts",
            ],
            include: ["src/**/*.ts"],
        },
    },
    base: "/codemirror-languageserver/",
});
