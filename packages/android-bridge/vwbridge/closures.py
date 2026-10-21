"""Deterministic comparison with the stock app's layered vehicle artwork.

This reads which openings the graphic depicts, not independent sensor values.
Unknown models, clipped/changed images and ambiguous matches stay unavailable.
"""
from functools import lru_cache
from io import BytesIO
from itertools import product
from pathlib import Path

from .device import BridgeError

SIDES = ("front_left", "front_right", "rear_left", "rear_right")
SIZE = (128, 144)
ASSETS = Path(__file__).resolve().parents[3] / "app/assets/vehicle"


@lru_cache(maxsize=1)
def assets():
    from PIL import Image
    return {p.stem.removeprefix("idbuzz_2024_"): Image.open(p).convert("RGBA").resize(SIZE, Image.Resampling.BILINEAR)
            for p in ASSETS.glob("idbuzz_2024_*.png")}


def render(states, hood, trunk):
    layers = assets()
    image = layers["body"].copy()
    for side, state in zip(SIDES, states):
        if state == 3:
            image.alpha_composite(layers[f"door_window_{side}_open"])
        else:
            image.alpha_composite(layers[f"door_{side}_{'open' if state & 1 else 'closed'}"])
            if state == 2:
                image.alpha_composite(layers[f"window_{side}_open"])
    if trunk:
        image.alpha_composite(layers["door_rear_open"])
    if hood:
        image.alpha_composite(layers["engine_hood_open"])
    return image


def classify(png: bytes, bounds):
    from PIL import Image, ImageChops, ImageStat
    image = Image.open(BytesIO(png)).convert("RGB")
    x1, y1, x2, y2 = bounds
    if (not 0 <= x1 < x2 <= image.width or not 0 <= y1 < y2 <= image.height
            or abs((x2 - x1) / (y2 - y1) - 1056 / 1188) > .003):
        raise BridgeError("CLOSURES_UNAVAILABLE", "Vehicle graphic is clipped or its layout changed")
    actual = image.crop(bounds).resize(SIZE, Image.Resampling.BILINEAR)
    background = actual.getpixel((0, 0))
    best = []
    for states in product(range(4), repeat=4):
        for hood, trunk in product(range(2), repeat=2):
            candidate = Image.new("RGBA", SIZE, background + (255,))
            candidate.alpha_composite(render(states, hood, trunk))
            variants = []
            for left, right in product(range(2), repeat=2):
                lit = candidate.copy()
                if left:
                    lit.alpha_composite(assets()["lights_left_on"])
                if right:
                    lit.alpha_composite(assets()["lights_right_on"])
                variants.append(sum(ImageStat.Stat(ImageChops.difference(actual, lit.convert("RGB"))).mean) / 3)
            # Blinking lights must not be confused with closure differences.
            score = min(variants)
            best.append((score, states, hood, trunk))
    best.sort()
    score, states, hood, trunk = best[0]
    # Calibrated against real front-door captures. Fail closed rather than
    # select the nearest image when none (or more than one) fits confidently.
    if score > .6 or best[1][0] - score < .075:
        raise BridgeError("CLOSURES_UNAVAILABLE", "Vehicle graphic does not match confidently")
    doors = [side.replace("_", " ") for side, state in zip(SIDES, states) if state & 1]
    windows = [side.replace("_", " ") for side, state in zip(SIDES, states) if state & 2]
    if hood:
        doors.append("hood")
    if trunk:
        doors.append("trunk")
    return {"openDoors": doors, "openWindows": windows, "closuresKnown": True}


def read(device, top, profile):
    if profile != "idbuzz_2024":
        return {"closuresKnown": False}
    candidates = [n for n in top if n.get("resource-id") == "com.vw.carnet.release:id/spriteImageView"]
    photos = [n for n in top if n.get("resource-id") == "com.vw.carnet.release:id/jellyBeanImageView"]
    if not candidates and len(photos) == 1:
        # The ordinary vehicle photo has no highlighted openings. Consumers
        # must label this "not shown open", never individual sensor "closed".
        return {"closuresKnown": True, "openDoors": [], "openWindows": []}
    if len(candidates) != 1:
        return {"closuresKnown": False}
    try:
        result = classify(device.screenshot(), candidates[0].bounds)
        # Reject navigation/scroll races between hierarchy and screenshot.
        after = [n for n in device.nodes() if n.get("resource-id") == candidates[0].get("resource-id")]
        if len(after) != 1 or after[0].bounds != candidates[0].bounds:
            raise BridgeError("CLOSURES_UNAVAILABLE", "Vehicle graphic changed during capture")
        return result
    except (BridgeError, ImportError, OSError, KeyError):
        return {"closuresKnown": False}
