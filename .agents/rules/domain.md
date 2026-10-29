# Domain context

使用/修改领域术语或进入模块时读取。OpenBot 共享词汇唯一来源是根 `CONTEXT.md`；仅在 `apps/openmuse/` 工作时另读其 `CONTEXT.md` 的 OpenMuse 局部词汇，不为其他模块另建术语表。

## 各事实源的分工

`CONTEXT.md` 只记词汇，不记流程、字段或接口形状。根文件 `## Language` 按主题（用户与模型访问、公司与团队、个人记忆、计费与积分、计费准入）分节，每个术语一条定义。Spec/ADR/Plan/Ticket 的位置、有效性与优先级统一见 [design.md](design.md)，执行证据见 [artifacts.md](artifacts.md)。

## 使用规则

1. 模块开工先查根词汇；OpenMuse 另查局部词汇。沿用既有词；反复出现的新词才补对应范围定义。
2. 改术语含义即改领域模型，同步对应 `CONTEXT.md` 及批准依据，必要时补 ADR。
3. 引用概念带 Spec 文件名、ADR 编号或词汇小节。定义冲突先核批准需求并解决，不静默任选。
4. 定义漂移时按批准需求修正，并在 Spec/ADR 留依据；保持词汇表准确，不只增不删。
