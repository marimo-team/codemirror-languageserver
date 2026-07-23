# codemirror-languageserver

CodeMirror 6 client plugin for the Language Server Protocol (completion, hover, diagnostics, signature help, rename). A modernized fork of FurqanSoftware/codemirror-languageserver, published to npm as `@marimo-team/codemirror-languageserver` and used by marimo's editor.

## Development

```bash
pnpm install --ignore-scripts --frozen-lockfile  # CI install
pnpm test              # vitest
pnpm run lint          # biome check --write (autofix.ci runs this on PRs)
pnpm run lint:ci       # biome check — non-mutating lint CI enforces
pnpm run typecheck     # tsc --noEmit
pnpm run build:demo    # vite build of demo/ (the demo script is build:demo, not demo)
pnpm run dev           # vite dev server
```

- Licensed BSD-3-Clause (inherited from the upstream fork), unlike the Apache-2.0 sibling repos.
- Release: pushing a `v*` tag triggers release.yml, which publishes to npm via OIDC.
