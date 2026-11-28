"""Compile real Compose contracts and exercise multi-host safety without SSH mutations."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_platform import installer

sys.modules['platform_installer'] = installer
spec = importlib.util.spec_from_file_location('cluster_installer', installer.ROOT / 'deploy/cluster.py')
cluster = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cluster)


class ClusterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='openbot-cluster-tests-')
        cls.directory = Path(cls.temporary.name)
        cls.platform = installer.Platform(cls.directory)
        with contextlib.redirect_stdout(io.StringIO()):
            cls.platform.initialize(interactive=False)
            user = installer.read_env(cls.platform.user_file)
            user.update(BOT_MODEL='fixture-model', OPENAI_API_KEY='fixture-api-key')
            installer.write_env(cls.platform.user_file, user)
            cls.platform.initialize(interactive=False)
        cls.inventory = json.loads((installer.ROOT / 'deploy/cluster/inventory.example.json').read_text())
        cls.documents = {component: json.loads(cls.platform.compose(component, '--profile', 'setup', 'config',
                                                                   '--format', 'json', capture=True))
                         for component in installer.COMPONENTS}
        cls.compiled, cls.metadata, cls.shared = cluster.compile_nodes(cls.platform, cls.inventory, cls.documents)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def write_inventory(self, inventory):
        path = self.directory / 'inventory.json'
        path.write_text(json.dumps(inventory))
        return path

    def test_three_nodes_have_separate_databases_apps_and_execution(self):
        self.assertIn('infrastructure-postgres', self.compiled['data']['services'])
        self.assertNotIn('infrastructure-postgres', self.compiled['apps']['services'])
        self.assertIn('openbot-server', self.compiled['apps']['services'])
        self.assertIn('agents-supervisor', self.compiled['compute']['services'])
        self.assertIn('spire-spire-server', self.compiled['compute']['services'])
        self.assertNotIn('openbot-server', self.compiled['compute']['services'])
        self.assertTrue(all('kafka' not in name and 'flexprice' not in name
                            for node in self.compiled.values() for name in node['services']))

    def test_redis_and_sentinels_are_split_across_three_hosts(self):
        for node in self.compiled.values():
            redis = [name for name in node['services'] if name.startswith('infrastructure-redis-')]
            sentinels = [name for name in node['services'] if name.startswith('infrastructure-sentinel-')]
            self.assertEqual(len(redis), 1)
            self.assertEqual(len(sentinels), 1)

    def test_remote_compute_has_no_database_or_rustfs_admin_credentials(self):
        serialized = json.dumps(self.compiled['compute']) + json.dumps(self.metadata['compute'])
        for key in ['POSTGRES_ADMIN_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'RUSTFS_SECRET_KEY',
                    'OPENOBSERVE_ROOT_PASSWORD', 'INFISICAL_ENCRYPTION_KEY', 'KEY_ENCRYPTION_KEY']:
            self.assertNotIn(self.platform.values[key], serialized, key)
        self.assertIn(self.platform.values['COMPUTER_TOKEN'], serialized)

    def test_cross_host_dependencies_use_overlay_not_compose_depends_on(self):
        all_services = {name for node in self.compiled.values() for name in node['services']}
        for node in self.compiled.values():
            for name, service in node['services'].items():
                self.assertTrue(set(service.get('depends_on', {})) <= set(node['services']), name)
        self.assertIn('openbot-migrate', all_services)
        shared_name = self.shared['openbot-central']
        for node in self.compiled.values():
            self.assertTrue(node['networks'][shared_name]['external'])
        # Only the application node owns the audit ingress alias.
        collectors = [node['services']['openobserve-otel-collector'] for node in self.compiled.values()]
        alias = lambda service: [a for settings in service['networks'].values() for a in settings.get('aliases', [])]
        self.assertEqual(sum('otel-collector' in alias(service) for service in collectors), 1)

    def test_private_aliases_cannot_route_infisical_bootstrap_to_opik_backend(self):
        apps = self.compiled['apps']['services']
        self.assertEqual(apps['infisical-bootstrap-admin']['networks'], {'infisical-private': {}})
        self.assertIn('backend', apps['infisical-backend']['networks']['infisical-private']['aliases'])
        shared_name = self.shared['openbot-central']
        self.assertNotIn('backend', apps['opik-backend']['networks'][shared_name].get('aliases', []))

    def test_generated_manifests_render_and_preserve_local_identity_volumes(self):
        for name, document in self.compiled.items():
            path = self.directory / (name + '.json')
            path.write_text(json.dumps(document))
            result = subprocess.run(['docker', 'compose', '-f', str(path), '--profile', 'setup',
                                     'config', '--quiet'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, name + result.stderr)
            for service in document['services'].values():
                self.assertNotIn('env_file', service)
                for mount in service.get('volumes', []):
                    if mount['type'] == 'bind':
                        self.assertFalse(mount['source'].startswith(str(installer.ROOT) + '/'))
        compute = self.compiled['compute']
        mounts = {name: {mount['target']: mount['source'] for mount in compute['services'][name]['volumes']}
                  for name in ['spire-spire-server', 'agents-supervisor']}
        self.assertEqual(mounts['spire-spire-server']['/tmp/spire-server/private'],
                         mounts['agents-supervisor']['/tmp/spire-server/private'])

    def test_second_compose_parse_preserves_shell_variables_and_dollar_keys(self):
        documents = copy.deepcopy(self.documents)
        documents['agents']['services']['agent-bot']['environment']['OPENAI_API_KEY'] = 'literal$$key-value'
        compiled, _, _ = cluster.compile_nodes(self.platform, self.inventory, documents)
        for node_name in ['apps', 'compute']:
            path = self.directory / (node_name + '-literal.json')
            path.write_text(json.dumps(compiled[node_name]))
            result = subprocess.run(['docker', 'compose', '-f', str(path), '--profile', 'setup',
                                     'config', '--format', 'json'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('variable is not set', result.stderr)
            services = json.loads(result.stdout)['services']
            if node_name == 'apps':
                self.assertEqual(services['opik-frontend']['entrypoint'], documents['opik']['services']['frontend']['entrypoint'])
            else:
                self.assertEqual(services['agents-agent-bot']['environment']['OPENAI_API_KEY'], 'literal$$key-value')

    def test_reordered_inventory_keeps_primary_on_data_node(self):
        inventory = copy.deepcopy(self.inventory)
        inventory['nodes'] = [inventory['nodes'][1], inventory['nodes'][2], inventory['nodes'][0]]
        compiled, _, _ = cluster.compile_nodes(self.platform, inventory, self.documents)
        self.assertIn('infrastructure-redis-primary', compiled['data']['services'])
        self.assertEqual(sum(any(name.startswith('infrastructure-redis-') for name in node['services'])
                             for node in compiled.values()), 3)

    def test_primary_starts_first_even_when_inventory_order_changes(self):
        inventory = copy.deepcopy(self.inventory)
        inventory['nodes'] = [inventory['nodes'][1], inventory['nodes'][2], inventory['nodes'][0]]
        calls = []
        class Ordered(cluster.Cluster):
            def compose(self, node, *args):
                calls.append(node['role'])
        controller = Ordered(self.platform, self.write_inventory(inventory))
        controller.documents, _, _ = cluster.compile_nodes(self.platform, inventory, self.documents)
        controller.start_storage()
        self.assertEqual(calls[0], 'data')

    def test_invalid_or_conflicting_inventory_is_rejected(self):
        for mutation in ['duplicate_ip', 'unsafe_path', 'public_ip', 'overlap', 'duplicate_role']:
            inventory = copy.deepcopy(self.inventory)
            node = inventory['nodes'][1]
            if mutation == 'duplicate_ip':
                node['private_ip'] = inventory['nodes'][0]['private_ip']
            elif mutation == 'unsafe_path':
                node['directory'] = '/home/ubuntu/../root'
            elif mutation == 'public_ip':
                node['private_ip'] = '8.8.8.8'
            elif mutation == 'overlap':
                inventory['overlay_cidr'] = '10.0.0.0/16'
            else:
                node['role'] = 'compute'
            with self.subTest(mutation=mutation), self.assertRaises(installer.SetupError):
                cluster.load_inventory(self.write_inventory(inventory))

    def test_cli_init_and_plan_need_no_ssh_and_generate_private_node_files(self):
        with tempfile.TemporaryDirectory() as directory:
            platform = installer.Platform(directory)
            with contextlib.redirect_stdout(io.StringIO()):
                platform.initialize(interactive=False)
            user = installer.read_env(platform.user_file)
            user.update(BOT_MODEL='fixture', OPENAI_API_KEY='fixture')
            installer.write_env(platform.user_file, user)
            with contextlib.redirect_stdout(io.StringIO()):
                platform.initialize(interactive=False)
            command = [sys.executable, str(installer.ROOT / 'deploy/platform.py'), '--config-dir', directory, 'cluster']
            for action in ['init', 'plan']:
                result = subprocess.run([*command, action], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            for name in ['data', 'apps', 'compute']:
                manifest = Path(directory) / 'cluster' / name / 'compose.json'
                self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('env_file', json.loads(manifest.read_text())['services']['openobserve-otel-collector'])

    def test_failed_cluster_bootstrap_does_not_start_the_api(self):
        calls = []
        parent = self
        class Simulated(cluster.Cluster):
            def doctor(self):
                self.documents = parent.compiled
            def network(self):
                calls.append('network')
            def sync(self):
                calls.append('sync')
            def build(self):
                calls.append('build')
            def compose(self, node, *args):
                calls.append((node['name'], args))
                if 'infrastructure-rustfs-account-init' in args:
                    raise installer.SetupError('fixture failure')
            def node(self, node, action, *args, **kwargs):
                calls.append((node['name'], action))
        controller = Simulated(self.platform, self.write_inventory(self.inventory))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(installer.SetupError):
            controller.up()
        self.assertEqual(calls[:3], ['network', 'sync', 'build'])
        self.assertFalse(any(isinstance(call, tuple) and 'openbot-server' in call[1] for call in calls))

    def test_existing_unrelated_swarm_is_not_adopted(self):
        calls = []
        class Existing(cluster.Cluster):
            def ssh(self, node, arguments, **kwargs):
                calls.append(arguments)
                return json.dumps({'LocalNodeState': 'active', 'NodeID': 'foreign-node', 'Cluster': {'ID': 'foreign'}})
        with tempfile.TemporaryDirectory() as directory:
            platform = installer.Platform(directory)
            platform.values = self.platform.values
            controller = Existing(platform, self.write_inventory(self.inventory))
            with self.assertRaisesRegex(installer.SetupError, '其他 Swarm'):
                controller.network()
        self.assertEqual(len(calls), 1)

    def test_existing_topology_cannot_silently_move_data_to_another_node(self):
        with tempfile.TemporaryDirectory() as directory:
            platform = installer.Platform(directory)
            platform.values = self.platform.values
            state = Path(directory) / 'cluster/swarm.json'
            cluster.private_json(state, {'deployment': platform.values['OPENBOT_DEPLOYMENT_ID'],
                                         'inventory': self.inventory, 'cluster_id': 'fixture'})
            changed = copy.deepcopy(self.inventory)
            changed['nodes'][0]['directory'] += '-new'
            with self.assertRaisesRegex(installer.SetupError, '迁移'):
                cluster.Cluster(platform, self.write_inventory(changed))


if __name__ == '__main__':
    unittest.main()
