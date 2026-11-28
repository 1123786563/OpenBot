"""Compile the shared platform configuration into role-scoped multi-host Compose projects."""
import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import tempfile
import time

from platform_installer import SetupError, ROOT, basic

SHARED = {'openbot-central': 'middleware', 'openbot-central-agents': 'agents',
          'openbot-hindsight': 'hindsight', 'openbot-opik': 'opik',
          'openbot-observability': 'observability', 'openbot-spire': 'identity'}
ROLES = {'data', 'apps', 'compute', 'observer'}


def load_inventory(path):
    try:
        document = json.loads(Path(path).read_text())
        nodes = document['nodes']
        pool = ipaddress.ip_network(document['overlay_cidr'])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SetupError(f'服务器清单无效：{error}') from None
    if not isinstance(nodes, list) or len(nodes) < 3:
        raise SetupError('多机方案至少需要三台服务器，每台具有独立私网地址')
    if pool.version != 4 or pool.prefixlen > 20 or not pool.is_private:
        raise SetupError('overlay_cidr 需要一个至少 /20 的私有 IPv4 网段')
    names, addresses, targets = set(), set(), set()
    for node in nodes:
        try:
            name, target, directory, role = (node[key] for key in ['name', 'ssh', 'directory', 'role'])
            address = ipaddress.ip_address(node['private_ip'])
            valid = (re.fullmatch(r'[a-z][a-z0-9-]{0,24}', name)
                     and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*', target)
                     and re.fullmatch(r'/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+', directory)
                     and directory not in ['/', '/home', '/root', '/opt', '/tmp']
                     and '..' not in Path(directory).parts and role in ROLES
                     and address.version == 4 and address.is_private and not address.is_loopback
                     and address not in pool)
        except (KeyError, ValueError, TypeError):
            valid = False
        if not valid:
            raise SetupError('节点需填写合法名称、user@host、私网 IPv4、独立绝对目录和角色')
        if name in names or str(address) in addresses or target in targets:
            raise SetupError('节点名、SSH 目标和私网 IP 不能重复')
        names.add(name)
        addresses.add(str(address))
        targets.add(target)
    if {node['role'] for node in nodes[:3]} != {'data', 'apps', 'compute'}:
        raise SetupError('清单前三台需要分别是 data、apps、compute，后续节点使用 observer')
    for role in ['data', 'apps', 'compute']:
        if sum(node['role'] == role for node in nodes) != 1:
            raise SetupError(f'当前拓扑需要且只允许一台 {role} 节点，额外节点使用 observer')
    return document


def private_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')
    os.replace(temporary, path)


def owner(component, service, inventory):
    by_role = {node['role']: node['name'] for node in inventory['nodes'] if node['role'] != 'observer'}
    if component == 'infrastructure':
        if service.startswith('sentinel-'):
            index = int(service.rsplit('-', 1)[1]) - 1
            return inventory['nodes'][index]['name']
        if service.startswith('redis-replica-'):
            return inventory['nodes'][int(service.rsplit('-', 1)[1])]['name']
        return by_role['data']
    return by_role['compute' if component in ['spire', 'agents'] else 'apps']


