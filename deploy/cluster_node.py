#!/usr/bin/env python3
"""Node-local operations invoked by the inventory-driven cluster controller."""
import argparse
import base64
from collections import deque
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request


def save(path, document):
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(document, stream, indent=2)
    os.replace(temporary, path)


class Node:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.config_path = self.directory / 'compose.json'
        self.config = json.loads(self.config_path.read_text())
        self.meta = json.loads((self.directory / 'node.json').read_text())
        self.root = self.directory.parent
        self.base = ['docker', '--host', 'unix:///var/run/docker.sock', 'compose', '-p', self.config['name'], '-f', str(self.config_path)]

    def redact(self, text):
        environments = [service.get('environment', {}) for service in self.config['services'].values()]
        environments.append(self.meta['bootstrap'])
        for env in environments:
            for key, value in env.items():
                if value and len(str(value)) >= 8 and any(word in key for word in ['KEY', 'TOKEN', 'PASSWORD', 'SECRET', 'AUTH', 'DATABASE_URL']):
                    text = text.replace(str(value).replace('$$', '$'), '[redacted]')
        state = self.directory / 'runtime-state.json'
        if state.exists():
            token = json.loads(state.read_text()).get('SPIRE_JOIN_TOKEN')
            if token:
                text = text.replace(token, '[redacted]')
        return text

    def compose(self, *arguments, capture=False, input=None):
        # Environment is deliberately not used for interpolation: the generated JSON has resolved values.
        command = [*self.base, *arguments]
        if not capture and input is None:
            tail = deque(maxlen=50)
            with subprocess.Popen(command, cwd=self.root, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
                for line in process.stdout:
                    safe = self.redact(line)
                    tail.append(safe)
                    print(safe, end='', flush=True)
                status = process.wait()
            if status:
                raise RuntimeError(''.join(tail))
            return ''
        result = subprocess.run(command, cwd=self.root, input=input, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(self.redact(result.stderr[-3500:] + result.stdout[-1000:]))
        if not capture:
            print(self.redact(result.stdout + result.stderr), end='', flush=True)
        return result.stdout

    def apply_state(self):
        path = self.directory / 'runtime-state.json'
        if not path.exists() or self.meta['role'] != 'compute':
            return
        state = json.loads(path.read_text())
        token = state['SPIRE_JOIN_TOKEN']
        command = self.config['services']['spire-spire-agent']['command']
        command[command.index('-joinToken') + 1] = token
        self.config['services']['agents-supervisor']['environment']['SPIRE_AGENT_ID'] = \
            'spiffe://openbot.local/spire/agent/join_token/' + token
        save(self.config_path, self.config)

    def compute(self):
        self.compose('up', '-d', '--wait', '--wait-timeout', '180', 'spire-spire-server')
        path = self.directory / 'runtime-state.json'
        if not path.exists():
            output = self.compose('exec', '-T', 'spire-spire-server', '/opt/spire/bin/spire-server',
                                  'token', 'generate', '-ttl', '3600', capture=True)
            match = re.search(r'Token:\s*(\S+)', output)
            if not match:
                raise RuntimeError('SPIRE token 输出不符合预期，停止启动计算节点')
            save(path, {'SPIRE_JOIN_TOKEN': match[1]})
        self.apply_state()
        self.compose('up', '-d', '--wait', '--wait-timeout', '180', 'spire-spire-agent')
        names = [name for name in self.config['services'] if name.startswith('agents-')]
        self.compose('up', '-d', '--wait', '--wait-timeout', '300', *names)

    def build(self):
        if self.meta['role'] == 'apps':
            image = self.config['services']['openbot-server']['image']
            subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'build', '-f', 'deploy/openbot/Dockerfile', '--build-arg',
                            'TENANT_PACKAGE_DIR=../examples/personal', '-t', image, '.'], cwd=self.root, check=True)
        elif self.meta['role'] == 'compute':
            self.compose('build', *[name for name in self.config['services'] if name.startswith('agents-')])

    def request(self, path, auth, payload=None):
        env = self.config['services']['openobserve-openobserve']['environment']
        port = next(port['published'] for port in self.config['services']['openobserve-openobserve']['ports'])
        url = f'http://127.0.0.1:{port}/api/default' + path
        request = urllib.request.Request(url, headers={'Authorization': auth, 'Content-Type': 'application/json'},
                                         data=json.dumps(payload).encode() if payload is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, {}

    def observe(self):
        env = self.config['services']['openobserve-openobserve']['environment']
        encode = lambda user, password: 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()
        root = encode(env['ZO_ROOT_USER_EMAIL'], env['ZO_ROOT_USER_PASSWORD'])
        user = self.meta['bootstrap']['OPENOBSERVE_COLLECTOR_EMAIL']
        password = self.meta['bootstrap']['OPENOBSERVE_COLLECTOR_PASSWORD']
        end = time.monotonic() + 300
        while time.monotonic() < end:
            try:
                status, users = self.request('/users', root)
                if status == 200:
                    break
            except OSError:
                pass
            time.sleep(2)
        else:
            raise RuntimeError('OpenObserve 用户 API 未就绪')
        if not any(item.get('email') == user for item in users.get('data', [])):
            status, _ = self.request('/users', root, {'email': user, 'password': password, 'role': 'editor',
                                                     'first_name': 'OpenBot', 'last_name': 'Collector'})
            if status not in [200, 201]:
                raise RuntimeError(f'OpenObserve 账号初始化失败 HTTP {status}')
        status, _ = self.request('/streams', encode(user, password))
        if status != 200:
            raise RuntimeError(f'OpenObserve 采集账号认证失败 HTTP {status}，原账号保持不变')
        print('独立日志采集账号已验证。')

    def skill_reader(self):
        query = "SELECT to_regclass('public.skill_versions') IS NOT NULL"
        end = time.monotonic() + 180
        while time.monotonic() < end:
            result = self.compose('exec', '-T', 'infrastructure-postgres', 'psql', '-U', 'postgres', '-d', 'bifrost',
                                  '-XAt', '-c', query, capture=True)
            if result.strip() == 't':
                break
            time.sleep(2)
        else:
            raise RuntimeError('Bifrost 技能表尚未初始化')
        password = self.meta['bootstrap']['SKILL_READER_DB_PASSWORD']
        sql = "\\set reader_password '" + password + "'\n"
        sql += "SELECT format('CREATE ROLE openbot_skill_reader LOGIN PASSWORD %L', :'reader_password') "
        sql += "WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='openbot_skill_reader') \\gexec\nSET ROLE bifrost;\n"
        sql += (self.root / 'deploy/bifrost/skill-market-reader.sql').read_text()
        self.compose('exec', '-T', 'infrastructure-postgres', 'psql', '-U', 'postgres', '-d', 'bifrost',
                     '-X', '-v', 'ON_ERROR_STOP=1', input=sql, capture=True)
        print('技能目录只读账号已初始化。')

    def check(self):
        raw = self.compose('ps', '--all', '--format', 'json', capture=True)
        rows = json.loads(raw) if raw.strip().startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
        ready = {row['Service'] for row in rows if row['State'] == 'running' and row.get('Health') in ['', 'healthy', None]}
        missing = set(self.meta['expected']) - ready
        if missing:
            raise RuntimeError('未就绪：' + ', '.join(sorted(missing)))
        sentinel = next((name for name in self.config['services'] if name.startswith('infrastructure-sentinel-')), None)
        if sentinel:
            command = 'REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" redis-cli -p 26379 SENTINEL CKQUORUM openbot-redis'
            output = self.compose('exec', '-T', sentinel, 'sh', '-ec', command, capture=True)
            if not output.startswith('OK'):
                raise RuntimeError('Sentinel quorum 尚未就绪：' + output)
        tests = []
        for name, path in [('openbot-server', '/health'), ('opik-frontend', '/health'),
                           ('openobserve-openobserve', '/healthz'), ('infrastructure-rustfs', '/health')]:
            if name in self.config['services']:
                port = self.config['services'][name]['ports'][0]['published']
                tests.append(f'http://127.0.0.1:{port}{path}')
        for url in tests:
            with urllib.request.urlopen(url, timeout=10) as response:
                if response.status != 200:
                    raise RuntimeError(f'{url} 不健康')
        # Prove cross-host overlay DNS and a real TCP path; nothing is published on the database hosts.
        subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--network', self.meta['middleware'], 'busybox:1.37',
                        'sh', '-ec', 'nc -z -w 5 postgres 5432; nc -z -w 5 openobserve 5080'], check=True)
        print(f'OK {self.meta["node"]}：全部指定服务、Sentinel、HTTP 和跨机连通检查通过。')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('action', choices=['apply-state', 'build', 'compute', 'observe', 'skill-reader', 'check', 'compose'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    node = Node(args.directory)
    try:
        if args.action == 'compose':
            node.compose(*args.arguments)
        else:
            getattr(node, args.action.replace('-', '_'))()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('节点失败：' + node.redact(str(error)), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
