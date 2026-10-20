#!/usr/bin/env python3
import datetime,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
data=json.loads((ROOT/"tickets.json").read_text())
published=json.loads((ROOT/"published.json").read_text())
report=json.loads((ROOT/"verification.json").read_text())
assert published["status"]=="published-verified"
mapping=published["issues"];parent=mapping["ROOT"]
data["status"]="published-verified";data["parent"]=parent
(ROOT/"tickets.json").write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n")
owned={
"PKG01":["shared/enterprise/plugin-package-contracts.ts","server/src/plugin-packages/","scripts/plugin-packages/build.ts","server/src/enterprise/plugin-packages/routes.ts","app/src/components/market/package-pane.tsx","app/src/components/market/package-detail.tsx"],
"PKG02":["server/src/db/schema/enterprise-plugin-packages.ts","server/src/enterprise/plugin-packages/store.ts","server/src/enterprise/plugin-packages/mutation-context.ts","server/src/enterprise/plugin-packages/plans.ts","server/src/enterprise/plugin-packages/install-service.ts","app/src/components/market/package-install-dialog.tsx","server/drizzle/"],
"PKG03":["server/src/plugins/package-grants.ts","server/src/enterprise/plugin-packages/resources.ts","server/src/enterprise/plugin-packages/runtime.ts","server/src/enterprise/plugin-packages/pins.ts","server/src/enterprise/runs/service.ts","server/src/enterprise/runs/store.ts","app/src/components/market/package-grants.tsx"],
"PKG04":["server/src/enterprise/plugin-packages/expert-template.ts","server/src/agents/profile-store.ts","server/src/enterprise/tenancy/bots-ownership.ts","app/src/components/market/package-expert-dialog.tsx","server/drizzle/"],
"PKG05":["server/src/plugins/package-access.ts","server/src/plugins/store.ts","server/src/plugins/tools.ts","server/src/enterprise/plugin-packages/dispatch.ts","server/src/db/schema/enterprise-plugins.ts","app/src/components/market/package-connections.tsx"],
"PKG06":["server/src/enterprise/plugin-packages/plans.ts","server/src/enterprise/plugin-packages/lifecycle.ts","server/src/enterprise/plugin-packages/runtime.ts","app/src/components/market/package-version-dialog.tsx"],
"PKG07":["server/src/enterprise/plugin-packages/lifecycle.ts","server/src/enterprise/plugin-packages/dispatch.ts","app/src/components/market/package-status-dialog.tsx"],
"PKG08":["scripts/plugin-packages/publish.ts","server/src/plugin-packages/catalogue.ts","server/src/enterprise/plugin-packages/dispatch.ts","app/src/components/market/package-detail.tsx"],
"PKG09":["server/src/app.ts","server/src/index.ts","server/src/plugins/routes.ts","server/src/approvals/execute.ts","server/src/memory/ingestion.ts","server/src/enterprise/tenancy/admin-separation.ts"],
"PKG10":["server/src/enterprise/plugin-packages/dispatch.ts","server/src/enterprise/plugin-packages/routes.ts","app/src/components/market/package-operations.tsx"],
"PKG11":["plugins/","scripts/plugin-packages/migrate-legacy.ts","server/src/config.ts","server/src/marketplace/","package.json","Dockerfile","docs/operations/plugin-packages.md"],
"PKG12":["docs/plans/2026-10-19-plugin-package-marketplace/","docs/verification/"]
}
nodes=[]
for t in data["tickets"]:
 issue=mapping[t["id"]]
 nodes.append({
  "id":t["id"],"issue_number":issue["number"],"url":issue["url"],
  "source_issues":[parent["url"]],"acceptance":t["acceptance"],
  "depends_on":[mapping[k]["url"] for k in t["depends_on"]]+[f"https://github.com/{data['repository']}/issues/{n}" for n in t["external"]],
  "owner_role":"coordinator","implementation_roles":["backend_implementer","frontend_implementer"] if t["id"]!="PKG12" else [],
  "validator_role":["backend_validator","frontend_validator","reviewer"],
  "owned_files":owned[t["id"]],"owned_scope":t["scope"],
  "interfaces":{"consumes":t["consumes"],"produces":t["produces"]},
  "verification":t["verify"],"status":"pending",
  "technical_task_mapping":t["plan_tasks"]
 })
