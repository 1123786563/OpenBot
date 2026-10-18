# MT079 修复轮 — F1 关闭（preferences.ts biome 格式）

日期：2026-10-15（UTC 执行）。范围：仅关闭 MT079 复审 F1（低危），零语义变化。

## F1

`bunx biome check`（pinned 2.5.10）对 `server/src/enterprise/tenancy/preferences.ts` 行 262–266 报 1 处格式错（多行 `if (` 条件应为单行），exit 1；实现报告「biome exit 0」声明不可复现，且本 verification/ 目录原无 4 号 biome 存档（0/1/2/3/5 有、4 缺）。

## 前像哈希存档（修复前）

```
$ shasum -a 256 server/src/enterprise/tenancy/preferences.ts
6a8f2e25043d66a35ec142a6fba62451766ae26295ab29375ea7b255095edd4b  server/src/enterprise/tenancy/preferences.ts
```

与 brief 期望值 `6a8f2e25…` 一致。该前像字节同时由 `checkpoints/MT079/mutation/pristine-preferences.ts`（SHA 同为 `6a8f2e25…`）固化，修复后仍不得改动（见 4c-fix-diff.txt 证据链）。

## 1) 修复前复现（执行时终端记录转录）

```
$ cd server && bunx biome --version
Version: 2.5.10
$ bunx biome check src/enterprise/tenancy/preferences.ts tests/multitenancy/preferences.test.ts tests/multitenancy/support/preferences.ts
src/enterprise/tenancy/preferences.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Formatter would have printed the following content:

    260 260 │     patch: unknown,
    261 261 │   ): Readonly<Partial<UserPreferences>> {
    262     │ - ··if·(
    263     │ - ····!patch·||
    264     │ - ····typeof·patch·!==·"object"·||
    265     │ - ····Array.isArray(patch)
    266     │ - ··)·{
        262 │ + ··if·(!patch·||·typeof·patch·!==·"object"·||·Array.isArray(patch))·{
    267 263 │       throw new Error(
    268 264 │         "PREFERENCE_PATCH_INVALID: the patch must be a JSON object carrying at least one classified global personal preference key",

Checked 3 files in 41ms. No fixes applied.
Found 1 error.
check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Some errors were emitted while running checks.
```

= 1 error，与 F1 完全一致（262–266 行）。

## 2) 修复

```
$ bunx biome check --write src/enterprise/tenancy/preferences.ts
Checked 1 file in 48ms. Fixed 1 file.
```

仅 `--write` 该一个文件（brief 边界）；未触碰 preferences.test.ts / support/preferences.ts 及其他任何文件。

## 3) 修复后复跑（3 文件，exit 0 / 0 error / 0 warning）

```
$ bunx biome check src/enterprise/tenancy/preferences.ts tests/multitenancy/preferences.test.ts tests/multitenancy/support/preferences.ts
Checked 3 files in 20ms. No fixes applied.
（exit 0，无任何 error/warning 输出）
```

## 哈希链

| | SHA-256 |
| --- | --- |
| 修复前 preferences.ts（= pristine-preferences.ts） | `6a8f2e25043d66a35ec142a6fba62451766ae26295ab29375ea7b255095edd4b` |
| 修复后 preferences.ts | `032ae9dea7c98cf3ac002feb31791795cd2929118390fd3d5bc9c051034563c1` |

唯一 diff 见 `4c-fix-diff.txt`：262–266 行多行 `if (` 条件重排为单行，零语义变化。

## 关联复跑（同一修复后工作树）

- 专用库聚焦复跑（容器 `mt079-fix-pg`、六变量 env、base migrate + 九任务依赖序 apply）→ **23 pass / 0 fail / 0 skip**，exit 0：`4b-focused-after-fix.txt`。
- 修复后哈希已回写 `checkpoints/MT079/before-after-hashes.txt` 与 `sha256-manifest.txt`（其余条目未动，逐项说明见两文件内注记）；报告附记见 `reports/MT079.md` 修复轮附记段。
