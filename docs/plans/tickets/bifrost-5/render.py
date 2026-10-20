#!/usr/bin/env python3
"""Render one GitHub issue body per ticket from manifest.json.

Output: docs/tickets/bifrost-5/issues/<id>-<slug>.md
Blocked-by uses published issue numbers when present in the manifest
(ticket.issue_number), otherwise the local ticket id.

Usage: python3 render.py [--only 07.1,07.2] [--check]
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
OUT = os.path.join(HERE, "issues")


def load():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def ref(m, tid):
    t = m["_by"][tid]
    if t.get("issue_number"):
        return f"#{t['issue_number']} {t['title']}"
    return f"`{tid}` {t['title']}（本地编号，发布后替换为 Issue 号）"


def bullets(items, indent=""):
    return "\n".join(f"{indent}- {x}" for x in items)


def numbered(items):
    return "\n".join(f"{i+1}. {x}" for i, x in enumerate(items))


def render(m, t):
    gid = t["group"]
    gc = m.get("group_context", {}).get(gid, {})
    by = m["_by"]
    parent = m["parent"]
    lines = []
    lines.append("## Parent")
    lines.append("")
    lines.append(f"- Spec: {parent} — Bifrost 模型访问、短期虚拟 Key 与严格积分计费")
    lines.append(f"- 组 {gid} {t['group_title']}（本组 Ticket 见下方 Blocked by / Blocks）")
    lines.append(f"- 覆盖验收标准：{', '.join(t['acceptance_ids'])}")
    lines.append(f"- 主战场：`{t['primary_repo']}`")
    lines.append("")
    lines.append("## What to build")
    lines.append("")
    lines.append(t["what"])
    lines.append("")
    lines.append("## Acceptance criteria")
    lines.append("")
    lines.append(bullets([("[x] " if False else "[ ] ") + c for c in t.get("criteria", [])]))
    lines.append("")
    lines.append("## Blocked by")
    lines.append("")
    if t["depends_on"]:
        lines.append(bullets([ref(m, d) for d in t["depends_on"]]))
    else:
        lines.append("- None (can start immediately)")
    lines.append("")
    downstream = [x["id"] for x in m["tickets"] if t["id"] in x["depends_on"]]
    lines.append("## Blocks")
    lines.append("")
    lines.append(bullets([f"`{d}` {by[d]['title']}" for d in downstream]) if downstream else "- 无下游（本组交付终点）")
    lines.append("")
    lines.append("## Contracts")
    lines.append("")
    c = t.get("contracts", {})
    lines.append("**Consumes（前置已交付的契约，开工前先读实际实现，不臆测）**")
    lines.append("")
    lines.append(bullets(c.get("consumes", []) or ["-"]))
    lines.append("")
    lines.append("**Produces（本 Ticket 交付给下游的契约）**")
    lines.append("")
    lines.append(bullets(c.get("produces", [])))
    lines.append("")
    lines.append("## Implementation steps")
    lines.append("")
    lines.append(numbered(t.get("steps", [])))
    lines.append("")
    lines.append("## Write scope（只允许改这些范围，越界即停并上报）")
    lines.append("")
    lines.append(bullets(t.get("owned_scope", [])))
    lines.append("")
    lines.append("## Tests to write")
    lines.append("")
    lines.append(bullets(t.get("tests", [])))
    lines.append("")
    lines.append("## Verification（接手 agent 直接重跑这些命令）")
    lines.append("")
    ver = list(t.get("verification", [])) + list(gc.get("verification_common", []))
    lines.append("```bash")
    lines.append("\n".join(ver))
    lines.append("```")
    lines.append("")
    lines.append("## Handoff / 交接")
    lines.append("")
    lines.append(f"- **Resume hint**：{t.get('resume_hint','')}")
    lines.append("- **Checkpoint**：执行者必须在此填写未提交检查点或提交哈希、快照路径与文件哈希清单；空缺即视为未完成。")
    lines.append("- **失败即弃**：本 Ticket 失败不污染已验证的前置 Ticket；接手者读本节 + Verification 即可续做。")
    lines.append("")
    lines.append("## Sources")
    lines.append("")
    lines.append(bullets(gc.get("context", [])))
    anchors = gc.get("anchors", {})
    if anchors:
        lines.append("")
        lines.append("**代码锚点（以仓库当前实现为准，路径可能漂移）**")
        lines.append("")
        lines.append(bullets([f"{k}: `{v}`" for k, v in anchors.items()]))
    lines.append("")
    lines.append("## Global constraints（摘自父 Spec，冲突时以父 Spec 与 ADR 为准）")
    lines.append("")
    lines.append(bullets(m["global_constraints"]))
    lines.append("")
    lines.append("## Execution procedure")
    lines.append("")
    lines.append(numbered(m["execution_procedure"]))
    lines.append("")
    lines.append(f"**Failure policy**：{m['failure_policy']}")
    lines.append("")
    return "\n".join(lines)


def main():
    m = load()
    m["_by"] = {t["id"]: t for t in m["tickets"]}
    only = None
    for i, a in enumerate(sys.argv):
        if a == "--only":
            only = set(sys.argv[i + 1].split(","))
    os.makedirs(OUT, exist_ok=True)
    written, skipped = [], []
    for t in m["tickets"]:
        if only and t["id"] not in only:
            continue
        if not t.get("steps"):
            skipped.append(t["id"])
            continue
        path = os.path.join(OUT, f"{t['id']}-{t.get('slug', t['id'])}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(render(m, t))
        written.append(os.path.basename(path))
    print(f"rendered {len(written)} issue bodies -> {OUT}")
    if written:
        print("first:", written[0], "last:", written[-1])
    if skipped:
        print(f"skipped (no details yet): {len(skipped)} -> {' '.join(skipped[:12])}{' ...' if len(skipped)>12 else ''}")
    if "--check" in sys.argv and not written:
        sys.exit(1)


if __name__ == "__main__":
    main()
