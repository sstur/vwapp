import subprocess
import unittest
from unittest.mock import patch

from vwbridge.device import BridgeError, Device, parse_nodes, select


def hierarchy(*nodes):
    return parse_nodes("<hierarchy>" + "".join(nodes) + "</hierarchy>")


def button(package="com.vw.carnet.release", bounds="[10,20][90,60]", **attrs):
    fields = {"package": package, "bounds": bounds, "text": "Refresh", "enabled": "true", **attrs}
    return "<node " + " ".join(f'{key}="{value}"' for key, value in fields.items()) + "/>"


class SelectionTests(unittest.TestCase):
    def test_requires_unique_enabled_element_in_target_app(self):
        nodes = hierarchy(button("other.app"), button(enabled="false"), button())
        self.assertEqual(select(nodes, "com.vw.carnet.release", text="Refresh").center, (50, 40))
        with self.assertRaises(BridgeError):
            select(hierarchy(button(), button()), "com.vw.carnet.release", text="Refresh")

    def test_rejects_invisible_elements_and_invalid_xml(self):
        for bounds in ["[0,0][0,0]", "[90,20][10,60]", "unknown"]:
            with self.assertRaises(BridgeError):
                select(hierarchy(button(bounds=bounds)), "com.vw.carnet.release", text="Refresh")
        with self.assertRaises(BridgeError):
            parse_nodes("ERROR: could not get idle state")

    def test_password_text_and_description_are_redacted(self):
        node = hierarchy(button(password="true", text="secret", **{"content-desc": "secret"}))[0]
        self.assertNotIn("secret", str(node.public()))


class DeviceTests(unittest.TestCase):
    def test_serial_required(self):
        with self.assertRaises(BridgeError):
            Device("")

    @patch("vwbridge.device.subprocess.run")
    def test_shell_arguments_are_quoted_and_failures_do_not_leak_secrets(self, run):
        secret = "abc'$(touch /tmp/should-not-exist)"
        run.return_value = subprocess.CompletedProcess([], 1, secret, secret)
        with self.assertRaises(BridgeError) as error:
            Device("test-device", "/usr/bin/adb").text(secret)
        self.assertNotIn(secret, str(error.exception))
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ["/usr/bin/adb", "-s", "test-device", "shell"])
        import shlex
        self.assertEqual(shlex.split(argv[4]), ["input", "text", secret.replace(" ", "%s")])

    @patch.object(Device, "shell")
    def test_ui_dump_cleanup_even_if_parse_fails(self, shell):
        shell.side_effect = ["", "invalid XML", ""]
        with self.assertRaises(BridgeError):
            Device("test-device").nodes()
        self.assertEqual(shell.call_args.args[:2], ("rm", "-f"))

    @patch.object(Device, "nodes")
    @patch.object(Device, "shell")
    def test_no_tap_on_ambiguous_ui(self, shell, nodes):
        nodes.return_value = hierarchy(button(), button())
        with self.assertRaises(BridgeError):
            Device("test-device").tap("com.vw.carnet.release", text="Refresh")
        shell.assert_not_called()


if __name__ == "__main__":
    unittest.main()
