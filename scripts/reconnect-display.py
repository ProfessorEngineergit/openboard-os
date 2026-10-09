#!/usr/bin/env python3
"""Reapply display/touch settings after X11 display or USB hotplug."""
import os
import re
import subprocess
import sys
import time

os.environ.setdefault('DISPLAY', ':0')
os.environ.setdefault('XAUTHORITY', os.path.expanduser('~/.Xauthority'))

# Desired orientation comes from the OpenBoard controller (state file); landscape if unset.
# Each entry: xrandr rotation, expected geometry, libinput coordinate transformation matrix.
ORIENTATIONS = {
    'landscape':         ('normal',   '1920x1080+0+0', None),
    'portrait':          ('left',     '1080x1920+0+0', ['0', '-1', '1', '1', '0', '0', '0', '0', '1']),
    'landscape-flipped': ('inverted', '1920x1080+0+0', ['-1', '0', '1', '0', '-1', '1', '0', '0', '1']),
    'portrait-flipped':  ('right',    '1080x1920+0+0', ['0', '1', '0', '-1', '0', '1', '0', '0', '1']),
}
STATE_DIR = os.environ.get('OPENBOARD_STATE_DIR') or os.path.expanduser('~/.local/state/openboard')

def desired_orientation():
    try:
        with open(os.path.join(STATE_DIR, 'orientation')) as handle:
            name = handle.read().strip()
        return name if name in ORIENTATIONS else 'landscape'
    except OSError:
        return 'landscape'

def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=8)

def connected_outputs(text):
    blocks = re.split(r'(?=^\S+ (?:dis)?connected\b)', text, flags=re.M)
    found = []
    for block in blocks:
        match = re.match(r'^(\S+) connected\b([^\n]*)', block)
        if match and re.search(r'^\s+1920x1080\s', block, re.M):
            found.append((match[1], match[2].strip()))
    return found

def sharp_devices(text):
    return re.findall(r'Sharp SHARP LT60 TouchPanel[^\n]*?id=(\d+)', text)

last = None
while True:
    try:
        query = run('xrandr', '--query')
        if query.returncode:
            last = None
        else:
            outputs = connected_outputs(query.stdout)
            devices = sharp_devices(run('xinput', 'list', '--short').stdout)
            orientation = desired_orientation()
            signature = (tuple(outputs), tuple(devices), orientation)
            if outputs and signature != last:
                output, geometry = outputs[0]
                rotate, expected, matrix = ORIENTATIONS[orientation]
                current = re.search(r'\+0\+0 (left|right|inverted)', geometry)
                if expected not in geometry or (current.group(1) if current else 'normal') != rotate:
                    result = run('xrandr', '--output', output, '--mode', '1920x1080', '--rate', '60', '--rotate', rotate, '--primary', '--pos', '0x0')
                    if result.returncode:
                        raise RuntimeError(result.stderr.strip())
                for device in devices:
                    run('xinput', 'enable', device)
                    run('xinput', 'map-to-output', device, output)
                    # One output at 0,0 covers the whole screen, so the rotation matrix replaces the mapping.
                    if matrix:
                        run('xinput', 'set-prop', device, 'Coordinate Transformation Matrix', *matrix)
                run('xset', 's', 'off')
                run('xset', '-dpms')
                print(f'Ready: {output}, Full HD, {orientation}, {len(devices)} Sharp input devices', flush=True)
                last = signature
            elif not outputs:
                last = None
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
        print(f'Reconnect pending: {error}', file=sys.stderr, flush=True)
        last = None
    if '--once' in sys.argv:
        break
    time.sleep(3)
