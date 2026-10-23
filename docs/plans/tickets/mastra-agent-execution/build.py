#!/usr/bin/env python3
"""Render and validate local Issue drafts. Never calls the issue tracker."""

from pathlib import Path
import hashlib
import json


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]
manifest_path = ROOT / "tickets.json"
manifest = json.loads(manifest_path.read_text())
tickets = manifest["tickets"]
by_id = {ticket["id"]: ticket for ticket in tickets}
assert len(by_id) == len(tickets) == 16, "IDs must be unique"
assert manifest["repo"] == "1123786563/OpenBot"

visiting, visited, order = set(), set(), []


def visit(key):
    assert key in by_id, f"Unknown dependency: {key}"
    assert key not in visiting, f"Dependency cycle at {key}"
    if key in visited:
        return
    visiting.add(key)
    for predecessor in by_id[key]["depends_on"]:
        visit(predecessor)
    visiting.remove(key)
    visited.add(key)
    order.append(key)


for ticket in tickets:
    assert ticket["id"] not in ticket["depends_on"]
    assert len(ticket["criteria"]) >= 5
    for field in ("title", "deliver", "verification", "boundary", "produces", "risk"):
        assert ticket[field], (ticket["id"], field)
    assert set(ticket["roles"]) <= {"backend_implementer", "frontend_implementer"}
    assert set(ticket.get("external_blockers", [])) <= {395}
    visit(ticket["id"])

covered = {item for ticket in tickets for item in ticket["acceptance"]}
assert covered == {f"A{i:02d}" for i in range(1, 21)}, covered
assert order == [ticket["id"] for ticket in tickets], "Publish blockers first"

# Publishing replaces local draft references with real tracker identifiers. Never
# regenerate draft bodies over approved or published Issues.
if manifest["status"] != "draft-awaiting-breakdown-review":
    for ticket in tickets:
        body = (ROOT / ticket["file"]).read_bytes()
        assert hashlib.sha256(body).hexdigest() == ticket["body_sha256"], ticket["id"]
    parent = (ROOT / "parent-issue.md").read_bytes()
    assert hashlib.sha256(parent).hexdigest() == manifest["parent_body_sha256"]
    if manifest["status"] == "published-and-verified":
        assert manifest["parent_issue"] is not None
        assert all(ticket.get("issue_number") and ticket.get("url") for ticket in tickets)
    print(f"Validated {len(tickets)} existing bodies and DAG; status={manifest['status']}. No regeneration or tracker writes.")
    raise SystemExit(0)

