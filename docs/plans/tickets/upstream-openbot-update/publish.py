#!/usr/bin/env python3
"""Publish only this user-approved Issue set; persist each write receipt for recovery."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import subprocess
import sys

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
STATE=HERE/'tickets.json'
s=json.loads(STATE.read_text())
REPO='1123786563/OpenBot'
assert s['repo']==REPO
assert s['publication_authorized'] is True
assert s['approval']['implementation_authorized'] is False
assert s['approval']['user_message']=='采用'
LABELS=['enhancement','ready-for-agent']
by_key={t['id']:t for t in s['tickets']}
assert len(by_key)==12


def now(): return datetime.now(timezone.utc).isoformat()
def sha(body): return hashlib.sha256(body.encode()).hexdigest()
def save():
    p=STATE.with_suffix('.json.tmp')
    p.write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n')
    p.replace(STATE)

def api(method,path,payload=None,paginate=False):
    args=['gh','api',path,'--method',method]
    if paginate: args+=['--paginate','--slurp']
    if payload is not None: args+=['--input','-']
    p=subprocess.run(args,input=json.dumps(payload,ensure_ascii=False) if payload is not None else None,capture_output=True,text=True,timeout=90 if paginate else 45)
    if p.returncode:
        raise RuntimeError(f'{method} {path}: {p.stderr.strip()}')
    return json.loads(p.stdout) if p.stdout.strip() else None

def pages(path): return [x for page in api('GET',path,paginate=True) for x in page]
def marker(key): return f'<!-- openbot:upstream-openbot-update:{key} -->'

def record(target,item,body):
    target.update(issue_number=item['number'],issue_id=item['id'],url=item['html_url'],published_title=item['title'],body_sha256=sha(body),published_at=now())
    save()

def create_or_recover(key,title,body,target,existing):
    if target.get('issue_number'):
        item=api('GET',f"repos/{REPO}/issues/{target['issue_number']}")
        assert item['title']==title and item['body']==body, f'{key}: published body/title changed; inspect before retry'
        return item
    candidates=[x for x in existing if x['title']==title or marker(key) in (x.get('body') or '')]
    assert len(candidates)<=1, f'{key}: ambiguous duplicates'
    if candidates:
        item=candidates[0]
        assert marker(key) in (item.get('body') or '') and item['body']==body, f'{key}: title collision or changed body'
        record(target,item,body)
        print(f"Recovered {key}: {item['html_url']}",flush=True)
        return item
    s['in_flight_write']={'kind':'create_issue','key':key,'title':title,'body_sha256':sha(body),'started_at':now()}
    save()
    item=api('POST',f'repos/{REPO}/issues',{'title':title,'body':body,'labels':LABELS})
    record(target,item,body)
    s.pop('in_flight_write',None);save()
    existing.append(item)
    print(f"Created {key}: {item['html_url']}",flush=True)
    return item

def order():
    result=[];seen=set()
    while len(seen)<len(by_key):
        ready=[t['id'] for t in s['tickets'] if t['id'] not in seen and set(t['depends_on'])<=seen]
        assert ready,'missing dependency or cycle'
        result.extend(ready);seen.update(ready)
    return result

def verify(parent,body):
    children=pages(f"repos/{REPO}/issues/{parent['number']}/sub_issues?per_page=100")
    assert {x['number'] for x in children}=={t['issue_number'] for t in s['tickets']},'contains mismatch'
    p=api('GET',f"repos/{REPO}/issues/{parent['number']}")
    assert p['body']==body and p['state']=='open'
    assert set(LABELS)<={x['name'] for x in p['labels']}
    results=[]
    for t in s['tickets']:
        item=api('GET',f"repos/{REPO}/issues/{t['issue_number']}")
        assert item['body']==(HERE/t['file']).read_text() and item['title']==t['published_title'],t['id']
        assert sha(item['body'])==t['body_sha256'] and item['state']=='open',t['id']
        assert set(LABELS)<={x['name'] for x in item['labels']}
        blockers=pages(f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by?per_page=100")
        actual=sorted(x['number'] for x in blockers)
        expected=sorted(by_key[key]['issue_number'] for key in t['depends_on'])
        assert actual==expected,(t['id'],actual,expected)
        results.append({'key':t['id'],'number':item['number'],'url':item['html_url'],'body_sha256':sha(item['body']),'state':item['state'],'blocked_by':actual,'labels':[x['name'] for x in item['labels']]})
        print(f"Verified {t['id']}: #{item['number']}",flush=True)
    report={'verified_at':now(),'repo':REPO,'parent_url':p['html_url'],'parent_number':p['number'],'parent_body_sha256':sha(p['body']),'native_sub_issue_count':len(children),'native_dependency_count':sum(len(x['blocked_by']) for x in results),'issues':results,'implementation_started':False,'publication_complete':True}
    (HERE/'publication-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    s['status']='published-and-verified';s['verified_at']=report['verified_at'];s['implementation_started']=False
    s.pop('in_flight_write',None);save()
    return report

def publish():
    s['status']='publishing';s['topological_order']=order();save()
    # Read authenticated REST pages, not eventually-consistent search, to recover unknown writes.
    existing=pages(f'repos/{REPO}/issues?state=all&per_page=100')
    parent_title='[Spec] OpenBot 上游能力更新与 OpenMuse 治理兼容'
    parent_path=HERE/s['parent_body_file']
    parent_meta=s.setdefault('parent_publication',{})
    if not parent_meta.get('issue_number') and not any(marker('UP-SPEC') in (x.get('body') or '') for x in existing):
        spec=(ROOT/s['spec']).read_text()
        table='\n\n## 业务子 Issue 与依赖\n\n下表是已采用的稳定业务 key，GitHub 正式子 Issue 及阻塞关系通过原生关系展示。\n\n| Key | 交付 | Blocked by |\n|---|---|---|\n'
        for t in s['tickets']:
            table+=f"| {t['id']} | {t['title']} | {', '.join(t['depends_on']) or '无'} |\n"
        body=spec+table+f"\n{marker('UP-SPEC')}\n"
        parent_path.write_text(body)
    body=parent_path.read_text()
    s['spec_sha256']=sha((ROOT/s['spec']).read_text());s['parent_body_sha256']=sha(body);save()
    parent=create_or_recover('UP-SPEC',parent_title,body,parent_meta,existing)
    s.update(parent_issue=parent['number'],parent_id=parent['id'],parent_url=parent['html_url']);save()
    for key in s['topological_order']:
        t=by_key[key];p=HERE/t['file'];child=p.read_text()
        if not t.get('issue_number') and marker(key) not in child:
            child=re.sub(r'## Parent\n.*?(?=## What to build)',f"## Parent\n\nSpec: {parent['html_url']} — OpenBot 上游能力更新。本 Issue 是其正式子 Issue。\n\n",child,flags=re.S)
            for dep in t['depends_on']:
                assert by_key[dep].get('url'),dep
                child=re.sub(rf'\b{dep}\b',by_key[dep]['url'],child)
            child=child.replace('当前是未发布草稿。任何发布、实施、提交、推送、合并或生产上线按用户实际授权处理，不从本票状态推导。','用户于 2026-10-20 确认采用设计、测试边界与拆票，授权登记本 Issue；尚未启动代码实施。提交、推送、合并、生产迁移和上线仍依实际授权。')
            child+=f'\n{marker(key)}\n';p.write_text(child)
        create_or_recover(key,t['published_title'],child,t,existing)
    linked={x['id'] for x in pages(f"repos/{REPO}/issues/{parent['number']}/sub_issues?per_page=100")}
    for t in s['tickets']:
        if t['issue_id'] not in linked:
            api('POST',f"repos/{REPO}/issues/{parent['number']}/sub_issues",{'sub_issue_id':t['issue_id']});linked.add(t['issue_id'])
        t['parent_link_written']=True;save()
        known={x['id'] for x in pages(f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by?per_page=100")}
        for dep in t['depends_on']:
            predecessor=by_key[dep]
            if predecessor['issue_id'] not in known:
                api('POST',f"repos/{REPO}/issues/{t['issue_number']}/dependencies/blocked_by",{'issue_id':predecessor['issue_id']})
                known.add(predecessor['issue_id'])
        t['native_blocked_by_numbers']=[by_key[x]['issue_number'] for x in t['depends_on']];save()
        print(f"Linked {t['id']}: #{t['issue_number']}, blockers {t['native_blocked_by_numbers']}",flush=True)
    verify(parent,body)

if __name__=='__main__':
    try:
        publish()
    except Exception as e:
        s['status']='publication-incomplete';s['last_error']=str(e);s['last_error_at']=now();save()
        print(f'Publication stopped; resume from receipts: {e}',file=sys.stderr)
        raise
