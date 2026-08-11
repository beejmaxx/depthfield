#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_DIR="$PROJECT_DIR/dist/Depthfield.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

cd "$PROJECT_DIR"
cargo build --release

mkdir -p "$MACOS_DIR"
cp "$PROJECT_DIR/target/release/depthfield" "$MACOS_DIR/Depthfield"
cp "$PROJECT_DIR/packaging/Info.plist" "$CONTENTS_DIR/Info.plist"

chmod +x "$MACOS_DIR/Depthfield"
codesign --force --sign - "$APP_DIR"
echo "$APP_DIR"
