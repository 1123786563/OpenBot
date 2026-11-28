#!/usr/bin/env python3
"""Verify database initialization and vector operations in a disposable offline container."""
from pathlib import Path
import subprocess
import time
import uuid

CENTRAL = Path(__file__).resolve().parent


def main():
    name = 'openbot-postgres-check-' + uuid.uuid4().hex[:8]
    apps = ['openbot', 'bifrost', 'hindsight', 'infisical', 'openobserve', 'spire', 'flexprice', 'temporal']
    credentials = {app.upper() + '_DB_PASSWORD': 'a' * 64 for app in apps}
    started = False

    def execute(*args, input=None):
        return subprocess.check_output(['docker', 'exec', '-i', '-e', 'PGUSER=postgres', name, *args],
                                       text=True, input=input, stderr=subprocess.STDOUT, timeout=45).strip()

    try:
        subprocess.run(['docker', 'run', '--pull=never', '--rm', '-d', '--network', 'none',
                        '--name', name, '-e', 'POSTGRES_PASSWORD=fixture-only',
                        *[arg for key, value in credentials.items() for arg in ['-e', f'{key}={value}']],
                        'pgvector/pgvector:pg17'], check=True, stdout=subprocess.DEVNULL)
        started = True
        for _ in range(30):
            try:
                if execute('pg_isready', '-U', 'postgres'):
                    break
            except subprocess.CalledProcessError:
                time.sleep(1)
        script = (CENTRAL / 'postgres/init.sh').read_text()
        execute('sh', '-s', input=script)
        execute('sh', '-s', input=script)
        actual = execute('psql', '-XAt', '-d', 'postgres', '-c',
                         "SELECT datname FROM pg_database WHERE datname IN ('" +
                         "','".join([*apps, 'temporal_visibility']) + "') ORDER BY datname")
        assert actual.splitlines() == sorted([*apps, 'temporal_visibility'])
        privileged = execute('psql', '-XAt', '-d', 'postgres', '-c',
                             "SELECT rolname FROM pg_roles WHERE rolsuper AND rolname IN ('" +
                             "','".join(apps) + "')")
        assert privileged == ''
        for database in ['openbot', 'hindsight']:
            result = execute('psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', database,
                             '-c', "CREATE TEMP TABLE vector_check (v vector(3)); "
                             "INSERT INTO vector_check VALUES ('[1,2,3]'); "
                             "SELECT v <-> '[1,2,3]'::vector FROM vector_check;")
            assert result.splitlines()[-1] == '0'
        print('Repeat initialization, nine databases, non-superuser roles and real vector writes passed.')
    finally:
        if started:
            subprocess.run(['docker', 'stop', name], check=True, stdout=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    main()
