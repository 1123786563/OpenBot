#!/usr/bin/env python3
"""Dispatch the read-only reviewers for the settled implementer branches.

Each reviewer gets its OWN new child worktree based on the implementer's branch,
so "read-only" is a structural guarantee rather than a promise: any edit it makes
lands in its own checkout and cannot touch the implementer's work.

After each start, a message names the exact branch and diff base so the reviewer
never has to guess what it is auditing.
"""
import json, pathlib, subprocess, sys, time

ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
WT = pathlib.Path("/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration")
LEDGER = WT / "docs/plans/evidence/2026-10-14-opik/orca-frontier-wave.json"
REPO_ID = "d6edf033-748a-4549-ae5a-e9efd34cef91"
REPO = "1123786563/OpenBot"

TARGETS = {
    "T01": {"branch": "1123786563/opik-t01-module-seam", "base": "5e15ce4c7463a276e294626ad22e71791733a250", "name": "opik-review-t01"},
    "T02": {"branch": "1123786563/opik-t02-ui-i18n",     "base": "ef58d94654df9cbaa565474acf75d6193a0f6ddf", "name": "opik-review-t02"},
    "T05": {"branch": "1123786563/opik-t05-redaction",   "base": "ef58d94654df9cbaa565474acf75d6193a0f6ddf", "name": "opik-review-t05"},
    "T06": {"branch": "1123786563/opik-t06-scope-seam",  "base": "ef58d94654df9cbaa565474acf75d6193a0f6ddf", "name": "opik-review-t06"},
}

EXTRA = {
    "T01": [
        "你的 base 是 5e15ce4c，比其余三个审阅对象早一个提交：它不含更正后的基线文档（ef58d946 修正了 setup-hook 结论，d7d48b0d 修正了 E9 的错误诊断）。因此该 worktree 里的 baseline-gates 文档有两条已被推翻的结论，审阅时以协调者侧的最新版为准，不要把它当成实现者的失误。",
        "专项核对 1：观测授权必须用 canManageAgent，绝不能用 canAccessAgent（后者对 visibility=public 放行）。在 server/src/index.ts 的装配处逐字确认。",
        "专项核对 2：server/src/app.ts 与 server/src/index.ts 的改动必须极小（app.ts 一个可选 deps 字段 + 一行 app.route；index.ts 构造 + 传参）。用 git diff 数行数，任何重构都算越界。",
        "专项核对 3：实现者自报了一次 git stash 违规并自称已恢复。请独立核验：git stash list 现在应只剩 billing 工作流的条目，不应有 t01-* 残留；并判断其恢复是否真的没有污染工作树。这是协调者已上报给人类裁决的事项，你的独立结论是裁决依据。",
        "专项核对 4：实现者报告计划里的 rejectingUser 测试桩漏了 return（Hono 会 Context is not finalized）。确认它的修正是加了 return 且断言强度未降低（仍断言 401 且先于业务逻辑），而不是把断言改弱来让测试通过。",
    ],
    "T02": [
        "专项核对 1：八类状态 disabled/empty/forbidden/basic/omitted/truncated/syncing/unavailable 在 4 个命名空间 × 2 种语言共 8 个 JSON 里是否全部齐备、非空、语义不混用。自己重跑 parity 测试，不要抄实现者的输出。",
        "专项核对 2：必须是静态 import。确认 app/src/lib/i18n/index.ts 没有引入任何 lazy bundle loader（该文件注释解释了 lazy 会输掉 changeLanguage 的 fallback 竞态）。",
        "专项核对 3：确认没有编辑既有共享文案文件（agents.json / errors.json / admin.json / nav.json / common.json）。git diff --name-only 里出现任何一个都算越界。",
        "专项核对 4：验收标准第 3 条的『直接输入路由时仍执行权限校验』子句按 manifest 的 documented_deviations 移交给了 #18，本 Ticket 不应声称已验证。确认实现者没有把它记为通过。",
        "专项核对 5：owned files 是 11 个（超过 O1 的 ≤8，已记录在案的例外）。确认多出的确实是 8 个极小 JSON + 2 个注册文件 + 1 个测试，而不是夹带了逻辑代码。",
    ],
    "T05": [
        "专项核对 1：实现者自报发现并修复了计划里 5 处测试与实现互相矛盾的地方。逐条核验它的裁决方向是否正确——判据是计划的 Global Constraints（fail closed 优先）。特别确认：projectSafeName 的 regex 不再先于 byte budget 拦截（否则三态会塌缩成 omitted）、projectSafeUrl 对带 query 的普通 URL 是剥离后投影而非整体 omitted、projectSafeException 用 constructor.name 以保住子类名。",
        "专项核对 2：确认它没有为了让测试变绿而放宽任何断言。逐条对比断言强度，尤其是 canary 断言必须仍然是『输出不含 canary』而不是『canary 被替换』。",
        "专项核对 3：12 条 canary 是否全部真的被拒绝（bearer / OpenAI 风格 / AWS access key + secret / GitHub token / Slack token / PEM 私钥 / postgres+mysql+redis DSN / 账号标识 / 内部能力名 / reasoning 标签 / 带签名的私有文件 URL）。自己构造 1-2 个计划里没有的新凭据形状试试——如果新模式漏网，那是 finding，但要注意计划已声明 DENY 是模式表而非语义分析，默认 allowFreeText=false 才是兜底。",
        "专项核对 4：SECRET_CANARIES 按计划 Interfaces 曾被声明为 produces，实现者选择不导出（理由：不把对抗样本字面量固化进生产模块）。判断这个裁决是否成立，以及 manifest 的 produces 是否需要同步更正。",
        "专项核对 5：确认全是纯函数——无 IO、无环境变量、无日志、无上游调用。",
    ],
    "T06": [
        "专项核对 1：实现者自报把计划里的 locator 指纹从 String(scope.key.length) 改成了 keyLen+sha256 前缀，因为原设计对等长 key 会撞名、导致两个可信 scope 落进同一个上游 workspace。核验这个修复是否真的消除了碰撞（自己构造两个等长但不同的 scope key 试），以及它是否为此放宽了任何测试断言（不允许）。",
        "专项核对 2：fail-closed 纪律。确认 resolveObservationScope 是唯一签发点、对象被 Object.freeze、信任用模块私有 WeakSet、assertObservationScope 对序列化还原/展开复制/手搓对象一律拒绝，且没有导出任何 unsafe 逃生舱。",
        "专项核对 3：企业预留必须是拒绝而非回退。确认 enterpriseHint 的拒绝发生在 ownership 判定之前——否则合法 owner 就能借到工作台 scope，正是父 Spec 禁止的。",
        "专项核对 4：无租户模型纪律。确认没有 import db/schema 或 drizzle、导出名不含 tenant、ObservationScopeKind 只有一个成员、没有任何从 workspace/project/locator 反推 scope 的函数。",
        "专项核对 5：游标绑定的 CURSOR_KEY 含 process.pid 与 Date.now()，因此进程重启会使既有游标失效。确认这是有意的安全失败并且已在 checkpoint 里写明下游 #17 必须把『游标失效』表达为可解释错误而非静默回到第一页。",
        "专项核对 6：错误类是否遵守 code 即契约、message 就是 code 的既有约定（对照 server/src/enterprise/errors.ts）。",
    ],
}


