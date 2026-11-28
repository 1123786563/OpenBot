"""Behavior checks for the beginner installer; no production containers or credentials used."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('platform_installer', DEPLOY / 'platform.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

EXPECTED = {
    'infrastructure': installer.STORAGE, 'spire': ['spire-server', 'spire-agent'],
    'agents': ['agent-bot', 'agent-langgraph', 'agent-computer', 'supervisor'],
    'bifrost': ['bifrost', 'registry-proxy'], 'infisical': ['backend'],
    'hindsight': ['hindsight'], 'opik': ['backend', 'frontend', 'python-backend'],
    'openobserve': ['openobserve', 'otel-collector'], 'openbot': ['server', 'worker'],
}


class SimulatedPlatform(installer.Platform):
    """Model the externally observable Docker/API boundary, keeping installer ordering real."""
    def __init__(self, path):
        super().__init__(path)
        self.calls = []
        self.fail_service = None
        self.missing_worker = False

    def doctor(self, runtime=False):
        self.validate_inputs(self.values)

    def run(self, command, **kwargs):
        self.calls.append(('command', command))
        return '{}'

    def compose(self, component, *args, **kwargs):
        self.calls.append((component, args))
        if self.fail_service and self.fail_service in args:
            raise installer.SetupError('simulated initialization failure')
        if args[:1] == ('ps',):
            names = EXPECTED[component]
            if component == 'openbot' and self.missing_worker:
                names = ['server']
            return json.dumps([{'Service': name, 'State': 'running', 'Health': 'healthy'} for name in names])
        if args[-1:] == ("SELECT to_regclass('public.skill_versions') IS NOT NULL",):
            return 't\n'
        if 'generate' in args:
            return 'Token: fixture-join-token\n'
        return ''

    def request(self, url, authorization, method='GET', payload=None):
        self.calls.append(('http', (url, method, payload)))
        return (404, {}) if '/users/' in url else (200, {})

    def wait_http(self, *args, **kwargs):
        pass


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.output)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    def initialize(self, cls=installer.Platform):
        platform = cls(self.directory)
        platform.initialize(interactive=False)
        user = installer.read_env(platform.user_file)
        user.update(OPENAI_API_KEY='fixture-model-key', BOT_MODEL='fixture-model')
        installer.write_env(platform.user_file, user)
        platform.initialize(interactive=False)
        return platform

    def test_init_cli_works_without_node_or_docker(self):
        result = subprocess.run([sys.executable, str(DEPLOY / 'platform.py'), '--config-dir', str(self.directory),
                                 'init', '--non-interactive'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for filename in ['.env', '.env.user', '.env.server', '.env.agents', '.env.worker']:
            self.assertEqual((self.directory / filename).stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(installer.read_env(self.directory / '.env.user')), 4)

    def test_repeated_init_preserves_secrets_and_propagates_model_settings(self):
        platform = self.initialize()
        before = {key: platform.values[key] for key in installer.SECRET_KEYS}
        platform.initialize(interactive=False)
        self.assertEqual(before, {key: platform.values[key] for key in installer.SECRET_KEYS})
        server = installer.read_env(self.directory / '.env.server')
        agents = installer.read_env(self.directory / '.env.agents')
        self.assertEqual(server['OPENAI_API_KEY'], agents['OPENAI_API_KEY'])
        self.assertEqual(server['TENANT_PACKAGE_DIR'], '../examples/personal')
        self.assertNotIn('BETTER_AUTH_SECRET', server)
        self.assertEqual(server['COMPUTER_SUPERVISOR_URL'], '')
        self.assertEqual(server['AGENT_COMPUTER_URL'], 'http://agent-computer:4100')
        self.assertEqual(server['COMPUTER_TOKEN'], agents['COMPUTER_TOKEN'])
        self.assertNotEqual(platform.values['OPIK_S3_ACCESS_KEY'], platform.values['RUSTFS_ACCESS_KEY'])

    def test_env_roundtrip_preserves_literal_dollars_quotes_and_hash(self):
        values = {'SECRET': "a'b$HOME#123", 'URL': 'https://example.test/v1'}
        path = self.directory / '.env'
        installer.write_env(path, values)
        self.assertEqual(installer.read_env(path), values)

    def test_missing_model_prevents_install_before_mutations(self):
        platform = SimulatedPlatform(self.directory)
        platform.initialize(interactive=False)
        with self.assertRaisesRegex(installer.SetupError, '模型'):
            platform.up()
        self.assertEqual(platform.calls, [])

    def test_bootstrap_runs_dependencies_before_apps_and_uses_independent_collector(self):
        platform = self.initialize(SimulatedPlatform)
        platform.up()
        tasks = [args[-1] for component, args in platform.calls if component == 'infrastructure' and args[:1] == ('run',)]
        self.assertEqual(tasks, ['postgres-init', 'rustfs-init', 'rustfs-account-init'])
        starts = [(component, args) for component, args in platform.calls if component == 'openbot']
        self.assertTrue(starts)
        self.assertEqual(platform.values['SPIRE_JOIN_TOKEN'], 'fixture-join-token')
        header = platform.values['OPENOBSERVE_RUNTIME_AUTHORIZATION']
        self.assertEqual(header, installer.basic(platform.values['OPENOBSERVE_COLLECTOR_EMAIL'],
                                                platform.values['OPENOBSERVE_COLLECTOR_PASSWORD']))
        self.assertNotIn(platform.values['OPENOBSERVE_ROOT_PASSWORD'], header)
        before = platform.values['PLATFORM_ADMIN_PASSWORD']
        platform.up()
        self.assertEqual(before, platform.values['PLATFORM_ADMIN_PASSWORD'])
        token_calls = [call for call in platform.calls if call[0] == 'spire' and 'generate' in call[1]]
        self.assertEqual(len(token_calls), 1)

    def test_failed_init_stops_later_apps_and_rerun_recovers(self):
        platform = self.initialize(SimulatedPlatform)
        platform.fail_service = 'rustfs-account-init'
        with self.assertRaises(installer.SetupError):
            platform.up()
        self.assertFalse(any(component == 'openbot' for component, _ in platform.calls))
        saved_password = platform.values['POSTGRES_ADMIN_PASSWORD']
        platform.fail_service = None
        platform.up()
        self.assertEqual(installer.read_env(platform.env_file)['POSTGRES_ADMIN_PASSWORD'], saved_password)

    def test_check_fails_if_worker_is_missing_even_with_healthy_api(self):
        platform = self.initialize(SimulatedPlatform)
        platform.missing_worker = True
        with self.assertRaisesRegex(installer.SetupError, 'openbot'):
            platform.check()

    def test_parallel_installs_are_rejected(self):
        platform = self.initialize()
        other = installer.Platform(self.directory)
        with platform.lock():
            with self.assertRaisesRegex(installer.SetupError, '已有'):
                with other.lock():
                    pass

    def test_logs_redact_machine_secrets(self):
        platform = self.initialize()
        secret = platform.values['POSTGRES_ADMIN_PASSWORD']
        output = platform.redact('failed password=' + secret)
        self.assertNotIn(secret, output)
        self.assertIn('[redacted]', output)

    def test_build_selects_personal_frontend(self):
        platform = self.initialize(SimulatedPlatform)
        platform.build()
        commands = [args for component, args in platform.calls if component == 'command']
        self.assertIn('TENANT_PACKAGE_DIR=../examples/personal', commands[0])


if __name__ == '__main__':
    unittest.main()