issue_dir = ROOT / "issues"
issue_dir.mkdir(exist_ok=True)
common = """## Handoff notes

- 本文是尚未发布的 Issue 草案；评审确认后才发布到指定仓库并关联正式父 Spec。ready-for-agent 只表示规格可接手，不表示依赖已完成、已实现或已获上线授权。
- 使用根 CONTEXT 的术语，遵守公司/团队/本人/逻辑 Bot、计费准入、个人记忆和测试运行器 ADR；不得因框架替换重定权威。
- 每票保留独立可演示的行为；跨端时先固定事件/状态接口，再按专业角色安排票内实现 Task，不把业务票另拆成数据库/后端/前端水平交付。
- 领取前核验前置代码及其同哈希验证/Review 已集成；关闭状态不是实现证据，外部引用不是自动扩大的实施范围。
- 按仓库 writing-plans/SDD/独立 Review/OCR 流程实施；无提交授权用完整未提交增量检查点。该流程在真正实施时适用，本草案不启动实现。
- 验证由 e2e 统一调度，native/driven 清单与实际用例数对账，数据库仅用明确的一次性受限角色 fixture；skip/缺环境/零用例不算通过。
- 结束或中断记录 HEAD、范围、完整 patch/新增文件及哈希、实际命令与结果、Review 和限制，方便新 Agent 恢复；不擅自提交、推送、合并、生产导入、部署或关闭其他 Issue。
"""
rows = []
for ticket in tickets:
    key = ticket["id"]
    local_edges = [f"- {dep} — {by_id[dep]['title']}" for dep in ticket["depends_on"]]
    external_edges = [
        f"- https://github.com/{manifest['repo']}/issues/{number} — 既有交付合同（代码与验证需集成）"
        for number in ticket.get("external_blockers", [])
    ]
    blockers = "\n".join(local_edges + external_edges) or "None（拆票获确认并正式发布后可准备；不表示当前获准实现）"
    checklist = "\n".join(f"- [ ] {criterion}" for criterion in ticket["criteria"])
    body = f"""## Parent

ME-SPEC：内置 Agent 执行迁移 Mastra。本批父 Spec 尚未发布；当前不存在可引用的父 Issue 编号。

## What to build

{ticket['deliver']}

## Acceptance criteria

{checklist}

## Blocked by

{blockers}

## Scope boundary

{ticket['boundary']}

## Interfaces

- Consumes：前置票经审查的实际交付合同，以及父 Spec 的身份、预算、消息与恢复约束。
- Produces：{ticket['produces']}
- Responsibility：{' / '.join(ticket['roles'])}；相应只读验证者 + 独立 Spec/质量 reviewer。

## Verification

{ticket['verification']}

## Failure handling

{ticket['risk']}

## Acceptance mapping

父 Spec：{', '.join(ticket['acceptance'])}。既有实施计划关联：{', '.join(ticket['plan_tasks'])}。Issue 是完整业务切片，计划 Task 是票内或前置工程步骤，两者不一一等同。

{common}"""
    filename = f"issues/{key.lower()}.md"
    (ROOT / filename).write_text(body)
    ticket["file"] = filename
    ticket["body_sha256"] = hashlib.sha256(body.encode()).hexdigest()
    ticket["issue_number"] = None
    edges = ", ".join(ticket["depends_on"]) or "无内部依赖"
    if external_edges:
        edges += "；外部 #395"
    rows.append(f"| {key} | [{ticket['title']}]({filename}) | {edges} | {ticket['deliver']} |")

spec_path = REPO_ROOT / manifest["spec"]
spec = spec_path.read_text()
parent = "# Spec: 内置 Agent 执行迁移 Mastra\n\n" + spec.split("\n", 1)[1]
parent += "\n## 拟拆分的业务子 Issue\n\n"
parent += "| 本地编号 | 标题 | Blocked by |\n| --- | --- | --- |\n"
for ticket in tickets:
    edges = ", ".join(ticket["depends_on"]) or "None"
    if ticket.get("external_blockers"):
        edges += "; #395"
    parent += f"| {ticket['id']} | {ticket['title']} | {edges} |\n"
(ROOT / "parent-issue.md").write_text(parent)
manifest["parent_body_sha256"] = hashlib.sha256(parent.encode()).hexdigest()
manifest["spec_sha256"] = hashlib.sha256(spec.encode()).hexdigest()
manifest["topological_order"] = order
manifest["external_dependencies"] = [
    {"repo": manifest["repo"], "number": 395, "blocks": ["ME07"], "status": "OPEN at read; implementation not audited"}
]
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

