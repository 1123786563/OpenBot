# MT031 实现任务 — 插件目录与安装归属（Issue #74）
在 i14-mt031 树（BASE+240 项）实现 MCP/Composio/OpenConnector 插件公共目录与安装归属。前置 MT027 credentials、MT016 bot-ownership 已 verified。

## 验收
- AC1 目录只读全局可见且不含公司私有配置；安装记录固定公司与团队。
- AC2 用另一公司的安装/连接 ID 调用被拒且不触发供应商请求（vendorProbe 计数=0 断言，MT027 先例）。
- AC3 卸载/停用只影响本范围安装；共享目录条目不受影响。
- AC4 安装配置中的秘密脱敏保存与展示（SECRET_CARRIER_KEYS/断言无 envelope 泄漏，MT027 RedactedCredentialView 先例）。

## 交付约束
- 新文件建议：src/enterprise/tenancy/plugin-catalog.ts+tests+support；供应商调用面必须可探测（注入 probe 计数）。
- 安装行复合 FK 内嵌 tenant（MT027 三表 DDL 先例）；跨公司安装结构性不可能。
- 冻结面：credential-ownership.ts、enterprise-credentials.ts 只消费不改。

## 验证
- 端口 55565（库名 w14c），三步配方+七变量 env；基线 990/0/0/38；全量=990+新增；变异自证；typecheck/biome；checkpoints/MT031/、reports/MT031.md；禁 find /、禁 commit、docker rm 回显。
