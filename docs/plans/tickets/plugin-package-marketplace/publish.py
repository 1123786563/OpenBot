#!/usr/bin/env python3
"""Publish the user-requested package tickets; checkpoint every mutation."""
import argparse, datetime, hashlib, json, posixpath, re, subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT=Path(__file__).resolve().parent
REPO="1123786563/OpenBot"
DATA=json.loads((ROOT/"tickets.json").read_text())
TICKETS=DATA["tickets"]
STATE_PATH=ROOT/"published.json"
SPEC=Path("docs/specs/2026-10-19-plugin-package-marketplace-design.md")
PLAN=Path("docs/plans/2026-10-19-plugin-package-marketplace-implementation.md")
ROOT.joinpath("issues").mkdir(exist_ok=True)
state=json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"repository":REPO,"issues":{},"relations":[]}
def save():
    STATE_PATH.write_text(json.dumps(state,ensure_ascii=False,indent=2)+"\n")
def command(args, timeout=None):
    r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if r.returncode:
        raise RuntimeError("command failed: "+" ".join(args[:7])+"\n"+r.stderr[:2000])
    return r.stdout
def api(path,method="GET",fields=None):
    args=["gh","api",path,"--method",method,"-H","Accept: application/vnd.github+json"]
    for k,v in (fields or {}).items():args.extend(["-F",f"{k}={v}"])
    for attempt in range(3):
        try:
            return json.loads(command(args, timeout=35 if method=="GET" else None))
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            transient=isinstance(error,subprocess.TimeoutExpired) or any(s in str(error) for s in ["i/o timeout","dial tcp","TLS handshake timeout","unexpected EOF"])
            if method!="GET" or not transient or attempt==2:raise
            print("READ_RETRY",path,"attempt",attempt+2,flush=True)
def pages(path):
    result=[];page=1
    while True:
        join="&" if "?" in path else "?"
        batch=api(path+join+f"per_page=100&page={page}")
        if not isinstance(batch,list):raise RuntimeError("expected paginated list")
        result.extend(batch)
        if len(batch)<100:return result
        page+=1
