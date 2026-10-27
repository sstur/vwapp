"""Install an already configured/built bridge as a per-user macOS LaunchAgent."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
config = args.config.expanduser().resolve()
if not config.is_file() or not (root/'dist/agent.js').is_file():
    raise SystemExit('Create the private config and build the agent first')
label = 'com.vwapp.integrity-bridge'
plist = Path.home()/'Library/LaunchAgents'/f'{label}.plist'
plist.parent.mkdir(parents=True, exist_ok=True)
config.chmod(0o600)
settings = {
    'Label': label, 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
    'WorkingDirectory': str(root),
    'ProgramArguments': [str(root/'.venv/bin/python'), '-m', 'vwintegrity.server', '--config', str(config)],
    'EnvironmentVariables': {'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1'},
    'StandardOutPath': str(config.parent/'service.log'),
    'StandardErrorPath': str(config.parent/'service-error.log'),
}
plist.write_bytes(plistlib.dumps(settings));plist.chmod(0o600)
domain = f'gui/{os.getuid()}'
subprocess.run(['launchctl', 'bootout', domain+'/'+label], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
print('Installed '+label)
