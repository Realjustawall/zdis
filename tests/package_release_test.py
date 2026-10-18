import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('package_release', Path(__file__).resolve().parents[1] / 'scripts/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_both_platforms_keep_sources_and_ui_without_local_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            required = ['package-lock.json', 'client/dist/index.html', 'client/dist/sw.js',
                        'server/src/index.js', 'ubuntu/setup.sh', 'ubuntu/start.sh',
                        'ubuntu/.env.ubuntu.example', 'windows/setup.ps1', 'windows/start.ps1',
                        'windows/.env.windows.example', '.env.example', 'README.md']
            for name in required:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('content: ' + name, encoding='utf-8')
            (root / 'package.json').write_text(json.dumps({'version': '1.0.1'}), encoding='utf-8')
            (root / 'release-platform.json').write_text(json.dumps({'platform': 'ubuntu', 'product': 'ZDIS'}), encoding='utf-8')
            for name in ['.env', 'server/data/private.db', 'node_modules/private.js', 'local.log']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('must not ship', encoding='utf-8')
            for platform in ['ubuntu', 'windows']:
                output = Path(directory) / ('release.tar.gz' if platform == 'ubuntu' else 'release.zip')
                result = release.package(root, platform, output)
                self.assertEqual(result['version'], '1.0.1')
                self.assertEqual(len(result['sha256']), 64)
                if platform == 'windows':
                    with zipfile.ZipFile(output) as archive:
                        contents = {n.split('/', 1)[1]: archive.read(n) for n in archive.namelist()}
                else:
                    with tarfile.open(output) as archive:
                        contents = {e.name.split('/', 1)[1]: archive.extractfile(e).read() for e in archive.getmembers()}
                        self.assertEqual(archive.getmember('zdis-ubuntu/ubuntu/setup.sh').mode, 0o755)
                self.assertEqual(set(contents), set(required + ['package.json', 'release-platform.json']))
                self.assertEqual(json.loads(contents['release-platform.json'])['platform'], platform)
                self.assertEqual(contents['client/dist/index.html'], b'content: client/dist/index.html')

    def test_rejects_missing_build_instead_of_publishing_an_incomplete_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"version":"1.0.1"}', encoding='utf-8')
            (root / 'release-platform.json').write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Missing release file'):
                release.package(root, 'ubuntu', root / 'release.tar.gz')


if __name__ == '__main__':
    unittest.main()
