"""Real Compose checks for the env-only synchronization contract."""
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('middleware', Path(__file__).resolve().parents[1] / 'middleware-config.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    m.ROOT = root
    compose = root / 'compose.yml'
    env = root / 'probe.env'
    env.write_text('TOKEN="fixture$literal"\n')
    compose.write_text('services:\n  probe:\n    image: busybox:1.37\n    env_file: [probe.env]\n')
    (root / '.env').write_text('UNRELATED_PANEL_SETTING=fixture\n')
    files = m.env_files(compose)
    assert list(files.values()) == [env]
    values = {key: m.env_text(path.read_text()) for key, path in files.items()}
    assert m.apply_env(compose, values) == 0
    print('PASS only explicitly referenced env files are selected')
    try:
        m.apply_env(compose, {**values, 'COMPOSE_YAML': 'invalid'}, True)
        raise AssertionError('Non-env config was accepted')
    except RuntimeError:
        print('PASS non-env vault entries rejected')
    bad = {key: 'TOKEN="unterminated' for key in files}
    try:
        m.apply_env(compose, bad, True)
        raise AssertionError('Invalid dotenv accepted')
    except Exception:
        assert env.read_text() == values[next(iter(files))] + '\n'
        print('PASS invalid dotenv rolled back')
    good = {key: 'TOKEN="new-fixture"' for key in files}
    assert m.apply_env(compose, good, True) == 1
    assert m.apply_env(compose, good, True) == 0
    print('PASS valid env update is idempotent')

    runtime = root / 'runtime'
    runtime.mkdir()
    for service in ['flexprice', 'temporal']:
        (runtime / (service + '.env')).write_text('TOKEN="' + service + '-fixture"\n')
    shared = root / 'data.yml'
    shared.write_text('services:\n  flexprice:\n    image: busybox:1.37\n    env_file: runtime/flexprice.env\n  temporal:\n    image: busybox:1.37\n    env_file: runtime/temporal.env\n')
    flex = m.env_files(shared, 'flexprice')
    temporal = m.env_files(shared, 'temporal')
    assert list(flex.values()) == [runtime / 'flexprice.env']
    assert list(temporal.values()) == [runtime / 'temporal.env']
    before_temporal = (runtime / 'temporal.env').read_text()
    assert m.apply_env(shared, {key: 'TOKEN="new-flex"' for key in flex}, True, 'flexprice') == 1
    assert (runtime / 'temporal.env').read_text() == before_temporal
    print('PASS shared-stack middleware folders update only their own env file')

    database = root / 'database.env'
    database.write_text('POSTGRES_PASSWORD="fixture"\n')
    mixed = root / 'mixed.yml'
    mixed.write_text('services:\n  api:\n    image: example/app:1\n    env_file: probe.env\n  database:\n    image: getlago/postgres-partman:15.0-alpine\n    env_file: database.env\n')
    assert list(m.env_files(mixed).values()) == [env]
    assert set(m.env_files(mixed, include_databases=True).values()) == {env, database}
    print('PASS embedded database env excluded from vault but retained for backup')
