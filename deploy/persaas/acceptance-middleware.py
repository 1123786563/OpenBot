#!/usr/bin/env python3
"""Exercise deployed middleware through HTTPS without printing credentials."""
import base64
import datetime
import json
from pathlib import Path
import time
import secrets
import urllib.error
import urllib.request
import uuid
from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path('/opt/persaas')


def main():
    credentials = json.loads((ROOT / 'credentials.json').read_text())
    passed = []

    def check(name, condition):
        if not condition:
            raise RuntimeError(name)
        passed.append(name)
        print('PASS ' + name, flush=True)

    def basic(user, password):
        return 'Basic ' + base64.b64encode((user + ':' + password).encode()).decode()

    def call(url, body=None, auth=None, method=None, headers=None):
        h = {'Content-Type': 'application/json', **(headers or {})}
        if auth:
            h['Authorization'] = auth
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
        with urllib.request.urlopen(req, timeout=120) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None

    def refused(url, body=None):
        try:
            call(url, body)
            return False
        except urllib.error.HTTPError as error:
            return error.code in (401, 403)

    gateway = 'https://bifrost.persaas.cn'
    check('Bifrost admin API requires authentication', refused(gateway + '/api/providers'))
    body = {'model': 'zhipu/glm-4.7', 'messages': [{'role': 'user', 'content': 'Reply exactly gateway-check-ok'}], 'max_tokens': 100}
    check('Bifrost inference requires authentication', refused(gateway + '/v1/chat/completions', body))
    _, reply = call(gateway + '/v1/chat/completions', body, 'Bearer ' + credentials['bifrostOpenbotKey'])
    check('Bifrost restricted virtual key reaches real model', bool(reply['choices'][0]['message'].get('content')))

    opik = 'https://opik.persaas.cn'
    check('Opik console requires authentication', refused(opik + '/'))
    auth = basic('admin', credentials['opikPassword'])
    trace_id = str(uuid.UUID(int=(int(time.time() * 1000) << 80) | (7 << 76) | (secrets.randbits(12) << 64) | (2 << 62) | secrets.randbits(62)))
    trace = {'id': trace_id, 'name': 'Persaas deployment acceptance', 'project_name': 'persaas-deployment', 'start_time': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'input': {'test': 'deployment'}, 'output': {'result': 'ok'}}
    status, _ = call(opik + '/api/v1/private/traces', trace, auth, headers={'Comet-Workspace': 'default'})
    check('Opik trace ingestion', status == 201)
    found = False
    for _ in range(20):
        try:
            status, result = call(opik + '/api/v1/private/traces/' + trace_id, auth=auth, headers={'Comet-Workspace': 'default'})
            found = status == 200 and result['id'] == trace_id
            if found:
                break
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        time.sleep(1)
    check('Opik trace readback', found)

    query = {'query': 'mutation Login($input: LoginUserInput!) { loginUser(input: $input) { token user { id email } } }', 'variables': {'input': {'email': credentials['adminEmail'], 'password': credentials['lagoPassword']}}}
    status, result = call('https://lago-api.persaas.cn/graphql', query, headers={'Origin': 'https://lago.persaas.cn'})
    check('Lago administrator login', status == 200 and bool(result.get('data', {}).get('loginUser', {}).get('token')))
    check('Lago API health', call('https://lago-api.persaas.cn/health')[0] == 200)

    flex = 'http://127.0.0.1:18085'
    status, result = call(flex + '/v1/auth/login', {'email': credentials['adminEmail'], 'password': credentials['flexpriceOwnerPassword']})
    check('Flexprice native administrator login', status == 200 and bool(result.get('token')))
    flex_auth = 'Bearer ' + result['token']
    _, environments = call(flex + '/v1/environments', auth=flex_auth)
    environment = environments['environments'][0]['id']
    check('Flexprice authenticated environment customer API', call(flex + '/v1/customers', auth=flex_auth, headers={'X-Environment-ID': environment})[0] == 200)
    check('Flexprice public signup is closed at console proxy', refused(flex + '/v1/auth/signup', {'email': 'unused@example.test', 'password': 'unused-password'}))

    observe = 'https://openobserve.persaas.cn'
    auth = basic(credentials['openobserveEmail'], credentials['openobservePassword'])
    check('OpenObserve protected API requires authentication', refused(observe + '/api/default/streams'))
    marker = 'middleware-' + uuid.uuid4().hex
    check('OpenObserve log ingestion', call(observe + '/api/default/deployment_acceptance/_json', [{'message': marker, 'service': 'persaas-acceptance'}], auth)[0] == 200)
    found = False
    for _ in range(15):
        status, result = call(observe + '/api/default/_search', {'query': {'sql': "SELECT * FROM deployment_acceptance WHERE message = '" + marker + "'", 'start_time': int((time.time() - 300) * 1000000), 'end_time': int((time.time() + 30) * 1000000), 'from': 0, 'size': 10}}, auth)
        if result.get('hits'):
            found = True
            break
        time.sleep(1)
    check('OpenObserve log search readback', found)

    spec = spec_from_file_location('rustfs', ROOT / 'provision-rustfs.py')
    storage = module_from_spec(spec)
    spec.loader.exec_module(storage)
    for name, endpoint in [('opik', opik), ('lago', 'https://lago-api.persaas.cn')]:
        path = '/' + name + '/acceptance-' + uuid.uuid4().hex
        access, secret = credentials[name + 'S3AccessKey'], credentials[name + 'S3SecretKey']
        try:
            storage.request('PUT', path, access, secret, b'public-https-storage-check', endpoint)
            check(name + ' RustFS object HTTPS round trip', storage.request('GET', path, access, secret, endpoint=endpoint) == b'public-https-storage-check')
        finally:
            storage.request('DELETE', path, access, secret, endpoint=endpoint)
    target = ROOT / 'middleware-acceptance-report.json'
    target.write_text(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': passed, 'opikTraceId': trace_id}, indent=2))
    target.chmod(0o600)


if __name__ == '__main__':
    main()