def orca(args, timeout=900):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, cwd=str(WT), timeout=timeout)
    return r


def main():
    led = json.loads(LEDGER.read_text())
    manifest = json.loads((WT / "docs/tickets/opik-4/manifest.json").read_text())
    title_by_id = {t["id"]: t["title"] for t in manifest["tickets"]}
    only = sys.argv[1:] or list(TARGETS)
    for tid in [t for t in TARGETS if t in only]:
        rv = led["tasks"]["reviewers"][tid]
        tgt = TARGETS[tid]
        impl = dict(led["tasks"]["implementers"][tid])
        impl["title"] = title_by_id[tid]
        # Idempotent: an already-dispatched reviewer whose coordinates message never went out
        # (a prior run crashed while building the body) still needs that message.
        if rv.get("dispatch_id") and rv.get("coordinates_message"):
            print(f"{tid} reviewer already dispatched and briefed: {rv['dispatch_id']}")
            continue
        if rv.get("dispatch_id"):
            did = rv["dispatch_id"]
            print(f"{tid} reviewer already dispatched ({did}) but never briefed; sending coordinates only")
            body = build_body(tid, tgt, impl)
            send_coordinates(tid, did, body, rv, led)
            continue
        r = orca(["orchestration", "worker-start", "--json",
                  "--run", led["run_id"], "--task", rv["task_id"],
                  "--worktree", "new-child", "--repo", f"id:{REPO_ID}",
                  "--base-branch", tgt["branch"], "--name", tgt["name"],
                  "--display-name", f"review {tid} #{impl['issue']}",
                  "--comment", f"Read-only reviewer for Opik {tid}; audits {tgt['branch']}",
                  "--agent", "claude", "--setup", "run", "--timeout-ms", "600000"])
        if r.returncode != 0:
            print(f"!!! {tid} reviewer worker-start FAILED (exit {r.returncode}). NOT relaunching.", file=sys.stderr)
            print(r.stderr.strip()[:1200], file=sys.stderr)
            try:
                rec = json.loads(r.stdout)
                print("failedStage:", json.dumps(rec.get("failedStage"), ensure_ascii=False), file=sys.stderr)
                print("residualResources:", json.dumps(rec.get("residualResources"), ensure_ascii=False), file=sys.stderr)
            except Exception:
                pass
            LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
            sys.exit(1)
        rec = json.loads(r.stdout).get("result", {})
        did = rec.get("dispatchId")
        show = orca(["orchestration", "worker-show", "--dispatch", did, "--json"])
        sr = json.loads(show.stdout).get("result", {}) if show.returncode == 0 else {}
        w = sr.get("worker", {})
        rv.update({
            "dispatch_id": did,
            "terminal": w.get("agentTerminalHandle"),
            "worktree_path": (w.get("worktreeId") or "").split("::", 1)[-1] or None,
            "audits_branch": tgt["branch"],
            "diff_base": tgt["base"],
            "launch_effective": (rec.get("launch") or {}).get("effective"),
        })
        LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
        print(f"{tid} reviewer: dispatch={did} worktree={rv['worktree_path']}")

        body = build_body(tid, tgt, impl)
        send_coordinates(tid, did, body, rv, led)
        time.sleep(0.5)

    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
    print("\nreviewer dispatches:", {k: v.get("dispatch_id") for k, v in led["tasks"]["reviewers"].items()})


