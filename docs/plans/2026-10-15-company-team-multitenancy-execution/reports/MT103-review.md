# MT103 Independent Review — Issue #146

- Reviewer task: `task_019411171ea9` / Dispatch `ctx_1cca227a5d23` (independent of implementer Dispatch `ctx_31eb8dca8b8e`).
- Review date: 2026-10-15 (UTC). Review is **read-only**; the only write is this file.
- Reviewed package: `review-packages/MT103.md` (SHA-256 `0c98b35aeeee87786d7e0b4206600d3f3b5979c7161a1c02ffed6115717e7327`, verified).
- Snapshot scope: findings apply to the captured 2026-10-15 snapshot (BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`, gitlink `4679233…`, canonical `origin/main` = `81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4`). Canonical main is a moving ref; this review does not generalize beyond that snapshot.

## Verdicts

| Verdict | Result |
| --- | --- |
| **Spec compliance (Issue #146, 4 ACs)** | **PASS — 4/4 acceptance criteria satisfied** |
| **Report quality / correctness** | **PASS — all independently checkable claims verified accurate; 3 Info-level notes, no material defects** |

## Verification methodology

1. Package integrity: review-package SHA-256 matches; all six snapshot files in `checkpoints/MT103/manifest.sha256` (incl. `before.json`) re-hashed and match.
2. Issue #146 body fetched from `1123786563/OpenBot`: the four ACs quoted in report §7 match the issue text verbatim (no criterion omitted or softened).
3. Independent read-only reproduction in `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt103` (submodule initialized at the pinned SHA): ~34 git/filesystem probes covering every factual claim (commands listed per row below). No write, fetch, checkout, or ref mutation performed by this reviewer.
4. Network context check only: `git ls-remote https://github.com/1123786563/openmuse` — still `main` = `81d0d3a…` at review time, i.e. the snapshot had not drifted as of this review; conclusions remain snapshot-scoped regardless.

## Acceptance-criteria evaluation

### AC1 — 差异明确列出（特别是缺失适配层）→ **PASS**

| Report claim | Independent evidence | Result |
| --- | --- | --- |
| gitlink `46792335dfc260efa05f2185aa353093b12d9937` @ `apps/openmuse`, mode 160000 | `git ls-tree HEAD apps/openmuse` in worktree @ `f0520524` | ✅ exact |
| `.gitmodules`: openmuse URL-only (no branch pin); bifrost `branch = dev` | `cat .gitmodules` | ✅ exact |
| Pin commit = 2026-10-12 22:15:26 +0800「将移动端 UI 本地化为中文并添加 OpenBot 集成文档」, docs-only, no adapter | `git show --no-patch`; `ls-tree` grep shows only `docs/OPENBOT-INTEGRATION.md`, ADR 0001/0005/0007/0009/0010, plans; `ls-tree HEAD -- apps/mobile/src/openbot` = 0 files | ✅ exact |
| canonical `main` = `81d0d3a…`; gitlink is ancestor, behind exactly 2 commits (`6e3a131`, `81d0d3a`) | `merge-base --is-ancestor` → true; `rev-list --count HEAD..origin/main` = 2; log matches subjects/dates | ✅ exact |
| Diff: 161 files, +17162/−28; dirstat 20.4% `src/openbot` / 12.4% `test` / 1.2% `apps/mobile` / 59.0% `docs/superpowers/plans/tickets` / 4.3% `.omc/reports` / 0.6% `.omc/research` | `git diff --stat HEAD..origin/main \| tail -1`; `git diff --dirstat=files,0` | ✅ all values exact |
| Missing adapter: 33 source files + 20 `openbot-*.test.ts` at canonical, absent at pin; `App.tsx` wiring +243; +7 deps (better-auth/@better-auth/expo 1.7.1, expo-constants/linking/network/secure-store/web-browser) | `ls-tree … origin/main` counts = 33/20; 0/absent at pin; `diff --stat -- apps/mobile/App.tsx` = 243; package.json diff = exactly the 7 listed deps | ✅ exact |
| Timing paradox: pin-introducing commit `27829833` (2026-10-14 22:41:42 +0800) later than adapter commit `6e3a131` (18:24:59 +0800), same day | `git show --no-patch --date=iso` both commits; `27829833` deleted 71 `apps/openmuse-mobile/**` files and added `apps/openmuse` | ✅ verified (see Info-2 nuance) |

The headline conclusion — “固定 gitlink 指向缺少适配层的 pre-adapter 提交；已集成 canonical 来源在 main 上” — is fully substantiated.

### AC2 — 任务专用工作区基线；外部主工作区未修改；旧目录未重建 → **PASS**

- Task worktree `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt103` exists at HEAD `f0520524`, branch `1123786563/i6-mt103`; `git submodule status` = pin `4679233` (clean); submodule `origin/main` = `81d0d3a` as remote-tracking ref — exactly the reviewable baseline semantics described in report §4. ✅
- Task worktree `git status --porcelain` empty (no gitlink/tracked change). ✅
- External parent workspace `company-team-multitenancy-execution`: `submodule status` = `-4679233… apps/openmuse`, `-f10954f… bifrost` (uninitialized, untouched); no `apps/openmuse`/`bifrost` modification lines in status. ✅
- `apps/` in both workspaces contains only `openmuse`; no `openmuse-mobile` anywhere (not rebuilt). ✅
- Implementer's parent-workspace writes limited to the three authorized paths (`reports/MT103.md`, `checkpoints/MT103/*`, `mt103-canonical-mobile-baseline.md`, all hash-verified in manifest). Other staged/untracked planning artifacts exist in the parent workspace but pre-date/belong to the planning phase; nothing attributes them to this implementer and nothing contradicts the write-scope claim (see Info-3).

### AC3 — 接入前提与风险清单 → **PASS**

§5 provides 5 prerequisites, 6 risks, and a produced-interface list. Checkable items all verified:

- CI submodule guard exists as described: `.github/workflows/ci.yml` `submodule` job runs `git submodule update --init apps/openmuse` and asserts checkout == gitlink; it does **not** validate pin freshness vs canonical main (the exact blind spot the report names); job is in the required-checks `needs` list. ✅
- Spec §8 path drift confirmed: `docs/specs/2026-10-14-company-team-multitenancy-design.md` line 166 row cites `app/`, `apps/openmuse-mobile/` (deleted by `27829833`), `desktop/`, `mobile-bff/`; actual location is `server/src/mobile-bff/` (`server/src/app.ts` imports `./mobile-bff/{activity,openmuse-bot,routes,workspace}`). ✅
- Backend seams pre-exist at the OpenBot tree: `server/src/auth/` (better-auth) and `server/src/mobile-bff/` (4 files as listed) mounted via `server/src/app.ts`. ✅
- OpenBot CI excludes submodule tests: `27829833` commit body — “test discovery path-anchored to keep the submodule's own suite out; biome excludes apps/openmuse”. ✅
- Adapter has zero tenancy semantics: `git grep -iE 'company|organization|team|tenant' origin/main -- apps/mobile/src/openbot` → **0 hits**. ✅ (see Info-1)
- Runtime config claims exact: canonical `config.ts` rejects path/credentials/query/fragment (origin-only), Android default `http://10.0.2.2:8787`, else `http://localhost:8787`, `OPENMUSE_SCHEME = "openmuse"`. ✅
- “单一 main 无 tag”: `ls-remote` shows only `HEAD`/`refs/heads/main`/`refs/pull/95/head`; 0 tags. ✅
- MT083 (#126) prerequisite is framed as “领取前核验实际交付契约” — appropriately hedged cross-ticket dependency, not falsifiable within this snapshot; not a gap.

### AC4 — 结论可被独立复核（含命令与版本标识）→ **PASS**

- §6 provides 9 command groups with expected outputs and full SHAs; checkpoints provide `verification.txt` (raw transcript), `pin-vs-canonical.diffstat.txt`, before/after JSON, and a hash manifest.
- This reviewer reproduced every §6 command group successfully with matching outputs (network `ls-remote` included), plus additional probes (ancestry, dirstat, config.ts content, CI yaml, spec §8, commit bodies) — no stale or fabricated output detected.
- Snapshot hashes: all 6 manifest entries re-verified byte-for-byte.

## Findings

No High or Medium findings. Three Info-level notes (none affects either verdict):

1. **[Info] §3.2/§6-9 grep annotation slightly inaccurate (conservative direction).** Report says the tenancy grep yields “无任何业务命中（仅注释中的 'scoped by …' 等无关词）” — implying irrelevant comment-level matches exist. Actual execution (both the §3.2 wide pattern `company|organization|team|tenant` and the §6-9 narrow pattern) returns **zero hits** in `apps/mobile/src/openbot` at `origin/main`. The parenthetical overstates noise; the underlying conclusion (adapter has no company/team tenancy semantics — key MT104 input) is *strengthened*, not weakened. `reports/MT103.md` §3.2 / §6 cmd 9.
2. **[Info] “时序反差” inference relies on commit dates, not push times.** `27829833` (22:41 +0800) being later than `6e3a131` (18:24 +0800) proves the pin *commit* postdates the adapter *commit*, but git cannot prove `6e3a131` was already pushed to `main` at 22:41. Circumstantially supported (`refs/pull/95/head` = `6e3a131` shows PR flow) and immaterial to the verdict (pin-vs-main gap is verified directly), but the report's “而非当时 main 已有的适配层版本” phrasing carries one unverifiable step. `reports/MT103.md` §0 timing row.
3. **[Info] Parent-workspace write attribution is asserted, not provable from git alone.** The parent execution workspace contains staged planning artifacts (`docs/plans/2026-10-15-company-team-multitenancy/*`, `docs/tickets/multitenancy/*`) beyond the implementer's three authorized paths. These are plainly planning-phase outputs and no evidence attributes them to the implementer; the verifiable part of the claim (gitlink/submodule state untouched, submodules uninitialized, no code/business-file modification) checks out. `reports/MT103.md` §4.

## Contradictions / stale output / scope drift — none found

- No contradiction between report, transcript (`verification.txt`), diffstat, checkpoints, and live worktree state.
- No scope drift: research/report-only ticket honored — no production code changes, no commit/push/merge/gitlink update/migration/deploy anywhere in evidence; task worktree clean at review time.

## Reviewer reproduction commands (abridged)

All run 2026-10-15 in `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt103` (read-only): `git rev-parse HEAD`; `git ls-tree HEAD apps/openmuse`; `cat .gitmodules`; `git submodule status apps/openmuse`; `git -C apps/openmuse rev-parse HEAD origin/main`; `git -C apps/openmuse merge-base --is-ancestor HEAD origin/main`; `git -C apps/openmuse rev-list --count HEAD..origin/main`; `git -C apps/openmuse log --oneline --date=iso --pretty='%h %ad %s' HEAD..origin/main`; `git -C apps/openmuse diff --stat/--dirstat=files,0 HEAD..origin/main`; `git -C apps/openmuse ls-tree -r --name-only origin/main -- apps/mobile/src/openbot` (33) `| wc -l` and test grep (20); same at HEAD (0); `git -C apps/openmuse grep -inE 'company|organization|team|tenant' origin/main -- apps/mobile/src/openbot` (0 hits); `git -C apps/openmuse show origin/main:apps/mobile/src/openbot/config.ts`; `git log -1 -- apps/openmuse`; `git show 27829833 --name-status` (71 D + A apps/openmuse); `git log -1 --format=%b 27829833`; `grep` of `docs/specs/2026-10-14-company-team-multitenancy-design.md` §8; `grep` of `.github/workflows/ci.yml` submodule job; `ls server/src/auth server/src/mobile-bff`; `grep mobile-bff server/src/app.ts`; parent-workspace `git submodule status` / `status --porcelain` / `ls apps/`; `git ls-remote https://github.com/1123786563/openmuse`; `shasum -a 256` on all snapshot files.
