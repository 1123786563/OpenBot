#!/usr/bin/env python3
"""Run three isolated Docker-in-Docker daemons; never initialize Swarm on the host daemon."""
import json
import importlib.util
from pathlib import Path
import sys
import tempfile
import subprocess
import time
import uuid


def main():
    prefix = 'openbot-overlay-check-' + uuid.uuid4().hex[:8]
    nodes = [prefix + '-' + str(index) for index in range(3)]
    started = []
    network_created = False

    def host(*args):
        return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT, timeout=120).strip()

    def engine(node, *args):
        return host('exec', node, 'docker', *args)

    try:
        host('network', 'create', prefix)
        network_created = True
        for node in nodes:
            host('run', '--pull=never', '--privileged', '--rm', '-d', '--name', node,
                 '--network', prefix, '--cpus', '0.5', '--memory', '512m',
                 '-e', 'DOCKER_TLS_CERTDIR=', 'docker:29-dind', '--storage-driver=vfs')
            started.append(node)
        addresses = {}
        for node in nodes:
            for _ in range(45):
                try:
                    engine(node, 'info')
                    break
                except subprocess.CalledProcessError:
                    time.sleep(1)
            else:
                raise RuntimeError(node + ' nested Docker did not start')
            addresses[node] = host('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', node)
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('platform_installer', root / 'platform.py')
        installer = importlib.util.module_from_spec(spec)
        sys.modules['platform_installer'] = installer
        spec.loader.exec_module(installer)
        spec = importlib.util.spec_from_file_location('cluster_under_test', root / 'cluster.py')
        cluster = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cluster)
        with tempfile.TemporaryDirectory(prefix='openbot-network-controller-') as control:
            platform = installer.Platform(control)
            platform.values = {'OPENBOT_DEPLOYMENT_ID': prefix}
            inventory = {'overlay_cidr': '10.240.0.0/16', 'nodes': [
                {'name': f'node{index}', 'ssh': 'root@' + node, 'private_ip': addresses[node],
                 'directory': '/opt/openbot', 'role': ['data', 'apps', 'compute'][index]}
                for index, node in enumerate(nodes)]}
            path = Path(control) / 'inventory.json'
            path.write_text(json.dumps(inventory))
            class Nested(cluster.Cluster):
                def ssh(self, node, arguments, *, input=None, capture=True, timeout=None):
                    target = node['ssh'].split('@', 1)[1]
                    result = subprocess.run(['docker', 'exec', '-i', target, *arguments],
                                            input=input, capture_output=True, text=True, timeout=60)
                    if result.returncode:
                        raise RuntimeError(result.stdout + result.stderr)
                    return result.stdout
            controller = Nested(platform, path)
            controller.shared = {name: prefix + '-' + suffix for name, suffix in cluster.SHARED.items()}
            controller.network()
            controller.network()
            overlay = controller.shared['openbot-central']
        for node in nodes:
            engine(node, 'pull', 'busybox:1.37')
        engine(nodes[0], 'run', '-d', '--name', 'db-probe', '--network', overlay, '--network-alias', 'shared-db',
               'busybox:1.37', 'httpd', '-f', '-p', '8080')
        for node in nodes[1:]:
            engine(node, 'run', '--rm', '--network', overlay, 'busybox:1.37', 'sh', '-ec',
                   'nslookup shared-db; nc -z -w 10 shared-db 8080')
        details = json.loads(engine(nodes[0], 'network', 'inspect', overlay))[0]
        assert details['Driver'] == 'overlay' and details['Attachable'] and 'encrypted' in details['Options']
        print('Production network initialization and rerun, three independent daemons, encrypted overlay DNS and TCP passed.')
    finally:
        for node in reversed(started):
            subprocess.run(['docker', 'rm', '-f', '-v', node], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if network_created:
            subprocess.run(['docker', 'network', 'rm', prefix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
