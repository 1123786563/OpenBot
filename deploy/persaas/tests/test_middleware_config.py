"""Real Compose checks for individual middleware variables."""
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('middleware', Path(__file__).resolve().parents[1] / 'middleware-config.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    m.ROOT = root
    env = root / '.container-api.env'
    env.write_text('TOKEN="fixture$$literal"\n')
    other = root / '.container-worker.env'
    other.write_text('TOKEN="different-worker-value"\n')
    db = root / 'database.env'
    db.write_text('POSTGRES_PASSWORD="fixture"\n')
    compose = root / 'compose.yml'
    compose.write_text('services:\n  api:\n    image: example/app:1\n    env_file: .container-api.env\n  worker:\n    image: example/app:1\n    env_file: .container-worker.env\n  database:\n    image: getlago/postgres-partman:15.0-alpine\n    env_file: database.env\n')
    (root / '.env').write_text('UNRELATED_PANEL_SETTING=fixture\n')
    assert m.variable_groups(compose, 'example') == {'example/api': env, 'example/worker': other}
    assert set(m.env_files(compose, include_databases=True).values()) == {env, other, db}
    assert m.env_values(env) == {'TOKEN': 'fixture$literal'}
    print('PASS service folders isolate duplicate variable names and exclude database env')
    values = {'TOKEN': 'quote" dollar$ slash\\ newline\nnext', 'EMPTY': '', 'PADDED': ' padded '}
    assert m.apply_variables(compose, env, values, True) == 1
    assert m.env_values(env) == values
    assert m.apply_variables(compose, env, values, True) == 0
    assert m.env_values(other) == {'TOKEN': 'different-worker-value'}
    print('PASS individual values round-trip quotes, dollars, multiline, empty and whitespace')
    try:
        m.apply_variables(compose, env, {'INVALID-KEY': 'fixture'}, True)
        raise AssertionError('Invalid variable name accepted')
    except RuntimeError:
        assert m.env_values(env) == values
    print('PASS invalid variable names rejected before file writes')
    original = env.read_text()
    real_definition = m.definition
    def fail_definition(path, unresolved=False):
        if path == compose:
            raise RuntimeError('fixture configuration failure')
        return real_definition(path, unresolved)
    m.definition = fail_definition
    try:
        m.apply_variables(compose, env, {'TOKEN': 'changed'}, True)
        raise AssertionError('Invalid compose accepted')
    except RuntimeError:
        assert env.read_text() == original
    finally:
        m.definition = real_definition
    print('PASS failed Compose validation restores the original env file')
    runtime = root / 'runtime'
    runtime.mkdir()
    for service in ['flexprice', 'temporal']:
        (runtime / (service + '.env')).write_text('TOKEN="' + service + '"\n')
    shared = root / 'data.yml'
    shared.write_text('services:\n  flexprice:\n    image: example/app:1\n    env_file: runtime/flexprice.env\n  temporal:\n    image: example/app:1\n    env_file: runtime/temporal.env\n')
    assert m.variable_groups(shared, 'flexprice') == {'flexprice': runtime / 'flexprice.env'}
    assert m.variable_groups(shared, 'temporal') == {'temporal': runtime / 'temporal.env'}
    print('PASS shared-stack services retain independent vault folders')
