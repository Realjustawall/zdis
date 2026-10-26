#!/usr/bin/env python3
"""Install/launch smoke only; the reserved CI origin intentionally has no server."""
import json
from pathlib import Path
import subprocess
import sys
import time

directory = Path(sys.argv[1]).resolve()
manifest = json.loads((directory/'manifest.json').read_text())
package = 'com.zdis.server.s' + manifest['serverId']


def adb(*args):
    return subprocess.check_output(['adb', *args], text=True, stderr=subprocess.STDOUT)


try:
    adb('install', '-r', str(directory/'ZDis.apk'))
    adb('logcat', '-c')
    result = adb('shell', 'am', 'start', '-W', '-n', package+'/com.zdis.chat.MainActivity')
    (directory/'android-launch.txt').write_text(result)
    if 'Status: ok' not in result:
        raise RuntimeError('Activity launch failed: ' + result)
    for _ in range(10):
        time.sleep(1)
        if not adb('shell', 'pidof', package).strip():
            raise RuntimeError('Android app process exited during launch')
    log = adb('logcat', '-d', '-b', 'crash')
    if package in log and 'FATAL EXCEPTION' in log:
        raise RuntimeError('Android crash detected: ' + log)
    print('APK installed and remained running; native install/launch smoke passed.')
finally:
    (directory/'android-logcat.txt').write_text(adb('logcat', '-d'))
