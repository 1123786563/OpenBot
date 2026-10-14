# B02 — Canonical Web build from submodule: Evidence

> **pin amended by coordinator 2026-10-12: user committed main.**
> Plan specified `1ac68f3`; during execution `git ls-remote ... refs/heads/main` returned
> `46792335dfc260efa05f2185aa353093b12d9937` ("将移动端 UI 本地化为中文并添加 OpenBot 集成文档",
> the previously-staged 54-file changeset, direct child of `1ac68f3`). Coordinator directed pinning
> `4679233` (committed + pushed) instead. NOT-IN-PIN example amended from `strings.ts` to
> `docs/superpowers/ledger`.

- **Date (UTC):** 2026-10-12T14:41:55Z
- **Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base` @ branch `v4/openbot-exec`, HEAD `748f91ad`
- **Pin SHA (full):** `46792335dfc260efa05f2185aa353093b12d9937`
- **Submodule:** `apps/openmuse` → `https://github.com/1123786563/openmuse`

## 1. Pin verification (ls-remote)

```
$ git ls-remote https://github.com/1123786563/openmuse refs/heads/main
46792335dfc260efa05f2185aa353093b12d9937	refs/heads/main
```

Remote main HEAD equals the pinned SHA.

## 2. Staged index state (uncommitted checkpoint — NO commit made)

```
$ git status --porcelain | grep -E "apps/openmuse|gitmodules"
A  .gitmodules
A  apps/openmuse

$ git ls-files -s apps/openmuse
160000 46792335dfc260efa05f2185aa353093b12d9937 0	apps/openmuse

$ cat .gitmodules
[submodule "apps/openmuse"]
	path = apps/openmuse
	url = https://github.com/1123786563/openmuse
```

Exactly one submodule entry, no `branch` pin. OpenBot Bun workspace unchanged: `["app","server","worker"]`.

## 3. In-place Web build (fast feedback)

```
$ cd apps/openmuse && pnpm install --frozen-lockfile | tail
+ typescript 5.9.3
Done in 7.7s using pnpm v11.19.0
$ git -C apps/openmuse status --porcelain   # lockfile untouched → empty

$ pnpm build:web | tail
› web bundles (2):
_expo/static/js/web/browser-a16dc6a975c4405df5be736d4a266e08.js (349 B)
_expo/static/js/web/index-c9e2fe803a32494132849f829b9c99a9.js (5.18 MB)
› Files (2):
index.html (1.21 kB)
metadata.json (49 B)
Exported: dist/web
```

`apps/openmuse/apps/mobile/dist/web/index.html` exists.

### Artifact digests (in-place)

sha256 of manifest `/tmp/b02-web-files.sha256`:
`b04b550fb04bf9e2ac196b90e3244f25192013dfbd9e9b02d4d7d8b6727b0152`

```
24138521ff8310bcf549bcb99bccf4963578dab020793387c0d2e464d7336bf5  _expo/static/js/web/browser-a16dc6a975c4405df5be736d4a266e08.js
b79b59569611ec123d6cfd337557fe8c24c8f7881b1bc2311b30352f22959951  _expo/static/js/web/index-c9e2fe803a32494132849f829b9c99a9.js
3a323215d0976583d0c3d0748df06bce75db9b05cc955901709b18e3b64e9b34  assets/assets/capybara.6e2c4a2ea01a5e70e79dd5c58574fac7.png
0e1ae0c193742292e55c28ef3fbe9149b590ce066819f7e0d75c6762d62b0f4f  index.html
aa5f19cc84d41c0f8c70ececb2bc82e863227ea1e121632aca879eb616056991  metadata.json
```

(paths relative to `apps/mobile/dist/web/`)

## 4. Simulated clean-checkout acceptance (contract §1)

Scratch: `rm -rf /tmp/b02-clean-checkout && mkdir -p /tmp/b02-clean-checkout`, then
`git clone --no-checkout <worktree> ob`, `git checkout 748f91ad`, reproduce staged index
(`git apply --cached` of `git diff --cached -- .gitmodules`;
`git update-index --add --cacheinfo 160000,46792335dfc260efa05f2185aa353093b12d9937,apps/openmuse`;
`git checkout -- .gitmodules && git checkout-index -a -f`). Scratch index verified identical
to worktree staged state (`A .gitmodules` / `A apps/openmuse` / `160000 4679233...`).

Exact contract commands and results:

```
$ git submodule update --init --recursive
Submodule 'apps/openmuse' (https://github.com/1123786563/openmuse) registered for path 'apps/openmuse'
Submodule path 'apps/openmuse': checked out '46792335dfc260efa05f2185aa353093b12d9937'

$ git -C apps/openmuse checkout 46792335dfc260efa05f2185aa353093b12d9937  # no-op, already at pin

$ cd apps/openmuse && pnpm install --frozen-lockfile
Done in 7s using pnpm v11.19.0

$ pnpm build:web
› Assets (1): assets/capybara.6e2c4a2ea01a5e70e79dd5c58574fac7.png (1.41 MB)
› web bundles (2):
_expo/static/js/web/browser-a16dc6a975c4405df5be736d4a266e08.js (349 B)
_expo/static/js/web/index-c9e2fe803a32494132849f829b9c99a9.js (5.18 MB)
› Files (2):
index.html (1.21 kB)
metadata.json (49 B)
Exported: dist/web
```

`/tmp/b02-clean-checkout/ob/apps/openmuse/apps/mobile/dist/web/index.html` exists, and its
5-file digest list is byte-identical to the in-place build (`DIGESTS_MATCH`).

## 5. OpenBot build unaffected

```
$ cd /tmp/b02-clean-checkout/ob && bun install --frozen-lockfile
1340 packages installed [3.83s]

$ bun run build
app prebuild: Exited with code 0
worker build: Exited with code 0
server build: Exited with code 0
app build: ✓ 17153 modules transformed.
app build: ✓ built in 8.55s
app build: Exited with code 0
```

Zero mentions of `apps/openmuse` in the build log; no error lines.

## 6. User-edit isolation proof (NOT-IN-PIN)

```
$ cd /tmp/b02-clean-checkout/ob/apps/openmuse && test ! -e docs/superpowers/ledger && echo NOT-IN-PIN
NOT-IN-PIN
$ ls /Users/wuyongjun/trea/openmuse/docs/superpowers/ledger
2026-10-12-openbot-v4-execution
```

`docs/superpowers/ledger` exists as uncommitted state in the user's OpenMuse main checkout but is
absent from the pinned submodule checkout — user edits cannot be mistaken for pinned content.
Submodule HEAD verified `46792335dfc260efa05f2185aa353093b12d9937`.