def compile_nodes(platform, inventory, documents):
    """Pure transformation. No SSH, no containers, and no copying of whole-cluster env files."""
    deployment = platform.values['OPENBOT_DEPLOYMENT_ID']
    shared = {name: f'{deployment}-{suffix}' for name, suffix in SHARED.items()}
    nodes = {node['name']: {'name': f'{deployment}-{node["name"]}', 'services': {}, 'networks': {}, 'volumes': {}}
             for node in inventory['nodes']}
    metadata = {node['name']: {'deployment': deployment, 'role': node['role'], 'expected': [],
                              'middleware': shared['openbot-central'], 'node': node['name'], 'bootstrap': {}}
                for node in inventory['nodes']}
    component_owners = {}
    for component, document in documents.items():
        for service in document['services']:
            # Flexprice remains outside the default cluster installation.
            if service in ['kafka', 'temporal', 'flexprice-clickhouse']:
                continue
            component_owners[(component, service)] = owner(component, service, inventory)
    seed_nodes = inventory['nodes'][:3]
    primary = next(node for node in inventory['nodes'] if node['role'] == 'data')
    replicas = [node for node in seed_nodes if node['name'] != primary['name']]
    component_owners[('infrastructure', 'redis-primary')] = primary['name']
    for index, node in enumerate(replicas, 1):
        component_owners[('infrastructure', f'redis-replica-{index}')] = node['name']

    def volume_name(actual):
        return deployment + '-' + actual.removeprefix('openbot-central-')

    for (component, original), node_name in component_owners.items():
        node = next(node for node in inventory['nodes'] if node['name'] == node_name)
        result = nodes[node_name]
        source = documents[component]
        service = copy.deepcopy(source['services'][original])
        key = component + '-' + original
        service.pop('container_name', None)
        service.pop('env_file', None)
        service['labels'] = {**service.get('labels', {}), 'openbot.deployment': deployment,
                             'openbot.component': component, 'openbot.node': node_name}
        dependencies = service.get('depends_on', {})
        service['depends_on'] = {component + '-' + target: value for target, value in dependencies.items()
                                 if component_owners.get((component, target)) == node_name}
        if not service['depends_on']:
            service.pop('depends_on', None)
        converted_networks = {}
        for network, settings in service.get('networks', {}).items():
            declaration = source['networks'][network]
            actual = declaration.get('name', network)
            network_key = shared.get(actual, component + '-' + network)
            if actual in shared:
                result['networks'][network_key] = {'external': True, 'name': network_key}
            else:
                result['networks'][network_key] = {'driver': 'bridge'}
            aliases = list((settings or {}).get('aliases', []))
            # Generic backend aliases belong only on the application's private bridge.
            if actual not in shared:
                aliases.append(original)
            elif (component == 'infrastructure' or original in ['bifrost', 'hindsight', 'openobserve', 'spire-server']):
                aliases.append(original)
            if component == 'openbot' and original == 'server' and actual == 'openbot-central-agents':
                aliases.append('openbot-api')
            converted_networks[network_key] = {'aliases': sorted(set(aliases))} if aliases else {}
        if converted_networks:
            service['networks'] = converted_networks
        if component == 'infisical':
            local = 'infisical-private'
            result['networks'][local] = {'driver': 'bridge'}
            service['networks'][local] = {'aliases': ['backend']} if original == 'backend' else {}
            if original == 'bootstrap-admin':
                service['networks'] = {local: {}}
        for mount in service.get('volumes', []):
            if mount['type'] == 'bind':
                if mount['target'] == '/runtime-logs':
                    mount['source'] = node['directory'] + '/.openbot/runtime-logs'
                elif mount['source'].startswith(str(ROOT) + '/'):
                    mount['source'] = node['directory'] + mount['source'][len(str(ROOT)):]
                elif not mount['source'].startswith(('/var/lib/docker/', '/var/run/')):
                    raise SetupError(f'不能向远程节点复制仓库外的挂载 {mount["source"]}')
            elif mount['type'] == 'volume':
                declaration = source['volumes'][mount['source']]
                actual = declaration.get('name', mount['source'])
                volume_key = 'volume-' + hashlib.sha256(actual.encode()).hexdigest()[:12]
                mount['source'] = volume_key
                # Role compilation includes the identity server and supervisor on the same compute host.
                result['volumes'][volume_key] = {'name': volume_name(actual)}
        if service.get('build'):
            service['build']['context'] = node['directory']
        env = service.setdefault('environment', {})
        if component == 'agents' and original == 'supervisor':
            env['COMPUTER_NETWORK'] = shared['openbot-central-agents']
            env['COMPUTER_NAMESPACE'] = deployment
            env['SPIRE_AGENT_SOCKET_VOLUME'] = volume_name('openbot-central-spire-agent-socket')
        if original == 'otel-collector':
            env['OPENOBSERVE_RUNTIME_AUTHORIZATION'] = basic(platform.values['OPENOBSERVE_COLLECTOR_EMAIL'], platform.values['OPENOBSERVE_COLLECTOR_PASSWORD'])
            env['OPENOBSERVE_AUDIT_AUTHORIZATION'] = env['OPENOBSERVE_RUNTIME_AUTHORIZATION']
            # All node collectors reach the same O2 service through the overlay.
            env['OPENOBSERVE_OTLP_LOGS_URL'] = 'http://openobserve:5080/api/default/v1/logs'
            service['networks'][shared['openbot-central']] = {}
            result['networks'][shared['openbot-central']] = {'external': True, 'name': shared['openbot-central']}
            service['networks'][shared['openbot-observability']] = {'aliases': ['otel-collector']}
        result['services'][key] = service
        if service.get('restart') != 'no' and not service.get('profiles'):
            metadata[node_name]['expected'].append(key)

    # A local Collector per host, without distributing database or administrator passwords.
    app_node = next(node for node in inventory['nodes'] if node['role'] == 'apps')
    template = nodes[app_node['name']]['services']['openobserve-otel-collector']
    for node in inventory['nodes']:
        result = nodes[node['name']]
        if node['name'] != app_node['name']:
            collector = copy.deepcopy(template)
            collector.pop('depends_on', None)
            collector['networks'] = {shared['openbot-central']: {}, shared['openbot-observability']: {}}
            collector['labels']['openbot.node'] = node['name']
            for mount in collector['volumes']:
                if mount['type'] == 'bind' and mount['source'].startswith(app_node['directory'] + '/'):
                    mount['source'] = node['directory'] + mount['source'][len(app_node['directory']):]
            result['services']['openobserve-otel-collector'] = collector
            metadata[node['name']]['expected'].append('openobserve-otel-collector')
            for network in collector['networks']:
                result['networks'][network] = {'external': True, 'name': network}
    metadata[app_node['name']]['bootstrap'].update(
        OPENOBSERVE_COLLECTOR_EMAIL=platform.values['OPENOBSERVE_COLLECTOR_EMAIL'],
        OPENOBSERVE_COLLECTOR_PASSWORD=platform.values['OPENOBSERVE_COLLECTOR_PASSWORD'])
    metadata[primary['name']]['bootstrap']['SKILL_READER_DB_PASSWORD'] = platform.values['SKILL_READER_DB_PASSWORD']
    # External overlays can be referenced by short names from source declarations only after normalization.
    return nodes, metadata, shared


