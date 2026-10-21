import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from vwbridge.device import BridgeError
from vwbridge.server import BridgeServer, Journal


VIN = "WVWZZZ1JZXW000001"
KEY = "test-key-" * 8


class Driver:
    def __init__(self):
        self.calls = 0
        self.failure = False

    def climate(self, enabled):
        self.calls += 1
        if self.failure:
            raise BridgeError("OUTCOME_UNKNOWN", "Device disconnected")
        return {"climateOn": enabled}

    def status(self):
        return {"soc": 50}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "requests.sqlite3"
        self.journal = Journal(self.path)
        self.driver = Driver()
        self.server = BridgeServer(("127.0.0.1", 0),
                                   {"apiKey": KEY, "vin": VIN, "commandsEnabled": True},
                                   self.driver, self.journal)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method="POST", path="/v1/climate", body=None, key=KEY):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        if body is None:
            body = {"requestId": "test-request-001", "vin": VIN, "enabled": True}
        connection.request(method, path, json.dumps(body) if method == "POST" else None, headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_unauthorized_never_touches_device(self):
        self.assertEqual(self.request(key="wrong")[0], 401)
        self.assertEqual(self.request("GET", "/v1/status", key="")[0], 401)
        self.assertEqual(self.driver.calls, 0)

    def test_validates_vin_and_boolean_before_device_access(self):
        for body in [{"requestId": "test-0001", "vin": VIN, "enabled": "false"},
                     {"requestId": "test-0001", "vin": "wrong", "enabled": False},
                     {"requestId": "test-0001", "vin": VIN, "enabled": True, "shell": "anything"}]:
            self.assertEqual(self.request(body=body)[0], 400)
        self.assertEqual(self.driver.calls, 0)

    def test_retry_returns_saved_result_and_conflict_does_not_overwrite_it(self):
        first = self.request()
        self.assertEqual(first[0], 200)
        self.assertEqual(self.request(), first)
        changed = {"requestId": "test-request-001", "vin": VIN, "enabled": False}
        self.assertEqual(self.request(body=changed)[1]["error"], "IDEMPOTENCY_CONFLICT")
        self.assertEqual(self.request(), first)
        self.assertEqual(self.driver.calls, 1)

    def test_unknown_outcome_is_not_reexecuted(self):
        self.driver.failure = True
        first = self.request()
        self.assertEqual(first[1]["error"], "OUTCOME_UNKNOWN")
        self.assertEqual(self.request(), first)
        self.assertEqual(self.driver.calls, 1)

    def test_busy_phone_rejects_read_and_write(self):
        with self.server.device_lock:
            self.assertEqual(self.request()[1]["error"], "DEVICE_BUSY")
            self.assertEqual(self.request("GET", "/v1/status")[1]["error"], "DEVICE_BUSY")
        self.assertEqual(self.driver.calls, 0)

    def test_crash_pending_record_becomes_unknown_after_restart(self):
        body = {"requestId": "test-crash-001", "vin": VIN, "enabled": True}
        self.assertIsNone(self.journal.begin(body["requestId"], body))
        restarted = Journal(self.path)
        self.assertEqual(restarted.begin(body["requestId"], body)[1]["error"], "OUTCOME_UNKNOWN")

    def test_no_generic_device_endpoint(self):
        self.assertEqual(self.request(path="/shell")[0], 404)
        self.assertEqual(self.request("GET", "/screenshot")[0], 404)


if __name__ == "__main__":
    unittest.main()
