import importlib.util
import hashlib
import json
import pathlib
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from unittest.mock import patch

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('builder', root/'scripts/build-server-clients.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
verification_spec = importlib.util.spec_from_file_location('artifact_verifier', root/'scripts/verify-native-artifacts.py')
artifact_verifier = importlib.util.module_from_spec(verification_spec)
verification_spec.loader.exec_module(artifact_verifier)

class NativeClientTests(unittest.TestCase):
    def test_real_artifact_verifier_rejects_tampering_and_wrong_server(self):
        origin = 'https://ci.zdis.invalid'
        server_id = hashlib.sha256(origin.encode()).hexdigest()[:12]
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            config = {'appId': 'com.zdis.server.s'+server_id, 'server': {'url': origin, 'cleartext': False}}
            with zipfile.ZipFile(directory/'ZDis.apk', 'w') as apk:
                apk.writestr('assets/capacitor.config.json', json.dumps(config))
                apk.writestr('classes.dex', b'x'*2048)
            (directory/'ZDis-Setup.exe').write_bytes(b'MZ'+b'x'*2048)
            manifest = {'serverUrl': origin, 'serverId': server_id, 'sha256': {
                name: hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ('ZDis.apk', 'ZDis-Setup.exe')}}
            (directory/'manifest.json').write_text(json.dumps(manifest))
            artifact_verifier.verify(directory, origin)
            with self.assertRaisesRegex(ValueError, 'different server'):
                artifact_verifier.verify(directory, 'https://other.invalid')
            (directory/'ZDis-Setup.exe').write_bytes(b'MZtampered')
            with self.assertRaisesRegex(ValueError, 'hash'):
                artifact_verifier.verify(directory, origin)

    def test_android_source_and_optional_capture_hardware_are_packaged(self):
        main = root/'client/android/app/src/main'
        android = '{http://schemas.android.com/apk/res/android}'
        manifest = ET.parse(main/'AndroidManifest.xml').getroot()
        features = {node.get(android+'name'): node.get(android+'required') for node in manifest.findall('uses-feature')}
        for feature in ('android.hardware.microphone', 'android.hardware.camera', 'android.hardware.camera.any', 'android.hardware.camera.autofocus'):
            self.assertEqual(features.get(feature), 'false', feature)
        activity = manifest.find('application/activity').get(android+'name')
        self.assertEqual(activity, 'com.zdis.chat.MainActivity')
        self.assertTrue((main/'java/com/zdis/chat/MainActivity.java').is_file())
        self.assertTrue((main/'res/values/styles.xml').is_file())

    def test_origin_validation(self):
        for invalid in ('http://server.test', 'https://u:p@server.test', 'https://server.test/path',
                        'https://server.test?x=1', 'file:///tmp/test', 'https://server.test/#x'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                builder.validate_origin(invalid)
        self.assertEqual(builder.validate_origin('https://server.test:443/'), 'https://server.test:443')

    def test_failed_build_does_not_publish_or_expose_signing_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = pathlib.Path(temp)
            calls = []
            def fake_run(args, **kwargs):
                args = list(map(str,args)); calls.append((args, kwargs))
                if args[:2] == ['openssl','req']:
                    pathlib.Path(args[args.index('-keyout')+1]).write_text('key')
                    pathlib.Path(args[args.index('-out')+1]).write_text('cert')
                elif args[0] in ('openssl','keytool'):
                    flag = '-out' if args[0] == 'openssl' else '-keystore'
                    pathlib.Path(args[args.index(flag)+1]).write_text('signing-key')
                elif args[:2] == ['docker','run']:
                    raise RuntimeError('simulated toolchain failure')
            # Docker and ownership changes are OS boundaries, not performed by
            # this control-flow test (the isolated runner can lack UID maps).
            with patch.object(builder, 'run', fake_run), patch.object(builder.os, 'chown'):
                with self.assertRaisesRegex(RuntimeError, 'toolchain'):
                    builder.build('https://server.test',temp/'downloads',temp/'signing',root)
            self.assertFalse((temp/'downloads/manifest.json').exists())
            self.assertEqual(list((temp/'downloads').iterdir()), [])
            password = next((temp/'signing').glob('*/password')).read_text()
            self.assertTrue(all(password not in str(args) for args, _ in calls))
            containers = [args for args, _ in calls if args[:2] == ['docker', 'run']]
            self.assertTrue(containers)
            for args in containers:
                self.assertNotEqual(args[args.index('--user')+1].split(':')[0], '0')
                self.assertFalse(any(str(temp/'signing') in arg for arg in args))
            self.assertTrue(all((p.stat().st_mode & 0o077) == 0 for p in (temp/'signing').glob('*/*')))

if __name__ == '__main__': unittest.main()
