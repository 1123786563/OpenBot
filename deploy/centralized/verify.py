#!/usr/bin/env python3
"""Render centralized Compose with isolated fixtures; never start or alter services."""
import json
import contextlib
import importlib.util
import io
import shutil
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CENTRAL = ROOT / 'deploy/centralized'
COMPONENTS = ['infrastructure', 'infisical', 'opik', 'hindsight', 'bifrost',
              'openobserve', 'spire', 'agents', 'flexprice', 'openbot']


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def verify():
    with tempfile.TemporaryDirectory(prefix='openbot-central-check-') as temporary:
        temporary = Path(temporary)
        template = (CENTRAL / '.env.example').read_text()
        fixture = re.sub(r'^([A-Z][A-Z0-9_]*)=$', lambda m: m[1] + '=' + 'a' * 64,
                         template, flags=re.M)
        fixture += ('\nOPIK_S3_ENDPOINT=https://s3.example.test\n'
                    'OPENBOT_IMAGE=openbot:fixture\nFLEXPRICE_IMAGE=flexprice:fixture\n'
                    'OPENOBSERVE_ROOT_EMAIL=admin@example.test\n'
                    f'OPENBOT_AGENT_SOURCE={ROOT}\n'
                    'INFISICAL_ENCRYPTION_KEY=' + 'b' * 32 + '\n')
        env_file = temporary / 'fixture.env'
        env_file.write_text(fixture)
        app_env = temporary / 'app.env'
        app_env.write_text('FLEXPRICE_AUTH_SECRET=fixture-only\n')
        environment = {key: value for key, value in os.environ.items()
                       if key in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']}
        environment.update(CENTRAL_ENV_FILE=str(env_file),
                           FLEXPRICE_ENV_FILE=str(app_env),
                           OPENBOT_SERVER_ENV_FILE=str(app_env),
                           OPENBOT_AGENT_ENV_FILE=str(app_env),
                           OPENBOT_WORKER_ENV_FILE=str(app_env),
                           OPENBOT_RUNTIME_LOG_DIR=str(temporary))
        rendered = {}
        for component in COMPONENTS:
            result = subprocess.run(
                ['bash', str(ROOT / 'deploy/compose.sh'), '--central', component,
                 '--profile', '*', 'config', '--format', 'json'], env=environment, capture_output=True, text=True)
            check(result.returncode == 0, f'{component}: {result.stderr}')
            config = json.loads(result.stdout)
            rendered[component] = config
            check(config['name'].startswith('openbot-central-'), f'{component}: project isolation')
            if component == 'agents':
                for service in config['services'].values():
                    check(Path(service['build']['context']).exists(), 'Agent build context missing')
            for name, service in config['services'].items():
                for port in service.get('ports', []):
                    check(port.get('host_ip') == '127.0.0.1', f'{component}/{name}: non-loopback port')
                if component != 'infrastructure':
                    check(not any(word in service['image'] for word in
                                  ['postgres:', 'pgvector/', 'mysql:', 'redis:', 'minio:']),
                          f'{component}/{name}: bundled database or MinIO')
                for mount in service.get('volumes', []):
                    if (mount['type'] == 'bind' and mount.get('read_only')
                            and mount['source'] not in ['/var/lib/docker/containers', '/var/run/docker.sock']):
                        check(Path(mount['source']).exists(), f'{component}/{name}: missing {mount["source"]}')
            print(f'{component}: Compose rendered')
        infra = rendered['infrastructure']['services']
        check('minio' not in infra and 'lago' not in infra, 'legacy services included')
        check(len([s for s in infra if s.startswith('sentinel-')]) == 3, 'three Sentinels required')
        check(len([s for s in infra if s.startswith('redis-')]) == 3, 'three Redis data nodes required')
        check(infra['clickhouse']['image'] != infra['flexprice-clickhouse']['image'],
              'unverified ClickHouse consolidation')
        for service in ['postgres', 'mysql', 'clickhouse', 'redis-primary', 'kafka', 'temporal']:
            check(not infra[service].get('ports'), f'{service}: database port published')
        infisical = rendered['infisical']['services']['backend']['environment']
        check('REDIS_URL' not in infisical, 'Infisical standalone URL overrides Sentinel')
        check(infisical['REDIS_SENTINEL_MASTER_NAME'] == 'openbot-redis', 'Infisical master mismatch')
        opik = rendered['opik']['services']
        for name in ['backend', 'python-backend']:
            env = opik[name]['environment']
            check(env['REDIS_URL'].endswith('/2'), f'{name}: wrong Redis DB')
            check(env['OPIK_REDIS_SENTINEL_ENABLED'] == 'true', f'{name}: Sentinel disabled')
            check(env['OPIK_REDIS_SENTINEL_MASTER_NAME'] == 'openbot-redis', f'{name}: wrong master')
        check(opik['backend']['environment']['S3_URL'] == 'https://s3.example.test', 'RustFS endpoint')
        for service in rendered['flexprice']['services'].values():
            env = service['environment']
            check(env['FLEXPRICE_REDIS_DB'] == '3', 'Flexprice wrong Redis DB')
            check(env['FLEXPRICE_REDIS_SENTINEL_MASTER_NAME'] == 'openbot-redis', 'Flexprice master mismatch')
        for script in CENTRAL.rglob('*.sh'):
            subprocess.run(['sh', '-n', str(script)], check=True)
        # Verify the new mode does not change legacy/local routing, without reading private env files.
        fake = temporary / 'docker'
        fake.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
        fake.chmod(0o700)
        mock_env = {**environment, 'PATH': str(temporary) + os.pathsep + environment['PATH']}
        for args, expected in [(['bifrost', 'config'], '/deploy/bifrost/.env'),
                               (['--local', 'opik', 'config'], '/deploy/.local/opik.env')]:
            result = subprocess.run(['bash', str(ROOT / 'deploy/compose.sh'), *args],
                                    env=mock_env, capture_output=True, text=True, check=True)
            check(any(arg.endswith(expected) for arg in json.loads(result.stdout)), 'legacy route changed')
    # Render the actual novice-generated settings, not just a hand-maintained fixture.
    spec = importlib.util.spec_from_file_location('platform_installer', ROOT / 'deploy/platform.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='openbot-first-install-check-') as directory:
        platform = module.Platform(directory)
        with contextlib.redirect_stdout(io.StringIO()):
            platform.initialize(interactive=False)
        for component in module.COMPONENTS:
            rendered = json.loads(platform.compose(component, 'config', '--format', 'json', capture=True))
            if component == 'agents':
                computer = rendered['services']['agent-computer']['environment']
                check(computer['OPENBOT_EDITION'] == 'personal' and computer['COMPUTER_PERSON_ID'] == 'personal',
                      'Personal browser ownership not configured')
                check(computer['COMPUTER_LOOPBACK_RELAYS'] == '18001=openbot-api:3001',
                      'Recorder cannot reach the loopback OpenBot origin')
            if component == 'openbot':
                check(rendered['services']['server']['environment']['DATABASE_URL'].startswith('postgresql://openbot:'),
                      'API received database administrator credentials')
                check(rendered['services']['migrate']['environment']['DATABASE_URL'].startswith('postgresql://postgres:'),
                      'initial migrations lack extension-owner privileges')
                if shutil.which('bun'):
                    environment = rendered['services']['server']['environment']
                    environment.update(module.read_env(platform.directory / '.env.server'))
                    environment['NODE_ENV'] = 'production'
                    environment['OPENBOT_IN_CONTAINER'] = 'true'
                    result = subprocess.run(
                        ['bun', '--no-env-file', '-e',
                         "import { loadConfig } from './server/src/config.ts'; "
                         "const config = loadConfig(JSON.parse(await Bun.stdin.text())); "
                         "if (config.computer?.provider !== 'shared') process.exit(1);"],
                        cwd=ROOT, input=json.dumps(environment), text=True, capture_output=True)
                    check(result.returncode == 0, 'Generated API configuration rejected: ' + result.stderr)

    print('Actual first-install settings and ordinary API/migration account separation passed.')
    print('Connection contracts, bind sources, shell syntax and legacy routing passed.')


if __name__ == '__main__':
    verify()
