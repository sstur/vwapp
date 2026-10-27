import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from vwintegrity.server import handler_for, valid_request


class FakeService:
    config = {'apiKey': 'a' * 48}
    last_success = None
    calls = 0

    def mint(self, body):
        self.calls += 1
        return 200, {'token': 'private-integrity-token'}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(self.service))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body, auth=True, path='/v1/integrity'):
        c = http.client.HTTPConnection(*self.server.server_address)
        headers = {'Authorization': 'Bearer ' + self.service.config['apiKey']} if auth else {}
        c.request('POST', path, json.dumps(body), headers)
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, json.loads(data), r.getheader('Cache-Control')

    def test_auth_required_before_any_mint(self):
        self.assertEqual(self.request({'requestHash': 'a'*43+'='}, auth=False)[0], 401)
        self.assertEqual(self.service.calls, 0)

    def test_rejects_credentials_extra_fields_and_invalid_hashes(self):
        for body in [{'password':'secret'}, {'requestHash':'short'}, {'requestHash':'a'*43+'=', 'token':'secret'}, []]:
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.service.calls, 0)

    def test_only_integrity_route_and_no_cache(self):
        body = {'requestHash':'a'*43+'='}
        self.assertTrue(valid_request(body))
        self.assertEqual(self.request(body, path='/command')[0], 404)
        status, response, cache = self.request(body)
        self.assertEqual(status, 200)
        self.assertIn('token', response)
        self.assertEqual(cache, 'no-store')
        self.assertEqual(self.service.calls, 1)


if __name__ == '__main__':
    unittest.main()
