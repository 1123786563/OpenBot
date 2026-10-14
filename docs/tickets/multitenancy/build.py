#!/usr/bin/env python3
"""Validate the multitenancy ticket breakdown and emit manifest + per-ticket bodies.

Fact sources: approved Spec (GitHub Issue #6 / docs/specs/2026-10-14-company-team-multitenancy-design.md),
ADR 0004 (accepted), ADR 0002/0003, CONTEXT.md. Granularity rule from the user (2026-10-15): every ticket
must fit a single code-agent context so another agent can take over quickly; multi-dependency and
multi-target tickets are split further (splits.json).
"""
import json, re, sys, collections
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC_ISSUE = "https://github.com/1123786563/OpenBot/issues/6"
PLAN_FOLDER = "docs/plans/2026-10-15-company-team-multitenancy"
REF = re.compile(r"MT\d{3}")

base = []
for p in sorted(HERE.glob("parts-*.json")):
    base.extend(json.loads(p.read_text()))
base_by_id = {t["id"]: t for t in base}
splits = json.loads((HERE / "splits.json").read_text())["splits"]
split_by_orig = {s["orig"]: s for s in splits}

errors = []
for s in splits:
    if s["orig"] not in base_by_id:
        errors.append(f"splits.json: unknown orig {s['orig']}")

# --- expand splits in place -------------------------------------------------
expanded, last_of = [], {}
for t in base:
    s = split_by_orig.get(t["id"])
    if not s:
        expanded.append(dict(t, split_from=None))
        last_of[t["id"]] = t["id"]
        continue
    parts = s["parts"]
    temps = [t["id"] if i == 0 else f"{t['id']}~{i+1}" for i in range(len(parts))]
    for i, (part, tid) in enumerate(zip(parts, temps)):
        inherited_notes = t.get("notes", "")
        if i == 0:
            notes = (inherited_notes + " " if inherited_notes else "") + f"（原 Ticket 已按粒度要求拆为 {len(parts)} 段，本段为第 1 段。）"
        else:
            notes = f"由「{t['title']}」拆出的第 {i+1}/{len(parts)} 段；上一段（{parts[i-1]['title']}）完成并集成后再领取。"
            if part.get("notes"):
                notes += " " + part["notes"]
        expanded.append({
            "id": tid,
            "g": t["g"],
            "slug": part["slug"],
            "title": part["title"],
            "what": part["what"],
            "deps": part.get("deps", "@prev"),
            "acc": part.get("acc", t["acc"]),
            "scope": part.get("scope", t["scope"]),
            "crit": part["crit"],
            "verify": part.get("verify", t["verify"]),
            "notes": notes.strip(),
            "split_from": t["id"],
        })
    last_of[t["id"]] = temps[-1]

def resolve_temp(ref):
    """Map an original MT id (or temp id) to the temp id that carries it."""
    if ref in last_of:
        return last_of[ref]
    return ref

# resolve deps to temp ids
for t in expanded:
    deps = t["deps"]
    if deps == "@inherit":
        deps = list(base_by_id[t["split_from"] or t["id"]]["deps"])
    resolved, seen = [], set()
    for i, d in enumerate(deps if isinstance(deps, list) else [deps]):
        if d == "@prev":
            idx = expanded.index(t) - 1
            d = expanded[idx]["id"]
        elif d == "@prev-all":
            idx = expanded.index(t)
            origin = t["split_from"]
            for prev in expanded[:idx]:
                if prev["split_from"] == origin and prev["id"] not in seen:
                    resolved.append(prev["id"]); seen.add(prev["id"])
            continue
        else:
            d = resolve_temp(d)
        if d not in seen:
            resolved.append(d); seen.add(d)
    t["deps"] = resolved

temp_by_id = {t["id"]: t for t in expanded}

# --- turn every textual MT reference into a slug token, then renumber -------
for t in expanded:
    for field in ("what", "scope", "verify", "notes"):
        t[field] = REF.sub(lambda m: f"⟦{temp_by_id[resolve_temp(m.group(0))]['slug']}⟧"
                           if resolve_temp(m.group(0)) in temp_by_id else m.group(0), t[field])
    t["crit"] = [REF.sub(lambda m: f"⟦{temp_by_id[resolve_temp(m.group(0))]['slug']}⟧"
                         if resolve_temp(m.group(0)) in temp_by_id else m.group(0), c) for c in t["crit"]]

