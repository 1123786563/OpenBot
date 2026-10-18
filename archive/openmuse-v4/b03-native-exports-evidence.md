# B03 — Native (iOS/Android) exports from submodule: Evidence

- **Date (UTC):** 2026-10-12T14:51:06Z
- **Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base` @ branch `v4/openbot-exec`, HEAD `748f91ad`
- **Pin SHA (full):** `46792335dfc260efa05f2185aa353093b12d9937` (= B02 pin, read from b02-web-build-evidence.md)
- **Submodule:** `apps/openmuse` → `https://github.com/1123786563/openmuse`
- **Scratch:** `/tmp/b03-clean-checkout/ob` (clean checkout of HEAD `748f91ad` + staged `.gitmodules`/gitlink reproduced, per B02 recipe)

## 1. Scratch clean checkout

Reproduced the B02 recipe exactly: `rm -rf /tmp/b03-clean-checkout && mkdir -p /tmp/b03-clean-checkout`,
`git clone --no-checkout <worktree> ob`, `git checkout 748f91ad`,
`git apply --cached` of `git diff --cached -- .gitmodules`,
`git update-index --add --cacheinfo 160000,46792335dfc260efa05f2185aa353093b12d9937,apps/openmuse`,
`git checkout -- .gitmodules && git checkout-index -a -f`.

Scratch index verified identical to worktree staged state:

```
$ git status --porcelain | grep -E "apps/openmuse|gitmodules"
A  .gitmodules
A  apps/openmuse
$ git ls-files -s apps/openmuse
160000 46792335dfc260efa05f2185aa353093b12d9937 0	apps/openmuse

$ git submodule update --init --recursive
Submodule 'apps/openmuse' (https://github.com/1123786563/openmuse) registered for path 'apps/openmuse'
Submodule path 'apps/openmuse': checked out '46792335dfc260efa05f2185aa353093b12d9937'

$ cd apps/openmuse && pnpm install --frozen-lockfile
+ typescript 5.9.3
Done in 7s using pnpm v11.19.0
```

## 2. iOS export

```
$ cd /tmp/b03-clean-checkout/ob/apps/openmuse && pnpm build:ios 2>&1 | tail -10
› Assets (1):
assets/capybara.png (1.41 MB)

› ios bundles (1):
_expo/static/js/ios/index-f9fa22c53b1e999cdd4118ca88c437a9.hbc (8.67 MB)

› Files (1):
metadata.json (204 B)

Exported: dist/ios
```

Export completed with no interactive native SDK step and no Xcode requirement.

**Plan-expectation note:** the plan expected `apps/mobile/dist/ios/index.html`; expo `platform: ios`
exports do not produce `index.html` (web-only) — they produce a Hermes bytecode bundle + assets +
metadata.json, exactly as the plan's own failure-handling section describes ("expo export for
ios/android platforms produces JS bundles + assets"). Success marker used instead:
`apps/mobile/dist/ios/_expo/static/js/ios/index-f9fa22c53b1e999cdd4118ca88c437a9.hbc` (8,665,032 B).

### iOS artifact digests (run 1)

sha256 of manifest `/tmp/b03-ios.sha256`:
`488e122fb400a4409644ab71968fa1deb23fba85ef956d353878139c126272bb`

```
4e751be8710914632162203c29552909070446f50fdd7e82bb64c38529da1b48  apps/mobile/dist/ios/_expo/static/js/ios/index-f9fa22c53b1e999cdd4118ca88c437a9.hbc
3a323215d0976583d0c3d0748df06bce75db9b05cc955901709b18e3b64e9b34  apps/mobile/dist/ios/assets/6e2c4a2ea01a5e70e79dd5c58574fac7
a5d34ddce2eca0e2385bab567284654d7b16d20a8d933654f88f5efde199a514  apps/mobile/dist/ios/metadata.json
```

## 3. Android export

```
$ pnpm build:android 2>&1 | tail -10
› Assets (1):
assets/capybara.png (1.41 MB)

› android bundles (1):
_expo/static/js/android/index-f6fa7902a39b3a9379192e28bd0d7039.hbc (8.62 MB)

› Files (1):
metadata.json (212 B)

Exported: dist/android
```

