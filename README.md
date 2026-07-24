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
- `Ctrl/Cmd + .` - Open the code action menu at the cursor/selection

## Advanced Configuration

### Completion Behavior

```typescript
const ls = languageServer({
  // ...

  // Optional: Filter complete (`isIncomplete: false`) completion lists
  // client-side instead of re-querying the server on every keystroke.
  clientSideFiltering: true,
});
```

Completion items the server marks deprecated get a `cm-deprecated` class,
shown with a strikethrough by default. Override with:

```css
.cm-tooltip-autocomplete li.cm-deprecated .cm-completionLabel {
  text-decoration: line-through;
  opacity: 0.7;
}
```

### Code Actions

Pressing `Ctrl/Cmd + .` (configurable via `keyboardShortcuts.codeActions`)
requests code actions for the current selection — including refactors and
source actions not tied to a diagnostic — and shows them in a small menu at
the cursor. Actions the server provides lazily (without an edit) are resolved
via `codeAction/resolve` before being applied.

Hosts can replace the built-in menu with their own UI:

```typescript
const ls = languageServer({
  // ...
  codeActionsConfig: {
    renderMenu: (actions, apply) => {
      // Render your own menu; call apply(action) with the chosen action.
      myMenu.show(actions.map((a) => ({
        label: a.title,
        onSelect: () => apply(a),
      })));
    },
  },
});
```

Custom entry points (e.g. an "Organize imports" button) can request filtered
actions directly through the plugin:

```typescript
import { getLanguageServerPlugin } from '@marimo-team/codemirror-languageserver';

const plugin = getLanguageServerPlugin(view);
if (plugin) {
  const wholeDocument = {
    start: { line: 0, character: 0 },
    end: { line: view.state.doc.lines - 1, character: 0 },
  };
  const actions = await plugin.requestCodeActions(view, wholeDocument, [
    'source.organizeImports',
  ]);
  if (actions?.[0]) {
    await plugin.applyCodeAction(actions[0]);
  }
}
```

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

Check out our [live demo](https://github.com/mscolnick/codemirror-languageserver/tree/main/demo) to see the plugin in action.

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
