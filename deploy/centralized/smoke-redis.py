#!/usr/bin/env python3
"""Exercise Sentinel and DB separation in disposable containers with no published ports."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

CENTRAL = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory(prefix='openbot-sentinel-smoke-') as temporary:
        temporary = Path(temporary)
        env = temporary / 'fixture.env'
        env.write_text(re.sub(r'^([A-Z][A-Z0-9_]*)=$', lambda m: m[1] + '=' + 'a' * 64,
                              (CENTRAL / '.env.example').read_text(), flags=re.M))
        rendered = subprocess.check_output(['docker', 'compose', '--env-file', str(env),
                                           '-f', str(CENTRAL / 'docker-compose.yml'),
                                           'config', '--format', 'json'], text=True)
        config = json.loads(rendered)
        names = [name for name in config['services'] if name.startswith(('redis-', 'sentinel-'))]
        services = {name: config['services'][name] for name in names}
        volumes = {}
        for service in services.values():
            service['pull_policy'] = 'never'
            for mount in service['volumes']:
                if mount['type'] == 'volume':
                    volumes[mount['source']] = {}
        # Remove rendered explicit names, so every network/volume belongs to the disposable project.
        path = temporary / 'compose.json'
        path.write_text(json.dumps({'services': services, 'volumes': volumes, 'networks': {'middleware': {}}}))
        project = 'openbot-sentinel-check-' + uuid.uuid4().hex[:8]
        base = ['docker', 'compose', '-p', project, '-f', str(path)]

        def compose(*args, input=None):
            return subprocess.check_output([*base, *args], text=True, input=input,
                                           stderr=subprocess.STDOUT, timeout=60).strip()

        def redis(service, *args, sentinel=False):
            password = 'a' * 64
            return compose('exec', '-T', '-e', 'REDISCLI_AUTH=' + password, service,
                           'redis-cli', '--raw', '-p', '26379' if sentinel else '6379', *args)

        def until(predicate, message, seconds=45):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                try:
                    value = predicate()
                    if value:
                        return value
                except subprocess.CalledProcessError:
                    pass
                time.sleep(1)
            raise AssertionError(message)

        try:
            compose('up', '-d', '--wait', '--wait-timeout', '50')
            until(lambda: '2' in redis('redis-primary', 'INFO', 'replication').split('connected_slaves:')[-1][:1],
                  'replicas not synchronized')
            assert redis('redis-primary', '-n', '2', 'SET', 'central-smoke', 'opik') == 'OK'
            assert redis('redis-primary', '-n', '3', 'SET', 'central-smoke', 'flexprice') == 'OK'
            for replica in ['redis-replica-1', 'redis-replica-2']:
                until(lambda: redis(replica, '-n', '2', 'GET', 'central-smoke') == 'opik', 'replica DB 2')
                until(lambda: redis(replica, '-n', '3', 'GET', 'central-smoke') == 'flexprice', 'replica DB 3')
            print('Replica synchronization and DB 2/3 separation passed.', flush=True)
            # Allow Sentinel peer discovery before removing the primary.
            until(lambda: 'num-other-sentinels\n2' in redis('sentinel-1', 'SENTINEL', 'master',
                                                          'openbot-redis', sentinel=True), 'Sentinel peer discovery')
            addresses = {}
            for name in ['redis-primary', 'redis-replica-1', 'redis-replica-2']:
                container = compose('ps', '-q', name)
                address = subprocess.check_output(
                    ['docker', 'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
                    text=True).strip()
                addresses[address] = name
                addresses[name] = name
            until(lambda: all('num-slaves\n2' in redis(node, 'SENTINEL', 'master', 'openbot-redis', sentinel=True)
                              for node in ['sentinel-1', 'sentinel-2', 'sentinel-3']),
                  'Sentinels did not discover both replicas')
            compose('stop', 'redis-primary')

            def promoted():
                address = redis('sentinel-1', 'SENTINEL', 'get-master-addr-by-name',
                                'openbot-redis', sentinel=True).splitlines()[0]
                name = addresses.get(address)
                if name not in ['redis-replica-1', 'redis-replica-2']:
                    return False
                return name if redis(name, 'ROLE').splitlines()[0] == 'master' else False

            master = until(promoted, 'Sentinel did not promote a reachable replica')
            assert redis(master, '-n', '2', 'GET', 'central-smoke') == 'opik'
            assert redis(master, '-n', '3', 'GET', 'central-smoke') == 'flexprice'
            assert redis(master, '-n', '2', 'SET', 'after-failover', 'preserved') == 'OK'
            compose('start', 'redis-primary')
            until(lambda: redis('redis-primary', 'ROLE').splitlines()[0] == 'slave', 'old primary did not rejoin')
            until(lambda: redis('redis-primary', '-n', '2', 'GET', 'after-failover') == 'preserved', 'rejoin replication')
            # Inspect persisted config after Sentinel's reconfiguration, then restart the promoted master.
            compose('restart', master)
            until(lambda: redis(master, 'ROLE').splitlines()[0] == 'master', 'promoted role lost on restart')
            assert redis(master, '-n', '2', 'GET', 'after-failover') == 'preserved'
            print('Failover, old-primary rejoin, AOF persistence and promoted-master restart passed.', flush=True)
        except Exception:
            print(compose('logs', '--tail', '60', 'sentinel-1', 'sentinel-2', 'sentinel-3'), flush=True)
            for node in ['sentinel-1', 'sentinel-2', 'sentinel-3']:
                try:
                    print(node, redis(node, 'SENTINEL', 'master', 'openbot-redis', sentinel=True), flush=True)
                except Exception:
                    pass
            raise
        finally:
            subprocess.run([*base, 'down', '-v', '--remove-orphans'], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


if __name__ == '__main__':
    main()
