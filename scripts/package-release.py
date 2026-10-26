"""Build and verify source/server distributions with the freshly built web UI."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import zipfile

EXCLUDED_DIRS = {
    '.git', 'node_modules', '.tmp', '.playwright-cli', '__pycache__',
    'output', 'data', 'uploads', 'logs', 'backups', 'test-results',
    'playwright-report', 'coverage', 'Saved',
}


def package(root, platform, destination):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    metadata = json.loads((root / 'release-platform.json').read_text(encoding='utf-8'))
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    metadata.update(platform=platform, version=version)
    prefix = 'zdis-windows-server' if platform == 'windows' else 'zdis-ubuntu'
    files = {}
    for directory, children, filenames in os.walk(root, followlinks=False):
        children[:] = sorted(name for name in children if name not in EXCLUDED_DIRS)
        for name in sorted(children + filenames):
            if (Path(directory) / name).is_symlink():
                raise ValueError('Release sources must not contain symlinks: ' + name)
        for name in sorted(filenames):
            source = Path(directory) / name
            if source.resolve() == destination:
                continue
            if name.startswith('.env') and not name.endswith('.example'):
                continue
            if name.endswith(('.log', '.db', '.sqlite', '.sqlite3', '.sqlite3-wal',
                              '.sqlite3-shm', '.tsbuildinfo', '.zip', '.tar.gz', '.pyc', '.jks', '.p12', '.key')):
                continue
            relative = source.relative_to(root).as_posix()
            content = source.read_bytes()
            if relative == 'release-platform.json':
                content = (json.dumps(metadata, indent=2) + '\n').encode('utf-8')
            files[relative] = content
    required = ['package.json', 'package-lock.json', 'client/dist/index.html',
                'client/dist/sw.js', 'server/src/index.js', 'release-platform.json']
    required += ['windows/setup.ps1', 'windows/start.ps1', 'windows/.env.windows.example'] if platform == 'windows' else ['ubuntu/setup.sh', 'ubuntu/start.sh', 'ubuntu/.env.ubuntu.example']
    for name in required:
        if name not in files:
            raise ValueError('Missing release file: ' + name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if platform == 'windows':
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(files.items()):
                archive.writestr(prefix + '/' + name, content)
        with zipfile.ZipFile(destination) as archive:
            extracted = {name[len(prefix) + 1:]: archive.read(name) for name in archive.namelist()}
    else:
        with tarfile.open(destination, 'w:gz') as archive:
            for name, content in sorted(files.items()):
                entry = tarfile.TarInfo(prefix + '/' + name)
                entry.size = len(content)
                entry.mode = 0o755 if name.endswith('.sh') else 0o644
                archive.addfile(entry, io.BytesIO(content))
        with tarfile.open(destination, 'r:gz') as archive:
            extracted = {entry.name[len(prefix) + 1:]: archive.extractfile(entry).read() for entry in archive.getmembers()}
    # Verify every included file, not only the archive's required entry points.
    if files != extracted:
        raise ValueError('Archive contents differ from the release source files')
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return {'platform': platform, 'version': version, 'files': len(files), 'sha256': digest, 'archive': str(destination)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--platform', choices=['ubuntu', 'windows'], required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.root, args.platform, args.output), indent=2))
