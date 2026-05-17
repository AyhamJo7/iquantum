#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SPEC="${PACKAGE_SPEC:-@iquantum/cli}"
EXPECTED_VERSION="${EXPECTED_VERSION:-2.0.0}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/ayhamjo7/iquantum-sandbox:latest}"
WORKDIR="$(mktemp -d)"
PREFIX="$WORKDIR/npm-global"
HOME_DIR="$WORKDIR/home"
BUN_BIN_DIR="$(dirname "$(command -v bun)")"

cleanup() {
  if command -v iq >/dev/null 2>&1; then
    iq daemon stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$PREFIX" "$HOME_DIR"
export HOME="$HOME_DIR"
export PATH="$PREFIX/bin:$BUN_BIN_DIR:$PATH"

echo "installing $PACKAGE_SPEC"
npm install -g "$PACKAGE_SPEC" --prefix "$PREFIX"

echo "checking version"
test "$(iq --version)" = "$EXPECTED_VERSION"

echo "writing config"
iq config set ANTHROPIC_API_KEY sk-ant-smoke
iq config set IQUANTUM_SANDBOX_IMAGE "$SANDBOX_IMAGE"
test "$(iq config get ANTHROPIC_API_KEY)" = "sk-...moke"

echo "checking daemon lifecycle"
iq daemon start
for _ in $(seq 1 30); do
  if iq daemon status | grep -q "daemon is running"; then
    break
  fi
  sleep 1
done
iq daemon status | grep -q "daemon is running"
iq daemon stop

echo "smoke test passed"