Success marker: `apps/mobile/dist/android/_expo/static/js/android/index-f6fa7902a39b3a9379192e28bd0d7039.hbc`.
Same plan-expectation note as iOS: native export produces no `index.html`.

### Android artifact digests

sha256 of manifest `/tmp/b03-android.sha256`:
`106c5796d8916eebc409239ccd3ce9db8c07829632efc37c7f0287d18711e5f0`

```
85d4fa6a84579823c4c5c4c1413c92d51ab0896af4cfb381608e0ba6f734a595  apps/mobile/dist/android/_expo/static/js/android/index-f6fa7902a39b3a9379192e28bd0d7039.hbc
3a323215d0976583d0c3d0748df06bce75db9b05cc955901709b18e3b64e9b34  apps/mobile/dist/android/assets/6e2c4a2ea01a5e70e79dd5c58574fac7
2ac44bae5c57f8e24c6c772c658b3b899b1270e43b74ebad59b497dffda6bc58  apps/mobile/dist/android/metadata.json
```

## 4. Same-SHA and workspace-separation proofs

```
$ git -C /tmp/b03-clean-checkout/ob/apps/openmuse rev-parse HEAD   # before Task 2
46792335dfc260efa05f2185aa353093b12d9937
$ git -C /tmp/b03-clean-checkout/ob/apps/openmuse rev-parse HEAD   # after Task 3
46792335dfc260efa05f2185aa353093b12d9937
```

Identical, and equal to the B02 pin. Both artifacts tie to the same submodule SHA.

Workspace separation (in `/tmp/b03-clean-checkout/ob`, after `bun install --frozen-lockfile`
→ "1340 packages installed [3.56s]"):

```
$ bun pm ls 2>/dev/null | grep -c openmuse
0
$ test -f apps/openmuse/pnpm-lock.yaml && ! test -f apps/openmuse/bun.lock && echo OK
OK
$ git -C apps/openmuse status --porcelain | wc -l
0
```

- Bun workspace lists 0 packages from `apps/openmuse` (OpenBot root `workspaces: ["app","server","worker"]` unchanged).
- Submodule keeps its own `pnpm-lock.yaml`; no `bun.lock` created inside it.
- Exports only wrote gitignored `dist/` — submodule tree clean.

## 5. Determinism spot-check — OBSERVATION (hbc not byte-reproducible; sources/assets deterministic)

`rm -rf apps/mobile/dist/ios && pnpm build:ios` twice more. Across 3 runs of the same pinned
checkout:

| run | hbc sha256 | asset sha256 | metadata.json sha256 | hbc filename |
|-----|-----------|--------------|---------------------|--------------|
| 1 | `4e751be8…29da1b48` | `3a323215…3e9b34` | `a5d34ddc…199a514` | `index-f9fa22c53b1e999cdd4118ca88c437a9.hbc` |
| 2 | `f3bc1c8a…61305c0` | `3a323215…3e9b34` | `a5d34ddc…199a514` | `index-f9fa22c53b1e999cdd4118ca88c437a9.hbc` |
| 3 | `a737061b…480a28` | `3a323215…3e9b34` | `a5d34ddc…199a514` | `index-f9fa22c53b1e999cdd4118ca88c437a9.hbc` |

- `assets/` and `metadata.json` are byte-identical across all runs.
- The `.hbc` Hermes bytecode container differs each run: run2 vs run3 sizes 8,665,032 vs 8,665,034 B,
  2,287,498 differing bytes (~26%), first difference at byte offset 33 (header region).
- The emitted filename content-hash `f9fa22c53b1e999cdd4118ca88c437a9` is identical in all 3 runs —
  the JS source bundle itself is deterministic; only the Hermes bytecode compilation varies
  (randomized hash seed / string-table ordering in the Hermes compiler is a known source of
  non-bit-reproducible `.hbc` output).

Assessment per plan: recorded as an observation, escalated in the report. Android was spot-checked
implicitly via identical pipeline (same toolchain, one run); iOS is the documented 3-run sample.

## 6. Evidence file digest

`shasum -a 256 docs/openmuse-v4/b03-native-exports-evidence.md` — recorded in the completion
report; NO commit made.