tickets = expanded
ids = [f"MT{n:03d}" for n in range(1, len(tickets) + 1)]
new_of_temp = {t["id"]: nid for t, nid in zip(tickets, ids)}
slug_to_new = {t["slug"]: nid for t, nid in zip(tickets, ids)}
for t, nid in zip(tickets, ids):
    t["old_id"], t["id"] = t["id"], nid
    t["deps"] = [new_of_temp[d] for d in t["deps"]]
    for field in ("what", "scope", "verify", "notes"):
        t[field] = re.sub(r"⟦([a-z0-9\-]+)⟧", lambda m: slug_to_new.get(m.group(1), m.group(0)), t[field])
    t["crit"] = [re.sub(r"⟦([a-z0-9\-]+)⟧", lambda m: slug_to_new.get(m.group(1), m.group(0)), c) for c in t["crit"]]
    if t.get("split_from"):
        t["split_from"] = f"{base_by_id[t['split_from']]['id']} {base_by_id[t['split_from']]['title']}"

by_id = {t["id"]: t for t in tickets}

# --- validation ------------------------------------------------------------
dupes = [i for i, c in collections.Counter(t["slug"] for t in tickets).items() if c > 1]
if dupes:
    errors.append(f"duplicate slugs: {dupes}")
for t in tickets:
    for d in t["deps"]:
        if d not in by_id:
            errors.append(f"{t['id']}: unknown dep {d}")
        elif int(d[2:]) >= int(t["id"][2:]):
            errors.append(f"{t['id']}: dep {d} is not declared earlier")
    for a in t["acc"]:
        if not re.fullmatch(r"A(1[0-3]|[1-9])", a):
            errors.append(f"{t['id']}: unknown acceptance {a}")
    if len(t.get("crit", [])) < 3:
        errors.append(f"{t['id']}: fewer than 3 acceptance criteria")
    for text in t.get("crit", []) + [t.get("notes", ""), t.get("scope", ""), t.get("what", "")]:
        for ref in REF.findall(text):
            if ref not in by_id:
                errors.append(f"{t['id']}: references unknown ticket {ref}")
        if "⟦" in text:
            errors.append(f"{t['id']}: unresolved slug token in text")

state, order = {}, []
def visit(n, stack):
    if state.get(n) == "done":
        return
    if state.get(n) == "open":
        errors.append(f"cycle: {' -> '.join(stack + [n])}")
        return
    state[n] = "open"
    for d in by_id[n]["deps"]:
        if d in by_id:
            visit(d, stack + [n])
    state[n] = "done"
    order.append(n)
for t in tickets:
    visit(t["id"], [])
topological = order == [t["id"] for t in tickets]

acc_cov = collections.Counter(a for t in tickets for a in t["acc"])
missing_acc = [f"A{n}" for n in range(1, 14) if not acc_cov.get(f"A{n}")]
if missing_acc:
    errors.append(f"acceptance not covered: {missing_acc}")
groups = collections.Counter(t["g"] for t in tickets)
frontier = [t["id"] for t in tickets if not t["deps"]]
multi_dep = sorted(((len(t["deps"]), t["id"]) for t in tickets), reverse=True)[:5]

# --- emit ------------------------------------------------------------------
def body(t):
    lines = ["## Parent", "", f"Spec: {SPEC_ISSUE} — 公司与团队多租户整改（全功能隔离后统一上线）", "",
             "## What to build", "", t["what"], "", "## Acceptance criteria", ""]
    lines += [f"- [ ] {c}" for c in t["crit"]]
    lines += ["", "## Blocked by", ""]
    if not t["deps"]:
        lines.append("None (can start immediately).")
    else:
        lines += [f"- #{PUBLISHED[d]} {by_id[d]['title']}（{d}）" if d in PUBLISHED
                  else f"- {d} {by_id[d]['title']}" for d in t["deps"]]
    lines += ["", "## Scope boundary", "", t["scope"], "", "## Verification", "", t["verify"], "",
              "## Handoff notes", "",
              "- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。",
              f"- 覆盖验收：{', '.join(t['acc'])}。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。",
              f"- 若工作区存在实施计划 `{PLAN_FOLDER}/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。",
              "- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。",
              "- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。",
              "- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。",
              "- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。"]
    if t.get("notes"):
        lines.append(f"- Ticket 备注：{t['notes']}")
    return "\n".join(lines) + "\n"

PUBLISHED = {}
if (HERE / "published.json").exists():
    PUBLISHED = json.loads((HERE / "published.json").read_text())

