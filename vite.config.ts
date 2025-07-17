import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
    test: {
        globals: true,
        environment: "jsdom",
        coverage: {
            enabled: false, // Enable explicitly with --coverage flag
            reporter: ["text", "json", "html"],
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
