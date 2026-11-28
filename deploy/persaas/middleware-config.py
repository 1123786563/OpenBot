#!/usr/bin/env python3
"""Synchronize existing middleware configuration with the private Infrastructure vault."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/persaas')


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE).decode()


def atomic(path, value, mode=0o600, uid=None, gid=None):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.vault-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        if uid is not None:
            os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Vault:
    def __init__(self):
        self.credentials = json.loads((ROOT / 'credentials.json').read_text())
        self.token = ''
        c = self.credentials
        self.token = self.call('v3/auth/login', {'email': c['adminEmail'], 'password': c['infisicalPassword']})['accessToken']
        self.token = self.call('v3/auth/select-organization', {'organizationId': c['infisicalOrgId']})['token']
        self.project = c['infisicalInfrastructureProjectId']

    def call(self, path, body=None, method=None):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request('http://127.0.0.1:18082/api/' + path,
            data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)

    def read(self, folder):
        query = urllib.parse.urlencode({'projectId': self.project, 'environment': 'prod', 'secretPath': '/' + folder, 'expandSecretReferences': 'false'})
        return {item['secretKey']: item['secretValue'] for item in self.call('v4/secrets?' + query)['secrets']}

    def write(self, folder, values):
        try:
            self.call('v2/folders', {'projectId': self.project, 'environment': 'prod', 'name': folder, 'path': '/'})
        except urllib.error.HTTPError as error:
            if error.code not in (400, 409):
                raise
        old = self.read(folder)
        new = [{'secretKey': key, 'secretValue': value} for key, value in values.items() if key not in old]
        if new:
            self.call('v4/secrets/batch', {'projectId': self.project, 'environment': 'prod', 'secretPath': '/' + folder, 'secrets': new})
        for key, value in values.items():
            if key in old and old[key] != value:
                self.call('v4/secrets/' + key, {'projectId': self.project, 'environment': 'prod', 'secretPath': '/' + folder, 'secretValue': value}, 'PATCH')
        actual = self.read(folder)
        if any(actual.get(key) != value for key, value in values.items()):
            raise RuntimeError('Vault readback mismatch: ' + folder)


def file_key(path, compose):
    if path == compose:
        return 'COMPOSE_YAML'
    if path == compose.parent / '.env':
        return 'PANEL_ENV_FILE'
    name = re.sub('[^A-Za-z0-9]', '_', path.name).upper()
    return 'CONFIG_' + name + '_' + hashlib.sha256(str(path).encode()).hexdigest()[:10].upper()


def inventory():
    ids = run('docker', 'ps', '-q').split()
    containers = json.loads(run('docker', 'inspect', *ids)) if ids else []
    groups = {}
    for container in containers:
        labels = container['Config'].get('Labels') or {}
        files = labels.get('com.docker.compose.project.config_files', '').split(',')
        if len(files) != 1 or not files[0]:
            raise RuntimeError('Container has no single Compose source: ' + container['Name'])
        compose = Path(files[0]).resolve()
        if not str(compose).startswith(('/opt/1panel/apps/', '/opt/persaas/')):
            raise RuntimeError('Unexpected Compose source')
        folder = labels['com.docker.compose.project']
        if folder == 'persaas-data':
            folder = 'data-services'
        if folder == 'redis-cluster-master':
            folder = 'redis'
        group = groups.setdefault(folder, {'compose': compose, 'paths': {compose}, 'containers': []})
        if group['compose'] != compose:
            raise RuntimeError('Duplicate project name')
        group['containers'].append(container)
        dotenv = compose.parent / '.env'
        if dotenv.is_file():
            group['paths'].add(dotenv)
        for mount in container['Mounts']:
            source = Path(mount['Source'])
            if not str(source).startswith(('/opt/1panel/', '/opt/persaas/')):
                continue
            if source.is_file():
                group['paths'].add(source)
            elif source.is_dir() and any(part in source.name.lower() for part in ['conf', 'config', 'cert', 'ssl']):
                group['paths'].update(p for p in source.rglob('*') if p.is_file() and not p.is_symlink())
    for group in groups.values():
        compose = group['compose']
        definition = json.loads(run('docker', 'compose', '-f', str(compose), 'config', '--no-env-resolution', '--format', 'json', cwd=compose.parent))
        for service in definition['services'].values():
            for entry in service.get('env_file', []):
                path = Path(entry['path'] if isinstance(entry, dict) else entry)
                # Runtime folders own these generated exports; keep one configuration authority.
                if path.parent != ROOT / 'runtime':
                    group['paths'].add(path)
    # Website configuration stays owned by 1Panel; include its actual proxy and TLS files.
    if 'openresty' in groups:
        for pattern in ['*/proxy/*.conf', '*/ssl/*.pem', '*/ssl/*.key', '*/ssl/*.crt']:
            groups['openresty']['paths'].update(Path('/opt/1panel/1panel/www/sites').glob(pattern))
    return groups


def values_for(group):
    compose = group['compose']
    values, manifest = {}, {}
    for path in sorted(group['paths']):
        if path.is_symlink() or path.stat().st_size > 500000:
            raise RuntimeError('Unsupported configuration file: ' + str(path))
        stat = path.stat()
        key = file_key(path, compose)
        values[key] = path.read_text()
        manifest[key] = {'path': str(path), 'mode': stat.st_mode & 0o777, 'uid': stat.st_uid, 'gid': stat.st_gid}
    values['FILES_MANIFEST_JSON'] = json.dumps(manifest, sort_keys=True)
    # Effective environment is evidence, not another editable configuration source.
    rendered = json.loads(run('docker', 'compose', '-f', str(compose), 'config', '--format', 'json', cwd=compose.parent))
    values['EFFECTIVE_ENVIRONMENT_JSON'] = json.dumps({name: config.get('environment', {}) for name, config in rendered['services'].items()}, sort_keys=True)
    return values, manifest


def apply(group, values, write=False):
    _, local = values_for(group)
    manifest = json.loads(values['FILES_MANIFEST_JSON'])
    if manifest != local:
        raise RuntimeError('Configuration paths or ownership changed; inventory and push again before applying')
    changes = [(Path(meta['path']), values[key], meta) for key, meta in manifest.items() if Path(meta['path']).read_text() != values[key]]
    if not write or not changes:
        return len(changes)
    backup = ROOT / 'backups' / ('vault-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    for path, _, _ in changes:
        target = backup / path.relative_to('/')
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(path, target)
    try:
        for path, value, meta in changes:
            atomic(path, value, meta['mode'], meta['uid'], meta['gid'])
        compose = group['compose']
        run('docker', 'compose', '-f', str(compose), 'config', '--quiet', cwd=compose.parent)
        if any(c['Config']['Labels'].get('com.docker.compose.project') == 'openresty' for c in group['containers']):
            run('docker', 'exec', group['containers'][0]['Id'], 'openresty', '-t')
    except Exception:
        for path, _, meta in changes:
            atomic(path, (backup / path.relative_to('/')).read_text(), meta['mode'], meta['uid'], meta['gid'])
        raise
    return len(changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['push', 'check', 'apply'])
    parser.add_argument('--project', help='One Compose project / Infrastructure folder')
    parser.add_argument('--restart', action='store_true', help='Recreate the selected project after applying')
    args = parser.parse_args()
    if args.restart and (args.action != 'apply' or not args.project):
        parser.error('--restart requires apply --project NAME')
    vault = Vault()
    groups = inventory()
    if args.project:
        groups = {args.project: groups[args.project]}
    report = []
    for folder, group in sorted(groups.items()):
        if args.action == 'push':
            values, manifest = values_for(group)
            vault.write(folder, values)
            count = len(manifest)
            print(folder + ': uploaded and readback verified ' + str(count) + ' files')
        else:
            values = vault.read(folder)
            count = apply(group, values, args.action == 'apply')
            print(folder + ': ' + str(count) + ' changed files')
            if args.restart:
                compose = group['compose']
                run('docker', 'compose', '-f', str(compose), 'up', '-d', '--force-recreate', cwd=compose.parent)
                print(folder + ': recreated; run middleware acceptance before continuing')
        report.append({'project': folder, 'fileCount' if args.action == 'push' else 'changedFiles': count})
    atomic(ROOT / 'middleware-config-report.json', json.dumps({'action': args.action, 'projects': report, 'time': time.time()}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # HTTP bodies, Compose stderr and file contents can contain credentials.
        print('Middleware configuration operation failed (' + type(error).__name__ + '). No secret values printed.', flush=True)
        raise SystemExit(1)
