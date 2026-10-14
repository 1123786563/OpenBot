#!/usr/bin/env python3
"""Sync the two post-approval corrections to the already-published issues.

1. #8  (T02) — single i18n namespace -> four sub-namespaces (-runs/-datasets/
   -evaluations/-admin); the frontend shared-types responsibility moves to #18.
2. #17 (T11) — gains #7 (T01) as a blocker, because T01 was an orphan prefactor
   that nothing depended on.

Bodies are patched locally, PATCHed to GitHub, then re-fetched so the local
record is byte-identical to the remote.
"""
import json, pathlib, subprocess, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
pub = json.loads((HERE / "publication-v2.json").read_text())
num = {t: v["number"] for t, v in pub["issues"].items()}
iid = {t: v["id"] for t, v in pub["issues"].items()}
title_by_num = {v["number"]: v["title"] for v in pub["issues"].values()}
content = json.loads((HERE / "ticket-issue-content-v2.json").read_text())
draft_file = {t["id"]: HERE / t["draft_file"] for t in content["tickets"]}

def api(method, path, body=None):
    args = ["gh", "api", "-X", method, path]
    if body is not None:
        args += ["--input", "-"]
    r = subprocess.run(args, capture_output=True, text=True,
                       input=json.dumps(body) if body is not None else None)
    if r.returncode != 0:
        raise RuntimeError(f"{method} {path}: {r.stderr.strip()[:400]}")
    return json.loads(r.stdout) if r.stdout.strip() else {}

log = []

# ---- 1. patch #8 (T02) ----
p8 = draft_file["T02"]
b = p8.read_text()
old_what = "为观测界面建立独立的双语命名空间与路由约定，使后续前端 Ticket 不再争用既有共享文案文件，并统一八类可用性状态的表达。"
new_what = ("为观测界面建立 runs / datasets / evaluations / admin 四个双子语命名空间与路由约定，"
            "使四条前端链（运行、评测集、实验、管理）各自独占文案文件，既不争用既有共享文案文件，也不彼此争用。")
old_ac = "- [ ] 观测界面文案集中在独立双语命名空间，新增前端 Ticket 不需要编辑既有共享文案文件。"
new_ac = ("- [ ] 观测界面文案按运行、评测集、实验、管理拆成四个双子语命名空间，四条前端链各自独占文案文件，"
          "既不需要编辑既有共享文案文件，也不会彼此冲突。")
old_ac4 = "- [ ] 前端共享类型位置确定，后端契约变化时只需改一处类型定义。"
new_ac4 = "- [ ] 四个子命名空间的归属矩阵（哪条前端链写哪个文件）写入交接说明，接手 agent 不会写错文件。"
old_ho = "Produces: i18n 命名空间 key 约定 + 前端共享类型位置 + 路由命名约定."
new_ho = "Produces: 四个子命名空间的 key 约定与归属矩阵（哪条前端链写哪个文件）+ 路由命名约定."
for o, n in ((old_what, new_what), (old_ac, new_ac), (old_ac4, new_ac4), (old_ho, new_ho)):
    assert o in b, f"#8 missing: {o[:50]}"
    b = b.replace(o, n)
p8.write_text(b)
new_title8 = "[Opik T02] 观测 UI 独立 i18n 子命名空间与路由约定"
api("PATCH", f"/repos/{REPO}/issues/{num['T02']}", {"title": new_title8, "body": b})
log.append(f"#{num['T02']} T02 title+body patched (four sub-namespaces)")

# ---- 2. move the frontend shared-types criterion to #18 (T12) ----
p18 = draft_file["T12"]
b18 = p18.read_text()
anchor = "- [ ] 恶意正文只作为文本渲染，不产生可执行内容。"
assert anchor in b18
b18 = b18.replace(anchor, anchor + "\n- [ ] 前端共享类型位置确定，后端契约变化时只需改一处类型定义（该职责由 T02 移入本 Ticket）。")
p18.write_text(b18)
api("PATCH", f"/repos/{REPO}/issues/{num['T12']}", {"body": b18})
log.append(f"#{num['T12']} T12 body patched (shared frontend types moved in from T02)")

# ---- 3. #17 (T11) gains #7 (T01) as blocker ----
p17 = draft_file["T11"]
b17 = p17.read_text()
first_dep = f"- #{num['T07']} {title_by_num[num['T07']].split('] ', 1)[1]}"
assert first_dep in b17, "could not locate the Blocked by list in #17"
b17 = b17.replace(first_dep,
                  f"- #{num['T01']} {title_by_num[num['T01']].split('] ',1)[1]}\n" + first_dep, 1)
p17.write_text(b17)
api("PATCH", f"/repos/{REPO}/issues/{num['T11']}", {"body": b17})
log.append(f"#{num['T11']} T11 body patched (added #{num['T01']} to Blocked by)")
api("POST", f"/repos/{REPO}/issues/{num['T11']}/dependencies/blocked_by", {"issue_id": iid["T01"]})
log.append(f"#{num['T11']} native blocked_by -> #{num['T01']} added")
time.sleep(0.4)

# ---- 4. re-fetch everything touched so local == remote ----
for tid in ("T02", "T12", "T11"):
    n = num[tid]
    draft_file[tid].write_text(api("GET", f"/repos/{REPO}/issues/{n}")["body"])
log.append("re-fetched #8/#17/#18 bodies from GitHub")

# ---- 5. verify the new edge and the parent totals ----
deps = api("GET", f"/repos/{REPO}/issues/{num['T11']}/dependencies/blocked_by?per_page=100")
got = sorted(d["number"] for d in deps)
want = sorted(num[b] for b in ("T01", "T07", "T10"))
log.append(f"#17 blocked_by = {got} (expected {want}) -> {'OK' if got == want else 'MISMATCH'}")
p4 = api("GET", f"/repos/{REPO}/issues/4")
log.append(f"parent #4 sub_issues_summary = {p4['sub_issues_summary']}")
i8 = api("GET", f"/repos/{REPO}/issues/{num['T02']}")
log.append(f"#8 title = {i8['title']}")

(HERE / "post-approval-corrections.json").write_text(json.dumps({
    "corrected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "reason": ["T01 was an orphan prefactor (no dependents)",
               "6 frontend tickets shared two locale JSON files with 10 pairwise-unordered owner pairs"],
    "changes": log,
}, ensure_ascii=False, indent=1))
print("\n".join(log))
