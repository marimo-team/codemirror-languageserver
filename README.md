# CodeMirror 6 Language Server Protocol (LSP) Plugin

[![npm version](https://img.shields.io/npm/v/@marimo-team/codemirror-languageserver.svg)](https://www.npmjs.com/package/@marimo-team/codemirror-languageserver)
[![npm downloads](https://img.shields.io/npm/dm/@marimo-team/codemirror-languageserver.svg)](https://www.npmjs.com/package/@marimo-team/codemirror-languageserver)
[![License](https://img.shields.io/npm/l/@marimo-team/codemirror-languageserver.svg)](https://github.com/marimo-team/codemirror-languageserver/blob/main/LICENSE)
[![CI](https://github.com/marimo-team/codemirror-languageserver/actions/workflows/test.yml/badge.svg)](https://github.com/marimo-team/codemirror-languageserver/actions/workflows/test.yml)

A powerful LSP client plugin for CodeMirror 6 that brings IDE-like features to your editor.

> This is a fork of [FurqanSoftware/codemirror-languageserver](https://github.com/FurqanSoftware/codemirror-languageserver) with additional features and modernization.

## Features

- 🔍 **Code Completion** - Intelligent autocompletion with support for snippets
- 💡 **Hover Information** - Rich documentation on hover
- ⚠️ **Diagnostics** - Real-time error checking and warnings
- 🔄 **Code Actions** - Quick fixes and refactoring suggestions
- 🏷️ **Symbol Renaming** - Smart symbol renaming across files
- 🎯 **Go to Definition** - Jump to symbol definitions
- 🎨 **Markdown Support** - Rich formatting in hover tooltips and documentation

## Installation

```bash
npm install @marimo-team/codemirror-languageserver
# or
pnpm add @marimo-team/codemirror-languageserver
# or
yarn add @marimo-team/codemirror-languageserver
```

## Usage

```typescript
import { languageServer } from '@marimo-team/codemirror-languageserver';
import { EditorState, EditorView } from '@codemirror/basic-setup';
import { WebSocketTransport } from '@open-rpc/client-js';

// Create a WebSocket transport
const transport = new WebSocketTransport('ws://your-language-server-url');

// Configure the language server plugin
const ls = languageServer({
  transport,
  rootUri: 'file:///',
  documentUri: 'file:///path/to/your/file',
  languageId: 'typescript', // Or any other language ID supported by your LSP

  // Optional: Customize keyboard shortcuts
  keyboardShortcuts: {
    rename: 'F2',                // Default: F2
    goToDefinition: 'ctrlcmd',   // Ctrl/Cmd + Click
  },

  // Optional: Allow HTML content in tooltips
  allowHTMLContent: true,
});

// Create editor with the LSP plugin
const view = new EditorView({
  state: EditorState.create({
    doc: 'Your initial content',
    extensions: [
      // ... other extensions ...
      ls
    ]
  }),
  parent: document.querySelector('#editor')
});
```

## Keyboard Shortcuts

- `F2` - Rename symbol under cursor
- `Ctrl/Cmd + Click` - Go to definition
- `Ctrl/Cmd + Space` - Trigger completion manually

## Advanced Configuration

### Sharing Client Across Multiple Instances

```typescript
import { LanguageServerClient } from '@marimo-team/codemirror-languageserver';

const client = new LanguageServerClient({
  transport,
  rootUri: 'file:///',
  workspaceFolders: [{ name: 'workspace', uri: 'file:///' }]
});

// Use in multiple editors
const ls1 = languageServerWithClient({
  client,
  documentUri: 'file:///file1.ts',
  languageId: 'typescript'
});

const ls2 = languageServerWithClient({
  client,
  documentUri: 'file:///file2.ts',
  languageId: 'typescript'
});
```

## Contributing

Contributions are welcome! Feel free to:

- Report bugs
- Suggest new features
- Submit pull requests

Please ensure your PR includes appropriate tests and documentation.

## Demo

Check out our [live demo](https://github.com/mscolnick/codemirror-languageserver/tree/main/demo) to see the plugin in action. Run it locally with `pnpm dev`.

The demo has three tabs, all running in the browser via Web Workers:

- **Mock** — an in-memory language server.
- **Python** — [Ruff](https://github.com/astral-sh/ruff) (`@astral-sh/ruff-wasm-web`) for lint diagnostics, quick-fixes, and formatting.
- **TypeScript** — a TypeScript language service over [`@typescript/vfs`](https://github.com/microsoft/TypeScript-Website/tree/v2/packages/typescript-vfs) for completion, hover, go-to-definition, diagnostics, signature help, and rename.

### Optional: ty type-checking in the Python tab

The Python tab can additionally surface type-check diagnostics from [ty](https://github.com/astral-sh/ty) (Astral's type checker) alongside Ruff's lint output. `ty` is not published to npm, so build its WASM module once (requires a Rust toolchain and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/installer/)):

```bash
pnpm build:ty-wasm
```

This clones ruff into `.cache/` and vendors the build into `demo/vendor/ty_wasm/` (both gitignored). When present, the Python worker loads it automatically; when absent, the demo falls back to Ruff only.

## License

BSD 3-Clause License

## Credits

This is a modernized fork of [FurqanSoftware/codemirror-languageserver](https://github.com/FurqanSoftware/codemirror-languageserver) with additional features:

- Modernized codebase (linting, formatting, etc.)
- Testing
- GitHub Actions CI
- Symbol renaming
- Markdown code completions
- Code completion `resolve` support
- Code actions and quick fixes
- Go-to-definition
- Improved demo page
- Better error handling
- Enhanced documentation
