#!/usr/bin/env python3
"""Add the epic layer required by GitHub's 100 sub-issue cap: Spec #6 -> 20 group epics -> 143 tickets.

Idempotent and resumable via epics.json. Steps: create epics, unlink tickets from the Spec, link epics to
the Spec, link tickets to their epic.
"""
import json, subprocess, sys, time, collections
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 6
published = json.loads((HERE / "published.json").read_text())
manifest = json.loads((HERE / "manifest.json").read_text())
tickets = manifest["tickets"]
by_id = {t["id"]: t for t in tickets}
EP = HERE / "epics.json"
epics = json.loads(EP.read_text()) if EP.exists() else {}

GROUP_INTRO = {
 "A": "前置改造：入口清单事实源、共用身份夹具与受限角色数据库 harness、安全迁移工具。后续所有 Ticket 都消费这三件产物。",
 "B": "公司成员与团队成员关系、集中授权 seam 的团队资格与事务内重验、选择与管理入口、撤权级联与审计。",
 "C": "资源可见性与版本化策略、团队公共动作矩阵、个人权限与显式分享、不可见语义、核心租户域表 RLS 兜底。",
 "D": "多租户模式与启动就绪校验、公司运行配置装配（替换部署级单份租户包）、缓存键与外部命名空间归属。",
 "E": "Bot 归属、发布受众与旧 public 显式迁移、公共 Bot 使用身份、生命周期动作授权、专家/模板安装回执。",
 "F": "会话列表与计数、消息与历史 replay、群成员与 Bot 席位、附件签发与清理、事件流订阅与外部线程映射。",
 "G": "SSO/SCIM 归属与定向停用、凭据归属与脱敏、OAuth state 固定归属、凭据取用 lease、全局身份与例外登记。",
 "H": "插件安装与连接归属、工具调用实时重校验、技能与组件发布、共享账号审批绑定、Host Access 与危险动作。",
 "I": "知识库归属与受限查询、检索候选范围限制、文档生命周期、个人记忆、学习容器与演示隔离。",
 "J": "任务与租约固定归属、扫描只有调度权、认领/重试/取消、入站事件归属解析、主动建议与事务边界。",
 "K": "电脑与浏览器分配、执行侧快照/shell/文件、运行协议与适配器归属、跨语言传递、既有保证不回退、公共 Bot 状态隔离。",
 "L": "Craft 会话与调度、产物与对象存储、签名下载双点校验、Workshop 与沙箱关联、分享令牌改为有效授权。",
 "M": "OpenMuse 私有 Bot、任务与租约、文件与个人工作区、个人域对象、连接器与邮件日历、审阅动作与通知、语音与移动聚合、删除语义分离与清理 manifest。",
 "N": "公司计费 Customer 映射与账户类型、原子预扣、结算幂等、回调与对账解析付款账户、账务可见性、历史余额一次性迁移。",
 "O": "平台管理与公司/团队管理分离、人员生命周期、路由策略与模板归属、审计分域、偏好与业务配置分离。",
 "P": "Web 选择与传输、缓存 generation、各业务页面组接入范围、管理界面能力门控、账单与用量视图。",
 "Q": "桌面原生组织上下文与命令门控、凭据命名空间、切换清理、组织登录与选择、本地状态隔离。",
 "R": "移动端 submodule 基线核对、tenancy 适配层、流式与媒体传输、三端一致性验证。",
 "S": "遥测归属字段、用量事件账户区分与脱敏、观测后端查询授权、已启用集成的隔离与账户路由证据。",
 "T": "迁移与回填、外部状态迁移与隔离清单、回退程序、入口装配闭合、例外登记、启动就绪强制、验收 harness 与四组覆盖证据、缺口关闭、独立审查与上线候选包。",
}


def sh(args, retries=4):
    for a in range(retries):
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
        err = (r.stderr or r.stdout).strip().replace("\n", " ")
        if "rate limit" in err.lower() or "secondary" in err.lower() or "timeout" in err.lower():
            time.sleep(20 * (a + 1)); continue
        raise SystemExit(f"failed: {' '.join(args[:5])} :: {err[:400]}")
    raise SystemExit(f"gave up: {' '.join(args[:5])}")


groups = collections.OrderedDict()
for t in tickets:
    groups.setdefault(t["group"], []).append(t["id"])