def public_spec():
    s=SPEC.read_text()
    def link(m):
        label,target=m.group(1),m.group(2)
        if "://" in target:return m.group(0)
        resolved=posixpath.normpath(posixpath.join("docs/specs",target))
        if resolved==str(PLAN):return label+"（本地工作区计划；远端以本父 Issue 的完整快照为依据）"
        return "["+label+"](https://github.com/"+REPO+"/blob/main/"+resolved+")"
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)",link,s)
def parent_body():
    rows=[]
    for t in TICKETS:
        record=state["issues"].get(t["id"])
        title=("["+t["id"]+"]("+record["url"]+")") if record else t["id"]
        blockers=[state["issues"].get(k,{}).get("url",k) for k in t["depends_on"]]
        blockers.extend(f"https://github.com/{REPO}/issues/{n}" for n in t["external"])
        rows.append("| "+title+" | "+t["title"]+" | "+(", ".join(blockers) or "无")+" |")
    return """<!-- openbot-plugin-packages:ROOT:v1 -->
## 目标与状态

依据用户“设计详细方案并拆解具体 Issue”的请求建立本 Epic 和正式子 Issue。本轮授权为方案与建单，尚未开始生产代码实施；不包含提交、推送、合并、生产迁移或部署授权。

采用版本化插件包装配现有 Skill、专家模板和受管连接器；先交付当前可信公司/团队范围。完整 Personal Space、缺执行范围的逻辑私有 Bot、外部格式离线导入和任意可执行插件是后续范围，不作为 V1 已支持能力。

以下快照完整嵌入方案，避免依赖尚未提交的本地文档。旧有 #6/#194/#74/#75/#76/#137/#177 的正文与状态保持原状；本 Epic 不代替原多租户总体上线门禁。

## 正式子 Issue 与依赖

contains 仅表示聚合；blocked-by 才表示执行依赖。GitHub 原生关系是最终核验依据。子 Issue 标签 ready-for-agent 表示需求/验收已写清，不表示前置已完成或本轮已获实施授权。

| ID | 可独立验收的业务切片 | Blocked by |
| --- | --- | --- |
"""+ "\n".join(rows)+"""

## 与已有工作的关系

- #74：已有关联目录、连接器安装与连接归属；复用既有实现，关闭状态不能代替当前工作区验证。
- #75：当前用户连接与 Bot 授权实时重验，作为包工具执行的原生外部依赖；本 Epic 只增加包来源关联及 Run pin，不重做通用连接治理。
- #76/#137：旧 Skill/组件发布和旧页面范围接线为相关工作；新包只新增不可变包资源和插件包视图，不能覆盖原票范围或擅自更改其依赖。
- #177：旧多租户插件/知识闭环证据继续由原票管理；本 Epic 验收只证明新增包闭环。

## 执行与验收

业务 Issue 采用纵向切片；后端、前端、迁移、验证在同一票内按接口拆成 Superpowers Task，不再拆水平 Issue。默认沿依赖串行实施；前置已验证并集成后才能领取下游。父 Issue 聚合 A01–A12，不重复实现子 Issue。

实施遵循仓库 Issue 流程：摄取树与 DAG → writing-plans → SDD → 独立 Review → OCR → 必要修复及复审。真实数据库使用受限角色；测试遵守 ADR 0008 的 e2e native/driven；skip、缺环境、空报告不能计为通过。审批和外部效果未知不能用普通重试绕过。

## 完整详细方案快照

"""+public_spec()
def issue_body(t):
    parent=state["issues"].get("ROOT",{}).get("url","父 Issue 待发布")
    deps=[state["issues"].get(k,{}).get("url",k) for k in t["depends_on"]]
    deps.extend(f"https://github.com/{REPO}/issues/{n}" for n in t["external"])
    return f"""<!-- openbot-plugin-packages:{t['id']}:v1 -->
## Parent

{parent}

## What to build

{t['delivers']}

## Scope boundary

{t['scope']}

## Acceptance criteria

"""+ "\n".join("- [ ] "+x for x in t["checks"])+"""

## Blocked by

"""+("\n".join("- "+x for x in deps) if deps else "None（无任务前置；仍须有本次实施授权和有效执行工作区）。")+f"""

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

{t['verify']}

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 {', '.join(t['acceptance'])}。
- consumes：{t['consumes']}
- produces：{t['produces']}
- owned_scope：{t['scope']} 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 {', '.join(t['plan_tasks'])}；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
"""
def write_drafts():
    (ROOT/"parent.md").write_text(parent_body())
    for t in TICKETS:(ROOT/"issues"/(t["id"]+".md")).write_text(issue_body(t))
def create(key,title,path,labels):
    if key in state["issues"]:
        item=state["issues"][key]
        if "id" not in item:item["id"]=api(f"repos/{REPO}/issues/{item['number']}")["id"];save()
        return item
    # Protect against an interrupted/ambiguous prior create without relying on search indexing.
    marker=f"<!-- openbot-plugin-packages:{key}:v1 -->"
    since = state.get("scan_since")
    suffix = "&since="+since if since else ""
    matches=[x for x in pages(f"repos/{REPO}/issues?state=all&sort=created&direction=desc"+suffix) if marker in (x.get("body") or "")]
    if len(matches)>1:raise RuntimeError("duplicate markers require manual reconciliation: "+key)
    if matches:
        x=matches[0];item={"number":x["number"],"id":x["id"],"url":x["html_url"]};state["issues"][key]=item;save();return item
    state["pending_mutation"]={"key":key,"title":title,"body_sha256":hashlib.sha256(path.read_bytes()).hexdigest()};save()
    requests=ROOT/"requests";requests.mkdir(exist_ok=True)
    request_path=requests/(key+".json")
    request_path.write_text(json.dumps({"title":title,"body":path.read_text(),"labels":labels},ensure_ascii=False))
    out=command(["gh","api",f"repos/{REPO}/issues","--method","POST","--input",str(request_path)])
    created=json.loads(out)
    item={"number":created["number"],"url":created["html_url"],"id":created["id"]}
    state["issues"][key]=item;state.pop("pending_mutation",None);save()
    print("CREATED",key,item["url"],flush=True)
    return item