tdir = HERE / "tickets"
tdir.mkdir(exist_ok=True)
for f in tdir.glob("*.md"):
    f.unlink()
for t in tickets:
    (tdir / f"{t['id']}-{t['slug']}.md").write_text(body(t))

manifest = {
    "repository": "1123786563/OpenBot",
    "parent_spec_issue": SPEC_ISSUE,
    "parent_spec_title": "Spec: 公司与团队多租户整改（全功能隔离后统一上线）",
    "source_documents": [
        "docs/specs/2026-10-14-company-team-multitenancy-design.md",
        "docs/adr/0004-company-team-tenancy.md",
        "docs/adr/0002-per-user-bot-model-access.md",
        "docs/adr/0003-bifrost-openbot-credit-admission.md",
        "CONTEXT.md",
        f"{PLAN_FOLDER}/00-master.md",
    ],
    "prepared_date": "2026-10-15",
    "status": "draft-awaiting-breakdown-approval",
    "granularity_rule": "每个 Ticket 必须能在单个 code agent 上下文内完成，使某个 agent 失败时另一个 agent 能很快接手；多依赖与多目标 Ticket 已进一步拆分。",
    "sequencing": "宽范围机械重构按 expand → migrate（按 blast radius 分批）→ contract 排序；每批一个 Ticket，保持每个 Ticket 是可独立验证的业务行为切片。",
    "ticket_count": len(tickets),
    "split_count": sum(1 for t in tickets if t.get("split_from")),
    "frontier": frontier,
    "most_dependent": [{"id": i, "deps": n} for n, i in multi_dep],
    "acceptance_coverage": dict(sorted(acc_cov.items(), key=lambda kv: int(kv[0][1:]))),
    "groups": dict(groups),
    "checks": {
        "unique_slugs": not dupes,
        "dependencies_exist": not any("unknown dep" in e for e in errors),
        "deps_declared_earlier": not any("not declared earlier" in e for e in errors),
        "no_cycles": not any("cycle" in e for e in errors),
        "declaration_order_topological": topological,
        "acceptance_coverage_13": not missing_acc,
        "no_unknown_ticket_references": not any("unknown ticket" in e for e in errors),
        "no_unresolved_tokens": not any("unresolved slug" in e for e in errors),
    },
    "errors": errors,
    "tickets": [
        {"id": t["id"], "slug": t["slug"], "group": t["g"], "title": t["title"],
         "depends_on": t["deps"], "acceptance": t["acc"], "split_from": t.get("split_from"),
         "issue_number": PUBLISHED.get(t["id"]), "status": "pending"}
        for t in tickets
    ],
}
(HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

bl = ["# 多租户整改 Ticket 拆解（待审阅）", "",
      f"父 Spec：{SPEC_ISSUE}（Issue #6）。共 **{len(tickets)}** 个 Ticket，{len(groups)} 组，其中 {manifest['split_count']} 个由多依赖/多目标 Ticket 拆分而来。",
      "", f"粒度规则：{manifest['granularity_rule']}", "", f"排序：{manifest['sequencing']}", "",
      f"可立即开始（无阻塞）：{', '.join(frontier)}", "",
      "验收覆盖：" + ", ".join(f"{k}×{v}" for k, v in sorted(acc_cov.items(), key=lambda kv: int(kv[0][1:]))), "",
      "校验：" + json.dumps(manifest["checks"], ensure_ascii=False), "", "---", ""]
cur = None
for i, t in enumerate(tickets, 1):
    if t["g"] != cur:
        cur = t["g"]
        bl += ["", f"### {cur}", ""]
    bl.append(f"{i}. **{t['id']} {t['title']}**")
    bl.append(f"   - Blocked by: {', '.join(t['deps']) if t['deps'] else 'None'}")
    bl.append(f"   - Delivers: {t['what']}")
    bl.append(f"   - Acceptance: {', '.join(t['acc'])}")
(HERE / "breakdown.md").write_text("\n".join(bl) + "\n")

print(json.dumps({"tickets": len(tickets), "split_parts": manifest["split_count"], "groups": len(groups),
                  "frontier": frontier, "most_dependent": manifest["most_dependent"],
                  "acceptance_coverage": manifest["acceptance_coverage"],
                  "checks": manifest["checks"], "errors": errors}, ensure_ascii=False, indent=1))
sys.exit(1 if errors else 0)
