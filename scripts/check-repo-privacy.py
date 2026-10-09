#!/usr/bin/env python3
"""Check staged/tracked repository files without printing matching secrets."""
import re
import subprocess
import sys
import struct

files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
files = [name for name in files if name]
if not files:
    raise SystemExit('No tracked files to check; stage the source files first.')
blocked_prefixes = ('logs/', 'backups/', 'kiosk/data/', 'gods-eye-view/', 'vendor/', 'remote/novnc/')
# Generated third-party bundles (minified) contain random strings that look like keys.
generated_prefixes = ('kiosk/apps/board/dist/', 'kiosk/vendor/liquid-glass/glass-runtime.js', 'kiosk/ui/fonts/')
blocked_names = {'kiosk/config.json', 'kiosk/api-token', '.env'}
public_images = {'docs/screenshots/dock.png', 'docs/screenshots/astra.png', 'docs/screenshots/board.png', 'docs/screenshots/settings.png'}
patterns = {
    'provider key': re.compile(r'(?:AIza[\w-]{30,}|sk-[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})'),
    'private key': re.compile(r'BEGIN [A-Z ]*PRIVATE KEY'),
    'private network address': re.compile(r'\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b'),
    'personal home path': re.compile(r'/(?:Users|home)/[^/\s]+/'),
    'literal API token': re.compile(r'''["'][a-f0-9]{64}["']'''),
}
errors = []
for name in files:
    if name.startswith(blocked_prefixes) or name in blocked_names or name.startswith('.env.'):
        errors.append((name, 'runtime/private file'))
        continue
    if name.startswith(generated_prefixes):
        continue
    # Inspect the exact index content that will be committed, not the working copy.
    raw = subprocess.check_output(['git', 'show', ':' + name])
    if name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
        if name not in public_images or not raw.startswith(b'\x89PNG\r\n\x1a\n'):
            errors.append((name, 'unapproved image'))
            continue
        # Metadata checks complement, but cannot replace, visual privacy review.
        offset = 8
        while offset < len(raw):
            if offset + 12 > len(raw):
                errors.append((name, 'invalid PNG')); break
            length = struct.unpack('>I', raw[offset:offset + 4])[0]
            kind = raw[offset + 4:offset + 8]
            if kind not in {b'IHDR', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'cHRM', b'pHYs'}:
                errors.append((name, 'unexpected PNG metadata'))
            offset += length + 12
            if offset > len(raw):
                errors.append((name, 'invalid PNG')); break
        continue
    content = raw.decode('utf-8', errors='replace')
    for label, pattern in patterns.items():
        if pattern.search(content): errors.append((name, label))
if errors:
    for name, label in errors: print(f'{name}: {label}', file=sys.stderr)
    raise SystemExit(1)
print(f'Privacy check passed for {len(files)} tracked files (images still require visual review).')
