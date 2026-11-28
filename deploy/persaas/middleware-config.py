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


def projects():
    ids = run('docker', 'ps', '-q').split()
    result = {}
    for item in json.loads(run('docker', 'inspect', *ids)) if ids else []:
        labels = item['Config'].get('Labels') or {}
        sources = labels.get('com.docker.compose.project.config_files', '').split(',')
        if len(sources) != 1 or not sources[0]:
            raise RuntimeError('Expected one Compose file per running project')
        path = Path(sources[0]).resolve()
        if not str(path).startswith(('/opt/1panel/apps/', '/opt/persaas/')):
            raise RuntimeError('Unexpected Compose path')
        name = labels['com.docker.compose.project']
        name = {'persaas-data': 'data-services', 'redis-cluster-master': 'redis'}.get(name, name)
        result[name] = path
    data = ROOT / 'data.yml'
    if data in result.values():
        result.pop('data-services', None)
        result.update(flexprice=data, temporal=data)
    return result


def definition(compose, unresolved=False):
    args = ['docker', 'compose', '--profile', '*', '-f', str(compose), 'config', '--format', 'json']
    if unresolved:
        args.append('--no-env-resolution')
    return json.loads(run(*args, cwd=compose.parent))


def database_service(service):
    image = service.get('image', '').split('@')[0].rsplit('/', 1)[-1].split(':')[0]
    return image in {'postgres', 'postgres-partman', 'pgvector', 'mysql', 'mariadb', 'clickhouse-server', 'redis', 'valkey', 'mongo', 'mongodb'}


def env_files(compose, project=None, include_databases=False):
    paths = set()
    selected = ROOT / 'runtime' / (str(project) + '.env') if project in ('flexprice', 'temporal') else None
    for service in definition(compose, True)['services'].values():
        if not include_databases and database_service(service):
            continue
        for item in service.get('env_file', []):
            path = Path(item['path'] if isinstance(item, dict) else item)
            # Each shared-stack env belongs to its middleware folder.
            if (selected is not None and path == selected) or (selected is None and path.parent != ROOT / 'runtime'):
                paths.add(path)
    return {('ENV_' + re.sub('[^A-Za-z0-9]', '_', path.name).upper() + '_' + hashlib.sha256(str(path).encode()).hexdigest()[:10].upper()): path for path in sorted(paths)}


def env_text(text):
    # Outside a dotenv value, leading/trailing empty lines carry no configuration.
    return text.strip()


def materialize(compose):
    import yaml
    original = compose.read_text()
    raw = yaml.safe_load(original)
    before = definition(compose)
    changes = False
    for name, service in raw['services'].items():
        values = before['services'].get(name, {}).get('environment', {})
        if not values or not service.get('environment'):
            continue
        # Shared-stack env files are managed by their middleware folders.
        existing = service.get('env_file', [])
        if any('/runtime/' in str(item) or str(item).startswith('runtime/') for item in (existing if isinstance(existing, list) else [existing])):
            continue
        target = compose.parent / ('.container-' + name + '.env')
        text = ''.join(key + '=' + json.dumps(str(value).replace('$', '$$'), ensure_ascii=False) + '\n' for key, value in sorted(values.items()) if value is not None)
        if any(value is None for value in values.values()):
            raise RuntimeError('Unresolved container environment variable')
        atomic(target, text)
        service.pop('environment', None)
        service['env_file'] = [str(target)]
        changes = True
    if not changes:
        return
    backup = ROOT / 'backups' / ('env-materialize-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    atomic(backup / 'compose.yml', original)
    stat = compose.stat()
    try:
        atomic(compose, yaml.safe_dump(raw, sort_keys=False), stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        after = definition(compose)
        if before != after:
            raise RuntimeError('Materialization changed rendered Compose configuration')
    except Exception:
        atomic(compose, original, stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        raise


def apply_env(compose, values, write=False, project=None):
    files = env_files(compose, project)
    if set(values) != set(files):
        raise RuntimeError('Vault must contain exactly the discovered .env files')
    changes = [(path, values[key]) for key, path in files.items() if env_text(path.read_text()) != values[key]]
    if not write or not changes:
        return len(changes)
    backup = ROOT / 'backups' / ('env-apply-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    originals = []
    for path, value in changes:
        if path.is_symlink() or not isinstance(value, str):
            raise RuntimeError('Invalid env file')
        stat = path.stat()
        old = path.read_text()
        atomic(backup / path.name, old)
        originals.append((path, old, stat))
    try:
        for path, value in changes:
            stat = path.stat()
            atomic(path, value + '\n', stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        definition(compose)
    except Exception:
        for path, old, stat in originals:
            atomic(path, old, stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        raise
    return len(changes)


def main():
    parser = argparse.ArgumentParser(description='Manage only middleware .env files in Infisical')
    parser.add_argument('action', choices=['materialize', 'push', 'check', 'apply'])
    parser.add_argument('--project')
    parser.add_argument('--restart', action='store_true')
    args = parser.parse_args()
    if args.restart and (args.action != 'apply' or not args.project):
        parser.error('--restart requires apply --project NAME')
    groups = projects()
    if args.project:
        groups = {args.project: groups[args.project]}
    vault = None if args.action == 'materialize' else Vault()
    report = []
    for folder, compose in sorted(groups.items()):
        if args.action == 'materialize':
            materialize(compose)
            print(folder + ': container environment preserved')
            continue
        files = env_files(compose, folder)
        if not files:
            continue
        if args.action == 'push':
            values = {key: env_text(path.read_text()) for key, path in files.items()}
            vault.write(folder, values)
            count = len(files)
            print(folder + ': verified ' + str(count) + ' env files')
        else:
            count = apply_env(compose, vault.read(folder), args.action == 'apply', folder)
            print(folder + ': ' + str(count) + ' changed env files')
            if args.restart:
                services = ['--no-deps', folder] if folder in ('flexprice', 'temporal') else []
                run('docker', 'compose', '-f', str(compose), 'up', '-d', '--force-recreate', *services, cwd=compose.parent)
        report.append({'project': folder, 'count': count})
    if vault:
        atomic(ROOT / 'middleware-config-report.json', json.dumps({'action': args.action, 'projects': report, 'time': time.time()}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Environment operation failed (' + type(error).__name__ + '); no secret values printed.', flush=True)
        raise SystemExit(1)
