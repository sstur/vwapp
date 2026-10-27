"""Run in an isolated child: Frida/JNI calls have an enforceable outer deadline."""
import json
import sys
import time
from pathlib import Path

import frida
from .device import Device


def mint(config, request_hash):
    device = Device(config)
    pid = device.ready()
    connection = frida.get_device(config['serial'], timeout=10).attach(pid)
    script = None
    try:
        source = Path(__file__).resolve().parents[1] / 'dist' / 'agent.js'
        script = connection.create_script(source.read_text())
        script.load()
        rpc = script.exports_sync

        def wait():
            until = time.monotonic() + 25
            while time.monotonic() < until:
                result = rpc.poll()
                if not result.get('pending'):
                    if result.get('error'):
                        raise RuntimeError('INTEGRITY_REJECTED')
                    return result
                time.sleep(.2)
            raise TimeoutError('INTEGRITY_TIMEOUT')

        rpc.prepare()
        if not wait().get('ready'):
            raise RuntimeError('INTEGRITY_NOT_READY')
        rpc.request(request_hash)
        token = wait().get('token')
        if not isinstance(token, str) or not 100 < len(token) < 20000:
            raise RuntimeError('INVALID_INTEGRITY_RESPONSE')
        return token
    finally:
        if script is not None:
            script.unload()
        connection.detach()


if __name__ == '__main__':
    try:
        config = json.loads(Path(sys.argv[1]).read_text())
        body = json.load(sys.stdin)
        print(json.dumps({'token': mint(config, body['requestHash'])}), flush=True)
    except Exception as error:
        # Native/provider exception text can contain implementation details. Never
        # forward it, nor any token/hash/config, to logs or remote callers.
        print(json.dumps({'event': 'mint_failed', 'type': type(error).__name__}), file=sys.stderr, flush=True)
        print(json.dumps({'error': 'INTEGRITY_UNAVAILABLE'}), flush=True)
        sys.exit(1)