def publish():
    write_drafts()
    root=create("ROOT","Spec: 插件包与市场 V1（受信包、范围授权与版本化运行）",ROOT/"parent.md",["enhancement"])
    if "scan_since" not in state:
        state["scan_since"]=api(f"repos/{REPO}/issues/{root['number']}")["created_at"]
        save()
    external={}
    for n in sorted({n for t in TICKETS for n in t["external"]}):
        external[n]=api(f"repos/{REPO}/issues/{n}")
    for t in TICKETS:
        write_drafts()
        item=create(t["id"],f"[插件包 {t['id']}] "+t["title"],ROOT/"issues"/(t["id"]+".md"),["enhancement","ready-for-agent"])
        if t["id"] in state.get("linked",[]):continue
        sub_ids={x["id"] for x in pages(f"repos/{REPO}/issues/{root['number']}/sub_issues")}
        if item["id"] not in sub_ids:
            api(f"repos/{REPO}/issues/{root['number']}/sub_issues","POST",{"sub_issue_id":item["id"]})
        blockers=[state["issues"][k] for k in t["depends_on"]]+[{"id":external[n]["id"],"number":n} for n in t["external"]]
        linked={x["id"] for x in pages(f"repos/{REPO}/issues/{item['number']}/dependencies/blocked_by")}
        for blocker in blockers:
            if blocker["id"] not in linked:
                api(f"repos/{REPO}/issues/{item['number']}/dependencies/blocked_by","POST",{"issue_id":blocker["id"]})
        state.setdefault("linked",[]).append(t["id"]);save()
        print("LINKED",t["id"],"blockers",[x["number"] for x in blockers],flush=True)
    write_drafts()
    patch_path=ROOT/"requests"/"ROOT-update.json";patch_path.parent.mkdir(exist_ok=True)
    patch_path.write_text(json.dumps({"body":(ROOT/"parent.md").read_text()},ensure_ascii=False))
    command(["gh","api",f"repos/{REPO}/issues/{root['number']}","--method","PATCH","--input",str(patch_path)])
    state["status"]="published-pending-verification";state["published_at"]=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
def verify():
    root=state["issues"]["ROOT"]
    children=pages(f"repos/{REPO}/issues/{root['number']}/sub_issues")
    expected={state["issues"][t["id"]]["number"] for t in TICKETS}
    if {x["number"] for x in children}!=expected:raise RuntimeError("subissue mismatch")
    report={"repository":REPO,"parent":root,"verified_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"sub_issue_count":len(children),"issues":[]}
    child_map={x["number"]:x for x in children}
    def read_ticket(t):
        item=state["issues"][t["id"]]
        remote=child_map[item["number"]]
        if "body" not in remote:remote=api(f"repos/{REPO}/issues/{item['number']}")
        native=pages(f"repos/{REPO}/issues/{item['number']}/dependencies/blocked_by")
        return t,remote,native
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(read_ticket,TICKETS))
    for t,remote,native in results:
        item=state["issues"][t["id"]]
        if remote["title"]!=f"[插件包 {t['id']}] "+t["title"]:raise RuntimeError("title mismatch "+t["id"])
        expected_deps={state["issues"][k]["number"] for k in t["depends_on"]}|set(t["external"])
        if {x["number"] for x in native}!=expected_deps:raise RuntimeError("dependency mismatch "+t["id"])
        if remote["body"].strip()!=issue_body(t).strip():raise RuntimeError("body mismatch "+t["id"])
        if "ready-for-agent" not in {x["name"] for x in remote["labels"]}:raise RuntimeError("label missing")
        report["issues"].append({"key":t["id"],"number":item["number"],"url":item["url"],"blocked_by":sorted(expected_deps),"acceptance":t["acceptance"],"body_sha256":hashlib.sha256(remote["body"].encode()).hexdigest()})
    remote_root=api(f"repos/{REPO}/issues/{root['number']}")
    if remote_root["body"].strip()!=parent_body().strip():raise RuntimeError("parent snapshot mismatch")
    (ROOT/"verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    state["relations"]=[{"parent":root["number"],"contains":[x["number"] for x in children]}]+[{"issue":x["number"],"blocked_by":x["blocked_by"]} for x in report["issues"]]
    if state.get("pending_mutation",{}).get("key") in state["issues"]:state.pop("pending_mutation",None)
    state["status"]="published-verified";save()
    print("VERIFIED",len(children),"subissues; bodies, labels, native dependencies and parent snapshot match",flush=True)
if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--publish",action="store_true");parser.add_argument("--verify",action="store_true")
    args=parser.parse_args()
    if args.publish:publish()
    elif args.verify:verify()
    else:write_drafts();print("DRAFTS_WRITTEN",len(TICKETS))

