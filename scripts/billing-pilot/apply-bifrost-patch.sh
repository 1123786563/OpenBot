#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo 'Usage: apply-bifrost-patch.sh BIFROST_SOURCE_DIR' >&2
  exit 2
fi

source_dir=$(cd "$1" && pwd)
repo=$(git rev-parse --show-toplevel)
patch_dir="$repo/deploy/middleware/bifrost/patches"

if [[ ! -f "$source_dir/zhipu-core/providers/openai/chat.go" ]]; then
  echo "Bifrost source is missing core/providers/openai/chat.go: $source_dir" >&2
  exit 1
fi
if [[ ! -f "$source_dir/Dockerfile.zhipu-proxy-go" ]]; then
  echo "Bifrost source is missing Dockerfile.zhipu-proxy-go: $source_dir" >&2
  exit 1
fi

apply_patch() {
  local patch=$1
  if patch --dry-run --forward --batch -p1 -d "$source_dir" < "$patch" >/dev/null 2>&1; then
    patch --forward --batch -p1 -d "$source_dir" < "$patch" >/dev/null
    return
  fi
  if patch --dry-run --forward --batch -R -p1 -d "$source_dir" < "$patch" >/dev/null 2>&1; then
    echo "already applied: $(basename "$patch")"
    return
  fi
  echo "patch does not apply cleanly: $patch" >&2
  exit 1
}

apply_patch "$patch_dir/zhipu-max-output.patch"
apply_patch "$patch_dir/pinned-build-replace.patch"
if command -v git >/dev/null 2>&1 && git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$source_dir" diff --check
fi
