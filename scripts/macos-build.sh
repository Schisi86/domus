#!/usr/bin/env bash
# Builds the macOS installer on a Mac (Apple Silicon or Intel).
#
# Needs: Xcode Command Line Tools (xcode-select --install), Rust (https://rustup.rs)
# and Node.js 20+. Output:
#   target/universal-apple-darwin/release/bundle/dmg/Domus_<version>_universal.dmg
#
# The app is signed ad hoc ("-") but not notarized: on first start macOS asks
# for confirmation (System Settings › Privacy & Security › "Open Anyway").
set -euo pipefail
cd "$(dirname "$0")/.."
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo test -p nexus-server -p nexus-net -p nexustalk
npm ci --prefix app
(cd app && npx tauri build --target universal-apple-darwin --bundles app,dmg)
cd target/universal-apple-darwin/release/bundle/dmg
shasum -a 256 ./*.dmg | tee SHA256SUMS.txt