spec=Path("docs/specs/2026-10-19-plugin-package-marketplace-design.md")
manifest={
 "repository":data["repository"],"parent":parent,
 "status":"published-verified-not-started",
 "source_read_at":report["verified_at"],
 "workspace":str(Path.cwd()),"git_head":subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip(),
 "spec_path":str(spec),"spec_sha256":hashlib.sha256(spec.read_bytes()).hexdigest(),
 "contains":[n["url"] for n in nodes],"nodes":nodes,
 "external_dependencies":[{"number":74,"evidence":"Existing plugin installation module inspected; status alone is not implementation evidence."},{"number":75,"evidence":"Existing issue remains a prerequisite for package-origin tool invocation; verify implementation and integration before dispatch."}],
 "review_status":"Planning graph validated; remote bodies, labels, sub-issues and blocked-by links read back. No implementation review claimed."
}
(ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
lines=["# 插件包与市场 V1 — Issue 拆解与执行入口","",
f"- 仓库：{data['repository']}",f"- 父方案：[{parent['number']}]({parent['url']})；完整详细方案快照已嵌入正文。",
"- 状态：12 个正式子 Issue 已发布并回读核验；生产实现未开始。",
"- 每票按业务纵向闭环验收，后端/前端作为票内 Task；ready-for-agent 表示定义齐全，依赖与实施授权仍需满足。",
"- 本地详细方案："+str(spec),
"- 机器可读 DAG：manifest.json；远端核验证据：verification.json；每票正文：issues/PKGxx.md。","",
"## Issue 与真实阻塞","",
"| ID | Issue | 交付 | Blocked by |","| --- | --- | --- | --- |"]
for t in data["tickets"]:
 issue=mapping[t["id"]]
 deps=[f"#{mapping[k]['number']}" for k in t["depends_on"]]+[f"#{n}" for n in t["external"]]
 lines.append(f"| {t['id']} | [#{issue['number']}]({issue['url']}) | {t['title']} | {', '.join(deps) or '无'} |")
lines += ["","## 验收映射","","| 验收 | 覆盖业务票 |","| --- | --- |"]
for i in range(1,13):
 ac=f"A{i:02}"
 refs=[f"[#{mapping[t['id']]['number']}]({mapping[t['id']]['url']})" for t in data["tickets"] if ac in t["acceptance"]]
 lines.append(f"| {ac} | {', '.join(refs)} |")
lines += ["","## 实施边界与恢复","",
"原实施计划 T1–T10 是技术任务参考，不应在领取一个业务 Issue 后机械执行其全部任务。每次实施应从该 Issue 的用户结果、依赖、验收与 consumes/produces 重新生成详细 Task Brief；只修改本票所需的存储/接口/界面。例如 PKG02 只落地安装所需表，专家创建在 PKG04，工具派发在 PKG05。",
"默认按 PKG01→PKG02→PKG03→PKG04→PKG05→PKG06→PKG07→PKG08→PKG09→PKG10→PKG11→PKG12 串行；DAG 只保存真实前置，不把默认串行顺序伪装成业务依赖。PKG05 另受 #75 阻塞。",
"实施前先按仓库规则建立/核验执行工作区，将本目录、Spec 与 Plan 显式复制并校验；创建 Issue 不授予提交、推送、合并或部署权限。不得使用工作区中的其他会话改动充当本次已验证交付。",
"外部 #74/#75/#76/#137/#177 已读取正文、状态和评论；旧父 Spec 与原 Issue 正文/状态没有修改。#74 既有模块仅作为复用证据，闭票不替代测试；#75 的实际交付仍须在当前执行分支验收。",
"本阶段不声称已实现真实 Personal Space 或未接线的逻辑私有 Bot 多范围执行。后续个人模式与外部插件导入需完成各自领域合同后另立业务票。",
"恢复先读 published.json 与 verification.json，核对远端后再操作。publish.py --publish 会复用本次 marker 和创建检查点；不能在网络写入结果不明时盲目重复建单。",""]
(ROOT/"README.md").write_text("\n".join(lines))
plan=Path("docs/plans/2026-10-19-plugin-package-marketplace-implementation.md")
text=plan.read_text()
note=f"**Issue 拆解更新（2026-10-19）：** 用户随后要求拆为具体 Issue，已发布父方案 [#{parent['number']}]({parent['url']}) 与 12 张纵向业务票；[真实依赖与验收映射](../tickets/plugin-package-marketplace/README.md) 取代本文 T1–T10 作为 Issue 领取顺序。本文仍作技术实现参考，执行单个 Issue 时只提取它需要的 Task，不把整套水平任务提前实施。\\n\\n".replace("\\n","\n")
if "**Issue 拆解更新（2026-10-19）：**" not in text:
 text=text.replace("## Global Constraints\n\n",note+"## Global Constraints\n\n",1)
 text=text.replace("本次无 Issue 输入，不创建 Issue 树或假定 Issue 已批准。","此表为拆票前技术参考。正式实施须读取父 Issue #459 与正式子 Issue，领取顺序和业务依赖以 Issue DAG 为准，不能把本表当作已批准的实施派发。")
 plan.write_text(text)
print("INDEX_WRITTEN",parent["url"],len(nodes),"issues")

