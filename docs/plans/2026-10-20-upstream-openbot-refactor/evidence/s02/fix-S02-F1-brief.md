# Fix Brief S02-F1：mysql 规则大小写不敏感导致端口误脱敏且真密码存活

- **来源**：S02 OCR r1b finding（medium，security），主控已实证（`bun run` 探针）：
  - `mysql -h db -P3306 -phunter2 app` → `mysql -h db -P[REDACTED] -phunter2 app`（端口被误脱敏；**真密码 `-phunter2` 存活**）。
  - 根因：mysql 规则保留 `i` 标志，`-p` 命中大写 `-P`（端口附着形式）；`g` 从首个匹配后继续，剩余文本无 `\bmysql\b` 锚点，后续真正 `-p` 不再匹配。
  - sshpass 规则刻意去掉 `i` 并注释 "Case matters here"——同组标准应一致。
- **裁决（主控，入 ledger §7）**：字节一致移植是手段不是 Spec 要求；A02（"指定参数秘密不进入实际 OTLP body"）与模块自身 "a secret that survived costs a rotation" 优先级高于与上游逐字节一致。本地修复，账本记录与上游的有理由分歧；向上游反馈属对外动作，不在本授权内（记录为建议）。

## owner_role: backend_implementer（原 S02 实现者）
## owned_files
- `server/src/telemetry/scrub.ts`
- `server/tests/enterprise-controls.test.ts`

## 要求（RED→GREEN）
1. **RED**：新增用例断言 `mysql -h db -P3306 -phunter2 app` → `mysql -h db -P3306 -p[REDACTED] app`（端口保留、密码脱敏）；先运行证明当前失败。
2. **GREEN**：mysql 规则 flags `gi` → `g`（与 sshpass 一致）；加注释说明：大写 `-P` 是 mysql 端口附着形式、本规则刻意大小写敏感、与上游存在有理由分歧（上游现状会把端口当秘密并放过同命令后续真密码）。不得改动其他规则。
3. 复跑：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts`（全部通过）+ `bun test ./server/tests/otel-export-scrubbing.test.ts`。
4. format 自查：`bunx biome format` 两个文件——新增行不得引入新违规（enterprise-controls.test.ts 第 1 行 import 漂移为 BASE 既有，不触碰）。
5. 更新 `evidence/s02/implementer-report.md`：追加 S02-F1 段（RED/GREEN 证据、探针前后对照）。

## 报告
完成后回信：diff 摘要、RED/GREEN 用例数、format 结果。
