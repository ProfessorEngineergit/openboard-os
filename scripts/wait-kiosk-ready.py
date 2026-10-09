#!/usr/bin/env python3
"""Wait for the X session and both local apps before opening the kiosk."""
import os
import subprocess
import time
import urllib.request

os.environ.setdefault('DISPLAY', ':0')
os.environ.setdefault('XAUTHORITY', os.path.expanduser('~/.Xauthority'))
attempt = 0
while True:
    try:
        x = subprocess.run(['xset', 'q'], capture_output=True, timeout=3)
        if x.returncode:
            raise RuntimeError('X session is not ready')
        for url in ('http://localhost:4173/', 'http://localhost:4180/health'):
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status != 200:
                    raise RuntimeError('Local app is not ready')
        print('X session and kiosk apps are ready', flush=True)
        break
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        if attempt % 15 == 0:
            print('Waiting for X session and kiosk apps…', flush=True)
        attempt += 1
        time.sleep(1)
