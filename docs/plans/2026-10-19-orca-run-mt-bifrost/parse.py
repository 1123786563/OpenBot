#!/usr/bin/env python3
"""R3: 解析已摄取的 Issue 正文，提取显式依赖，构建 DAG 与就绪集。

只信任结构化位置：叶票 `## Blocked by` / `## Blocks` 段、聚合票 Tickets 表格
与 `## 跨组依赖` 段。其余正文（Handoff notes 等）中的编号一律忽略。
"""
import json
import re
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
ISSUES = DIR / "issues"

ROOTS = [5, 6]
# 结构化段落之外的引用不解析；聚合表格通过 URL 提号
RE_MT = re.compile(r"\bMT(\d{3})\b")
RE_NUM = re.compile(r"#(\d+)\b")
RE_URL = re.compile(r"issues/(\d+)\b")
RE_BF = re.compile(r"\b(\d{2}\.\d{1,2})\b")


def section(body: str, name: str) -> str:
    """提取 `## <name>` 段落文本（到下一个 ## 为止）。"""
    m = re.search(rf"^##\s+{re.escape(name)}\s*$", body, re.M)
    if not m:
        return ""
    rest = body[m.end():]
    nxt = re.search(r"^##\s+", rest, re.M)
    return rest[:nxt.start()] if nxt else rest


def classify(issue):
    n, title = issue["number"], issue["title"]
    if n in ROOTS:
        return "root", None
    if title.startswith("[多租户") or re.match(r"^\[计费支付\]", title):
        return "aggregate", None
    m = re.match(r"^\[计费支付 (BP\d+)\]", title)
    if m:
        return "bp", m.group(1)
    m = RE_MT.search(title)
    if m:
        return "mt", f"MT{m.group(1)}"
    m = re.search(r"\bBifrost\s+(\d{2}\.\d{1,2})\b", title)
    if m:
        return "bf", m.group(1)
    return "unknown", None


def parse_refs(text: str):
    """从一段文本提取 (mt_ids, numbers, bf_ids)。"""
    mts = {f"MT{m}" for m in RE_MT.findall(text)}
    nums = {int(m) for m in RE_NUM.findall(text)} | {int(m) for m in RE_URL.findall(text)}
    bfs = set(RE_BF.findall(text))
    return mts, nums, bfs


