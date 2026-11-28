#!/usr/bin/env python3
"""Create private application buckets and scoped RustFS keys on the data node."""
import datetime
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import subprocess
import urllib.parse
import urllib.error
import urllib.request

ROOT = Path('/opt/persaas')


def request(method, path, access, secret, data=b'', endpoint='http://127.0.0.1:9000'):
    now = datetime.datetime.now(datetime.timezone.utc)
    timestamp = now.strftime('%Y%m%dT%H%M%SZ')
    day = now.strftime('%Y%m%d')
    digest = hashlib.sha256(data).hexdigest()
    parts = urllib.parse.urlsplit(path)
    query = urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(parts.query, keep_blank_values=True)), quote_via=urllib.parse.quote)
    headers = {'host': urllib.parse.urlsplit(endpoint).netloc, 'x-amz-content-sha256': digest, 'x-amz-date': timestamp}
    canonical = '\n'.join([method, parts.path, query, ''.join(k + ':' + v + '\n' for k, v in sorted(headers.items())), ';'.join(sorted(headers)), digest])
    scope = day + '/us-east-1/s3/aws4_request'
    sign = lambda key, text: hmac.new(key, text.encode(), hashlib.sha256).digest()
    key = sign(sign(sign(sign(('AWS4' + secret).encode(), day), 'us-east-1'), 's3'), 'aws4_request')
    signature = hmac.new(key, ('AWS4-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + hashlib.sha256(canonical.encode()).hexdigest()).encode(), hashlib.sha256).hexdigest()
    headers['Authorization'] = f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={";".join(sorted(headers))}, Signature={signature}'
    req = urllib.request.Request(endpoint + path, data=data if method in ('PUT', 'POST') else None, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def main():
    credential_file = ROOT / 'credentials.json'
    credentials = json.loads(credential_file.read_text())
    container = json.loads(subprocess.check_output(['docker', 'inspect', '1Panel-rustfs-ZaQO']))[0]
    env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    root_access, root_secret = env['RUSTFS_ACCESS_KEY'], env['RUSTFS_SECRET_KEY']
    name = 'opik'
    try:
        request('PUT', '/' + name, root_access, root_secret)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
    cors = b'<CORSConfiguration><CORSRule><AllowedOrigin>https://opik.persaas.cn</AllowedOrigin><AllowedOrigin>https://www.persaas.cn</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>'
    request('PUT', '/' + name + '?cors', root_access, root_secret, cors)
    if name + 'S3AccessKey' not in credentials:
        access = 'persaas-' + name + '-' + secrets.token_hex(6)
        secret = secrets.token_hex(24)
        policy = {'Version': '2012-10-17', 'Statement': [
            {'Effect': 'Allow', 'Action': ['s3:ListBucket', 's3:GetBucketLocation'], 'Resource': ['arn:aws:s3:::' + name]},
            {'Effect': 'Allow', 'Action': ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], 'Resource': ['arn:aws:s3:::' + name + '/*']},
        ]}
        request('PUT', '/rustfs/admin/v3/add-service-account', root_access, root_secret, json.dumps({'accessKey': access, 'secretKey': secret, 'name': 'Persaas-' + name, 'policy': policy}).encode())
        credentials[name + 'S3AccessKey'] = access
        credentials[name + 'S3SecretKey'] = secret
        credential_file.write_text(json.dumps(credentials, indent=2))
        credential_file.chmod(0o600)
    access, secret = credentials[name + 'S3AccessKey'], credentials[name + 'S3SecretKey']
    path = '/' + name + '/deployment-check-' + secrets.token_hex(6)
    try:
        request('PUT', path, access, secret, b'persaas-storage-check')
        assert request('GET', path, access, secret) == b'persaas-storage-check'
    finally:
        request('DELETE', path, access, secret)
    try:
        request('GET', '/', access, secret)
        raise RuntimeError('Bucket listing was admitted')
    except urllib.error.HTTPError as error:
        assert error.code == 403
    print(name + ': private bucket, object round trip, bucket listing denial passed')


if __name__ == '__main__':
    main()