# --- 1. create epic issues --------------------------------------------------
for gname, ids in groups.items():
    if gname in epics:
        continue
    letter = gname.split()[0]
    lines = [
        f"## Parent", "", f"Spec: https://github.com/{REPO}/issues/{PARENT} — 公司与团队多租户整改（全功能隔离后统一上线）", "",
        f"## 本组范围", "", f"**{gname}**（{ids[0]}–{ids[-1]}，共 {len(ids)} 个 Ticket）", "", GROUP_INTRO[letter], "",
        "## Tickets", "", "| Ticket | Issue | Blocked by | 验收 |", "| --- | --- | --- | --- |",
    ]
    for i in ids:
        t = by_id[i]
        deps = ", ".join(f"[{d}](https://github.com/{REPO}/issues/{published[d]})" if d in published else d for d in t["depends_on"]) or "—"
        lines.append(f"| {t['id']} {t['title']} | [#{published[i]}](https://github.com/{REPO}/issues/{published[i]}) | {deps} | {', '.join(t['acceptance'])} |")
    external = sorted({d for i in ids for d in by_id[i]["depends_on"] if d not in ids})
    lines += ["", "## 跨组依赖", "",
              ("本组 Ticket 依赖的外部前置：" + ", ".join(f"[{d}](https://github.com/{REPO}/issues/{published[d]}) {by_id[d]['title']}" for d in external))
              if external else "本组无跨组外部依赖。", "",
              "## 使用说明", "",
              f"- 领取本组内 Ticket 前，先在父 Spec #{PARENT} 与本组表格中确认 Blocked by 各项已验证并集成到当前工作区。",
              "- 每个 Ticket 都是单个 code agent 上下文内可完成的业务行为切片，含正向与越权验收；失败时另一个 agent 可直接依 Ticket 正文接手。",
              "- 本 Issue 是分组容器，不是可领取的实现任务，因此未打 `ready-for-agent` 标签；实现请领取上表中的具体 Ticket。",
              "- 事实源：父 Spec、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`。"]
    tmp = HERE / ".tmp-epic.md"
    tmp.write_text("\n".join(lines) + "\n")
    url = sh(["gh", "issue", "create", "--repo", REPO,
              "--title", f"[多租户 {letter}] {gname.split(' ', 1)[1]}（{ids[0]}–{ids[-1]}）",
              "--body-file", str(tmp)])
    epics[gname] = int(url.rstrip("/").split("/")[-1])
    EP.write_text(json.dumps(epics, ensure_ascii=False, indent=1) + "\n")
    tmp.unlink(missing_ok=True)
    print(f"epic {gname} -> #{epics[gname]}", flush=True)
    time.sleep(0.4)

# --- 2. integer ids of every open issue ------------------------------------
id_of = {}
for page in range(1, 8):
    out = sh(["gh", "api", f"repos/{REPO}/issues?state=open&per_page=100&page={page}",
              "--jq", ".[] | \"\\(.number) \\(.id)\""])
    if not out:
        break
    for line in out.splitlines():
        n, i = line.split(); id_of[int(n)] = int(i)
print(f"integer ids: {len(id_of)}", flush=True)

# --- 3. unlink tickets that are directly under the Spec ---------------------
cur = sh(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues", "--jq", ".[].number"])
current = {int(x) for x in cur.split()} if cur else set()
ticket_numbers = set(published.values())
to_unlink = sorted(current & ticket_numbers)
print(f"sub-issues of #{PARENT}: {len(current)}; tickets to unlink: {len(to_unlink)}", flush=True)
for n in to_unlink:
    r = subprocess.run(["gh", "api", "-X", "DELETE", f"repos/{REPO}/issues/{PARENT}/sub_issues/{id_of[n]}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"unlink #{n} failed: {(r.stderr or r.stdout).strip()[:150]}")
    time.sleep(0.2)

# --- 4. link epics under the Spec ------------------------------------------
for gname, n in epics.items():
    if n not in id_of:
        print(f"epic {gname} #{n} missing id"); continue
    r = subprocess.run(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues",
                        "-F", f"sub_issue_id={id_of[n]}"], capture_output=True, text=True)
    if r.returncode != 0 and "already" not in (r.stderr or "").lower():
        print(f"epic link {gname} failed: {(r.stderr or r.stdout).strip()[:150]}")
    time.sleep(0.2)
print("epics linked to spec", flush=True)

# --- 5. link tickets under their epic --------------------------------------
ok = fail = 0
for gname, ids in groups.items():
    epic_n = epics[gname]
    for i in ids:
        n = published[i]
        r = subprocess.run(["gh", "api", f"repos/{REPO}/issues/{epic_n}/sub_issues",
                            "-F", f"sub_issue_id={id_of[n]}"], capture_output=True, text=True)
        if r.returncode == 0 or "already" in (r.stderr or "").lower():
            ok += 1
        else:
            fail += 1
            print(f"FAIL {i} #{n} -> epic #{epic_n}: {(r.stderr or r.stdout).strip()[:150]}", flush=True)
        time.sleep(0.18)
print(f"\nticket links ok={ok} fail={fail} total={len(tickets)}")
(HERE / "epics.json").write_text(json.dumps(epics, ensure_ascii=False, indent=1) + "\n")
sys.exit(1 if fail else 0)
