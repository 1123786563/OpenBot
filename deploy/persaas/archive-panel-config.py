#!/usr/bin/env python3
"""Archive current 1Panel configuration in the administrator-only Infisical project; run as root on A."""
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/persaas')


def main():
    credentials = json.loads((ROOT / 'credentials.json').read_text())
    token = ''

    def call(path, body=None, method=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request('http://127.0.0.1:18082/api/' + path,
            data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)

    token = call('v3/auth/login', {'email': credentials['adminEmail'], 'password': credentials['infisicalPassword']})['accessToken']
    token = call('v3/auth/select-organization', {'organizationId': credentials['infisicalOrgId']})['token']
    if not credentials.get('infisicalInfrastructureProjectId'):
        result = call('v1/projects', {'projectName': 'Persaas Infrastructure', 'slug': 'persaas-infrastructure', 'shouldCreateDefaultEnvs': True})
        credentials['infisicalInfrastructureProjectId'] = result['project']['id']
        path = ROOT / 'credentials.json'
        path.write_text(json.dumps(credentials, indent=2))
        path.chmod(0o600)
    project = credentials['infisicalInfrastructureProjectId']
    def archive(name, values):
        try:
            call('v2/folders', {'projectId': project, 'environment': 'prod', 'name': name, 'path': '/'})
        except urllib.error.HTTPError as error:
            if error.code not in (400, 409):
                raise
            # Confirm existence through the subsequent folder-specific secrets request.
        query = urllib.parse.urlencode({'projectId': project, 'environment': 'prod', 'secretPath': '/' + name, 'expandSecretReferences': 'false'})
        existing = {item['secretKey']: item['secretValue'] for item in call('v4/secrets?' + query)['secrets']}
        new = [{'secretKey': key, 'secretValue': value} for key, value in values.items() if key not in existing]
        if new:
            call('v4/secrets/batch', {'projectId': project, 'environment': 'prod', 'secretPath': '/' + name, 'secrets': new})
        for key, value in values.items():
            if key in existing and existing[key] != value:
                call('v4/secrets/' + key, {'projectId': project, 'environment': 'prod', 'secretPath': '/' + name, 'secretValue': value}, 'PATCH')
        print(name + ': archived ' + str(len(values)) + ' configuration entries')

    for name in ['bifrost', 'opik', 'lago', 'mysql']:
        base = Path('/opt/1panel/apps') / (name if name == 'mysql' else 'local/' + name) / name
        compose = base / 'docker-compose.yml'
        values = {'COMPOSE_YAML': compose.read_text()}
        rendered = json.loads(subprocess.check_output(['docker', 'compose', '-f', str(compose), 'config', '--format', 'json'], cwd=base))
        for service, config in rendered['services'].items():
            if config.get('environment'):
                values[service.upper().replace('-', '_') + '_ENVIRONMENT_JSON'] = json.dumps(config['environment'])
        values['PANEL_ENV_FILE'] = (base / '.env').read_text()
        values['ADMIN_USERNAME'] = 'root' if name == 'mysql' else ('admin' if name != 'lago' else credentials['adminEmail'])
        values['ADMIN_PASSWORD'] = credentials[{'mysql': 'mysqlRootPassword', 'bifrost': 'bifrostPassword', 'opik': 'opikPassword', 'lago': 'lagoPassword'}[name]]
        if name == 'bifrost':
            values['BIFROST_CONFIG_JSON'] = (base / 'bifrost.json').read_text()
            values['OPENBOT_VIRTUAL_KEY'] = credentials['bifrostOpenbotKey']
        if name == 'lago':
            values['LAGO_SECRET_KEYS_JSON'] = subprocess.check_output(['docker', 'exec', '-u', '0', 'persaas-lago-api', 'cat', '/lago-secrets/keys.json']).decode()
        archive(name, values)
    archive('openobserve', {'ADMIN_EMAIL': credentials['openobserveEmail'], 'ADMIN_PASSWORD': credentials['openobservePassword']})
    archive('flexprice-admin', {'ADMIN_EMAIL': credentials['adminEmail'], 'ADMIN_PASSWORD': credentials['flexpriceOwnerPassword'], 'CONSOLE_LOCAL_URL': 'http://127.0.0.1:18085', 'FRONTEND_VERSION': 'v2.0.22'})


if __name__ == '__main__':
    main()
