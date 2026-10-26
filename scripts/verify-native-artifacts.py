#!/usr/bin/env python3
"""Check real builder outputs; signature cryptography is checked by platform tools."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def verify(directory, origin):
    directory = Path(directory)
    manifest = json.loads((directory/'manifest.json').read_text())
    server_id = hashlib.sha256(origin.encode()).hexdigest()[:12]
    if manifest['serverUrl'] != origin or manifest['serverId'] != server_id:
        raise ValueError('Build manifest points to a different server')
    for name in ('ZDis.apk', 'ZDis-Setup.exe'):
        data = (directory/name).read_bytes()
        if len(data) < 1024 or hashlib.sha256(data).hexdigest() != manifest['sha256'][name]:
            raise ValueError(f'Invalid artifact or hash: {name}')
    if (directory/'ZDis-Setup.exe').read_bytes()[:2] != b'MZ':
        raise ValueError('Windows installer is not a PE executable')
    with zipfile.ZipFile(directory/'ZDis.apk') as apk:
        config = json.loads(apk.read('assets/capacitor.config.json'))
        if config['server']['url'] != origin or config['appId'] != f'com.zdis.server.s{server_id}':
            raise ValueError('APK has incorrect server configuration')
        if config['server'].get('cleartext') is not False:
            raise ValueError('APK unexpectedly permits cleartext server traffic')
    print('Both artifact hashes and embedded Android HTTPS server configuration verified.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    verify(args.directory, args.origin)
