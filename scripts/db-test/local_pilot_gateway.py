#!/usr/bin/env python3
"""Loopback-only acceptance gateway for the disposable Pilot stack."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import http.client
import json
import os
from pathlib import Path

RECOVERY = os.environ.get('PILOT_RECOVERY_STACK') == '1'
PRIVATE = (Path.home()/'.local/share/cloud-nexus-pilot/recovery-test/private.json') if RECOVERY else Path('/private/tmp/cnp-pilot-local-stack/private.json')
AUTH_PORT, REST_PORT, GATEWAY_PORT = (59091, 59092, 59090) if RECOVERY else (58091, 58092, 58090)
config = json.loads(PRIVATE.read_text())
allowed_origins = {'http://127.0.0.1:43101', 'http://localhost:43101', 'http://127.0.0.1:43102'} if RECOVERY else {'http://127.0.0.1:3100', 'http://localhost:3100', 'http://127.0.0.1:3000', 'http://localhost:3000'}


class Gateway(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Do not log tokens, request paths/queries, bodies or user content.

    def cors(self):
        origin = self.headers.get('origin')
        if origin in allowed_origins:
            self.send_header('access-control-allow-origin', origin)
            self.send_header('access-control-allow-credentials', 'true')
            self.send_header('vary', 'origin')

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.cors()
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.send_header('connection', 'close')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if self.headers.get('origin') not in allowed_origins:
            return self.reply(403, {'error': 'origin_denied'})
        self.send_response(204)
        self.cors()
        self.send_header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
        self.send_header('access-control-allow-headers', 'apikey,authorization,content-type,x-client-info,x-supabase-api-version,prefer,accept-profile,content-profile')
        self.send_header('content-length', '0')
        self.end_headers()

    def proxy(self):
        origin = self.headers.get('origin')
        if origin and origin not in allowed_origins:
            return self.reply(403, {'error': 'origin_denied'})
        if self.path.startswith('/auth/v1/'):
            port, path = AUTH_PORT, self.path[len('/auth/v1'):]
        elif self.path.startswith('/rest/v1/'):
            port, path = REST_PORT, self.path[len('/rest/v1'):]
        else:
            return self.reply(404, {'error': 'not_found'})
        key = self.headers.get('apikey', '')
        health = self.command == 'GET' and path.split('?')[0] == '/health' and port == AUTH_PORT
        if not health and not any(hmac.compare_digest(key, config[name]) for name in ('anon_key', 'service_key')):
            return self.reply(401, {'error': 'invalid_api_key'})
        try:
            length = int(self.headers.get('content-length', '0'))
            if length < 0 or length > 2_100_000 or self.headers.get('transfer-encoding'):
                return self.reply(413, {'error': 'invalid_or_excessive_body'})
            self.connection.settimeout(10)
            body = self.rfile.read(length) if length else None
            if body is not None and len(body) != length:
                return self.reply(400, {'error': 'incomplete_body'})
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in {'host', 'connection', 'transfer-encoding', 'content-length'}}
            headers['x-forwarded-proto'] = 'http'
            headers['x-forwarded-host'] = '127.0.0.1:'+str(GATEWAY_PORT)
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            try:
                conn.request(self.command, path, body, headers)
                response = conn.getresponse()
                data = response.read(2_100_001)
                if len(data) > 2_100_000:
                    return self.reply(502, {'error': 'upstream_response_excessive'})
                self.send_response(response.status)
                self.cors()
                for key, value in response.getheaders():
                    if key.lower() not in {'connection', 'transfer-encoding', 'content-length', 'access-control-allow-origin', 'access-control-allow-credentials', 'vary'}:
                        self.send_header(key, value)
                self.send_header('content-length', str(len(data)))
                self.send_header('connection', 'close')
                self.end_headers()
                self.wfile.write(data)
            finally:
                conn.close()
        except Exception:
            self.reply(502, {'error': 'local_upstream_unavailable'})

    do_GET = proxy
    do_POST = proxy
    do_PATCH = proxy
    do_PUT = proxy
    do_DELETE = proxy


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', GATEWAY_PORT), Gateway)
    print('Pilot local acceptance gateway listening on 127.0.0.1:'+str(GATEWAY_PORT), flush=True)
    server.serve_forever()
