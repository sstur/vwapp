import unittest

from vwbridge.device import BridgeError, Node
from vwbridge.myvw import PACKAGE, PREFIX, MyVW, climate_state, parse_status
from unittest.mock import Mock, patch


def node(text, suffix="", enabled="true", package=PACKAGE):
    return Node({"text": text, "resource-id": PREFIX + suffix if suffix else "",
                 "enabled": enabled, "package": package})


class StatusTests(unittest.TestCase):
    def test_map_keeps_approximate_permission_after_delayed_prompt(self):
        device = Mock()
        driver = MyVW(device, "a@example.com", "TESTVIN")
        driver.home = Mock()
        driver.tap_id = Mock()
        driver.wait_id = Mock(return_value=[node("An address", "label_nearest_address"), node("Parked at 1:32PM", "label_lpp_timestamp")])
        prompt = Node({"package": "com.google.android.permissioncontroller",
                       "resource-id": "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button",
                       "text": "Keep approximate location"})
        device.nodes.side_effect = [[], [prompt], [node("", "button_vehicle_location")]]
        device.shell.return_value = "* Hist #0: Activity\n launchedFromPackage=com.vw.carnet.release\n state=RESUMED\n Intent { act=android.intent.action.VIEW dat=https://www.google.com/maps/dir/?api=1&destination=37.5%2C-122.2 }"
        with patch("vwbridge.myvw.time.sleep"):
            result = driver.parked_location()
        self.assertEqual(result["parkedLat"], 37.5)
        device.tap.assert_any_call("com.google.android.permissioncontroller", text="Keep approximate location")
        self.assertEqual(device.tap.call_count, 2)  # Permission choice and vehicle map marker only.
        device.launch.assert_called_once_with(PACKAGE)

    def test_odometer_is_read_only_when_displayed(self):
        top = [node("van", "vehicleNameTextView")]
        idle = parse_status(top, [node("52% | 133 Est. mi"), node("29,907 mi")], "TESTVIN")
        charging = parse_status(top, [node("52% | 133 Est. mi"), node("42h 20m to 80%")], "TESTVIN")
        self.assertAlmostEqual(idle["odometerKm"], 48130.651)
        self.assertIsNone(charging["odometerKm"])
        self.assertEqual(charging["chargingTargetSoc"], 80)

    def test_charge_limit_noop_never_saves(self):
        driver = MyVW(Mock(), "a@example.com", "TESTVIN")
        driver.prepare = Mock()
        driver.open_battery_settings = Mock(return_value=[node("80%", "currentPercentageTextView")])
        driver.tap_id = Mock()
        self.assertFalse(driver.charge_limit(80)["changed"])
        driver.tap_id.assert_not_called()

    def test_charge_limit_wrong_slider_value_cancels_without_saving(self):
        device = Mock()
        driver = MyVW(device, "a@example.com", "TESTVIN")
        driver.prepare = Mock()
        slider = Node({"package": PACKAGE, "resource-id": PREFIX + "sliderRadius", "enabled": "true", "bounds": "[53,1740][1027,1818]"})
        driver.open_battery_settings = Mock(return_value=[node("100%", "currentPercentageTextView"), slider,
                                                         node("50%", "minValueTextView"), node("100%", "maxValueTextView")])
        driver.snapshot = Mock(return_value=[node("80%", "currentPercentageTextView")])
        driver.tap_id = Mock()
        with self.assertRaises(BridgeError):
            driver.charge_limit(90)
        driver.tap_id.assert_not_called()
        self.assertEqual(device.shell.call_args.args, ("input", "keyevent", "4"))

    def test_reading_preserves_freshness_and_unknown_values(self):
        top = [node("Test van", "vehicleNameTextView"), node("Unavailable", "vehicleModelTextView"),
               node("Updated yesterday", "timestampTextView")]
        controls = [node("48%  |  123 Est. mi"), node("Charging"), node("47h 15m to 100%")]
        result = parse_status(top, controls, "TESTVIN")
        self.assertEqual(result["soc"], 48)
        self.assertAlmostEqual(result["rangeKm"], 197.949)
        self.assertEqual(result["minutesToTarget"], 2835)
        self.assertIsNone(result["locked"])
        self.assertIsNone(result["capturedAt"])
        self.assertEqual(result["reportedUpdatedText"], "Updated yesterday")

    def test_paused_charging_reports_plugged_in_without_inventing_unplugged(self):
        result = parse_status([node("van", "vehicleNameTextView")],
                              [node("51% | 127 Est. mi"), node("Plugged in"), node("Start charging")], "TESTVIN")
        self.assertEqual(result["chargeState"], "Plugged in")
        self.assertTrue(result["pluggedIn"])

    def test_login_entry_is_not_tapped_again_while_transitioning(self):
        entry = [node("Log in", "loginButton")]
        device = Mock()
        device.nodes.side_effect = [entry, entry, [node("", "maincollapsing")]]
        driver = MyVW(device, "test@example.com", "")
        driver.home = Mock()
        with patch("vwbridge.myvw.time.sleep"):
            driver.sign_in()
        device.tap.assert_called_once_with(PACKAGE, **{"resource-id": PREFIX + "loginButton", "class": "android.widget.Button"})

    def test_pre_auth_navigation_failure_releases_only_unused_reservation(self):
        for started in (False, True):
            driver = MyVW(None, "test@example.com", "")
            driver.login_reservation = "account-reservation"
            driver.authentication_started = started
            driver._ensure_session = Mock(side_effect=BridgeError("UNEXPECTED_UI", "navigation failed"))
            clear = Mock()
            with self.assertRaises(BridgeError):
                driver.ensure_session({}, Mock(), clear)
            self.assertEqual(clear.call_count, 0 if started else 1)

    def test_other_app_cannot_supply_vehicle_values(self):
        with self.assertRaises(BridgeError):
            parse_status([node("van", "vehicleNameTextView")],
                         [node("80% | 100 Est. km", package="other.app")], "TESTVIN")

    def test_ambiguous_battery_reading_is_rejected(self):
        with self.assertRaises(BridgeError):
            parse_status([node("van", "vehicleNameTextView")],
                         [node("80% | 100 Est. km"), node("40% | 50 Est. km")], "TESTVIN")

    def test_climate_pending_or_changed_labels_are_not_success(self):
        title = node("Climate", "climateTitleTextView")
        self.assertFalse(climate_state([title, node("Off", "firstCommandTextView", "false"),
                                        node("On", "secondCommandTextView")]))
        self.assertTrue(climate_state([title, node("Off", "firstCommandTextView"),
                                       node("On", "secondCommandTextView", "false")]))
        with self.assertRaises(BridgeError):
            climate_state([title, node("Off", "firstCommandTextView", "false"),
                           node("On", "secondCommandTextView", "false")])
        with self.assertRaises(BridgeError):
            climate_state([node("Doors", "climateTitleTextView"),
                           node("Off", "firstCommandTextView"), node("On", "secondCommandTextView", "false")])


if __name__ == "__main__":
    unittest.main()
