#!/usr/bin/env bash
set -euo pipefail

# Build the Docker image for Linux and save it to a .tar for transfer.
#
# Optional environment overrides:
#   PLATFORM   default linux/amd64  (e.g. linux/arm64 for ARM Linux hosts)
#   VERSION    default version from package.json
#   IMAGE      default c-interface-discovery:<VERSION>
#   OUTPUT     default <repo>/c-interface-discovery-<VERSION>-<platform>.tar

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLATFORM="${PLATFORM:-linux/amd64}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
IMAGE="${IMAGE:-c-interface-discovery:${VERSION}}"
PLATFORM_FILE="${PLATFORM//\//-}"
OUTPUT="${OUTPUT:-$ROOT/c-interface-discovery-${VERSION}-${PLATFORM_FILE}.tar}"

echo "Building $IMAGE for $PLATFORM ..."
docker build --platform "$PLATFORM" -t "$IMAGE" .

echo "Saving to $OUTPUT ..."
docker save "$IMAGE" -o "$OUTPUT"

ls -lh "$OUTPUT"
