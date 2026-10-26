#!/usr/bin/env python3
"""Build both dedicated clients in disposable Docker workspaces; never publish to GitHub."""
import argparse, hashlib, json, os, secrets, shutil, subprocess, tempfile
from pathlib import Path
from urllib.parse import urlsplit

def validate_origin(value):
    url = urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('Use an HTTPS server origin without credentials, path, query or fragment.')
    _ = url.port
    return value.rstrip('/')

def run(args, **kw):
    subprocess.run([str(arg) for arg in args], check=True, **kw)

def build(origin, output, signing, root):
    origin = validate_origin(origin)
    server_id = hashlib.sha256(origin.encode()).hexdigest()[:12]
    output, signing = Path(output).resolve(), Path(signing).resolve()
    output.mkdir(parents=True, exist_ok=True)
    signing.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(signing, 0o700)
    # Stable keys survive upgrades, are unique per origin, and never enter source/downloads.
    keys = signing / server_id
    keys.mkdir(mode=0o700, exist_ok=True)
    password_file = keys / 'password'
    if not password_file.exists():
        password_file.write_text(secrets.token_hex(32)); os.chmod(password_file, 0o600)
    password = password_file.read_text().strip()
    env = {**os.environ, 'ZDIS_SIGNING_PASSWORD': password, 'CSC_KEY_PASSWORD': password}
    pfx = keys / 'windows.p12'
    if not pfx.exists():
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-nodes',
             '-subj', f'/CN=ZDis Server {server_id}', '-addext', 'extendedKeyUsage=codeSigning',
             '-keyout', keys/'windows.key', '-out', keys/'windows.crt'])
        run(['openssl', 'pkcs12', '-export', '-inkey', keys/'windows.key', '-in', keys/'windows.crt',
             '-out', pfx, '-passout', 'env:ZDIS_SIGNING_PASSWORD'], env=env)
    if not (keys/'android.jks').exists():
        run(['keytool', '-genkeypair', '-keystore', keys/'android.jks', '-storepass:env', 'ZDIS_SIGNING_PASSWORD',
             '-keypass:env', 'ZDIS_SIGNING_PASSWORD', '-alias', 'zdis', '-keyalg', 'RSA', '-keysize', '3072',
             '-validity', '10000', '-dname', f'CN=ZDis {server_id}'], env=env)
    for key in keys.iterdir(): os.chmod(key, 0o600)
    with tempfile.TemporaryDirectory(prefix='zdis-native-') as temp:
        work = Path(temp)/'source'
        shutil.copytree(root, work, ignore=shutil.ignore_patterns('.git','node_modules','.tmp','dist','build','data','output','uploads','backups','logs','.env*','*.jks','*.p12','*.key'))
        (work/'native/windows/server.json').write_text(json.dumps({'serverUrl': origin, 'serverId': server_id}))
        package = work/'native/windows/package.json'
        metadata = json.loads(package.read_text())
        metadata['build']['appId'] = f'com.zdis.server.s{server_id}'
        metadata['build']['productName'] = f'ZDis {server_id}'
        package.write_text(json.dumps(metadata, indent=2))
        for platform in ('android','windows'):
            run(['docker','build','-t',f'zdis-{platform}-builder','-f',work/f'native/docker/{platform}.Dockerfile',work])
        staged = Path(temp)/'artifacts'
        staged.mkdir()
        # Keep persistent signing keys private to the installer owner. Containers
        # receive a disposable read-only copy and run as an unprivileged UID,
        # including when the server installer itself is invoked as root.
        session_keys = Path(temp)/'signing'
        shutil.copytree(keys, session_keys)
        uid = os.getuid() or 10001
        gid = os.getgid() if os.getuid() else 10001
        if os.getuid() == 0:
            for folder in (work, staged, session_keys):
                os.chown(folder, uid, gid)
                for child in folder.rglob('*'):
                    if not child.is_symlink(): os.chown(child, uid, gid)
        common = ['docker','run','--rm','--user',f'{uid}:{gid}',
                  '-e','HOME=/tmp/zdis-builder-home','-e','WINEPREFIX=/tmp/zdis-wine',
                  '-v',f'{work}:/build','-v',f'{session_keys}:/signing:ro','-v',f'{staged}:/output']
        android_env = {**env, 'CAPACITOR_SERVER_URL': origin, 'ZDIS_APP_ID': f'com.zdis.server.s{server_id}',
                       'ZDIS_APP_NAME': f'ZDis {server_id}'}
        run(common + ['-e','ZDIS_SIGNING_PASSWORD','-e','CAPACITOR_SERVER_URL','-e','ZDIS_APP_ID','-e','ZDIS_APP_NAME',
            'zdis-android-builder','bash','-euc',
            'mkdir -p "$HOME"; npm ci; npm run build; cd client; npx cap sync android; cd android; '
            'bash gradlew --no-daemon assembleRelease; '
            'cp app/build/outputs/apk/release/app-release.apk /output/ZDis.apk; '
            '$ANDROID_HOME/build-tools/36.0.0/apksigner verify --verbose /output/ZDis.apk'], env=android_env)
        run(common + ['-e','CSC_LINK=/signing/windows.p12','-e','CSC_KEY_PASSWORD',
            'zdis-windows-builder','bash','-euc',
            'mkdir -p "$HOME"; cd native/windows; npm ci; npx electron-builder --win nsis --x64 --publish never; '
            'cp dist/ZDis-Setup.exe /output/ZDis-Setup.exe'], env=env)
        for name in ('ZDis.apk', 'ZDis-Setup.exe'):
            shutil.copyfile(staged/name, output/(name+'.tmp'))
        for name in ('ZDis.apk', 'ZDis-Setup.exe'):
            os.replace(output/(name+'.tmp'), output/name)
    # The manifest is written only after BOTH signed builds succeed.
    files = {name: hashlib.sha256((output/name).read_bytes()).hexdigest() for name in ('ZDis.apk','ZDis-Setup.exe')}
    (output/'manifest.json').write_text(json.dumps({'serverUrl':origin,'serverId':server_id,'sha256':files,
      'windowsTrust':'server-self-signed; install certificate only after verifying its fingerprint'}, indent=2))
    shutil.copyfile(keys/'windows.crt', output/'ZDis-Server-Certificate.crt')
    print('Dedicated clients ready:', output)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', default='/var/lib/zdis/clients')
    parser.add_argument('--signing-dir', default='/var/lib/zdis-client-signing')
    args=parser.parse_args()
    build(args.url,args.output,args.signing_dir,Path(__file__).resolve().parents[1])
