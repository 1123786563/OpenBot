# Bifrost 22.x 收口批实施计划（#352–#357，worktree bf20）

- 父 Spec：`docs/specs/2026-10-14-bifrost-github-spec.md`（#5，AC01–AC19）；映射依据 `docs/specs/2026-10-14-bifrost-integration-design.md`。
- Issue 来源：GitHub `1123786563/OpenBot` #352 #353 #354 #355 #356 #357（2026-10-22 快照，`ready-for-agent`，全 OPEN）。
- 工作区：bf20 worktree = main@HEAD `a789f6a4` + 未提交前置增量（11.x–21.x 交付 0165–0206 + #305 入口清单 + #312 证据表）。开工基线快照：`git status --porcelain` 276 行，SHA-256 `d2de7240…4e56`（区分自有增量）。全程不 commit、不 push；GitHub 只读。
- 测试库：`postgres://postgres:postgres@127.0.0.1:5566/bf20`（容器 orca-w3-bf-pg，已建库并迁移至 0206）。
- bifrost 子模块：零提交口径；本批在 bf20 检出至记录提交 `ad9470a5` 仅作只读锚点核对与（可行时）go test 复核，不产生任何子模块提交。
- OCR：按仓库裁决不做中间轮 OCR；#357 的 OCR 项落为「待执行清单」，最终提交前由主协调器统一执行一次。

## DAG

| # | Ticket | owned_files | depends_on | 验收要点 |
| --- | --- | --- | --- | --- |
| T1 | #352 全入口枚举 | `server/src/billing/entrypoint-catalog.ts`、`server/tests/entrypoint-enumeration.test.ts` | 前置 11.x–21.x 已在场 | 清单=实际入口（注册表派生），每条标注准入状态+付款账户来源；未准入入口列阻塞不放行；新增入口未登记→测试失败 |
| T2 | #353 每入口 gate/payer 核查 | `server/src/billing/entrypoint-gate-audit.ts`、`server/tests/entrypoint-gate-audit.integration.test.ts` | T1 | 每条入口四类核查（门禁/payer/拒绝/旁路）；余额不足→供应商调用数 0（含真库段）；证据绑定代码版本 |
| T3 | #354 conformance 证据：文本/图像/音频 | `server/src/billing/conformance-evidence.ts`、`server/tests/conformance-evidence.test.ts` | T2 | 三族启用能力各有绑定版本证据（上限/usage/取消尾部）；失效规则；缺环境标未验证不可启用 |
| T4 | #355 conformance 证据：Embedding/实时/异步/工具 | 同 T3 存储（共用结构），`server/tests/conformance-evidence-extended.test.ts` | T2（与 T3 共享 store，测试相互独立） | 四组（Embedding/Rerank/OCR、实时、异步/批量/视频、工具）证据与 22.3 同构；实时单元门控/耗尽停止/关停尾部、异步终态/取消未知、工具附加费/无旁路各有专门条目 |
| T5 | #356 父 Spec 19 条 AC 完整场景验收 | `server/src/billing/acceptance-matrix.ts`、`server/tests/acceptance-matrix.integration.test.ts` | T3+T4 | AC01–AC19 逐条映射可复现场景+命令+套件；跨进程故障场景（重启/双 worker/重放/时钟/断线）全执行记录；skip 不计通过 |
| T6 | #357 版本固定、独立 Review 与全范围 OCR | `server/src/billing/delivery-baseline.ts`、`server/tests/delivery-baseline.test.ts`、`reports/orca-dag-wave3-bf20.md`、`reports/bf20-increment-files.txt` | T5 | 版本固定记录（OpenBot+bifrost 子模块+迁移头）；独立 Review 双结论；OCR 待执行清单；部署就绪结论（未验证能力与遗留限制列明） |

## 关键设计

1. **清单的事实源是各家族已交付的注册表**（不按票面推定）：`IMAGE_ENTRYPOINTS`（#305）、`AUDIO_CAPABILITY_EVIDENCE`（#312）、`TOOL_SURCHARGE_ENTRIES`（#316/#343 线）、`VIDEO_EDIT_REQUEST_TYPES`、`REALTIME_UNIT_KINDS` 与实时三入口（15.x/16.x）、async/batch/video submit 服务、embedding/rerank/ocr admission、文本族 credit protocol（`creditProtocolEndpoints` + input-bound）。目录行与注册表双向对账 + seam 模块存在性检查（文件在盘上）→「新增入口未登记」失败。
2. **#353 的拒绝矩阵**：余额不足→供应商调用数 0。纯门以注入 spy 驱动实际 admission 服务（image/ocr/rerank 三门实际驱动；video/embedding/speech 的拒绝面由其已交付套件与 22.4 证据记录绑定，video 线三套件本批复跑全绿）；真库门（credit reserve/realtime establish+unit/async submit/batch submit/tool 身份行）在 bf20 库上以真实 reserve 服务驱动。payer 正确性以 `payer-binding`/`workbench-payer` 的实际解析断言（公司工作台→公司、个人 grant→个人、客户端指定 payer 拒绝）。
3. **conformance 证据为一套纯模块存储**（#312 同构）：每条证据绑定 entrypoint、约束事实（含数值）、验证环境与可重跑命令、失效绑定（所骑模块文件的 SHA-256）。失效规则：绑定文件哈希变化→证据失效。无迁移新增（0206 为头，纯模块无需 schema）。
4. **AC 矩阵**：AC01–AC19 每条 ≥1 场景 + ≥1 可执行命令 + ≥1 在场套件引用；矩阵测试校验可执行性（命令/套件文件在盘上、跨进程场景全覆盖、skip 不计通过的计数规则），逐条执行以回执形式绑定 HEAD 落入报告。
5. **版本固定**：HEAD `a789f6a4`、子模块 `ad9470a5`、迁移头 0206、增量清单 SHA-256；OCR 待执行清单含 workspace 模式命令与期望覆盖范围。

## 验证命令（每任务 RED→GREEN 后运行，最终汇总重跑）

```bash
bun test server/tests/entrypoint-enumeration.test.ts
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf20 bun test server/tests/entrypoint-gate-audit.integration.test.ts
bun test server/tests/conformance-evidence.test.ts
bun test server/tests/conformance-evidence-extended.test.ts
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf20 bun test server/tests/acceptance-matrix.integration.test.ts
bun test server/tests/delivery-baseline.test.ts
bun run --filter server typecheck
bunx biome lint --error-on-warnings <本批文件>
node scripts/e2e-add-driven.mjs <新套件> wave3 bf20 套件 && node scripts/e2e-coverage-audit.mjs
cd bifrost/plugins/governance && go test ./...   # 子模块检出后，可行时复核；不可行记录环境边界
```

已知基线红（不修不报，报告仅一句对账）：`image-entrypoints`（fixture 缺 `video_input`，bf19 同类）、`realtime-session-identity`/`realtime-unit-reservation`、server/app typecheck 存量错。
