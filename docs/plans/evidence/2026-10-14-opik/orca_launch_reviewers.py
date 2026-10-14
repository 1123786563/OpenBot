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
    "T03": {"branch": "1123786563/opik-t03-deployment",  "base": "ef58d94654df9cbaa565474acf75d6193a0f6ddf", "name": "opik-review-t03"},
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
    "T03": [
        "专项核对 1（版本纪律）：docker/opik/versions.json 的 9 个镜像是否全部有 tag+digest、零浮动 tag（latest/stable/edge/main/master/dev 一个都不能有）；compatibility.status 必须仍是 unverified 且 verifiedBy=#10 —— 只有 #10 拿到真实 ingest/query/evaluation/id 映射/删除证据后才有权翻成 verified，实现者若翻了就是 critical。",
        "专项核对 2（端口与 loopback）：所有发布端口只绑 127.0.0.1 与 [::1]；OTLP 的**宿主**端口必须是 5418/5417，不能是上游默认的 4318/4317（docker/compose/observability.yml 里 Tempo 已在 loopback 占用它们）。注意 ${VAR:-default} 里的 :- 含冒号，按字段解析时不要把容器端口误当宿主端口——协调者自己第一次就解析错了。",
        "专项核对 3（排除项）：demo-data-generator（会写示例数据，污染 #43 真实验收）、jaeger（本仓库已有 Tempo）、guardrails-backend* 都必须不在栈内。",
        "专项核对 4（配置面）：compose 里全部 ${VAR:?} 必需变量是否都写进了 .env.example（协调者实测为 6 个：MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD / CLICKHOUSE_PASSWORD / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD / REDIS_PASSWORD）；.env.example 里所有 OPIK_ 行是否都是注释态（默认关闭）；有没有任何真实密码被写进 compose / docs / .env.example。62 个 ${VAR:-} 可选上游调优变量未写入 .env.example 不算 finding。",
        "专项核对 5（越界裁定，这是本 Ticket 最重要的判断）：改动 12 个文件，owned_scope 只列了 6 个。多出的 6 个是 docker/opik/ 下 5 个上游支撑文件 + checkpoint。其中 otel-collector-config.yaml 在计划 File Structure 里是条件创建项；另外 4 个（clickhouse-config/additional_config.xml、clickhouse-config/users.d/distributed_insert_queue.xml、clickhouse-config/users.d/enable_time_type.xml、nginx_default_local.conf）不在计划内。判断：上游 compose 是否会挂载这些路径、缺了会不会连 docker compose config 都过不了。若成立，这是 owned_scope 漂移（与 T01 需要补 server/src/app.ts 同类），应建议协调者更正 manifest 而**不是**记实现者越界；若不成立，才是越界 finding。",
        "专项核对 6（真实启动声称）：checkpoint 声称真实栈 up 后 9 个服务全 healthy、health-check 200、OTLP 5418 200，然后干净 down。你无法复现（已 down），所以判断证据是否充分留痕、是否可被 #10 复用。**关键**：即使栈起来了，也不等于 ingest/query/evaluation/id 映射/删除被验证——那是 #10 的范围。确认实现者没有把『栈能起来』当作『兼容已验证』，compatibility.status 保持 unverified 就是这条的体现。",
        "专项核对 7（自报偏差核实）：实现者自报两处偏差——(a) .env.example 用占位 \"\" 是因为计划测试的跨行 regex 有缺陷；(b) frontend healthcheck 用 127.0.0.1 而非 localhost，因为 busybox wget 把 localhost 解析成 ::1。逐条核实理由是否成立、修法是否最小、有没有因此削弱任何断言。",
        "专项核对 8（基线继承）：该分支 base 是 ef58d946，早于协调者合并 main 的 ff63e5c5，所以 cd server && bun run typecheck 会红在 src/craft/webapp-proxy.ts TS2322。核实该文件与 base 逐字节一致（git diff ef58d946..HEAD -- server/src/craft/webapp-proxy.ts 应为空），确认不是本 Ticket 回归，不要记 finding。",
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
