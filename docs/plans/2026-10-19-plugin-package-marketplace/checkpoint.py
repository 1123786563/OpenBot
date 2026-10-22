import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = '9057aeebb69ebbbd2673378c17eec1dd830cfb17'
EVIDENCE = ROOT / 'docs/plans/2026-10-19-plugin-package-marketplace'


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sources():
    tracked = git('diff', '--name-only', '-z', BASE).decode().split('\0')
    untracked = git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')
    selected = []
    for name in sorted(set(tracked + untracked)):
        if not name or name.startswith('docs/plans/2026-10-19-plugin-package-marketplace/'):
            continue
        if '/.artifacts/' in name:
            continue
        path = ROOT / name
        if path.is_symlink():
            raise RuntimeError(f'Unexpected source symlink: {name}')
        data = path.read_bytes() if path.is_file() else None
        selected.append({'path': name, 'state': 'deleted' if data is None else 'present',
                         'sha256': digest(data) if data is not None else None,
                         'bytes': len(data) if data is not None else 0,
                         'untracked': name in untracked})
    return selected


def content_id(entries):
    return digest(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode())


parser = argparse.ArgumentParser()
parser.add_argument('name')
parser.add_argument('--verify', action='store_true')
args = parser.parse_args()
if not args.name.replace('-', '').replace('_', '').isalnum():
    raise SystemExit('Invalid checkpoint name')
output = EVIDENCE / 'checkpoints' / args.name
entries = sources()
if args.verify:
    expected = json.loads((output / 'manifest.json').read_text())
    actual = content_id(entries)
    print(json.dumps({'checkpoint': args.name, 'expected': expected['content_sha256'],
                      'actual': actual, 'matches': actual == expected['content_sha256']}))
    raise SystemExit(0 if actual == expected['content_sha256'] else 1)
output.mkdir(parents=True, exist_ok=False)
head = git('rev-parse', 'HEAD').decode().strip()
manifest = {'base': BASE, 'head': head, 'branch': git('branch', '--show-current').decode().strip(),
            'content_sha256': content_id(entries), 'files': entries,
            'limitations': ['Historical PKG01/PKG02 task-before snapshots were not captured; BASE is not claimed as a task-before checkpoint.',
                            'Generated artifact stores and execution reports are excluded from source identity.']}
for entry in entries:
    name = entry['path']
    if entry['state'] == 'present':
        target = output / 'files' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    if not entry['untracked']:
        result = subprocess.run(['git', '-C', str(ROOT), 'show', f'{BASE}:{name}'], capture_output=True)
        if result.returncode == 0:
            target = output / 'base-files' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(result.stdout)
(output / 'tracked.diff').write_bytes(git('diff', '--binary', BASE))
(output / 'index.diff').write_bytes(git('diff', '--cached', '--binary'))
(output / 'status.txt').write_bytes(git('status', '--short'))
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
if content_id(sources()) != manifest['content_sha256'] or git('rev-parse', 'HEAD').decode().strip() != head:
    raise SystemExit('Source changed during capture; checkpoint is invalid')
print(json.dumps({'checkpoint': str(output), 'files': len(entries), 'sha256': manifest['content_sha256']}))
