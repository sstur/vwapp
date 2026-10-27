import argparse
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HASH_PATTERN = re.compile(r'[A-Za-z0-9_-]{43}=\Z')


def valid_request(body):
    return (isinstance(body, dict) and set(body) == {'requestHash'}
            and isinstance(body['requestHash'], str)
            and HASH_PATTERN.fullmatch(body['requestHash']) is not None)


class Service:
    def __init__(self, config_path):
        self.path = str(Path(config_path).resolve())
        self.config = json.loads(Path(self.path).read_text())
        if len(self.config['apiKey']) < 32:
            raise ValueError('apiKey must have at least 32 random characters')
        self.lock = threading.Lock()
        self.last_success = None

    def mint(self, body):
        if not self.lock.acquire(timeout=1):
            return 503, {'error': 'BRIDGE_BUSY'}
        started = time.monotonic()
        try:
            # A separate process bounds attach/RPC stalls and releases native
            # resources on exit; the HTTP server remains responsive throughout.
            result = subprocess.run(
                [sys.executable, '-m', 'vwintegrity.mint', self.path],
                input=json.dumps(body), capture_output=True, text=True, timeout=75,
            )
            if result.returncode:
                print(json.dumps({'event': 'mint_child_failed', 'exitCode': result.returncode}), flush=True)
            response = json.loads(result.stdout)
            if result.returncode or not isinstance(response.get('token'), str):
                return 503, {'error': 'INTEGRITY_UNAVAILABLE'}
            self.last_success = int(time.time() * 1000)
            return 200, response
        except (subprocess.TimeoutExpired, ValueError, OSError):
            return 503, {'error': 'INTEGRITY_UNAVAILABLE'}
        finally:
            print(json.dumps({'event': 'integrity_request', 'durationMs': round((time.monotonic()-started)*1000)}), flush=True)
            self.lock.release()


def handler_for(service):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *args):
            pass  # No paths, authorization, request bodies or tokens in access logs.

        def reply(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            supplied = self.headers.get('Authorization', '')
            if not hmac.compare_digest(supplied.encode(), ('Bearer '+service.config['apiKey']).encode()):
                self.reply(401, {'error': 'UNAUTHORIZED'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != '/healthz':
                return self.reply(404, {'error': 'NOT_FOUND'})
            self.reply(200, {'ok': True, 'service': 'vw-integrity', 'lastSuccessAt': service.last_success})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != '/v1/integrity':
                return self.reply(404, {'error': 'NOT_FOUND'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1024 or self.headers.get('Transfer-Encoding'):
                    return self.reply(400, {'error': 'INVALID_REQUEST'})
                body = json.loads(self.rfile.read(size))
                if not valid_request(body):
                    return self.reply(400, {'error': 'INVALID_REQUEST'})
            except (ValueError, TimeoutError):
                return self.reply(400, {'error': 'INVALID_REQUEST'})
            status, response = service.mint(body)
            self.reply(status, response)
    return Handler


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    service = Service(args.config)
    server = ThreadingHTTPServer((service.config['host'], service.config['port']), handler_for(service))
    print('VW integrity bridge ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