readme = """# Mastra Agent 执行迁移：Issue 拆解评审包

日期：2026-10-19。状态：**16 张具体子 Issue 草案已生成，尚未发布到 GitHub**。

需求来自本次对话，目标 tracker 为 `1123786563/OpenBot`；本批将使用一张独立父 Spec，现有 #6/#376 只作约束与关联，不修改其正文/状态，也不把新迁移挂成重复的多租户功能。

## 评审入口

- [详细方案](../../specs/2026-10-19-mastra-agent-execution-migration-design.md)
- [架构决定提案](../../adr/0010-mastra-execution-openbot-governance.md)
- [拟发布父 Issue 正文](parent-issue.md)
- [可恢复拆票清单、依赖、验收与正文哈希](tickets.json)
- [既有 Issue 的读取快照与依赖核对](sources.json)
- [已有文件级实施计划](../../plans/2026-10-19-mastra-agent-execution-migration.md)

Issue 按业务可演示行为拆分，前后端专业分工放在票内，不将 15 个技术 Task 原样改名为 Issue。本轮共有 16 张子票；ME01 是必要的兼容性验证切片，其余是交互/后台/迁移完整路径。默认串行实施；DAG 分叉只表达真实依赖，不授权并行编辑共享模块。

本拆分获确认后，以批准 Spec 和本业务 DAG 决定范围及真实依赖；旧 15-Task 计划只作为文件/测试参考。实施前按每张 Issue 重新提取票内 Task Brief、核验已交付接口与共享文件所有权，不同时混用旧线性顺序和新业务 DAG 派发。

## 具体拆分

| 编号 | 标题/草案正文 | Blocked by | 交付行为 |
| --- | --- | --- | --- |
""" + "\n".join(rows) + """

## 测试 seam 待本次一并评审

1. 主 seam：真实挂载网页或持久后台任务的“已准入运行”入口，观察事件、历史、调用、receipt、用量及客户端行为。
2. 数据库集成：受限角色、真实 RLS/CAS/lease/intent，验证跨公司/团队/用户、重启及双实例；不以 mock 替代。
3. 外部依赖：确定性 provider/tool fixture 及锁定 Mastra 合约；必要真实能力缺环境则明确 unverified。

## 依赖图

```mermaid
flowchart TD
  ME01 --> ME02 --> ME03 --> ME04 --> ME05 --> ME06
  ME04 --> ME07
  H395[既有 #395 个人记忆权威退出] --> ME07
  ME05 --> ME08
  ME06 --> ME09
  ME07 --> ME09
  ME08 --> ME09
  ME09 --> ME10 --> ME11
  ME09 --> ME12
  ME03 --> ME13
  ME05 --> ME13
  ME11 --> ME14
  ME12 --> ME14
  ME13 --> ME14
  ME14 --> ME15 --> ME16
```

## 既有 Issue 与范围交界

| 既有 Issue | 本轮关系 | 处理 |
| --- | --- | --- |
| #6 公司/团队多租户 | 授权与统一开放约束 | 保持其正文/状态；本迁移通过不表示其全功能门槛通过 |
| #92 TypeScript Agent 归属 | 已验证执行绑定合同 | 核验当前代码、复用合同；不按 OPEN/CLOSED 猜是否满足 |
| #94 执行上界/审批/脱敏 | 必须保留的保证 | 本轮每个适配加行为证据，不重做所有原生引擎 |
| #395 Intelligence 个人记忆退出 | **ME07 的真实外部前置** | 本轮只消费，避免重发退出票；当前为 OPEN |
| #162 外部状态归属迁移 | 旧映射证据参考 | 当前 CLOSED，但仍核验代码/映射；不重复迁浏览器/向量 |
| #436 fresh-schema 故障 | 可能影响独立测试库 | 当前 OPEN；以实际 schema 探测证据判阻塞，不整票纳入迁移范围 |
| HeroUI #443 等 | 同时可能改客户端 | 不重做视觉；实施时共享文件串行/分开集成 |

## 发布规则

当前不伪造 GitHub 编号、URL 或批准状态。拆票粒度、依赖和主测试 seam 获确认后，先发布父 Spec，再按 tickets.json 拓扑序发布 16 张子票并应用现有 ready-for-agent 标签。父 Spec 的设计批准状态仍按实际记录，不因标签自动升级。

发布时将子票中的 ME-SPEC/ME 编号替换成真实 GitHub 链接；添加正式 sub-issue，contains 与 blocked_by 分别写入 manifest；支持原生依赖时写入并回读验证，不支持时保留正文依赖并披露。不要改已有 #6/#376 正文、状态或关闭它们。

如原生关系写入失败，保持真实已创建编号和错误以便幂等续跑；创建结果不明先按标记/标题回查，不能重复创建。每次发布立即保存远程 ID/URL/正文哈希；全部完成后回读正文、labels、contains 与依赖，核对全量分页和 A01–A20 覆盖。

未获批准执行/上线；发布 Issue 不提交代码、不启动实施、不执行生产迁移。真正实施按仓库完整工程流程与新执行基线进行，保留已有其他任务改动。

## 静态检查

在此目录执行 `python3 build.py`：只重建本地草案，校验唯一 ID、存在的依赖、无自环/环、拓扑顺序、每票至少五项验收、专业角色、外部依赖白名单和 A01–A20 完整覆盖；不调用 GitHub、不修改生产代码。这是文档校验，不是产品测试。
"""
(ROOT / "README.md").write_text(readme)
print(f"Validated {len(tickets)} tickets, A01-A20 coverage and acyclic dependencies; rendered local drafts only.")
