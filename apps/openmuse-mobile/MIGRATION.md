# OpenMuse Mobile → OpenBot 迁移记录

本目录是上游 OpenMuse 仓库 `apps/mobile` 子目录的迁移结果，**保留上游 27 个提交的完整历史**。

## 迁移元信息

| 项目 | 值 |
| --- | --- |
| 源仓库 | https://github.com/CopilotKit/openmuse |
| 本地源路径 | `/Users/wuyongjun/trea/openmuse` |
| 源 commit（迁移基点） | `1ac68f3` |
| 源子目录 | `apps/mobile` |
| split 分支名 | `openmuse-mobile-split`（head `39bc9ec`）——**在源仓创建，勿删** |
| 目标仓库 | `/Users/wuyongjun/trea/OpenBot` |
| 目标路径 | `apps/openmuse-mobile` |
| 目标分支 | `feat/openmuse-mobile-migration` |
| 迁移日期 | 2026-10-11 |
| 保留提交数 | 27（全仓 125 个提交中触及 `apps/mobile` 的全部） |
| 包名 | 保持上游 `@openmuse/mobile`，未改名（减少与上游的差异） |

## 实际执行的命令

```sh
# 1) 源仓：切出只含 apps/mobile 的分支
git -C /Users/wuyongjun/trea/openmuse subtree split --prefix=apps/mobile -b openmuse-mobile-split
#   → 遍历 125 个提交，产出 27 个提交，head 39bc9ec

# 2) 目标仓：基于 main 建分支
git -C /Users/wuyongjun/trea/OpenBot worktree add -b feat/openmuse-mobile-migration \
    /Users/wuyongjun/trea/OpenBot-migration-wt main

# 3) 目标仓：以 merge commit 方式挂入历史
git -C /Users/wuyongjun/trea/OpenBot-migration-wt subtree add \
    --prefix=apps/openmuse-mobile /Users/wuyongjun/trea/openmuse openmuse-mobile-split
#   → 生成 merge commit 622dd8e，父节点为 788e1cc(OpenBot main) + 39bc9ec(上游 split head)
```

> **为什么用 worktree 而不是直接切分支**：执行时 OpenBot 主工作区正处于一次
> 未完成的 `git merge`（`app/src/locales/*.json` 冲突）。`git switch` 直接报
> `fatal: cannot switch branch while merging`，而在那种状态下做 `subtree add`
> 会把别人半途的 merge 一起提交进去。改用 linked worktree 做隔离，主工作区零影响。

## 如何查看搬过来的历史（重要）

`subtree add` 挂进来的是上游 split 分支的**原始提交**，这些提交里的文件路径是
它自己的根目录（`App.tsx`、`src/...`），只有在 merge commit 处才映射到
`apps/openmuse-mobile/`。因此按路径过滤的 log 只会显示 1 条，这是 subtree 的正常行为，
**不代表历史丢失**：

```sh
# 只显示 1 条（merge commit 本身）——符合预期，不是失败
git log --oneline -- apps/openmuse-mobile | wc -l

# 真实的历史在这里：沿 merge commit 的第二父节点查看
git log --oneline 39bc9ec | wc -l                 # → 27
git rev-list --count 39bc9ec                      # → 27
git merge-base --is-ancestor 39bc9ec HEAD && echo YES   # → YES
git log --graph --oneline -10                     # 双父 merge + 上游提交链
git log --oneline 39bc9ec -- App.tsx              # App.tsx 的 5 次上游修改
```

## 迁移后的路径与配置修复

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `packages/domain/src/{index,agent,computer,date-time,jev}.ts` | **新增**（从源仓 `packages/domain/src` 原地复制，sha256 已校验一致） | 上游 13 个源文件 + 1 个测试通过 `../../../packages/domain/src` 引用 app 之外的共享包。该包不在 subtree 范围内，不复制则整个包无法编译。 |
| `src/*.tsx`、`src/*.ts`（13 个） | `"../../../packages/domain/src"` → `"../packages/domain/src"` | 同上；domain 现在是包内目录，相对深度减少一层。 |
| `test/jev-actions.test.ts` | 同上 | 使 `node --test` 能解析类型。 |
| `App.tsx` | `"../../packages/domain/src"` → `"./packages/domain/src"` | App.tsx 位于包根，只需一层。 |
| `tsconfig.json` | `paths["@openmuse/domain"]`：`"../../packages/domain/src/index.ts"` → `"./packages/domain/src/index.ts"` | 消掉越出包根的 tsconfig 路径映射。tsconfig 其余部分 `extends: expo/tsconfig.base`，来自 `node_modules`，无需改动。 |
| `metro.config.js` | `watchFolders: [path.resolve(__dirname, "../..")]` → `[__dirname]`；移除不再使用的 `path` require | 原来的 `../..` 指向源仓根（为了让 Metro 能解析包外的 `packages/domain`）。迁移后 `../..` 会变成 **OpenBot 仓库根**，Metro 将监视整个后端仓库（agent-*/server/worker/desktop…），构建会严重变慢且易出错。domain 已内置，监视自身目录即可。 |
| `README.md` | 演示图/视频 `../../assets/...`、`../../docs/DEMO.md` → 上游固定 commit 的绝对 URL；`pnpm --dir apps/mobile X` → `pnpm X`；测试命令去掉 `apps/mobile/` 前缀；"从仓库根启动 API" 改为说明 OpenBot 侧是 `server` workspace | 相对路径在迁移后全部失效；命令改为包内执行。 |
| `.gitignore` | **新增** | 上游这些规则在源仓根部，未随子目录搬来。缺少它会导致 `node_modules/`、`.expo/`、生成的 `ios/`、`android/`、`.env` 被误提交。 |
| `.npmrc` | **新增**（`auto-install-peers=false`、`strict-peer-dependencies=false`） | 复现源仓 pnpm 行为，避免脱离 workspace 后 peer 依赖解析与上游不一致导致装出不同的树。 |

