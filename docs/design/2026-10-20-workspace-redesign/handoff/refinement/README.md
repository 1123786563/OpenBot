# 工作台改造：实施前细化交付

2026-10-20，**待用户审阅，未实施生产代码**。本目录是当前细化的唯一新增事实源；旧设计及生产文件均未改动。

第二轮补充：[implementation-detail.md](./implementation-detail.md) 明确状态转移、生命周期可行性、串行所有权转移、测试分层与交互。交接模板见 [code-agent-prompt.md](./code-agent-prompt.md)；仅供用户发送，不代表本轮已启动实施。

推荐阅读顺序：

1. [implementation-spec.md](./implementation-spec.md)：精确Token/原生变量所有权、wrapper、布局尺寸与断点、Craft切换与状态。
2. [gap-analysis.md](./gap-analysis.md)：源码差异、五张布局参考落实矩阵、逐页变化与首批影响。
3. [task-dag.md](./task-dag.md)：Superpowers格式的21个草案任务、分批顺序、接口/角色/文件/验证；结构化数据见[tasks.json](./tasks.json)。
4. [route-acceptance.json](./route-acceptance.json)：76页独立绑定；另列4布局、7跳转。
5. [verification-plan.md](./verification-plan.md)：native/driven真实命令、真实产品URL/动态ID缺口、浏览器状态/视口/检查点与Review/OCR规则。
6. [execution-ready.md](./execution-ready.md)：最少决定、下一条启动指令、首批执行Brief；当前到此停止。

文档级证据：[ledger.md](./ledger.md)、[baseline.json](./baseline.json)、[route-rescan.json](./route-rescan.json)、[source-evidence.json](./source-evidence.json)、[theme-contract.json](./theme-contract.json)、[contrast-check.json](./contrast-check.json)、[validation.json](./validation.json)、[delivery-manifest.json](./delivery-manifest.json)。startup-status.txt 保留启动完整文件状态。baseline覆盖既有文件字节，不把未提交HeroUI内容计作本轮新增。

复核命令（根目录运行，仅写本目录的验证报告）：

```bash
python3 docs/design/2026-10-20-workspace-redesign/handoff/refinement/validate-docs.py
```

`build-docs.py` 是本次结构化产物的生成记录，读取现有设计页数据与源码，输出本目录主题、任务、逐页验收和差异文件。它不是生产实现脚本，也不是计划执行器。第二轮已经手工细化tasks/task-dag并新增补充，因此该历史生成器增加保护并拒绝直接重跑；要重新生成需先合入第二轮指针、元数据与决定，避免覆盖当前事实源。

第一批推荐T01–T08：主题与公共骨架→Bots/详情及配置/观测链→聊天，23页和共享层。Craft、设置/账务、知识库、其他后台/流程仍是后续独立批次，全部页面保留在总范围内。
