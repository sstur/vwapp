"""Install an existing named Cloudflare Tunnel as a macOS login service."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--token-file', type=Path, required=True)
p.add_argument('--stop', action='store_true')
a = p.parse_args()
os.umask(0o077)
label = 'com.vwapp.android-tunnel'
plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
domain = 'gui/' + str(os.getuid())
if a.stop:
    subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
    plist.unlink(missing_ok=True)
else:
    token = a.token_file.expanduser().resolve()
    if token.stat().st_mode & 0o077:
        p.error('Tunnel token must have mode 600')
    executable = shutil.which('cloudflared') or '/opt/homebrew/bin/cloudflared'
    if plist.exists():
        p.error('Tunnel service already exists; stop it before reinstalling')
    plist.parent.mkdir(parents=True, exist_ok=True)
    with plist.open('wb') as f:
        plistlib.dump({'Label': label,
                      'ProgramArguments': [executable, 'tunnel', '--no-autoupdate', 'run', '--token-file', str(token)],
                      'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
                      'StandardOutPath': str(token.parent / 'tunnel.log'),
                      'StandardErrorPath': str(token.parent / 'tunnel-error.log')}, f)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('Tunnel service installed')