def main():
    nodes, edges = {}, []  # edges: (dep_number -> number)
    external, unresolved = [], []
    by_id, by_number = {}, {}

    for f in sorted(ISSUES.glob("*.json")):
        it = json.loads(f.read_text())
        kind, tid = classify(it)
        by_number[it["number"]] = it
        if tid:
            by_id[tid] = it
        nodes[it["number"]] = {
            "number": it["number"], "title": it["title"], "state": it["state"],
            "kind": kind, "tid": tid, "labels": it.get("labels", []),
            "deps": [], "dep_ids": [], "ac": bool(section(it.get("body") or "", "Acceptance criteria").strip()),
            "blocked_by_raw": "", "inconsistent": [],
        }

    # 聚合票表格（| Ticket | Issue | Blocked by | 验收 |）里的依赖归到对应叶票
    for n, nd in nodes.items():
        it = by_number[n]
        if nd["kind"] != "aggregate":
            continue
        body = it.get("body") or ""
        for line in body.splitlines():
            if not line.strip().startswith("|") or "Issue" in line or "---" in line:
                continue
            cols = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cols) < 3:
                continue
            leaf_nums = {int(m) for m in RE_URL.findall(cols[1] if len(cols) > 1 else "")}
            dep_cell = cols[2] if len(cols) > 2 else ""
            if dep_cell in ("—", "-", ""):
                continue
            mts, nums, bfs = parse_refs(dep_cell)
            for ln in leaf_nums:
                if ln in nodes:
                    nd2 = nodes[ln]
                    for mt in mts:
                        nd2["dep_ids"] = nd2["dep_ids"] or []
                        if mt not in nd2["dep_ids"]:
                            nd2["dep_ids"].append(mt)
                    for num in nums:
                        if num in nodes and num != ln:
                            nodes[ln]["deps"].append(num)

    # 叶票 / 根的 ## Blocked by 与 ## Blocks
    for n, nd in nodes.items():
        if nd["kind"] in ("aggregate",):
            continue
        it = by_number[n]
        body = it.get("body") or ""
        bb = section(body, "Blocked by")
        bl = section(body, "Blocks")
        nd["blocked_by_raw"] = bb.strip()[:200]
        if re.sub(r"^[-\s]+", "", bb.strip().lower()).startswith("none"):
            continue
        mts, nums, bfs = parse_refs(bb)
        for mt in mts:
            nd["dep_ids"].append(mt)
        for num in nums:
            if num in nodes and num != n:
                nd["deps"].append(num)
            elif num not in nodes:
                external.append({"from": n, "ref": f"#{num}", "where": "blocked_by"})
        if not (mts or nums or bfs) and bb.strip():
            unresolved.append({"issue": n, "raw": bb.strip()[:120]})
        # Blocks 反向校验：A 声明 blocks B ⟹ B 的 deps 应含 A
        bl_nums = {int(m) for m in RE_NUM.findall(bl)} | {int(m) for m in RE_URL.findall(bl)}
        bl_mts = {f"MT{m}" for m in RE_MT.findall(bl)}
        for b in bl_nums:
            if b in nodes and n not in nodes[b]["deps"] and nodes[b]["kind"] not in ("root",):
                nodes[b]["inconsistent"].append(f"#{n} declares blocks #{b}, but #{b} does not list it in Blocked by")
        for mt in bl_mts:
            tgt = by_id.get(mt)
            if tgt and tgt["number"] in nodes and n not in nodes[tgt["number"]]["deps"]:
                nodes[tgt["number"]]["inconsistent"].append(f"#{n} declares blocks {mt}, but {tgt['number']} does not list it")

    # 把 dep_ids（MTxxx / nn.n）解析成 number
    for n, nd in nodes.items():
        for d in nd["dep_ids"]:
            tgt = by_id.get(d)
            if tgt and tgt["number"] in nodes and tgt["number"] != n:
                nd["deps"].append(tgt["number"])
            elif tgt is None:
                unresolved.append({"issue": n, "raw": d})
        nd["deps"] = sorted(set(nd["deps"]))

    # 环检测
    color, cycles = {}, []
    def dfs(u, stack):
        color[u] = 1
        for v in nodes.get(u, {}).get("deps", []):
            if color.get(v) == 1:
                cycles.append(stack[stack.index(v):] + [v])
            elif color.get(v, 0) == 0:
                dfs(v, stack + [v])
        color[u] = 2
    for n in nodes:
        if color.get(n, 0) == 0:
            dfs(n, [n])

    # 就绪集：open 且全部 deps 指向 closed（候选 satisfied）
    closed = {n for n, nd in nodes.items() if nd["state"] == "closed"}
    ready, blocked_open, leaf_open = [], [], 0
    for n, nd in nodes.items():
        if nd["kind"] in ("root", "aggregate") or nd["state"] != "open":
            continue
        leaf_open += 1
        open_deps = [d for d in nd["deps"] if d not in closed]
        if not nd["deps"]:
            ready.append(n)
        elif not open_deps:
            ready.append(n)
        else:
            blocked_open.append({"n": n, "open_deps": open_deps})

    out = {
        "roots": ROOTS,
        "nodes": nodes,
        "closed": sorted(closed),
        "external_refs": external,
        "unresolved": unresolved,
        "cycles": cycles,
        "ready": sorted(ready),
        "blocked_by_open": sorted(blocked_open, key=lambda x: x["n"]),
        "leaf_open": leaf_open,
    }
    (DIR / "dag.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"nodes={len(nodes)} leaf_open={leaf_open} closed={len(closed)} "
          f"ready={len(ready)} cycles={len(cycles)} unresolved={len(unresolved)} external={len(external)}")
    print("closed:", sorted(closed))
    print("ready:", sorted(ready))


if __name__ == "__main__":
    main()