def send_coordinates(tid, did, body, rv, led):
    s = orca(["orchestration", "send", "--to", f"dispatch:{did}",
              "--subject", f"{tid} 审阅对象坐标与专项核对清单", "--body", body, "--json"])
    try:
        parsed = json.loads(s.stdout) if s.returncode == 0 and s.stdout.strip() else {}
    except json.JSONDecodeError:
        parsed = {}
    if s.returncode == 0 and parsed.get("ok"):
        rv["coordinates_message"] = (parsed.get("result", {}).get("message") or {}).get("id")
        print(f"   coordinates sent: {rv['coordinates_message']}")
    else:
        rv["coordinates_message"] = None
        print(f"   !!! send failed: {s.stderr.strip()[:200] or s.stdout[:200]}")
    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))


def build_body(tid, tgt, impl):
    return "\n".join([
            f"【审阅对象的确切坐标】",
            f"- 被审分支：`{tgt['branch']}`（你当前的 worktree 就基于它，可直接在本地审阅）",
            f"- diff 基准：`{tgt['base']}`  —— 范围核对请用 `git diff --name-only {tgt['base']}..HEAD`",
            f"- Ticket：https://github.com/{REPO}/issues/{impl['issue']}（{tid} {impl['title']}）",
            f"- 实施计划：`{impl['plan']}`（含 Global Constraints 与末尾 Self-Review 声明，逐条核验其是否属实）",
            f"- 实现者 checkpoint：`docs/tickets/opik-4/checkpoints/{tid}.md`（参考但**不采信**，一切自己重跑）",
            f"- 交接契约：`docs/tickets/opik-4/manifest.json` 的 `{tid}` 条目",
            f"- 计划缺陷记录：`docs/plans/evidence/2026-10-14-opik/plan-errata-2026-10-15.md`（E1-E9，实现者发现的计划缺陷；判断实现者的偏差是否属于已记录的 errata）",
            "",
            "【基线（必读，别把既有红当成实现者的回归）】",
            "`docs/plans/evidence/2026-10-14-opik/baseline-gates-2026-10-15.md`。要点：",
            "- 仓库级 `bunx biome lint/format .` 在基线即红（lint 74 errors/132 warnings/29 infos，format 377 errors）。只按改动文件 scope 审。",
            "- `server/tests/ready.test.ts` 基线即红（3 fail，createApp 里的 TypeError），不属任何 Opik Ticket。",
            "- `cd server && bun run typecheck` 与 `cd app && bun run typecheck` 在合并 main 后应为绿；若在被审分支上是红的，先确认是不是因为该分支的 base 早于修复合并，再决定是否算 finding。",
            "",
            "【协调者指定的专项核对】",
            *[f"{i+1}. {x}" for i, x in enumerate(EXTRA[tid])],
            "",
            "【纪律】你只读，唯一可写文件是 `docs/plans/evidence/2026-10-14-opik/reviews/"
            f"{tid}-review.md`；把报告 commit 在你自己的审阅分支上以免丢失。不修 bug、不改测试、"
            "不改源码、不 push、不 merge、不动被审分支。发现问题只记录，由人类协调者裁决后另行派发修复。",
            "worker_done 用 --outcome succeeded（审阅完成即成功，与结论是否 approve 无关），"
            f"--report-path docs/plans/evidence/2026-10-14-opik/reviews/{tid}-review.md，"
            "三句话摘要里直接说出结论是 approve 还是 request-changes。",
        ])


if __name__ == "__main__":
    main()
