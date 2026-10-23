#!/usr/bin/env python3
"""Publish the user-approved Issue set with resumable local receipts."""

from pathlib import Path
import datetime
import hashlib
import json
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]
MANIFEST = ROOT / "tickets.json"
state = json.loads(MANIFEST.read_text())
REPO = "1123786563/OpenBot"
assert state["repo"] == REPO
assert state["publication_authorized_after_review"] is True
assert state.get("approval", {}).get("implementation_authorized") is False
LABELS = ["enhancement", "ready-for-agent"]
by_key = {t["id"]: t for t in state["tickets"]}
assert len(by_key) == 16


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(body):
    return hashlib.sha256(body.encode()).hexdigest()


def save():
    temporary = MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(MANIFEST)


def api(method, endpoint, payload=None, paginate=False):
    args = ["gh", "api", endpoint, "--method", method]
    if paginate:
        args.extend(["--paginate", "--slurp"])
    if payload is not None:
        args.extend(["--input", "-"])
    result = subprocess.run(
        args,
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        capture_output=True,
        text=True,
        timeout=90 if paginate else 40,
    )
    if result.returncode:
        raise RuntimeError(f"{method} {endpoint}: {result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def pages(endpoint):
    return [record for page in api("GET", endpoint, paginate=True) for record in page]


def marker(key):
    return f"<!-- openbot:mastra-agent-execution:{key} -->"


def record_issue(target, issue, body):
    target.update(
        issue_number=issue["number"],
        issue_id=issue["id"],
        url=issue["html_url"],
        published_title=issue["title"],
        body_sha256=sha(body),
        published_at=now(),
    )
    save()


def create_or_adopt(key, title, body, target):
    if target.get("issue_number"):
        issue = api("GET", f"repos/{REPO}/issues/{target['issue_number']}")
        assert issue["title"] == title and issue["body"] == body, key
        return issue
    found = [issue for issue in existing if issue.get("title") == title or marker(key) in (issue.get("body") or "")]
    assert len(found) <= 1, f"Ambiguous existing Issue for {key}"
    if found:
        issue = found[0]
        assert marker(key) in (issue.get("body") or ""), f"Title collision for {key}"
        assert issue["body"] == body, f"Existing publication differs for {key}"
        record_issue(target, issue, body)
        print(f"Recovered {key}: {issue['html_url']}", flush=True)
        return issue
    state["in_flight_write"] = {"kind": "create_issue", "key": key, "title": title, "body_sha256": sha(body), "started_at": now()}
    save()
    issue = api("POST", f"repos/{REPO}/issues", {"title": title, "body": body, "labels": LABELS})
    record_issue(target, issue, body)
    state.pop("in_flight_write", None)
    save()
    existing.append(issue)
    print(f"Created {key}: {issue['html_url']}", flush=True)
    return issue


def publish():
    global existing
    state["status"] = "publishing"
    save()
    # REST enumeration avoids relying on eventual-consistent search after unknown writes.
    existing = [] if state.get("parent_issue") and all(t.get("issue_number") for t in state["tickets"]) else pages(f"repos/{REPO}/issues?state=all&per_page=100")
    assert all(key in by_key for key in state["topological_order"])
    spec = (REPO_ROOT / state["spec"]).read_text()
    assert "尚未批准实施或发布" not in spec
    parent_body = "# Spec: 内置 Agent 执行迁移 Mastra\n\n" + spec.split("\n", 1)[1]
    parent_body += "\n## 业务子 Issue 与依赖\n\n正式子 Issue 使用 GitHub 原生关系展示；下表是已确认的稳定业务编号，不是 GitHub 编号。\n\n"
    parent_body += "| 编号 | 交付 | Blocked by |\n| --- | --- | --- |\n"
    for t in state["tickets"]:
        blockers = ", ".join(t["depends_on"]) or "None"
        if t.get("external_blockers"):
            blockers += "; https://github.com/1123786563/OpenBot/issues/395"
        parent_body += f"| {t['id']} | {t['title']} | {blockers} |\n"
    parent_body += f"\n{marker('ME-SPEC')}\n"
    (ROOT / "parent-issue.md").write_text(parent_body)
    state["spec_sha256"] = sha(spec)
    state["parent_body_sha256"] = sha(parent_body)
    parent_meta = state.setdefault("parent_publication", {})
    parent = create_or_adopt("ME-SPEC", "Spec: 内置 Agent 执行迁移 Mastra", parent_body, parent_meta)
    state["parent_issue"] = parent["number"]
    state["parent_url"] = parent["html_url"]
    state["parent_id"] = parent["id"]
    save()
    for key in state["topological_order"]:
        t = by_key[key]
        body_path = ROOT / t["file"]
        body = body_path.read_text()
        body = re.sub(
            r"## Parent\n.*?(?=## What to build)",
            f"## Parent\n\nSpec: {parent['html_url']} — 内置 Agent 执行迁移 Mastra。本 Issue 是其正式子 Issue。\n\n",
            body,
            flags=re.S,
        )
        for dep in t["depends_on"]:
            assert by_key[dep].get("issue_number"), f"Unpublished dependency: {dep}"
            body = re.sub(rf"\b{dep}\b", by_key[dep]["url"], body)
        body = body.replace(
            "None（拆票获确认并正式发布后可准备；不表示当前获准实现）",
            "None（无实施依赖；本次仅登记 Issue，不启动实现）",
        )
        body = body.replace(
            "本文是尚未发布的 Issue 草案；评审确认后才发布到指定仓库并关联正式父 Spec。",
            "方案、测试 seam 与拆票已由用户于 2026-10-19 确认，按该范围登记 Issue。",
        ).replace("该流程在真正实施时适用，本草案不启动实现。", "该流程在真正实施时适用，本 Issue 登记不启动实现。")
        if marker(key) not in body:
            body += f"\n{marker(key)}\n"
        body_path.write_text(body)
        create_or_adopt(key, f"[Mastra {key}] {t['title']}", body, t)
    # New parent's body/state is never patched after creation; children appear natively.
    children = pages(f"repos/{REPO}/issues/{parent['number']}/sub_issues?per_page=100")
    linked = {item["id"] for item in children}
    for t in state["tickets"]:
        # Successful writes were durably recorded; final verification below
        # still re-reads every relationship. Resume only unfinished writes.
        if t.get("parent_link_written") and "native_blocked_by_numbers" in t:
            continue
        if t["issue_id"] not in linked:
            api("POST", f"repos/{REPO}/issues/{parent['number']}/sub_issues", {"sub_issue_id": t["issue_id"]})
            linked.add(t["issue_id"])
        t["parent_link_written"] = True
        save()
        blockers = pages(f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by?per_page=100")
        known = {item["id"] for item in blockers}
        expected = []
        for key in t["depends_on"]:
            expected.append({"number": by_key[key]["issue_number"], "id": by_key[key]["issue_id"]})
        for number in t.get("external_blockers", []):
            item = api("GET", f"repos/{REPO}/issues/{number}")
            expected.append({"number": number, "id": item["id"]})
        for predecessor in expected:
            if predecessor["id"] not in known:
                api("POST", f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by", {"issue_id": predecessor["id"]})
        t["native_blocked_by_numbers"] = [item["number"] for item in expected]
        save()
        print(f"Linked {t['id']}: parent #{parent['number']}, blockers {t['native_blocked_by_numbers']}", flush=True)
    verify(parent, parent_body)


def verify(parent, parent_body):
    children = pages(f"repos/{REPO}/issues/{parent['number']}/sub_issues?per_page=100")
    assert {item["number"] for item in children} == {t["issue_number"] for t in state["tickets"]}, "Sub-issue mismatch"
    parent_read = api("GET", f"repos/{REPO}/issues/{parent['number']}")
    assert parent_read["body"] == parent_body and parent_read["state"] == "open"
    assert set(LABELS) <= {label["name"] for label in parent_read["labels"]}
    results = []
    for t in state["tickets"]:
        read = api("GET", f"repos/{REPO}/issues/{t['issue_number']}")
        assert read["title"] == t["published_title"]
        assert read["body"] == (ROOT / t["file"]).read_text(), t["id"]
        assert read["state"] == "open"
        assert set(LABELS) <= {label["name"] for label in read["labels"]}
        assert "尚未发布" not in read["body"] and "ME-SPEC" not in read["body"]
        blockers = pages(f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by?per_page=100")
        actual = sorted(item["number"] for item in blockers)
        assert actual == sorted(t["native_blocked_by_numbers"]), (t["id"], actual)
        results.append({"key": t["id"], "number": t["issue_number"], "body_sha256": sha(read["body"]), "state": read["state"], "blocked_by": actual, "labels": [label["name"] for label in read["labels"]]})
        print(f"Verified {t['id']}: #{t['issue_number']}", flush=True)
    report = {"verified_at": now(), "parent": parent["html_url"], "parent_body_sha256": sha(parent_read["body"]), "native_sub_issue_count": len(children), "native_dependency_count": sum(len(item["blocked_by"]) for item in results), "issues": results, "implementation_started": False}
    (ROOT / "publication-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    state["status"] = "published-and-verified"
    state["verified_at"] = report["verified_at"]
    state["native_relationship_support"]["write_support"] = "Verified by POST and paginated GET for all new sub-issues and blocked_by edges"
    state.pop("last_publication_error", None)
    save()
    update_readme(report)
    print(f"Published and verified parent #{parent['number']} + 16 children", flush=True)


def update_readme(report):
    path = ROOT / "README.md"
    text = path.read_text()
    text = text.replace(
        "**16 张具体子 Issue 草案已生成，尚未发布到 GitHub**",
        f"**已发布并回读核验：父 Spec #{state['parent_issue']} + 16 张正式子 Issue**",
    )
    text = text.replace("[架构决定提案]", "[已确认架构决定]").replace("[拟发布父 Issue 正文]", "[已发布父 Issue 正文快照]")
    text = text.replace("本批将使用一张独立父 Spec", f"本批使用独立父 Spec [#{state['parent_issue']}]({state['parent_url']})")
    text = text.replace("本拆分获确认后，以批准 Spec", "本拆分已获用户确认，以批准 Spec")
    rows = ["| 编号 | GitHub Issue / 本地正文 | Blocked by | 交付行为 |", "| --- | --- | --- | --- |"]
    for t in state["tickets"]:
        blockers = ", ".join(f"[#{n}](https://github.com/{REPO}/issues/{n})" for n in t["native_blocked_by_numbers"]) or "无"
        rows.append(f"| {t['id']} | [#{t['issue_number']} {t['title']}]({t['url']}) / [正文]({t['file']}) | {blockers} | {t['deliver']} |")
    start = text.index("| 编号 |", text.index("## 具体拆分"))
    end = text.index("\n## ", start)
    text = text[:start] + "\n".join(rows) + "\n" + text[end:]
    text = text.replace("## 测试 seam 待本次一并评审", "## 已确认的测试 seam")
    start = text.index("## 发布规则") if "## 发布规则" in text else text.index("## 发布与回读结果")
    end = text.index("## 静态检查", start)
    text = text[:start] + f"""## 发布与回读结果

- 正式父 Spec：[#{state['parent_issue']}]({state['parent_url']})；16 张子 Issue 全部 open，标签为 enhancement 和 ready-for-agent。
- GitHub 原生 contains 关系：{report['native_sub_issue_count']} 条；原生 blocked_by 关系：{report['native_dependency_count']} 条，包含 ME07 → 既有 #395。
- 已按分页回读父/子正文、标题、标签、状态、正式子 Issue 集合和每票阻塞集合，核对本地正文 SHA256；没有修改既有 #6/#376 正文或状态。
- [发布核验报告](publication-verification.json) 保存回读时间、正文摘要及全部关系；[清单](tickets.json) 保存真实编号/URL、原生依赖和批准记录。
- 方案、ADR、拆分与发布已确认；本次未启动代码实施，未提交、推送或执行生产迁移/部署。ready-for-agent 不代表所有前置已完成，目前只有 ME01 无实施依赖。
- 发布脚本逐条保存 receipt，网络失败可恢复；不要使用旧草案重新生成覆盖正式正文。恢复发布只核对本批，不更改已有父 Spec 正文和状态。

""" + text[end:]
    text = text.replace(
        "只重建本地草案，校验唯一 ID",
        "草案态重建本地正文，已批准/发布后只校验现有正文而不覆盖；校验唯一 ID",
    )
    path.write_text(text)


if __name__ == "__main__":
    try:
        publish()
    except Exception as error:
        state["status"] = "publication-incomplete"
        state["last_publication_error"] = {"at": now(), "error": str(error)}
        save()
        print(f"Publication stopped safely: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
