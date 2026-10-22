#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p sim-core
cp target/wasm32-unknown-unknown/release/sim_core.wasm web/public/sim_core.wasm
ls -lh web/public/sim_core.wasm
