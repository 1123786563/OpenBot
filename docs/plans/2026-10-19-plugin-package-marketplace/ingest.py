import datetime
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent / 'ingestion' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
OUT.mkdir(parents=True, exist_ok=False)
errors = []
requests = []
nodes = {}
contains = []
edges = []


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def fetch(endpoint):
    proc = subprocess.run(['gh', 'api', '-H', 'Accept: application/vnd.github+json', endpoint], capture_output=True, text=True)
    requests.append({'endpoint': endpoint, 'exit_code': proc.returncode})
    if proc.returncode:
        errors.append({'endpoint': endpoint, 'error': proc.stderr.strip()})
        return None
    return json.loads(proc.stdout)


def pages(repo, number, suffix):
    combined = []
    page = 1
    while True:
        endpoint = f'repos/{repo}/issues/{number}/{suffix}?per_page=100&page={page}'
        batch = fetch(endpoint)
        if batch is None:
            return None
        save(f'{repo.replace("/", "--")}-{number}-{suffix.replace("/", "--")}-{page}.json', batch)
        if not isinstance(batch, list):
            errors.append({'endpoint': endpoint, 'error': 'Expected array'})
            return None
        combined.extend(batch)
        if len(batch) < 100:
            return combined
        page += 1


def identity(issue):
    parts = urlparse(issue['repository_url']).path.strip('/').split('/')
    return '/'.join(parts[-2:]), issue['number']


def read_issue(repo, number, in_scope):
    key = f'{repo}#{number}'
    if key in nodes:
        nodes[key]['in_scope'] |= in_scope
        return nodes[key].get('children', [])
    body = fetch(f'repos/{repo}/issues/{number}')
    if body is None:
        return []
    save(f'{repo.replace("/", "--")}-{number}-issue.json', body)
    comments = pages(repo, number, 'comments')
    children = pages(repo, number, 'sub_issues') if in_scope else []
    blockers = pages(repo, number, 'dependencies/blocked_by')
    entry = {'repository': repo, 'number': number, 'state': body['state'], 'title': body['title'],
             'updated_at': body['updated_at'], 'in_scope': in_scope,
             'body_sha256': hashlib.sha256((body.get('body') or '').encode()).hexdigest(),
             'comment_count': len(comments) if comments is not None else None,
             'children': [identity(x) for x in children or []],
             'blocked_by': [identity(x) for x in blockers or []]}
    if comments is not None and len(comments) != body['comments']:
        errors.append({'issue': key, 'error': 'Comment count changed or incomplete'})
    nodes[key] = entry
    for child in children or []:
        child_repo, child_num = identity(child)
        contains.append({'parent': key, 'child': f'{child_repo}#{child_num}'})
    for blocker in blockers or []:
        dep_repo, dep_num = identity(blocker)
        edges.append({'issue': key, 'depends_on': f'{dep_repo}#{dep_num}'})
    return entry['children']


queue = [('1123786563/OpenBot', 459)]
while queue:
    repo, number = queue.pop(0)
    if f'{repo}#{number}' in nodes:
        continue
    queue.extend(read_issue(repo, number, True))
for repo, number in [('1123786563/OpenBot', 74), ('1123786563/OpenBot', 75)]:
    read_issue(repo, number, False)
scoped = {key for key, value in nodes.items() if value['in_scope'] and value['number'] != 459}
remaining = set(scoped)
order = []
while remaining:
    ready = sorted(key for key in remaining if not any(e['issue'] == key and e['depends_on'] in remaining for e in edges))
    if not ready:
        errors.append({'error': 'Dependency cycle', 'nodes': sorted(remaining)})
        break
    order.extend(ready)
    remaining.difference_update(ready)
local = json.loads((ROOT / 'docs/tickets/plugin-package-marketplace/manifest.json').read_text())
comparison = []
for node in local['nodes']:
    key = f'1123786563/OpenBot#{node["issue_number"]}'
    snapshot = ROOT / f'docs/tickets/plugin-package-marketplace/issues/{node["id"]}.md'
    comparison.append({'issue': key, 'acceptance': node['acceptance'],
                       'body_matches': key in nodes and hashlib.sha256(snapshot.read_bytes()).hexdigest() == nodes[key]['body_sha256']})
summary = {'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'complete': not errors, 'nodes': nodes, 'contains': contains, 'depends_on': edges,
           'topological_order': order, 'expected_child_count': 12, 'actual_child_count': len(scoped),
           'local_acceptance_comparison': comparison, 'errors': errors, 'requests': requests}
save('dag.json', summary)
print(json.dumps({'directory': str(OUT), 'complete': not errors, 'children': len(scoped),
                  'requests': len(requests), 'errors': errors}, ensure_ascii=False))
raise SystemExit(0 if not errors else 1)
