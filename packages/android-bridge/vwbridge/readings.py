"""Pure parsers for the verified myVW screen layouts.

Never infer closed doors, zero charge power, or exact time from absent UI data.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

from .device import BridgeError, Node

PACKAGE = "com.vw.carnet.release"


def texts(node: Node) -> list[str]:
    return [n.get("text") for n in (node, *node.descendants())
            if n.get("package") == PACKAGE and n.get("text")]


def day_label(value: str, reference: datetime):
    if value == "Today":
        return reference.date()
    if value == "Yesterday":
        return reference.date() - timedelta(days=1)
    for fmt in ("%m/%d/%Y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    for year in (reference.year, reference.year - 1):
        try:
            parsed = datetime.strptime(f"{value}, {year}", "%a, %b %d, %Y").date()
            if parsed <= reference.date() and parsed.strftime("%a") == value[:3]:
                return parsed
        except ValueError:
            pass
    return None


def activity_page(container: Node, reference: datetime, known=None):
    result = []
    current_day = None
    known = known if known is not None else {}
    for row in container.children:
        values = texts(row)
        if len(values) == 1:
            parsed = day_label(values[0], reference)
            if values[0] != "Keep track of certain actions taken in the myVW app.":
                current_day = parsed
        elif len(values) == 3 and re.fullmatch(r"\d{1,2}:\d{2}\s*[AP]M", values[2]):
            title, description, clock = values
            identity = (title, description, clock)
            # A scrolled page can start before the date that ended the prior
            # page. Never carry that trailing date across an overlapping page.
            # Only an unambiguous already-seen row can anchor a missing header.
            if current_day is None and len(known.get(identity, set())) == 1:
                current_day = next(iter(known[identity]))
            at = None
            if current_day:
                t = datetime.strptime(clock.replace(" ", ""), "%I:%M%p").time()
                at = int(datetime.combine(current_day, t, reference.tzinfo).timestamp() * 1000)
                known.setdefault(identity, set()).add(current_day)
            result.append({"at": at, "title": title,
                           "description": description if at is not None else f"{description} ({clock})",
                           "type": "Commands"})
    return result


def message_page(container: Node, reference: datetime):
    result = []
    for row in container.children:
        values = texts(row)
        if row.get("clickable") != "true" or len(values) != 3:
            continue
        title, date, body = values
        parsed = day_label(date, reference)
        if parsed is None:
            raise BridgeError("UNEXPECTED_UI", "Inbox message date format changed")
        # In this Compose layout the unread dot is the first, non-text child;
        # read rows start directly with the title. No opening/marking messages.
        first = row.children[0]
        if first.get("text") == title:
            read = True
        elif not first.get("text") and len(row.children) >= 4 and row.children[1].get("text") == title:
            read = False
        else:
            raise BridgeError("UNEXPECTED_UI", "Inbox unread indicator layout changed")
        key = hashlib.sha256((date + "\n" + title + "\n" + body).encode()).hexdigest()
        result.append({"id": "android:" + key, "title": title, "body": body,
                       "read": read, "at": int(datetime.combine(parsed, datetime.min.time(), reference.tzinfo).timestamp() * 1000)})
    return result


def direction_coordinates(activity_dump: str):
    """Read the foreground Maps intent that myVW just launched, not older tasks."""
    matches = []
    for block in re.split(r"(?m)^\s*\* Hist #", activity_dump):
        if not re.search(r"state=RESUMED\b", block) or "launchedFromPackage=" + PACKAGE not in block:
            continue
        for value in re.findall(r"Intent \{ act=android.intent.action.VIEW dat=(\S+)", block):
            url = urlparse(value)
            if url.scheme != "https" or url.netloc != "www.google.com" or url.path != "/maps/dir/":
                continue
            destination = parse_qs(url.query).get("destination", [])
            if len(destination) != 1 or not re.fullmatch(r"-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?", destination[0]):
                continue
            lat, lng = map(float, destination[0].split(","))
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                matches.append((lat, lng))
    if len(matches) != 1:
        raise BridgeError("UNEXPECTED_UI", "Cannot identify myVW's current directions destination")
    return matches[0]
