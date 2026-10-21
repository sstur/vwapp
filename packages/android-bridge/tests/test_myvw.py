import unittest

from vwbridge.device import BridgeError, Node
from vwbridge.myvw import PACKAGE, PREFIX, climate_state, parse_status


def node(text, suffix="", enabled="true", package=PACKAGE):
    return Node({"text": text, "resource-id": PREFIX + suffix if suffix else "",
                 "enabled": enabled, "package": package})


class StatusTests(unittest.TestCase):
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
