from pathlib import Path
import json,re,hashlib,subprocess,datetime
R=Path.cwd(); O=R/'docs/design/2026-10-20-workspace-redesign/handoff/refinement'
load=lambda f:json.loads((O/f).read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
a=load('route-acceptance.json');d=load('tasks.json');base=load('baseline.json');tasks=d['tasks'];errors=[]
def check(test,msg):
 if not test:errors.append(msg)
check(len(a['pages'])==76 and len(a['shared_layouts'])==4 and len(a['compatibility_redirects'])==7,'route count')
check(len({p['id'] for p in a['pages']})==76,'unique page ids')
check(len({t['id'] for t in tasks})==len(tasks),'unique tasks')
seen=set()
# Re-scan current declarations independently from the cached page map.
actual=[]
for f in (R/'app/src/routes').rglob('*.tsx'):
 m=re.search(r'createFileRoute\(\s*[\"\']([^\"\']+)',f.read_text())
 if m:actual.append((m.group(1),str(f.relative_to(R))))
expected=[(r['route_id'],r['source']) for r in load('route-rescan.json')['routes']]
check(set(actual)==set(expected) and len(actual)==87,'fresh route rescan differs')
for t in tasks:
 check(set(t['depends_on'])<=seen,'dependency order '+t['id']);seen.add(t['id'])
 for f in t['owned_files']:check('/../' not in f,'noncanonical owner '+f)
# Every node must feed the final acceptance gate through an actual dependency path.
reachable=set()
def visit(tid):
 if tid in reachable:return
 reachable.add(tid)
 for dep in next(t for t in tasks if t['id']==tid)['depends_on']:visit(dep)
visit('T21')
check(reachable=={t['id'] for t in tasks},'orphan task outside final gate')
check(len([f for t in tasks for f in t['owned_files']])==len(set(f for t in tasks for f in t['owned_files'])),'file owner collision')
for p in a['pages']:
 check((R/p['source']).is_file(),'missing source '+p['source'])
 check(sha(R/p['source'])==p['source_sha256'],'source drift '+p['source'])
 check(sum(p['id'] in t['source_pages'] for t in tasks if t['id'] not in ['T01','T02','T03','T08','T21'])==1,'page owner '+p['id'])
 check(all(k in p for k in ['normal','exception','permission','long_content','narrow_screen','acceptance_evidence']),'acceptance fields '+p['id'])
for f in base['files']:
 p=R/f['path'];check(p.is_file() and sha(p)==f['sha256'],'outside-scope drift '+f['path'])
# New files outside refinement are not ours to undo, but must be disclosed.
current=set(subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0'))
initial={f['path'] for f in base['files']};prefix=str(O.relative_to(R))+'/'
new_external=sorted(p for p in current-initial if p and not p.startswith(prefix) and (R/p).is_file())
check(not new_external,'new outside-scope files '+repr(new_external))
check(subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()==base['head'],'HEAD changed')
# Check all repository local Markdown links; code references without links are verified separately.
link_errors=[]
for f in O.glob('*.md'):
 for target in re.findall(r'\]\(([^)]+)\)',f.read_text()):
  if '://' in target or target.startswith('#'):continue
  p=(f.parent/target.split('#')[0]).resolve()
  if not p.exists():link_errors.append(f.name+': '+target)
check(not link_errors,'broken links '+repr(link_errors))
# Static sRGB contrast proposal. This is not a browser computation.
tokens={t['name']:t for t in load('theme-contract.json')['tokens']}
def color(name,theme):
 v=tokens[name][theme]
 if v.startswith('var('):return color(v[4:-1],theme)
 if v.startswith('#'):return tuple(int(v[i:i+2],16)/255 for i in [1,3,5])
 raise ValueError(v)
def lum(c):return sum(w*(x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4) for x,w in zip(c,[.2126,.7152,.0722]))
def ratio(c,b):
 x,y=sorted([lum(c),lum(b)]);return (y+.05)/(x+.05)
contrasts=[]
for theme in ['light','dark']:
 for fg in ['foreground','muted-text','accent-text','danger','success','warning']:
  for bg in ['canvas','surface','overlay','sidebar','hover-surface']:
   r=ratio(color('--ob-'+fg,theme),color('--ob-'+bg,theme));contrasts.append({'theme':theme,'foreground':fg,'background':bg,'ratio':round(r,3),'minimum':4.5,'pass':r>=4.5})
 for state in ['action','action-hover','danger','success','warning']:
  fg=state.split('-hover')[0]+'-foreground';r=ratio(color('--ob-'+fg,theme),color('--ob-'+state,theme));contrasts.append({'theme':theme,'foreground':fg,'background':state,'ratio':round(r,3),'minimum':4.5,'pass':r>=4.5})
 for state in ['danger','success','warning']:
  c=color('--ob-'+state,theme);b=color('--ob-surface',theme);soft=tuple(.1*x+.9*y for x,y in zip(c,b));r=ratio(c,soft);contrasts.append({'theme':theme,'foreground':state,'background':'10%soft '+state,'ratio':round(r,3),'minimum':4.5,'pass':r>=4.5})
 for fg in ['control-border','focus']:
  for bg in ['surface','overlay','sidebar']:
   r=ratio(color('--ob-'+fg,theme),color('--ob-'+bg,theme));contrasts.append({'theme':theme,'foreground':fg,'background':bg,'ratio':round(r,3),'minimum':3,'pass':r>=3})
failed=[c for c in contrasts if not c['pass']]
(O/'contrast-check.json').write_text(json.dumps({'method':'static sRGB luminance; proposal pairs only; no DOM/browser claim','checks':contrasts,'failed':failed},ensure_ascii=False,indent=2)+'\n')
check(not failed,'contrast pairs failed '+repr(failed))
report={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'documentation only','route_counts':a['count'],'tasks':len(tasks),'unique_owned_files':len(d['file_owners']),'baseline_files_verified_unchanged':len(base['files']),'new_outside_scope_files':new_external,'broken_links':link_errors,'contrast_pairs':len(contrasts),'errors':errors,'result':'pass' if not errors else 'fail','not_run':['production implementation','typecheck','build','native/driven suites','production browser','independent code review','OCR']}
(O/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2));raise SystemExit(bool(errors))
