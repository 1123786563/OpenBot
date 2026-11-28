#!/usr/bin/env python3
"""Restore a backup into temporary databases, verify table counts, then remove them."""
import fcntl
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    with open('/run/persaas-restorecheck.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            names = ['openbot', 'casdoor', 'flexprice', 'temporal', 'temporal_visibility', 'infisical', 'bifrost']
            with tarfile.open('/opt/persaas/backups/latest.tar.gz') as archive:
                for filename in [name + '.dump' for name in names] + ['opik.sql']:
                    member = archive.getmember('./' + filename)
                    if not member.isfile():
                        raise RuntimeError('Expected a regular database dump')
                    with archive.extractfile(member) as source, (work / filename).open('wb') as target:
                        shutil.copyfileobj(source, target)
            for name in names:
                container = '1Panel-pgvector-T1Hu'
                database = 'persaas_restorecheck_' + name
                run(['docker', 'cp', str(work / (name + '.dump')), container + ':/tmp/persaas-restore.dump'])
                try:
                    run(['docker', 'exec', container, 'sh', '-ec', 'createdb -U "$POSTGRES_USER" ' + database])
                    try:
                        run(['docker', 'exec', container, 'sh', '-ec', 'pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d ' + database + ' /tmp/persaas-restore.dump'])
                        run(['docker', 'exec', container, 'sh', '-ec', 'psql -U "$POSTGRES_USER" -d ' + database + ' -Atc "select count(*) from information_schema.tables where table_schema = current_schema()"'])
                    finally:
                        run(['docker', 'exec', container, 'sh', '-ec', 'dropdb -U "$POSTGRES_USER" ' + database])
                finally:
                    run(['docker', 'exec', container, 'rm', '-f', '/tmp/persaas-restore.dump'])
                print(name + ': backup restore passed', flush=True)
            mysql = ['docker', 'exec', '-i', 'persaas-mysql', 'sh', '-ec', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot']
            run(mysql, input=b'CREATE DATABASE persaas_restorecheck_opik;')
            try:
                with (work / 'opik.sql').open('rb') as source:
                    run(['docker', 'exec', '-i', 'persaas-mysql', 'sh', '-ec', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot persaas_restorecheck_opik'], stdin=source)
                run(mysql, input=b'SELECT count(*) FROM information_schema.tables WHERE table_schema="persaas_restorecheck_opik";')
            finally:
                run(mysql, input=b'DROP DATABASE persaas_restorecheck_opik;')
            print('opik: backup restore passed', flush=True)


if __name__ == '__main__':
    main()
