# OCR Review — Round 2(Craft Parity Remediation 终审,修复后复验轮)

> 命令(与 round 1 相同,范围随 HEAD 扩至含修复提交):
> `ocr review --from 3c690410 --to HEAD --audience agent --exclude "docs/**,.superpowers/**,docs/plans/**"`
> 会话 `dd9d3e71`(2026-10-13 03:31,cwd=repo)| 工作树 clean,无需 workspace 轮。

## 覆盖状态:**部分(8/36 文件,13 条意见,无 Critical/High)— LLM 配额阻断持续**

- 与 round 1 相同的精确阻断物:bigmodel 网关 `429 code 1302`(账户速率限制),28/36 文件全部因 429 失败(6 次重试均 429)。工具与凭证可用。
- 本轮期间同账户还在承载真实现场 GLM-5.3 回合(connect_app 停车/续跑复验),配额竞争加剧属预期。
- **round-3 待配额恢复后以同命令重跑**;两轮累计覆盖 13 个不同文件(round1 8 + round2 8,重叠若干),manager/routes/turn 引擎等核心文件仍由 SDD 评审与 439 craft 测试背书。

## 已完成文件与意见(round 2)

| 文件 | 意见 |
|---|---|
| session-ready.ts | 5(3 × bug·medium:轻路径 ack mcpConfigHash 未 dispose 旧实例[与 remediation-verification §3(i) 实测的实例配置缓存同族]、+ maintainability/style 若干) |
| connect-app.ts | 2(bug·medium:决策路径非原子;announce 顺序) |
| connect-app-routes.ts | 2(bug·medium:pendingConnectApp 删除路径单一) |
| connect-app-plugin.ts | 1 |
| session-routes.ts / templates/connect-app.plugin.ts / store.ts / directory-archive.ts / zip-archive.ts | 0/待复核(429) |

- 意见原文:`ocr-comments-round2-raw.txt`(同目录)。
- 分诊:3 × bug·medium → **defer-but-track**(决策原子性与 pending 清理属硬化项;dispose-实例一条与 F-G/实例缓存议题合并,随 F-G 流转);其余 low → defer(并入 remediation-verification §7)。