### 未修正 / 需后续解耦

- **vendored `packages/domain` 是一份副本，不再是上游共享包**。后续若上游改动
  `packages/domain`，`subtree pull` 只会更新 `apps/mobile` 内部文件，
  **不会**更新 `packages/domain/src`，且 pull 后上游新代码里的
  `../../../packages/domain/src` 引用会重新出现（需在 pull 后重做本文件里的路径改写）。
  建议后续二选一：(a) 由 OpenBot 侧建立真正的共享包（放 `shared/` 或用
  OpenBot 的 bun workspace），把 mobile 改为依赖它，彻底消除副本；
  (b) 保留副本但把同步 `packages/domain` 列入例行上游跟进清单。
- **`packages/backends` 实际无依赖**：迁移前已 grep 确认 `apps/mobile` 全量源码
  与配置中没有任何 `packages/backends` 引用，`packages/domain` 内部也没有。
  本包对外只有 `packages/domain` 这一个越界依赖，且它自身仅依赖 `zod`
  （mobile 的 package.json 已含 `zod ^4.1.0`），因此 vendoring 即可闭环。

## 与 OpenBot 既有 `mobile/` 目录的关系

OpenBot 根目录已有 `mobile/`（自带 Expo 参考实现，包名 `openbot-mobile`）。
按 `docs/superpowers/specs/OpenMuse-Mobile-OpenBot-Backend.md` §1.2 的口径
——"不以 OpenBot/mobile 为移动端主项目，仅作参考实现"——**本次未合并、未删除、未改动**它。

- `apps/openmuse-mobile`：从上游搬来的主战代码，后续对接 OpenBot 后端的主体。
- `mobile/`：保留原样，仅作参考实现与对照。

两者包名（`@openmuse/mobile` vs `openbot-mobile`）与目录都不同，不存在路径冲突。
是否后续合并/下线 `mobile/` 属于独立决策，不在本次迁移范围。

## 为什么没有加入 bun workspace

OpenBot 根 `package.json` 的 `workspaces` 是显式列举 `["app", "server", "worker"]`，
**本次未追加 `apps/openmuse-mobile`**，理由：

1. 包管理器不一致：OpenBot 用 `bun@1.3.14`，本包上游用 `pnpm@11.19.0`
   （`packageManager` 固定）。塞进 bun workspace 会让两个包管理器争同一份依赖树，
   移动端大量原生/Expo 依赖在 bun 下的解析与上游不一致，难复现上游能跑的版本组合。
2. 体量：Expo/RN 依赖上百个且含原生二进制，纳入后每次 `bun install` 与 CI 都要拖着它走，
   直接拖慢后端 CI，而后端 CI 根本不需要移动端代码。
3. 隔离后本包可以独立 `pnpm install`、独立出 CI job，失败不影响后端流水线。

代价：本包不会被根 `bun run typecheck` / `bun test` 覆盖，需要单独的 CI job（见下）。

## 本地启动

要求（沿用上游约束）：

- **Node >= 22**（源仓 `engines.node: ">=22"`；实测环境 v22.22.2）
- **pnpm 11.19.0**（源仓 `packageManager`）。已装则直接 `pnpm`，否则 `npx pnpm@11.19.0`

```sh
cd apps/openmuse-mobile
pnpm install            # 首次安装
pnpm typecheck          # tsc --noEmit
pnpm web                # web 预览 :8081（需先起 API server）
pnpm start              # dev-client
pnpm ios / pnpm android # 需要原生工具链与 dev build
node --experimental-strip-types --test test/date-time.test.ts   # 单个测试
```

默认 API 地址 `http://localhost:8787`（Android 模拟器用 `http://10.0.2.2:8787`），
可用 `EXPO_PUBLIC_API_URL` 覆盖。PDF 依赖 `react-native-pdf` /
`react-native-blob-util`，必须用 Expo **development build**，Expo Go 不含这些原生模块。

## 跟进上游

上游更新后，在源仓重做 split，再 pull 进本目录：

```sh
# 1) 源仓：拉取上游最新，重建 split 分支（-f 覆盖旧分支）
git -C /Users/wuyongjun/trea/openmuse fetch origin main
git -C /Users/wuyongjun/trea/openmuse subtree split --prefix=apps/mobile \
    -b openmuse-mobile-split -f

# 2) 目标仓：拉入
git -C /Users/wuyongjun/trea/OpenBot subtree pull \
    --prefix=apps/openmuse-mobile /Users/wuyongjun/trea/openmuse openmuse-mobile-split \
    --squash -m "chore(repo): 同步上游 OpenMuse Mobile 改动"
```

注意事项：

1. **`--squash` 会让上游新提交在 OpenBot 侧压成一个提交**，OpenBot 侧看不到上游逐条历史
   （历史仍在源仓 split 分支里可查）。若想保留逐条历史，去掉 `--squash`，
   但那样每次 pull 都会往 OpenBot 里挂一整串上游提交，仓库会越来越大。
2. **pull 后必须重做路径改写**：上游若新增/恢复了对 `../../../packages/domain/src`
   的引用，需要再改成 `../packages/domain/src`；同时检查 `packages/domain/src`
   是否需要同步上游新版本（见上文"未修正"）。
3. pull 前确保工作区干净；冲突时先解决再提交，**不要**用 `--force` 或 `reset --hard`。
4. 源仓只允许新增/更新 `openmuse-mobile-split` 这一个分支，不要动源仓其他分支。
