# Craft 预览独立 Origin — Ticket 拆分清单

- 状态：**Spec 已批准（2026-10-15），待发布授权**。Ticket 已按已批准 Spec 定稿，可逐张派发；尚未发布到 GitHub。
- 仓库：`1123786563/OpenBot`
- 父 Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`（GitHub: https://github.com/1123786563/OpenBot/issues/358）

## 已定案的设计决定（Spec D1–D11）

- **D1–D6**（实测证据锁定）：换主机才是真独立 origin（只换端口 cookie 仍共享）；保留 `allow-same-origin`；每会话子域名 + 应用跑根路径；短时一次性 preview ticket；dev 默认 `127.0.0.1:<SERVER_PORT>`；basePath 机制退场。
- **D7**（Q1）子域名用 hash，不用明文 session id。
- **D8**（Q2）泛域名证书用 ACME DNS-01 自动化（Ticket 00）。
- **D9**（Q3）ticket 单次使用 + 30 秒；兑换后种 preview 域会话级 HttpOnly cookie。
- **D10**（Q4）存量会话不迁移。
- **D11**（Q5）`webapp_url` 绝对化，下游逐一核验适配。

## 拆分策略（沿用仓库 R1–R8）

每张 Ticket 只引入一个可观察行为变化；成功路径与拒绝路径分开；恢复/故障注入单独成张；禁止无行为 Ticket；每张带 handoff 六件套；每组保留一张端到端缝合 Ticket。

## 依赖顺序

```
00 ACME 泛域名证书（仅生产形态需要；dev 127.0.0.1 不阻塞）
01 ticket 鉴权原语            （无前置）
02 host 路由 + origin 准入     （01；主机名用 hash，D7）
03 预览代理按 host 路由        （01, 02）
04 HMR 升级按 host 路由        （03）
05 脚手架退场 basePath         （03）
06 缝合：端到端隔离 + 可交互   （03,04,05）
07 故障与拒绝注入              （06）
08 存量会话行为回归            （06；D10 不迁移）
```

## Ticket 清单

| 编号 | 标题 | 对应验收 | Blocked by |
|---|---|---|---|
| 00 | ACME DNS-01 泛域名证书自动化（仅生产形态） | AC8 | — |
| 01 | Preview ticket 鉴权原语（单次使用/30s/preview 域 cookie） | AC4 | — |
| 02 | Host 路由与 origin 准入（hash 主机名） | AC6, AC9 | 01 |
| 03 | 预览代理按 Host 路由，`webapp_url` 绝对化 | AC1, AC2 | 01, 02 |
| 04 | HMR 升级在新 origin 下的鉴权与路由 | AC5 | 03 |
| 05 | 脚手架退场 basePath（删 cwd 抠取/assetPrefix/redirects） | AC2 | 03 |
| 06 | 缝合验收：隔离 + 可交互 + 热更新端到端 | AC1–AC3, AC5 | 03, 04, 05 |
| 07 | 拒绝与故障注入 | AC3, AC4 | 06 |
| 08 | 存量会话回归（D10 不迁移） | AC7 | 06 |

## 发布

已发布至 GitHub：父 Spec https://github.com/1123786563/OpenBot/issues/358，Tickets #359–#367，均带 `ready-for-agent` 标签；父 Issue 的任务清单用真实编号表达了 blocked-by 依赖。
