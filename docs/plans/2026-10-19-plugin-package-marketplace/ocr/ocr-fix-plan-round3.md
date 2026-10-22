# OCR 全范围 Round2（270 files, 32min, exit 0）medium 分诊与编号修复计划

Round2 基线：`ocr-workspace-round2.json`（status=partial，51 comments：0 critical/high、14 medium、37 low）。恢复会话产物；round1(00:16)→round2(00:58) 均为丢失续行段所跑，无 ledger 记录，本次补记。

## 分诊

| # | 位置 | 级别 | 判定 | 处置 |
|---|---|---|---|---|
| M1 | docs/verification/e2e-bun-suites.json | maintainability | **有效**：条目尾插违反 writeManifest 排序不变量 | F1：按有序位重插两条款 |
| M2 | server/src/index.ts(内层 try 外 createDatabase) | bug | **有效**：可恢复抛错会击穿整组路由 | F2：移入 try，走 503 降级 |
| M3 | app buildConfig 裸数字镜像 wire 限制 | maintainability | **有效** | F3：引用 shared 常量 |
| M4 | app loadMore 无防重入 | bug | **有效** | F4：pending 防重入 |
| M5 | 跨面放行审计事件仅返回值、落库靠调用方 | security | **待核**：读代码确认真伪 | F5 视核验 |
| M6 | 平台面判定只查 actor.kind | security | **待核**：可能上游已验 | F6 视核验 |
| M7 | enterprise_package_plans 无保留策略/索引 | performance | 有效但性能类，V1 数据量小 | **P7 延后**（记录） |
| M8 | 裸字符串错误 vs 品牌化错误体系 | maintainability | **有效** | F8：改用 packageError |
| M9 | 带 key 解包缺 key 静默 undefined vs Promise<T> | bug | **有效** | F9：缺 key 抛错 |
| M10 | createCodeRunGateway 重复构造 | maintainability | 有效-轻微 | **P10 延后** |
| M11 | 四表缺索引 | performance | 有效但性能类 | **P11 延后** |
| M12 | SIGINT/SIGTERM 清理漏 repeatAfterEach(kick) | bug | **有效**（测试侧） | F12 |
| M13 | 空数组忠实记录 GitHub 端点 | other | **非缺陷** | 关闭 |
| M0/M13 其余 low | — | — | — | 维持 parked 记录 |

## 修复轮

F1/F2/F3/F4/F8/F9/F12 → 单批 backend/app 修复实现者；F5/F6 先核验真伪；M7/M10/M11 延后记录；M13 关闭。修复后：typecheck/biome/受影响测试 → 干净的最终 OCR 轮（round3，全范围）。
