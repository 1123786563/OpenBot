import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = '1123786563/OpenBot'
OUT = ROOT / 'issue-snapshots'
OUT.mkdir(exist_ok=True)
requests = []
failures = []


def fetch(number, suffix='', paginated=False):
    path = f'repos/{REPO}/issues/{number}' + suffix
    args = ['gh', 'api', path + ('?per_page=100' if paginated else '')]
    if paginated:
        args += ['--paginate', '--slurp']
    result = subprocess.run(args, capture_output=True, text=True)
    filename = f'{number}' + suffix.replace('/', '-') + '.json'
    record = {'endpoint': path, 'command': args, 'exit_code': result.returncode,
              'read_at': datetime.now(timezone.utc).isoformat(), 'file': filename}
    requests.append(record)
    if result.returncode:
        failure = {**record, 'stderr': result.stderr}
        failures.append(failure)
        return None
    data = json.loads(result.stdout)
    (OUT / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    if paginated:
        if not all(isinstance(page, list) for page in data):
            raise ValueError(f'Unexpected pagination shape: {path}')
        record['pages'] = len(data)
        record['items'] = sum(len(page) for page in data)
        return [item for page in data for item in page]
    return data


queue = [472]
seen = set()
contains = []
depends = []
issues = {}
while queue:
    number = queue.pop(0)
    if number in seen:
        continue
    seen.add(number)
    issues[number] = fetch(number)
    fetch(number, '/comments', True)
    children = fetch(number, '/sub_issues', True)
    blockers = fetch(number, '/dependencies/blocked_by', True)
    if children is not None:
        for child in children:
            contains.append([number, child['number']])
            queue.append(child['number'])
    if blockers is not None:
        depends += [[number, blocker['number']] for blocker in blockers]

external = sorted({b for _, b in depends} - seen)
for number in external:
    issues[number] = fetch(number)
    fetch(number, '/comments', True)
    fetch(number, '/dependencies/blocked_by', True)

manifest = json.loads((ROOT.parent.parent / 'tickets/mastra-agent-execution/tickets.json').read_text())
checks = []
for ticket in manifest['tickets']:
    number = ticket['issue_number']
    issue = issues.get(number)
    digest = hashlib.sha256((issue.get('body') or '').encode()).hexdigest() if issue else None
    checks.append({'ticket': ticket['id'], 'number': number, 'body_sha256': digest,
                   'matches_approved_body': digest == ticket['body_sha256'],
                   'matches_native_dependencies': sorted(b for a, b in depends if a == number) == sorted(ticket['native_blocked_by_numbers'])})
report = {'read_at': datetime.now(timezone.utc).isoformat(), 'root': 472,
          'descendants': sorted(seen - {472}), 'external': external,
          'contains': contains, 'depends_on': depends, 'requests': requests,
          'failures': failures, 'checks': checks,
          'complete': not failures and all(c['matches_approved_body'] and c['matches_native_dependencies'] for c in checks)
          and sorted(seen - {472}) == sorted(t['issue_number'] for t in manifest['tickets'])}
(OUT / 'ingestion.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
for name, edges in [('contains', contains), ('depends_on', depends)]:
    (OUT / f'{name}.tsv').write_text('source\ttarget\n' + ''.join(f'{a}\t{b}\n' for a, b in edges))
print(json.dumps({'complete': report['complete'], 'issues': len(seen), 'contains': len(contains),
                  'depends_on': len(depends), 'external': external, 'failures': failures,
                  'mismatches': [c for c in checks if not c['matches_approved_body'] or not c['matches_native_dependencies']]}, ensure_ascii=False))
raise SystemExit(0 if report['complete'] else 1)
