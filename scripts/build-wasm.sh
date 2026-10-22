#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p sim-core
# The folder only ever holds this generated file, so a fresh clone has no web/public.
mkdir -p web/public
cp target/wasm32-unknown-unknown/release/sim_core.wasm web/public/sim_core.wasm
ls -lh web/public/sim_core.wasm
