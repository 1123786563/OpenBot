"""Refresh publication documentation, validate receipts and package documentation only."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import tarfile

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
s=json.loads((HERE/'tickets.json').read_text())
assert s['status']=='published-and-verified'
v=json.loads((HERE/'publication-verification.json').read_text())
assert v['publication_complete'] and v['native_sub_issue_count']==12 and v['native_dependency_count']==13
by_key={t['id']:t for t in s['tickets']}
assert len(by_key)==12
sha=lambda b:hashlib.sha256(b).hexdigest()
for t in s['tickets']:
    assert t['issue_number'] and t['url'] and t['parent_link_written']
    assert sha((HERE/t['file']).read_bytes())==t['body_sha256']
    assert sorted(t['native_blocked_by_numbers'])==sorted(by_key[x]['issue_number'] for x in t['depends_on'])
    t['status']='published'
assert sha((HERE/'parent-issue.md').read_bytes())==s['parent_body_sha256']
(HERE/'tickets.json').write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n')
p=HERE/'README.md';text=p.read_text()
text=text.replace('状态：**待审阅，本地父 Spec + 12 张业务 Issue；尚未发布到 GitHub**。',f"状态：**用户已采用；父 Spec #{s['parent_issue']} + 12 张正式子 Issue 已发布，原生关系已回读核验；尚未启动代码实施**。")
text=text.replace('本轮仅生成设计与票据，不启动生产代码改造；','本轮完成设计采用与 Issue 发布，不启动生产代码改造；')
text=text.replace('- `validation.json`：文档静态校验，不代表产品测试通过。','- `publication-verification.json`：GitHub 正文、标签、12 条父子关系和 13 条依赖的回读证据。\n- `validation.json`：本地文档与发布回执一致性校验，不代表产品测试通过。')
text=text.replace('## 发布规则',f"## 已发布 Issue\n\n父 Spec：[#{s['parent_issue']}]({s['parent_url']})。\n\n| Key | GitHub Issue | 标题 | 原生 Blocked by |\n|---|---|---|---|\n"+'\n'.join(f"| {t['id']} | [#{t['issue_number']}]({t['url']}) | {t['title']} | {', '.join('#'+str(x) for x in t['native_blocked_by_numbers']) or '无'} |" for t in s['tickets'])+'\n\n## 发布与恢复规则',1)
text=text.replace('依据 to-tickets，先由用户审阅业务粒度、测试边界与依赖，再发布。当前 manifest publication_authorized=false，所有 issue_number/url 均为空，UP key 不是 GitHub 编号。','用户已于 2026-10-20 确认“采用”设计、测试边界与拆分；manifest 已回填真实编号/URL。UP key 仍是稳定业务标识，不是 GitHub 编号。')
text=text.replace('用户确认发布后：','本次已按以下流程完成；如发布恢复，先核验现有回执：')
text=text.replace('本地草稿也可由用户采用后直接实施，不以发布 GitHub 为强制前提。若用户只要求发布，不启动实施。','当前已发布；后续执行者应读取正式父 Issue 树和实际依赖。用户本次采用并授权发布，不等于启动代码实施。')
text=text.replace('执行提示词默认可定位本地草稿或已发布编号，无需修改 UP key。','执行提示词已标注正式父 Issue，读取 manifest 中实际编号，无需手动替换 UP key。')
p.write_text(text)
p=HERE/'EXECUTION-PROMPT.md';text=p.read_text()
text=text.replace('以下框内内容供用户审阅设计与拆票后，复制到具有本仓库访问权限的 Code Agent。',f"设计与拆票已由用户采用并发布，父 Spec 为 #{s['parent_issue']}（{s['parent_url']}）。以下正文供用户复制到具有本仓库访问权限的 Code Agent。")
text=text.replace('目标仓库是 `1123786563/OpenBot`。',f"目标仓库是 `1123786563/OpenBot`，正式父 Spec 是 {s['parent_url']}；其 12 张子 Issue 和实际阻塞依赖以 GitHub 及本地 manifest 为准。",1)
p.write_text(text)
# Preserve the original pre-publication static check as a historical receipt.
p=HERE/'validation.json'
if not (HERE/'prepublication-validation.json').exists():
    (HERE/'prepublication-validation.json').write_bytes(p.read_bytes())
report={'checked_at':datetime.now(timezone.utc).isoformat(),'status':'published-and-verified','parent_url':s['parent_url'],'checks':{'unique_tickets':12,'acceptance_groups':12,'native_sub_issues_read_back':12,'native_dependencies_read_back':13,'body_hashes_match':True,'labels_read_back':['enhancement','ready-for-agent'],'product_tests_executed':False,'implementation_started':False},'publication_report':'publication-verification.json'}
p.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
# Reuse the explicit documentation allowlist from the previously checked archive.
old=json.loads((HERE/'bundle-manifest.json').read_text())
selected={ROOT/x['path'] for x in old['files']}
selected.update(p for p in HERE.rglob('*') if p.is_file() and p.suffix in {'.md','.json','.py'} and p.name!='bundle-manifest.json')
selected=sorted(p for p in selected if p.is_file() and p.name!='bundle-manifest.json' and 'handoff-bundle' not in p.relative_to(ROOT).parts)
manifest={'created_at':datetime.now(timezone.utc).isoformat(),'repository':s['repo'],'kind':'documentation-only','parent_url':s['parent_url'],'publication_status':s['status'],'files':[{'path':str(p.relative_to(ROOT)),'sha256':sha(p.read_bytes())} for p in selected]}
(HERE/'bundle-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
with tarfile.open(HERE/'handoff-bundle.tar.gz','w:gz') as tar:
    for p in selected+[HERE/'bundle-manifest.json']:
        tar.add(p,arcname=str(p.relative_to(ROOT)),recursive=False)
with tarfile.open(HERE/'handoff-bundle.tar.gz') as tar:
    for entry in manifest['files']:
        assert sha(tar.extractfile(entry['path']).read())==entry['sha256']
print(f"Packaged {len(selected)+1} documentation files; {s['parent_url']}")
