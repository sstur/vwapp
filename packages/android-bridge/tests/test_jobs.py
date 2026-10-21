import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vwbridge.device import BridgeError
from vwbridge.jobs import Jobs, validate
from vwbridge.server import Journal


class JobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'journal.sqlite3'
        self.server = SimpleNamespace(config={'apiKey': 'key' * 32, 'commandsEnabled': True},
                                      device_lock=threading.Lock(), driver=SimpleNamespace(device=None), journal=Journal(self.path))
        self.jobs = Jobs(self.server)
        self.body = {'requestId': 'test-request-001', 'operation': 'status', 'vin': 'WVWZZZ1JZXW000001',
                     'credentials': {'username': 'example@example.com', 'password': 'secret-password', 'spin': '1234'}, 'params': {}}

    def tearDown(self):
        for _ in range(100):
            if self.jobs.active is None: break
            time.sleep(.01)
        self.temp.cleanup()

    def wait(self):
        for _ in range(100):
            result = self.jobs.get(self.body['requestId'])
            if result and result['state'] != 'running': return result
            time.sleep(.01)
        self.fail('Job did not finish')

    @patch('vwbridge.jobs.MyVW')
    def test_duplicate_running_and_complete_never_reexecutes(self, driver):
        gate = threading.Event()
        driver.return_value.status.side_effect = lambda: (gate.wait(2) or True) and {'soc': 50}
        original = copy.deepcopy(self.body)
        self.assertEqual(self.jobs.submit(copy.deepcopy(original))['state'], 'running')
        self.assertEqual(self.jobs.submit(copy.deepcopy(original))['state'], 'running')
        conflict = copy.deepcopy(original); conflict['credentials']['password'] = 'different'
        with self.assertRaises(BridgeError) as e: self.jobs.submit(conflict)
        self.assertEqual(e.exception.code, 'IDEMPOTENCY_CONFLICT')
        gate.set(); self.wait()
        self.assertEqual(self.jobs.submit(original)['state'], 'succeeded')
        self.assertEqual(driver.return_value.status.call_count, 1)

    @patch('vwbridge.jobs.MyVW')
    def test_secrets_never_persist_and_are_cleared_after_job(self, driver):
        driver.return_value.status.return_value = {'soc': 50}
        self.jobs.submit(self.body); self.wait()
        self.assertEqual(self.body['credentials'], {})
        raw = self.path.read_bytes()
        for secret in (b'secret-password', b'example@example.com', b'1234'):
            self.assertNotIn(secret, raw)

    def test_restart_marks_pending_unknown_and_does_not_replay(self):
        with patch('vwbridge.jobs.threading.Thread'):
            self.jobs.submit(copy.deepcopy(self.body))
        self.server.device_lock.release(); self.jobs.active = None
        restarted = Jobs(self.server)
        self.assertEqual(restarted.get(self.body['requestId'])['error']['code'], 'OUTCOME_UNKNOWN')
        self.assertEqual(restarted.submit(self.body)['state'], 'failed')

    def test_busy_is_not_reserved(self):
        with self.server.device_lock:
            with self.assertRaises(BridgeError) as e: self.jobs.submit(self.body)
        self.assertEqual(e.exception.code, 'DEVICE_BUSY')
        self.assertIsNone(self.jobs.get(self.body['requestId']))

    def test_login_backoff_survives_restart_and_success_clears(self):
        account = self.jobs.reserve_login('example@example.com')
        with self.assertRaises(BridgeError): Jobs(self.server).reserve_login('example@example.com')
        self.jobs.login_succeeded(account)
        self.jobs.reserve_login('example@example.com')

    def test_validates_every_parameter_before_phone_access(self):
        changes = [{'params': {'shell': 'rm'}}, {'operation': 'shell'}, {'credentials': {'username': 'a', 'password': 'b'}},
                   {'vin': None}, {'operation': 'climate', 'params': {'enabled': 'true'}},
                   {'operation': 'climate', 'params': {'enabled': True, 'tempF': True}}]
        for change in changes:
            with self.assertRaises(BridgeError): validate({**copy.deepcopy(self.body), **change})
        self.assertIsNone(self.jobs.get(self.body['requestId']))

    @patch('vwbridge.jobs.MyVW')
    def test_unknown_exception_does_not_leak_credentials(self, driver):
        self.body['operation'] = 'climate'; self.body['params'] = {'enabled': True}
        driver.return_value.set_climate.side_effect = RuntimeError('secret-password')
        self.jobs.submit(self.body)
        result = self.wait()
        self.assertEqual(result['error']['code'], 'OUTCOME_UNKNOWN')
        self.assertNotIn('secret-password', json.dumps(result))

    @patch('vwbridge.jobs.MyVW')
    def test_write_success_and_uncertain_command_requires_status(self, driver):
        driver.return_value.set_climate.return_value = {'climateOn': True}
        driver.return_value.status.return_value = {'soc': 50}
        self.body['operation'] = 'climate'; self.body['params'] = {'enabled': True}
        self.jobs.submit(copy.deepcopy(self.body))
        self.assertEqual(self.wait()['state'], 'succeeded')
        driver.return_value.set_climate.assert_called_once()
        driver.return_value.set_climate.side_effect = BridgeError('OUTCOME_UNKNOWN', 'Lost device')
        self.body['requestId'] = 'test-unknown-002'
        self.jobs.submit(copy.deepcopy(self.body)); self.wait()
        self.body['requestId'] = 'test-blocked-003'
        self.jobs.submit(copy.deepcopy(self.body))
        self.assertEqual(self.wait()['error']['code'], 'NEEDS_RECONCILIATION')
        self.assertEqual(driver.return_value.set_climate.call_count, 2)
        self.body['requestId'] = 'test-status-004'; self.body['operation'] = 'status'; self.body['params'] = {}
        self.jobs.submit(copy.deepcopy(self.body)); self.assertEqual(self.wait()['state'], 'succeeded')
        self.body['requestId'] = 'test-resumed-005'; self.body['operation'] = 'climate'; self.body['params'] = {'enabled': True}
        driver.return_value.set_climate.side_effect = None
        self.jobs.submit(copy.deepcopy(self.body)); self.assertEqual(self.wait()['state'], 'succeeded')
