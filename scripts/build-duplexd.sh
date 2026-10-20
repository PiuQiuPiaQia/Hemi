#!/bin/zsh
# 019：编译原生双工守护进程（Swift 独立进程，选型见 019 technical-plan）。
# 产物 dist/duplexd（已 gitignore）；可用 HEMI_DUPLEX_BIN 指向其他位置。
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
swiftc -O src/main/audio/duplexd/main.swift -o dist/duplexd
echo "built dist/duplexd"
