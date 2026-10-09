#!/usr/bin/env python3
"""Check staged/tracked repository files without printing matching secrets."""
import re
import subprocess
import sys

files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
files = [name for name in files if name]
if not files:
    raise SystemExit('No tracked files to check; stage the source files first.')
blocked_prefixes = ('logs/', 'backups/', 'kiosk/data/', 'gods-eye-view/', 'vendor/', 'remote/novnc/')
blocked_names = {'kiosk/config.json', 'kiosk/api-token', '.env'}
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
    # Inspect the exact index content that will be committed, not the working copy.
    content = subprocess.check_output(['git', 'show', ':' + name]).decode('utf-8', errors='replace')
    for label, pattern in patterns.items():
        if pattern.search(content): errors.append((name, label))
if errors:
    for name, label in errors: print(f'{name}: {label}', file=sys.stderr)
    raise SystemExit(1)
print(f'Privacy check passed for {len(files)} source files.')
