#!/usr/bin/env python3
"""Validate RustFS account bootstrap and bucket-limited S3 access in a temporary project."""
import json
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

ASSETS = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory(prefix='openbot-rustfs-check-') as directory:
        directory = Path(directory)
        fixture = directory / 'fixture.env'
        data = re.sub(r'^([A-Z][A-Z0-9_]*)=$', lambda m: m[1] + '=' + 'a' * 64,
                      (ASSETS / '.env.example').read_text(), flags=re.M)
        data += '\nRUSTFS_ACCESS_KEY=ROOTFIXTURE1234567890\nOPIK_S3_ACCESS_KEY=OPIKFIXTURE1234567890\n'
        fixture.write_text(data)
        config = json.loads(subprocess.check_output(['docker', 'compose', '--env-file', str(fixture),
                            '-f', str(ASSETS / 'docker-compose.yml'), '--profile', 'setup',
                            'config', '--format', 'json'], text=True))
        names = ['rustfs', 'rustfs-volume-init', 'rustfs-init', 'rustfs-account-init']
        services = {name: config['services'][name] for name in names}
        for service in services.values():
            service.pop('profiles', None)
            service['pull_policy'] = 'never'
            service.pop('ports', None)
        services['rustfs']['networks'] = ['middleware']
        path = directory / 'compose.json'
        path.write_text(json.dumps({'services': services, 'volumes': {'rustfs-data': {}},
                                    'networks': {'middleware': {}}}))
        project = 'openbot-rustfs-check-' + uuid.uuid4().hex[:8]
        base = ['docker', 'compose', '-p', project, '-f', str(path)]

        def run(*args, success=True):
            result = subprocess.run([*base, *args], capture_output=True, text=True, timeout=120)
            if success and result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            return result

        try:
            run('up', '-d', '--wait', '--wait-timeout', '90', 'rustfs')
            for _ in range(2):
                run('run', '--rm', 'rustfs-init')
                run('run', '--rm', 'rustfs-account-init')
            arguments = ['run', '--rm', '--no-deps', '-e', 'AWS_ACCESS_KEY_ID=OPIKFIXTURE1234567890',
                         '-e', 'AWS_SECRET_ACCESS_KEY=' + 'a' * 64,
                         '--entrypoint', 'sh', 'rustfs-init', '-ec']
            run(*arguments, 'aws --endpoint-url http://rustfs:19000 s3api put-object '
                           '--bucket opik --key installer-smoke --body /init.sh >/dev/null; '
                           'aws --endpoint-url http://rustfs:19000 s3api get-object '
                           '--bucket opik --key installer-smoke /tmp/result >/dev/null; '
                           'cmp /init.sh /tmp/result')
            run('run', '--rm', '--no-deps', '--entrypoint', 'sh', 'rustfs-init', '-ec',
                'aws --endpoint-url http://rustfs:19000 s3api create-bucket --bucket private >/dev/null; '
                'aws --endpoint-url http://rustfs:19000 s3api put-object --bucket private --key secret --body /init.sh >/dev/null')
            denied = run(*arguments, 'aws --endpoint-url http://rustfs:19000 s3api get-object '
                         '--bucket private --key secret /tmp/forbidden', success=False)
            assert denied.returncode != 0, 'application key unexpectedly read another bucket'
            print('RustFS repeated bootstrap, application upload/download and bucket-limited access passed.')
        finally:
            subprocess.run([*base, 'down', '-v', '--remove-orphans'], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


if __name__ == '__main__':
    main()
