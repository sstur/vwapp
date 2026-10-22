import unittest
from pathlib import Path
from io import BytesIO

from vwbridge.closures import classify, read
from vwbridge.device import BridgeError


class ClosureTests(unittest.TestCase):
    def test_physical_door_captures(self):
        fixtures = Path(__file__).parent / "fixtures/closures"
        expected = {"passenger": "front right", "driver": "front left", "rear-left": "rear left", "rear-right": "rear right", "tailgate": "trunk", "hood": "hood"}
        for name, door in expected.items():
            with self.subTest(name=name):
                result = classify((fixtures / (name + ".png")).read_bytes(), (0, 0, 128, 144))
                self.assertEqual(result, {"openDoors": [door], "openWindows": [], "closuresKnown": True})

    def test_unknown_graphic_and_clipped_image_are_not_guessed(self):
        from PIL import Image
        buffer = BytesIO()
        Image.new("RGB", (128, 144), "white").save(buffer, format="PNG")
        for bounds in [(0, 0, 128, 144), (0, 0, 128, 120), (0, 0, 200, 225)]:
            with self.assertRaises(BridgeError):
                classify(buffer.getvalue(), bounds)

    def test_physical_front_window_capture(self):
        for name, side in [("driver", "front left"), ("passenger", "front right")]:
            png = (Path(__file__).parent / f"fixtures/closures/window-{name}.png").read_bytes()
            self.assertEqual(classify(png, (0, 0, 128, 144)),
                             {"openDoors": [], "openWindows": [side], "closuresKnown": True})

    def test_unconfigured_vehicle_stays_unknown(self):
        self.assertEqual(read(None, [], None), {"closuresKnown": False})


if __name__ == "__main__":
    unittest.main()
