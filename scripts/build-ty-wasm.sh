#!/usr/bin/env bash
#
# Build ty_wasm from the ruff monorepo and vendor it into demo/vendor/ty_wasm/.
# Requires a Rust toolchain, wasm-pack, and git.
#
# Usage:
#   pnpm build:ty-wasm
#   RUFF_REPO=/path/to/ruff pnpm build:ty-wasm   # reuse an existing checkout
#   RUFF_REF=main pnpm build:ty-wasm             # pin a branch/tag/commit
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/demo/vendor/ty_wasm"
RUFF_REF="${RUFF_REF:-main}"

if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "error: wasm-pack not found. Install it: https://rustwasm.github.io/wasm-pack/installer/" >&2
    exit 1
fi

# Use an existing ruff checkout if provided, otherwise clone into .cache.
if [ -n "${RUFF_REPO:-}" ]; then
    RUFF_DIR="$RUFF_REPO"
else
    RUFF_DIR="$ROOT/.cache/ruff"
    if [ ! -d "$RUFF_DIR/.git" ]; then
        echo "Cloning astral-sh/ruff into $RUFF_DIR ..."
        mkdir -p "$ROOT/.cache"
        git clone --filter=blob:none https://github.com/astral-sh/ruff "$RUFF_DIR"
    fi
    echo "Checking out ruff@$RUFF_REF ..."
    git -C "$RUFF_DIR" fetch --quiet origin "$RUFF_REF"
    git -C "$RUFF_DIR" checkout --quiet "$RUFF_REF"
    git -C "$RUFF_DIR" pull --quiet --ff-only origin "$RUFF_REF" || true
fi

echo "Building ty_wasm (this compiles a large Rust project; it can take a while)..."
wasm-pack build "$RUFF_DIR/crates/ty_wasm" --target web --out-dir "$OUT_DIR"

echo "Done. Vendored ty_wasm into $OUT_DIR"