class Cluster:
    def __init__(self, platform, inventory_path):
        self.platform = platform
        self.path = Path(inventory_path)
        self.inventory = load_inventory(self.path)
        self.nodes = self.inventory['nodes']
        self.directory = platform.directory / 'cluster'
        self.documents = None
        self.metadata = None
        self.shared = None
        state = self.directory / 'swarm.json'
        if state.exists():
            saved = json.loads(state.read_text())
            if saved.get('inventory') != self.inventory or saved.get('deployment') != platform.values.get('OPENBOT_DEPLOYMENT_ID'):
                raise SetupError('已部署的拓扑或部署标识发生变化。需要显式迁移，不能直接移动数据角色或重新生成密钥。')

    def role(self, role):
        return next(node for node in self.nodes if node['role'] == role)

    def ssh(self, node, arguments, *, input=None, capture=True, timeout=None):
        if arguments and arguments[0] == 'docker':
            arguments = ['docker', '--host', 'unix:///var/run/docker.sock', *arguments[1:]]
        command = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'ConnectTimeout=10', node['ssh'], shlex.join(arguments)]
        return self.platform.run(command, input=input, capture=capture, timeout=timeout)

    def node(self, node, action, *args, **kwargs):
        return self.ssh(node, ['python3', node['directory'] + '/deploy/cluster_node.py',
                              '--directory', node['directory'] + '/.openbot', action, *args], **kwargs)

    def plan(self, quiet=False):
        self.platform.require_config()
        self.platform.validate_inputs(self.platform.values)
        documents = {component: json.loads(self.platform.compose(component, '--profile', 'setup', 'config', '--format', 'json', capture=True))
                     for component in ['infrastructure', 'spire', 'agents', 'bifrost', 'infisical', 'hindsight', 'opik', 'openobserve', 'openbot']}
        self.documents, self.metadata, self.shared = compile_nodes(self.platform, self.inventory, documents)
        for node in self.nodes:
            target = self.directory / node['name']
            private_json(target / 'compose.json', self.documents[node['name']])
            private_json(target / 'node.json', self.metadata[node['name']])
            if not quiet:
                print(f'{node["name"]:12} {node["role"]:8} {node["private_ip"]:16} '
                      f'{len(self.metadata[node["name"]]["expected"])} 个常驻服务')
        if not quiet:
            print('计划已生成。未连接服务器，也未变更服务。生成文件包含该角色所需凭据，请保留在私有目录。')

    def doctor(self):
        self.plan(quiet=True)
        architectures = set()
        for node in self.nodes:
            info = json.loads(self.ssh(node, ['docker', 'info', '--format', '{{json .}}'], timeout=30))
            if info.get('OSType') != 'linux':
                raise SetupError(f'{node["name"]} 不是 Linux Docker Engine')
            if any('rootless' in option for option in info.get('SecurityOptions', [])):
                raise SetupError(f'{node["name"]} 使用 rootless Docker，当前 overlay 部署需要 rootful Engine')
            architectures.add(info.get('Architecture'))
            version = self.ssh(node, ['docker', 'compose', 'version', '--short'], timeout=20)
            if tuple(map(int, re.findall(r'\d+', version)[:3])) < (2, 24, 4):
                raise SetupError(f'{node["name"]} Compose 版本低于 2.24.4')
            code = 'import os,sys; assert sys.version_info >= (3,10); assert os.path.exists("/var/run/docker.sock")'
            self.ssh(node, ['python3', '-c', code], timeout=20)
            interfaces = json.loads(self.ssh(node, ['ip', '-j', 'address', 'show'], timeout=20))
            addresses = {address.get('local') for interface in interfaces for address in interface.get('addr_info', [])}
            if node['private_ip'] not in addresses:
                raise SetupError(f'{node["name"]} 上没有清单填写的私网 IP {node["private_ip"]}')
            routes = json.loads(self.ssh(node, ['ip', '-j', 'route', 'show'], timeout=20))
            pool = ipaddress.ip_network(self.inventory['overlay_cidr'])
            for route in routes:
                destination = route.get('dst', 'default')
                if destination != 'default' and ipaddress.ip_network(destination, strict=False).overlaps(pool):
                    # Existing managed overlay routes are expected after first installation.
                    if not ((self.directory / 'swarm.json').exists() and destination in {str(subnet) for subnet in pool.subnets(new_prefix=24)}):
                        raise SetupError(f'{node["name"]} 路由 {destination} 与 overlay_cidr 冲突')
            print(f'OK {node["name"]}：SSH、Docker、Compose、Python 与路由检查通过')
        if len(architectures) != 1:
            raise SetupError('当前安装要求所有服务器使用相同 CPU 架构')

    def network(self):
        manager = self.nodes[0]
        deployment = self.platform.values['OPENBOT_DEPLOYMENT_ID']
        state_path = self.directory / 'swarm.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        for index, node in enumerate(self.nodes):
            swarm = json.loads(self.ssh(node, ['docker', 'info', '--format', '{{json .Swarm}}']))
            if swarm['LocalNodeState'] == 'active' and not state:
                raise SetupError(f'{node["name"]} 已属于其他 Swarm，停止操作。不会强制离开或接管。')
            if swarm['LocalNodeState'] == 'inactive':
                if index == 0:
                    self.ssh(node, ['docker', 'swarm', 'init', '--advertise-addr', node['private_ip'],
                                    '--data-path-addr', node['private_ip']], capture=False)
                    initialized = json.loads(self.ssh(node, ['docker', 'info', '--format', '{{json .Swarm}}']))
                    cluster_id = initialized['Cluster']['ID']
                    state = {'cluster_id': cluster_id, 'deployment': deployment, 'inventory': self.inventory}
                    private_json(state_path, state)
                else:
                    token = self.ssh(manager, ['docker', 'swarm', 'join-token', '-q', 'manager' if index < 3 else 'worker']).strip()
                    script = ('read -r token; exec docker swarm join --token "$token" --advertise-addr '
                              + shlex.quote(node['private_ip']) + ' --data-path-addr ' + shlex.quote(node['private_ip'])
                              + ' ' + shlex.quote(manager['private_ip'] + ':2377'))
                    self.platform.values['CLUSTER_JOIN_TOKEN'] = token
                    try:
                        self.ssh(node, ['sh', '-ec', script], input=token + '\n')
                    finally:
                        self.platform.values.pop('CLUSTER_JOIN_TOKEN', None)
            current = json.loads(self.ssh(node, ['docker', 'info', '--format', '{{json .Swarm}}']))
            if not state or current.get('Cluster', {}).get('ID', state['cluster_id']) != state['cluster_id']:
                raise SetupError(f'{node["name"]} 已属于其他 Swarm，停止操作。不会强制离开或接管。')
            node_id = current['NodeID']
            # Inspect on the manager so workers cannot silently join an unrelated cluster.
            self.ssh(manager, ['docker', 'node', 'inspect', node_id], capture=True)
            self.ssh(manager, ['docker', 'node', 'update', '--label-add', 'openbot.deployment=' + deployment, node_id])
        for subnet, name in zip(ipaddress.ip_network(self.inventory['overlay_cidr']).subnets(new_prefix=24), self.shared.values()):
            existing = self.ssh(manager, ['docker', 'network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.ID}}']).strip()
            if existing:
                details = json.loads(self.ssh(manager, ['docker', 'network', 'inspect', existing]))[0]
                if (details.get('Driver') != 'overlay' or not details.get('Attachable')
                        or 'encrypted' not in details.get('Options', {})
                        or details.get('Labels', {}).get('openbot.deployment') != deployment):
                    raise SetupError(f'网络 {name} 与生成配置不符，停止操作')
            else:
                self.ssh(manager, ['docker', 'network', 'create', '--driver', 'overlay', '--attachable',
                                  '--opt', 'encrypted', '--subnet', str(subnet), '--label',
                                  'openbot.deployment=' + deployment, name])
        print('私网 Swarm 与加密 attachable overlay 已建立。')

    def sync(self):
        files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
        files += subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z', 'deploy'], cwd=ROOT).decode().split('\0')
        with tempfile.TemporaryDirectory(prefix='openbot-source-') as temporary:
            archive = Path(temporary) / 'source.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for filename in sorted(set(files)):
                    if not filename or any(part.startswith('.env') and not part.endswith('.example')
                                           for part in Path(filename).parts):
                        continue
                    if filename.startswith('deploy/centralized/config/') or not (ROOT / filename).is_file():
                        continue
                    tar.add(ROOT / filename, arcname=filename, recursive=False)
            for node in self.nodes:
                # SSH stdin streams the source archive. No environment file is part of the source bundle.
                command = ('set -eu; umask 077; mkdir -p ' + shlex.quote(node['directory'] + '/.openbot/runtime-logs')
                           + '; tar -xzf - -C ' + shlex.quote(node['directory']))
                with archive.open('rb') as stream:
                    result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                             node['ssh'], command], stdin=stream, capture_output=True)
                if result.returncode:
                    raise SetupError(f'{node["name"]} 源码同步失败：{result.stderr.decode()[-1000:]}')
                for filename in ['compose.json', 'node.json']:
                    content = (self.directory / node['name'] / filename).read_text()
                    code = ('import os,sys; p=sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); '
                            'os.fchmod(f,0o600); stream=os.fdopen(f,"wb"); stream.write(sys.stdin.buffer.read()); stream.close()')
                    self.ssh(node, ['python3', '-c', code, node['directory'] + '/.openbot/' + filename], input=content)
                self.node(node, 'apply-state')
                print(f'已同步 {node["name"]}：源码与该节点所需的配置')

    def build(self):
        for node in self.nodes:
            if node['role'] in ['apps', 'compute']:
                print(f'构建 {node["name"]} 本地镜像', flush=True)
                self.node(node, 'build', capture=False)

    def compose(self, node, *args):
        return self.node(node, 'compose', *args, capture=False)

    def up(self):
        with self.platform.lock():
            self.doctor()
            self.network()
            self.sync()
            self.build()
            data, apps, compute = (self.role(role) for role in ['data', 'apps', 'compute'])
            steps = [
                ('启动共享数据库', lambda: self.compose(data, 'up', '-d', '--wait', 'infrastructure-postgres', 'infrastructure-mysql')),
                ('创建应用数据库', lambda: self.compose(data, 'run', '--rm', 'infrastructure-postgres-init')),
                ('分散启动 Redis、Sentinel 和共享对象存储', self.start_storage),
                ('初始化对象存储和账号', lambda: [self.compose(data, 'run', '--rm', 'infrastructure-' + job) for job in ['rustfs-init', 'rustfs-account-init']]),
                ('启动中间件应用', lambda: self.start_apps(apps)),
                ('创建技能目录只读账号', lambda: self.node(data, 'skill-reader', capture=False)),
                ('配置日志采集账号', lambda: self.node(apps, 'observe', capture=False)),
                ('启动每台服务器的日志采集', lambda: [self.compose(node, 'up', '-d', 'openobserve-otel-collector') for node in self.nodes]),
                ('初始化计算节点身份与浏览器', lambda: self.node(compute, 'compute', capture=False)),
                ('迁移并启动主应用', lambda: self.compose(apps, 'up', '-d', '--wait', '--wait-timeout', '300', 'openbot-server', 'openbot-worker')),
            ]
            for index, (title, action) in enumerate(steps, 1):
                print(f'\n[多机 {index}/{len(steps)}] {title}', flush=True)
                action()
            self.check()

    def start_storage(self):
        for node in sorted(self.nodes, key=lambda item: item['role'] != 'data'):
            names = [name for name, service in self.documents[node['name']]['services'].items()
                     if name.startswith('infrastructure-') and not service.get('profiles')]
            if names:
                self.compose(node, 'up', '-d', '--wait', '--wait-timeout', '300', *names)

    def start_apps(self, node):
        names = [key for key, service in self.documents[node['name']]['services'].items()
                 if not service.get('profiles') and not key.startswith(('openbot-', 'openobserve-otel-', 'infrastructure-'))]
        self.compose(node, 'up', '-d', '--wait', '--wait-timeout', '900', *names)
        self.compose(node, 'run', '--rm', 'infisical-bootstrap-admin')

    def check(self):
        for node in self.nodes:
            self.node(node, 'check', capture=False)

    def status(self):
        for node in self.nodes:
            self.node(node, 'compose', 'ps', '--all', capture=False)

    def stop(self):
        with self.platform.lock():
            order = {'observer': 0, 'compute': 1, 'apps': 2, 'data': 3}
            for node in sorted(self.nodes, key=lambda item: order[item['role']]):
                self.compose(node, 'stop')
        print('所有节点已停止，数据卷、Swarm 和 overlay 保留。')

    def logs(self, node_name, service=None, tail=100):
        node = next((node for node in self.nodes if node['name'] == node_name), None)
        if node is None:
            raise SetupError('logs 需要 --node，填写清单中的节点名')
        if not 1 <= tail <= 10000:
            raise SetupError('--tail 需要在 1 到 10000 之间')
        if service and not re.fullmatch(r'[a-z][a-z0-9-]*', service):
            raise SetupError('服务名格式无效')
        self.node(node, 'compose', 'logs', '--tail', str(tail), *([service] if service else []), capture=False)
