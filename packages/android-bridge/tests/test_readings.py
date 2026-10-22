import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from vwbridge.device import BridgeError, Node
from vwbridge.readings import PACKAGE, activity_page, day_label, direction_coordinates, message_page


def node(text="", children=(), **attributes):
    return Node({"package": PACKAGE, "text": text, **attributes}, tuple(children))


def event(title, clock):
    return node(children=[node(title), node("Updated"), node(clock)])


class ReadingsTests(unittest.TestCase):
    reference = datetime(2026, 10, 21, 16, tzinfo=ZoneInfo("America/Los_Angeles"))

    def test_activity_overlap_does_not_assign_previous_pages_last_date(self):
        known = {}
        first = activity_page(node(children=[node("Today"), event("Charge settings", "4:25PM"),
                                            node("Sun, Oct 4"), event("Lock", "9:00AM")]), self.reference, known)
        second = activity_page(node(children=[event("Charge settings", "4:25PM"),
                                             node("Sun, Oct 4"), event("Lock", "9:00AM")]), self.reference, known)
        self.assertEqual(first, second)
        self.assertEqual(datetime.fromtimestamp(first[0]["at"] / 1000, self.reference.tzinfo).day, 21)
        self.assertEqual(datetime.fromtimestamp(first[1]["at"] / 1000, self.reference.tzinfo).day, 4)

    def test_unknown_activity_date_stays_unknown(self):
        result = activity_page(node(children=[event("Lock", "9:00AM")]), self.reference)
        self.assertIsNone(result[0]["at"])
        self.assertIn("9:00AM", result[0]["description"])
        self.assertIsNone(day_label("a new date format", self.reference))

    def test_inbox_reads_full_body_and_unread_dot_without_opening(self):
        read = node(children=[node("News"), node("10/13/2026"), node("Full message body"), node()], clickable="true")
        unread = node(children=[node(), node("News"), node("10/13/2026"), node("Full message body"), node()], clickable="true")
        a = message_page(node(children=[read]), self.reference)[0]
        b = message_page(node(children=[unread]), self.reference)[0]
        self.assertTrue(a["read"])
        self.assertFalse(b["read"])
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(a["body"], "Full message body")
        self.assertEqual(message_page(node(children=[node(children=[unread])]), self.reference), [b])

    def test_maps_intent_requires_current_foreground_and_myvw_origin(self):
        valid = "* Hist #0: Activity\n launchedFromPackage=com.vw.carnet.release\n state=RESUMED\n Intent { act=android.intent.action.VIEW dat=https://www.google.com/maps/dir/?api=1&destination=37.5%2C-122.2&travelmode=walking }"
        self.assertEqual(direction_coordinates(valid), (37.5, -122.2))
        for invalid in [valid.replace("RESUMED", "STOPPED"), valid.replace(PACKAGE, "another.app"),
                        valid.replace("37.5", "137.5"), valid.replace("www.google.com", "example.com")]:
            with self.assertRaises(BridgeError):
                direction_coordinates(invalid)


if __name__ == "__main__":
    unittest.main()
