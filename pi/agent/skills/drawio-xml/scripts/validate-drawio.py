#!/usr/bin/env python3
"""Validate draw.io XML structure and rendered diagram geometry.

The XML checks catch broken mxGraph references. When the draw.io desktop CLI is
available, SVG checks validate the geometry that draw.io actually renders,
including label containment and label/box/connector collisions. The script
intentionally uses only Python's standard library.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

EPSILON = 1e-7
DEFAULT_DRAWIO = "/Applications/draw.io.app/Contents/MacOS/draw.io"
NUMBER_RE = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
PATH_TOKEN_RE = re.compile(rf"[AaCcHhLlMmQqSsTtVvZz]|{NUMBER_RE}")
TRANSFORM_RE = re.compile(rf"([A-Za-z]+)\s*\(([^)]*)\)")


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    @property
    def center(self) -> Point:
        return Point(self.x + self.width / 2, self.y + self.height / 2)

    def inflate(self, amount: float) -> "Rect":
        return Rect(
            self.x - amount,
            self.y - amount,
            self.width + 2 * amount,
            self.height + 2 * amount,
        )


@dataclass
class Finding:
    severity: str
    code: str
    message: str
    page: Optional[str] = None
    cell: Optional[str] = None

    def as_dict(self) -> dict:
        result = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }
        if self.page is not None:
            result["page"] = self.page
        if self.cell is not None:
            result["cell"] = self.cell
        return result


@dataclass
class Report:
    path: str
    findings: List[Finding]

    def error_count(self) -> int:
        return sum(f.severity == "error" for f in self.findings)

    def warning_count(self) -> int:
        return sum(f.severity == "warning" for f in self.findings)

    def as_dict(self, strict: bool) -> dict:
        errors = self.error_count()
        warnings = self.warning_count()
        return {
            "file": self.path,
            "ok": errors == 0 and (not strict or warnings == 0),
            "errors": errors,
            "warnings": warnings,
            "findings": [f.as_dict() for f in self.findings],
        }


@dataclass
class Page:
    index: int
    name: str
    page_id: str
    model: ET.Element
    root: ET.Element
    cells: Dict[str, ET.Element]
    parents: Dict[str, Optional[str]]
    vertex_ids: List[str]
    edge_ids: List[str]
    geometry: Dict[str, ET.Element]
    rects: Dict[str, Rect]
    origins: Dict[str, Point]


# ---------------------------------------------------------------------------
# XML and graph helpers


class PngFormatError(ValueError):
    """The input is not a well-formed PNG container."""


class EmbeddedDiagramError(ValueError):
    """The PNG is valid but does not contain usable draw.io XML."""


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def is_drawio_png(path: Path) -> bool:
    return path.name.lower().endswith(".drawio.png")


def iter_png_text_chunks(path: Path) -> Iterable[Tuple[str, bytes]]:
    """Yield PNG text chunks without depending on Pillow."""
    try:
        stream = path.open("rb")
    except OSError:
        raise
    with stream:
        if stream.read(8) != PNG_SIGNATURE:
            raise PngFormatError("file is not a PNG")
        while True:
            raw_length = stream.read(4)
            if not raw_length:
                raise PngFormatError("PNG ended before IEND")
            if len(raw_length) != 4:
                raise PngFormatError("truncated PNG chunk length")
            length = struct.unpack(">I", raw_length)[0]
            if length > 64 * 1024 * 1024:
                raise PngFormatError("PNG chunk is unreasonably large")
            chunk_type = stream.read(4)
            if len(chunk_type) != 4:
                raise PngFormatError("truncated PNG chunk type")
            data = stream.read(length)
            raw_crc = stream.read(4)
            if len(data) != length or len(raw_crc) != 4:
                raise PngFormatError("truncated PNG chunk data")
            expected_crc = struct.unpack(">I", raw_crc)[0]
            actual_crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
            if actual_crc != expected_crc:
                raise PngFormatError(
                    f"invalid CRC for PNG chunk {chunk_type.decode('latin-1')!r}"
                )

            if chunk_type == b"tEXt":
                keyword, separator, value = data.partition(b"\x00")
                if separator:
                    yield keyword.decode("latin-1"), value
            elif chunk_type == b"zTXt":
                keyword, separator, value = data.partition(b"\x00")
                if separator and value:
                    if value[0] != 0:
                        continue
                    try:
                        value = zlib.decompress(value[1:])
                    except zlib.error:
                        continue
                    yield keyword.decode("latin-1"), value
            elif chunk_type == b"iTXt":
                keyword, separator, remainder = data.partition(b"\x00")
                if not separator or len(remainder) < 2:
                    continue
                compressed = remainder[0]
                compression_method = remainder[1]
                remainder = remainder[2:]
                _, separator, remainder = remainder.partition(b"\x00")
                if not separator:
                    continue
                _, separator, value = remainder.partition(b"\x00")
                if not separator:
                    continue
                if compressed:
                    if compression_method != 0:
                        continue
                    try:
                        value = zlib.decompress(value)
                    except zlib.error:
                        continue
                yield keyword.decode("utf-8", "replace"), value

            if chunk_type == b"IEND":
                return


def embedded_xml_candidates(payload: bytes) -> Iterable[bytes]:
    current = payload
    for _ in range(3):
        yield current
        try:
            unquoted = urllib.parse.unquote_to_bytes(current.decode("latin-1"))
        except (UnicodeDecodeError, ValueError):
            return
        if unquoted == current:
            return
        current = unquoted


def extract_embedded_diagram(path: Path) -> ET.Element:
    """Extract the mxfile/mxGraphModel stored by draw.io in a PNG text chunk."""
    found_metadata = False
    for keyword, payload in iter_png_text_chunks(path):
        if keyword.lower() not in {"mxfile", "mxgraphmodel"}:
            continue
        found_metadata = True
        for candidate in embedded_xml_candidates(payload):
            try:
                root = ET.fromstring(candidate)
            except ET.ParseError:
                continue
            root_name = local_name(root.tag)
            if root_name == "mxfile":
                return root
            if root_name == "mxGraphModel":
                wrapper = ET.Element(
                    "mxfile",
                    {"host": "app.diagrams.net", "type": "device"},
                )
                diagram = ET.SubElement(
                    wrapper,
                    "diagram",
                    {"id": "embedded-page-1", "name": "Page-1"},
                )
                diagram.append(root)
                return wrapper

    if found_metadata:
        raise EmbeddedDiagramError("PNG contains invalid embedded draw.io XML")
    raise EmbeddedDiagramError("PNG contains no embedded draw.io XML")


def children(element: ET.Element, name: str) -> List[ET.Element]:
    return [child for child in list(element) if local_name(child.tag) == name]


def child(element: ET.Element, name: str) -> Optional[ET.Element]:
    matches = children(element, name)
    return matches[0] if matches else None


def parse_float(
    element: ET.Element,
    attribute: str,
    default: Optional[float] = None,
) -> Optional[float]:
    value = element.get(attribute)
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def style_map(style: str) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for item in style.split(";"):
        if "=" in item:
            key, value = item.split("=", 1)
            result[key] = value
    return result


def style_tokens(style: str) -> set[str]:
    return {item for item in style.split(";") if item and "=" not in item}


def has_style_token(style: str, token: str) -> bool:
    return token in style_tokens(style)


def is_text_cell(cell: ET.Element) -> bool:
    styles = style_map(cell.get("style", ""))
    return has_style_token(cell.get("style", ""), "text") or styles.get("shape") == "text"


def is_edge_label_style(cell: ET.Element) -> bool:
    styles = style_map(cell.get("style", ""))
    return has_style_token(cell.get("style", ""), "edgeLabel") or styles.get(
        "edgeLabel"
    ) == "1"


def is_edge_label_cell(page: Page, cell_id: str) -> bool:
    cell = page.cells.get(cell_id)
    if cell is None:
        return False
    return is_edge_label_style(cell) or page.parents.get(cell_id) in page.edge_ids


def is_box_cell(page: Page, cell_id: str) -> bool:
    cell = page.cells.get(cell_id)
    return bool(
        cell is not None
        and cell_id in page.vertex_ids
        and not is_edge_label_cell(page, cell_id)
        and not is_text_cell(cell)
        and page.parents.get(cell_id) not in page.edge_ids
    )


def label_text(value: str) -> str:
    """Return visible-ish text from a draw.io HTML label value."""
    value = html.unescape(value or "")
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(
        r"</(?:div|p|li|tr|h[1-6])\s*>",
        "\n",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"<[^>]*>", " ", value)
    return " ".join(value.replace("\xa0", " ").split())


def has_label_content(value: str) -> bool:
    decoded = html.unescape(value or "")
    return bool(label_text(decoded)) or bool(
        re.search(r"<(?:img|svg|object|iframe|video|canvas)\b", decoded, re.IGNORECASE)
    )


def is_hidden(cell: ET.Element) -> bool:
    if cell.get("visible") == "0":
        return True
    return style_map(cell.get("style", "")).get("visibility") == "hidden"


def is_container(cell: ET.Element) -> bool:
    styles = style_map(cell.get("style", ""))
    return styles.get("container") == "1" or styles.get("swimlane") == "1"


def is_effectively_hidden(page: Page, cell_id: str) -> bool:
    current: Optional[str] = cell_id
    seen: set[str] = set()
    while current is not None and current not in seen:
        seen.add(current)
        cell = page.cells.get(current)
        if cell is not None and is_hidden(cell):
            return True
        current = page.parents.get(current)
    return False


def point_from_element(element: ET.Element) -> Optional[Point]:
    x = parse_float(element, "x")
    y = parse_float(element, "y")
    if x is None or y is None:
        return None
    return Point(x, y)


def positive_overlap(a: Rect, b: Rect, tolerance: float = 0.0) -> bool:
    width = min(a.right, b.right) - max(a.x, b.x)
    height = min(a.bottom, b.bottom) - max(a.y, b.y)
    return width > tolerance and height > tolerance


def rect_overflow(inner: Rect, outer: Rect, tolerance: float = 0.0) -> Dict[str, float]:
    overflow = {
        "left": max(outer.x - inner.x, 0.0),
        "top": max(outer.y - inner.y, 0.0),
        "right": max(inner.right - outer.right, 0.0),
        "bottom": max(inner.bottom - outer.bottom, 0.0),
    }
    return {
        side: amount
        for side, amount in overflow.items()
        if amount > tolerance + EPSILON
    }


def point_to_rect_boundary_distance(point: Point, rect: Rect) -> float:
    inside_x = rect.x - EPSILON <= point.x <= rect.right + EPSILON
    inside_y = rect.y - EPSILON <= point.y <= rect.bottom + EPSILON
    if inside_x and inside_y:
        return min(
            abs(point.x - rect.x),
            abs(rect.right - point.x),
            abs(point.y - rect.y),
            abs(rect.bottom - point.y),
        )
    dx = max(rect.x - point.x, 0.0, point.x - rect.right)
    dy = max(rect.y - point.y, 0.0, point.y - rect.bottom)
    return math.hypot(dx, dy)


def point_to_rect_distance(point: Point, rect: Rect) -> float:
    dx = max(rect.x - point.x, 0.0, point.x - rect.right)
    dy = max(rect.y - point.y, 0.0, point.y - rect.bottom)
    return math.hypot(dx, dy)


def point_to_segment_distance(point: Point, first: Point, second: Point) -> float:
    dx = second.x - first.x
    dy = second.y - first.y
    length_squared = dx * dx + dy * dy
    if length_squared <= EPSILON:
        return math.hypot(point.x - first.x, point.y - first.y)
    fraction = (
        (point.x - first.x) * dx + (point.y - first.y) * dy
    ) / length_squared
    fraction = min(1.0, max(0.0, fraction))
    nearest = Point(first.x + fraction * dx, first.y + fraction * dy)
    return math.hypot(point.x - nearest.x, point.y - nearest.y)


def segment_intersects_rect(a: Point, b: Point, rect: Rect) -> bool:
    """Liang-Barsky segment/rectangle intersection."""
    dx = b.x - a.x
    dy = b.y - a.y
    t0, t1 = 0.0, 1.0
    for p, q in (
        (-dx, a.x - rect.x),
        (dx, rect.right - a.x),
        (-dy, a.y - rect.y),
        (dy, rect.bottom - a.y),
    ):
        if abs(p) < EPSILON:
            if q < 0:
                return False
            continue
        ratio = q / p
        if p < 0:
            if ratio > t1:
                return False
            t0 = max(t0, ratio)
        else:
            if ratio < t0:
                return False
            t1 = min(t1, ratio)
    return t0 <= t1 + EPSILON


def orientation(a: Point, b: Point, c: Point) -> float:
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)


def on_segment(a: Point, b: Point, p: Point) -> bool:
    return (
        min(a.x, b.x) - EPSILON <= p.x <= max(a.x, b.x) + EPSILON
        and min(a.y, b.y) - EPSILON <= p.y <= max(a.y, b.y) + EPSILON
        and abs(orientation(a, b, p)) <= EPSILON
    )


def segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    o1 = orientation(a, b, c)
    o2 = orientation(a, b, d)
    o3 = orientation(c, d, a)
    o4 = orientation(c, d, b)

    if (
        ((o1 > EPSILON and o2 < -EPSILON) or (o1 < -EPSILON and o2 > EPSILON))
        and ((o3 > EPSILON and o4 < -EPSILON) or (o3 < -EPSILON and o4 > EPSILON))
    ):
        return True
    return (
        abs(o1) <= EPSILON
        and on_segment(a, b, c)
        or abs(o2) <= EPSILON
        and on_segment(a, b, d)
        or abs(o3) <= EPSILON
        and on_segment(c, d, a)
        or abs(o4) <= EPSILON
        and on_segment(c, d, b)
    )


def segment_to_rect_distance(first: Point, second: Point, rect: Rect) -> float:
    if segment_intersects_rect(first, second, rect):
        return 0.0
    corners = (
        Point(rect.x, rect.y),
        Point(rect.right, rect.y),
        Point(rect.right, rect.bottom),
        Point(rect.x, rect.bottom),
    )
    return min(
        point_to_rect_distance(first, rect),
        point_to_rect_distance(second, rect),
        *(point_to_segment_distance(corner, first, second) for corner in corners),
    )


def route_to_rect_distance(route: Sequence[Point], rect: Rect) -> float:
    return min(
        (segment_to_rect_distance(first, second, rect) for first, second in segments(route)),
        default=math.inf,
    )


def collinear_overlap_length(
    first_a: Point,
    first_b: Point,
    second_a: Point,
    second_b: Point,
) -> float:
    """Return the positive shared length of two collinear segments."""
    if (
        abs(orientation(first_a, first_b, second_a)) > EPSILON
        or abs(orientation(first_a, first_b, second_b)) > EPSILON
    ):
        return 0.0
    dx = abs(first_b.x - first_a.x)
    dy = abs(first_b.y - first_a.y)
    if dx >= dy:
        return max(
            0.0,
            min(max(first_a.x, first_b.x), max(second_a.x, second_b.x))
            - max(min(first_a.x, first_b.x), min(second_a.x, second_b.x)),
        )
    return max(
        0.0,
        min(max(first_a.y, first_b.y), max(second_a.y, second_b.y))
        - max(min(first_a.y, first_b.y), min(second_a.y, second_b.y)),
    )


def segments(points: Sequence[Point]) -> Iterable[Tuple[Point, Point]]:
    return zip(points, points[1:])


def union_rects(rects: Sequence[Rect]) -> Optional[Rect]:
    if not rects:
        return None
    left = min(r.x for r in rects)
    top = min(r.y for r in rects)
    right = max(r.right for r in rects)
    bottom = max(r.bottom for r in rects)
    return Rect(left, top, right - left, bottom - top)


def ancestors(page: Page, cell_id: str) -> set[str]:
    result: set[str] = set()
    current = page.parents.get(cell_id)
    seen: set[str] = set()
    while current is not None and current not in seen:
        result.add(current)
        seen.add(current)
        current = page.parents.get(current)
    return result


def is_ancestor(page: Page, possible_ancestor: str, cell_id: str) -> bool:
    return possible_ancestor in ancestors(page, cell_id)


def geometry_for(page: Page, cell_id: str) -> Optional[ET.Element]:
    return page.geometry.get(cell_id)


def global_origin(
    page: Page,
    cell_id: str,
    stack: Optional[set[str]] = None,
) -> Point:
    if cell_id in page.origins:
        return page.origins[cell_id]
    if stack is None:
        stack = set()
    if cell_id in stack:
        return Point(0.0, 0.0)
    current_stack = set(stack)
    current_stack.add(cell_id)

    cell = page.cells.get(cell_id)
    if cell is None:
        return Point(0.0, 0.0)
    parent_id = page.parents.get(cell_id)
    if parent_id in {None, "0", "1"}:
        base = Point(0.0, 0.0)
    else:
        base = global_origin(page, parent_id, current_stack)

    geo = geometry_for(page, cell_id)
    if geo is None:
        page.origins[cell_id] = base
        return base

    x = parse_float(geo, "x", 0.0)
    y = parse_float(geo, "y", 0.0)
    x = x if x is not None else 0.0
    y = y if y is not None else 0.0

    if geo.get("relative") == "1" and parent_id not in {None, "0", "1"}:
        parent_rect = rect_for(page, parent_id, current_stack)
        if parent_rect is not None:
            x *= parent_rect.width
            y *= parent_rect.height

    offset = next(
        (
            p
            for p in geo.iter()
            if local_name(p.tag) == "mxPoint" and p.get("as") == "offset"
        ),
        None,
    )
    if offset is not None:
        offset_point = point_from_element(offset)
        if offset_point is not None:
            x += offset_point.x
            y += offset_point.y

    result = Point(base.x + x, base.y + y)
    page.origins[cell_id] = result
    return result


def rect_for(
    page: Page,
    cell_id: str,
    stack: Optional[set[str]] = None,
) -> Optional[Rect]:
    if cell_id in page.rects:
        return page.rects[cell_id]
    geo = geometry_for(page, cell_id)
    if geo is None:
        return None
    width = parse_float(geo, "width", 0.0)
    height = parse_float(geo, "height", 0.0)
    if width is None or height is None:
        return None
    origin = global_origin(page, cell_id, stack)
    result = Rect(origin.x, origin.y, width, height)
    page.rects[cell_id] = result
    return result


def static_edge_route(page: Page, edge_id: str) -> Optional[List[Point]]:
    edge = page.cells[edge_id]
    source = edge.get("source")
    target = edge.get("target")
    source_rect = rect_for(page, source) if source else None
    target_rect = rect_for(page, target) if target else None
    if source_rect is None or target_rect is None:
        return None

    points = [source_rect.center]
    geo = geometry_for(page, edge_id)
    if geo is not None:
        array = next(
            (
                a
                for a in geo.iter()
                if local_name(a.tag) == "Array" and a.get("as") == "points"
            ),
            None,
        )
        if array is not None:
            parent_origin = global_origin(page, page.parents.get(edge_id, "1") or "1")
            for point_element in children(array, "mxPoint"):
                point = point_from_element(point_element)
                if point is not None:
                    points.append(Point(parent_origin.x + point.x, parent_origin.y + point.y))
    points.append(target_rect.center)
    return points


# ---------------------------------------------------------------------------
# SVG parsing helpers

Matrix = Tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply_matrix(a: Matrix, b: Matrix) -> Matrix:
    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def transform_point(matrix: Matrix, point: Point) -> Point:
    return Point(
        matrix[0] * point.x + matrix[2] * point.y + matrix[4],
        matrix[1] * point.x + matrix[3] * point.y + matrix[5],
    )


def transform_from_attribute(value: str) -> Matrix:
    result = IDENTITY
    for name, raw_args in TRANSFORM_RE.findall(value or ""):
        try:
            args = [float(v) for v in re.findall(NUMBER_RE, raw_args)]
        except ValueError:
            continue
        operation: Matrix
        lower = name.lower()
        if lower == "translate" and args:
            operation = (1, 0, 0, 1, args[0], args[1] if len(args) > 1 else 0)
        elif lower == "scale" and args:
            operation = (
                args[0],
                0,
                0,
                args[1] if len(args) > 1 else args[0],
                0,
                0,
            )
        elif lower == "matrix" and len(args) == 6:
            operation = tuple(args)  # type: ignore[assignment]
        elif lower == "rotate" and args:
            radians = math.radians(args[0])
            rotation: Matrix = (
                math.cos(radians),
                math.sin(radians),
                -math.sin(radians),
                math.cos(radians),
                0,
                0,
            )
            if len(args) >= 3:
                cx, cy = args[1], args[2]
                operation = multiply_matrix(
                    multiply_matrix((1, 0, 0, 1, cx, cy), rotation),
                    (1, 0, 0, 1, -cx, -cy),
                )
            else:
                operation = rotation
        else:
            continue
        result = multiply_matrix(result, operation)
    return result


def cubic(p0: Point, p1: Point, p2: Point, p3: Point, steps: int = 8) -> List[Point]:
    result = []
    for index in range(1, steps + 1):
        t = index / steps
        inverse = 1 - t
        result.append(
            Point(
                inverse**3 * p0.x
                + 3 * inverse**2 * t * p1.x
                + 3 * inverse * t**2 * p2.x
                + t**3 * p3.x,
                inverse**3 * p0.y
                + 3 * inverse**2 * t * p1.y
                + 3 * inverse * t**2 * p2.y
                + t**3 * p3.y,
            )
        )
    return result


def quadratic(p0: Point, p1: Point, p2: Point, steps: int = 8) -> List[Point]:
    result = []
    for index in range(1, steps + 1):
        t = index / steps
        inverse = 1 - t
        result.append(
            Point(
                inverse**2 * p0.x + 2 * inverse * t * p1.x + t**2 * p2.x,
                inverse**2 * p0.y + 2 * inverse * t * p1.y + t**2 * p2.y,
            )
        )
    return result


def parse_path(value: str) -> List[List[Point]]:
    """Parse common SVG path commands and sample curves into polylines."""
    tokens = PATH_TOKEN_RE.findall(value or "")
    command_letters = set("AaCcHhLlMmQqSsTtVvZz")
    index = 0
    command: Optional[str] = None
    x = y = 0.0
    start_x = start_y = 0.0
    last_cubic: Optional[Point] = None
    last_quadratic: Optional[Point] = None
    subpaths: List[List[Point]] = []
    current: Optional[List[Point]] = None

    def is_command(token: str) -> bool:
        return token in command_letters

    def take(count: int) -> Optional[List[float]]:
        nonlocal index
        if index + count > len(tokens) or any(
            is_command(t) for t in tokens[index : index + count]
        ):
            return None
        try:
            values = [float(t) for t in tokens[index : index + count]]
        except ValueError:
            return None
        index += count
        return values

    def add(point: Point) -> None:
        nonlocal current
        if current is None:
            current = []
            subpaths.append(current)
        current.append(point)

    while index < len(tokens):
        if is_command(tokens[index]):
            command = tokens[index]
            index += 1
        if command is None:
            break
        upper = command.upper()
        relative = command.islower()

        if upper == "Z":
            if current is not None:
                add(Point(start_x, start_y))
                x, y = start_x, start_y
            last_cubic = None
            last_quadratic = None
            command = None
            continue

        count = {
            "M": 2,
            "L": 2,
            "H": 1,
            "V": 1,
            "C": 6,
            "S": 4,
            "Q": 4,
            "T": 2,
            "A": 7,
        }.get(upper)
        if count is None:
            break
        values = take(count)
        if values is None:
            break

        if upper == "M":
            nx = values[0] + (x if relative else 0)
            ny = values[1] + (y if relative else 0)
            x, y = nx, ny
            start_x, start_y = x, y
            current = []
            subpaths.append(current)
            current.append(Point(x, y))
            command = "l" if relative else "L"
            last_cubic = None
            last_quadratic = None
        elif upper == "L":
            x = values[0] + (x if relative else 0)
            y = values[1] + (y if relative else 0)
            add(Point(x, y))
            last_cubic = None
            last_quadratic = None
        elif upper == "H":
            x = values[0] + (x if relative else 0)
            add(Point(x, y))
            last_cubic = None
            last_quadratic = None
        elif upper == "V":
            y = values[0] + (y if relative else 0)
            add(Point(x, y))
            last_cubic = None
            last_quadratic = None
        elif upper == "C":
            c1 = Point(
                values[0] + (x if relative else 0),
                values[1] + (y if relative else 0),
            )
            c2 = Point(
                values[2] + (x if relative else 0),
                values[3] + (y if relative else 0),
            )
            end = Point(
                values[4] + (x if relative else 0),
                values[5] + (y if relative else 0),
            )
            if current is None:
                add(Point(x, y))
            current.extend(cubic(Point(x, y), c1, c2, end))
            x, y = end.x, end.y
            last_cubic = c2
            last_quadratic = None
        elif upper == "S":
            c1 = (
                Point(2 * x - last_cubic.x, 2 * y - last_cubic.y)
                if last_cubic
                else Point(x, y)
            )
            c2 = Point(
                values[0] + (x if relative else 0),
                values[1] + (y if relative else 0),
            )
            end = Point(
                values[2] + (x if relative else 0),
                values[3] + (y if relative else 0),
            )
            if current is None:
                add(Point(x, y))
            current.extend(cubic(Point(x, y), c1, c2, end))
            x, y = end.x, end.y
            last_cubic = c2
            last_quadratic = None
        elif upper == "Q":
            control = Point(
                values[0] + (x if relative else 0),
                values[1] + (y if relative else 0),
            )
            end = Point(
                values[2] + (x if relative else 0),
                values[3] + (y if relative else 0),
            )
            if current is None:
                add(Point(x, y))
            current.extend(quadratic(Point(x, y), control, end))
            x, y = end.x, end.y
            last_quadratic = control
            last_cubic = None
        elif upper == "T":
            control = (
                Point(2 * x - last_quadratic.x, 2 * y - last_quadratic.y)
                if last_quadratic
                else Point(x, y)
            )
            end = Point(
                values[0] + (x if relative else 0),
                values[1] + (y if relative else 0),
            )
            if current is None:
                add(Point(x, y))
            current.extend(quadratic(Point(x, y), control, end))
            x, y = end.x, end.y
            last_quadratic = control
            last_cubic = None
        elif upper == "A":
            # The endpoint is sufficient for collision testing; arc extrema are
            # uncommon in draw.io edge routes and are rendered as a short path.
            x = values[5] + (x if relative else 0)
            y = values[6] + (y if relative else 0)
            add(Point(x, y))
            last_cubic = None
            last_quadratic = None

    return [path for path in subpaths if path]


def bbox_from_points(points: Sequence[Point]) -> Optional[Rect]:
    if not points:
        return None
    left = min(p.x for p in points)
    top = min(p.y for p in points)
    right = max(p.x for p in points)
    bottom = max(p.y for p in points)
    return Rect(left, top, right - left, bottom - top)


def svg_shape_bbox(element: ET.Element, matrix: Matrix) -> Optional[Rect]:
    tag = local_name(element.tag)
    if tag == "rect":
        x = parse_float(element, "x", 0.0)
        y = parse_float(element, "y", 0.0)
        width = parse_float(element, "width")
        height = parse_float(element, "height")
        if None in (x, y, width, height):
            return None
        points = [
            transform_point(matrix, Point(x, y)),
            transform_point(matrix, Point(x + width, y)),
            transform_point(matrix, Point(x + width, y + height)),
            transform_point(matrix, Point(x, y + height)),
        ]
        return bbox_from_points(points)
    if tag in {"ellipse", "circle"}:
        cx = parse_float(element, "cx", 0.0)
        cy = parse_float(element, "cy", 0.0)
        if tag == "circle":
            rx = ry = parse_float(element, "r")
        else:
            rx = parse_float(element, "rx")
            ry = parse_float(element, "ry")
        if None in (cx, cy, rx, ry):
            return None
        points = [
            transform_point(matrix, Point(cx - rx, cy - ry)),
            transform_point(matrix, Point(cx + rx, cy - ry)),
            transform_point(matrix, Point(cx + rx, cy + ry)),
            transform_point(matrix, Point(cx - rx, cy + ry)),
        ]
        return bbox_from_points(points)
    if tag == "line":
        points = [
            transform_point(
                matrix,
                Point(
                    parse_float(element, "x1", 0.0) or 0.0,
                    parse_float(element, "y1", 0.0) or 0.0,
                ),
            ),
            transform_point(
                matrix,
                Point(
                    parse_float(element, "x2", 0.0) or 0.0,
                    parse_float(element, "y2", 0.0) or 0.0,
                ),
            ),
        ]
        return bbox_from_points(points)
    if tag in {"polyline", "polygon"}:
        values = re.findall(NUMBER_RE, element.get("points", ""))
        if len(values) < 2:
            return None
        points = [
            transform_point(matrix, Point(float(values[i]), float(values[i + 1])))
            for i in range(0, len(values) - 1, 2)
        ]
        return bbox_from_points(points)
    if tag == "path":
        paths = parse_path(element.get("d", ""))
        points = [point for path in paths for point in path]
        return bbox_from_points([transform_point(matrix, point) for point in points])
    return None


def walk_owned(
    element: ET.Element,
    parent_matrix: Matrix,
    owner_id: str,
) -> Iterable[Tuple[ET.Element, Matrix]]:
    """Yield descendants belonging to one data-cell-id group with transforms."""
    current_matrix = multiply_matrix(
        parent_matrix,
        transform_from_attribute(element.get("transform", "")),
    )
    for descendant in list(element):
        descendant_id = descendant.get("data-cell-id")
        if descendant_id is not None and descendant_id != owner_id:
            continue
        descendant_matrix = multiply_matrix(
            current_matrix,
            transform_from_attribute(descendant.get("transform", "")),
        )
        yield descendant, descendant_matrix
        # Pass the matrix before the child transform; the child must not be
        # applied twice when the recursive call processes it.
        yield from walk_owned(descendant, current_matrix, owner_id)


def walk_owned_with_context(
    element: ET.Element,
    parent_matrix: Matrix,
    owner_id: str,
    ancestors: Tuple[ET.Element, ...] = (),
) -> Iterable[Tuple[ET.Element, Matrix, Tuple[ET.Element, ...]]]:
    """Yield owned SVG descendants with transforms and inherited-style context."""
    current_matrix = multiply_matrix(
        parent_matrix,
        transform_from_attribute(element.get("transform", "")),
    )
    for descendant in list(element):
        descendant_id = descendant.get("data-cell-id")
        if descendant_id is not None and descendant_id != owner_id:
            continue
        descendant_matrix = multiply_matrix(
            current_matrix,
            transform_from_attribute(descendant.get("transform", "")),
        )
        descendant_ancestors = ancestors + (element,)
        yield descendant, descendant_matrix, descendant_ancestors
        yield from walk_owned_with_context(
            descendant,
            current_matrix,
            owner_id,
            descendant_ancestors,
        )


def css_style_map(style: str) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for declaration in style.split(";"):
        if ":" in declaration:
            key, value = declaration.split(":", 1)
            result[key.strip().lower()] = value.strip()
    return result


def svg_style_value(
    element: ET.Element,
    ancestors: Sequence[ET.Element],
    property_name: str,
) -> Optional[str]:
    """Read an SVG presentation property, including inherited group styles."""
    property_name = property_name.lower()
    for candidate in (element, *reversed(ancestors)):
        value = candidate.get(property_name)
        if value is not None:
            return value
        value = css_style_map(candidate.get("style", "")).get(property_name)
        if value is not None:
            return value
    return None


def css_number(value: Optional[str], default: Optional[float] = None) -> Optional[float]:
    if value is None:
        return default
    match = re.search(NUMBER_RE, value)
    if match is None:
        return default
    try:
        number = float(match.group(0))
    except ValueError:
        return default
    unit = value[match.end() :].strip().lower()
    if unit.startswith("pt"):
        number *= 96.0 / 72.0
    elif unit.startswith("in"):
        number *= 96.0
    elif unit.startswith("cm"):
        number *= 96.0 / 2.54
    elif unit.startswith("mm"):
        number *= 96.0 / 25.4
    return number if math.isfinite(number) else default


def svg_text_content(element: ET.Element) -> str:
    parts: List[str] = []
    if element.text:
        parts.append(element.text)
    for descendant in list(element):
        if local_name(descendant.tag) == "br":
            parts.append("\n")
        else:
            parts.append(svg_text_content(descendant))
        if descendant.tail:
            parts.append(descendant.tail)
    return "".join(parts)


def estimated_text_width(value: str, font_size: float) -> float:
    """Conservatively estimate an SVG text run when no browser bbox exists."""
    widths = 0.0
    for character in value:
        if character in "\r\n":
            continue
        if character.isspace():
            factor = 0.33
        elif character in "ilI.,:;!'|`\\\"()[]{}":
            factor = 0.28
        elif character in "MW@#%&":
            factor = 0.88
        elif character.isupper() or character.isdigit():
            factor = 0.64
        else:
            factor = 0.55
        widths += font_size * factor
    return widths


def svg_image_bbox(element: ET.Element, matrix: Matrix) -> Optional[Rect]:
    x = parse_float(element, "x", 0.0)
    y = parse_float(element, "y", 0.0)
    width = parse_float(element, "width")
    height = parse_float(element, "height")
    if None in (x, y, width, height) or width < 0 or height < 0:
        return None
    points = [
        transform_point(matrix, Point(x, y)),
        transform_point(matrix, Point(x + width, y)),
        transform_point(matrix, Point(x + width, y + height)),
        transform_point(matrix, Point(x, y + height)),
    ]
    return bbox_from_points(points)


def svg_text_bbox(
    element: ET.Element,
    matrix: Matrix,
    ancestors: Sequence[ET.Element],
) -> Optional[Rect]:
    value = svg_text_content(element)
    if not value.strip():
        return None

    x_match = re.search(NUMBER_RE, element.get("x", ""))
    y_match = re.search(NUMBER_RE, element.get("y", ""))
    if x_match is None or y_match is None:
        return None
    x = float(x_match.group(0))
    y = float(y_match.group(0))
    dx = css_number(element.get("dx"), 0.0) or 0.0
    dy = css_number(element.get("dy"), 0.0) or 0.0
    x += dx
    y += dy

    font_size = css_number(
        svg_style_value(element, ancestors, "font-size"),
        12.0,
    ) or 12.0
    lines = value.splitlines() or [value]
    line_widths = [
        estimated_text_width(line, font_size)
        for line in lines
    ]
    width = max(line_widths, default=0.0)
    text_length = css_number(element.get("textLength"))
    if text_length is not None and len(lines) == 1:
        width = text_length
    letter_spacing = css_number(
        svg_style_value(element, ancestors, "letter-spacing"),
        0.0,
    ) or 0.0
    width += max(len(value) - len(lines), 0) * letter_spacing

    anchor = (svg_style_value(element, ancestors, "text-anchor") or "start").lower()
    if anchor == "middle":
        left = x - width / 2
    elif anchor in {"end", "right"}:
        left = x - width
    else:
        left = x

    line_height = font_size * 1.2
    baseline = (
        svg_style_value(element, ancestors, "dominant-baseline") or ""
    ).lower()
    if baseline in {"middle", "central"}:
        top = y - (len(lines) * line_height) / 2
    elif baseline in {"hanging", "text-before-edge"}:
        top = y
    else:
        top = y - font_size * 0.8
    bottom = top + max(len(lines) * line_height, font_size)

    points = [
        transform_point(matrix, Point(left, top)),
        transform_point(matrix, Point(left + width, top)),
        transform_point(matrix, Point(left + width, bottom)),
        transform_point(matrix, Point(left, bottom)),
    ]
    return bbox_from_points(points)


def rendered_foreign_object_bbox(
    element: ET.Element,
    matrix: Matrix,
) -> Optional[Rect]:
    """Approximate a foreignObject label when its SVG fallback image is absent."""
    text = svg_text_content(element)
    if not text.strip():
        return None

    layout: Optional[ET.Element] = None
    for descendant in element.iter():
        styles = css_style_map(descendant.get("style", ""))
        if "width" in styles and (
            "margin-left" in styles or "padding-top" in styles
        ):
            layout = descendant
            break
    if layout is None:
        return None
    styles = css_style_map(layout.get("style", ""))
    x = css_number(styles.get("margin-left"), 0.0) or 0.0
    y = css_number(styles.get("padding-top"), 0.0) or 0.0
    width = css_number(styles.get("width"))

    font_size = 12.0
    white_space = "normal"
    for descendant in reversed(list(element.iter())):
        descendant_styles = css_style_map(descendant.get("style", ""))
        font_size = css_number(descendant_styles.get("font-size"), font_size) or font_size
        white_space = descendant_styles.get("white-space", white_space).lower()

    lines = text.replace("\r", "").split("\n") or [text]
    measured_width = max(
        (estimated_text_width(line, font_size) for line in lines),
        default=0.0,
    )
    if width is None or width <= 1 or white_space == "nowrap":
        label_width = measured_width
        line_count = len(lines)
    else:
        label_width = width
        line_count = 0
        for line in lines:
            line_count += max(1, math.ceil(estimated_text_width(line, font_size) / width))
    label_height = max(font_size, line_count * font_size * 1.2)
    points = [
        transform_point(matrix, Point(x, y - label_height / 2)),
        transform_point(matrix, Point(x + label_width, y - label_height / 2)),
        transform_point(matrix, Point(x + label_width, y + label_height / 2)),
        transform_point(matrix, Point(x, y + label_height / 2)),
    ]
    return bbox_from_points(points)


def rendered_label_bboxes(group: ET.Element, cell_id: str) -> List[Rect]:
    """Extract visible label bounds from a rendered data-cell group."""
    owned = list(walk_owned_with_context(group, IDENTITY, cell_id))
    matrices = {id(element): matrix for element, matrix, _ in owned}
    label_image_ids: set[int] = set()
    foreign_objects: List[Tuple[ET.Element, Matrix]] = []

    for element, matrix, _ in owned:
        tag = local_name(element.tag)
        if tag == "foreignObject":
            foreign_objects.append((element, matrix))
        if tag != "switch":
            continue
        if not any(local_name(descendant.tag) == "foreignObject" for descendant in element.iter()):
            continue
        for descendant in element.iter():
            if local_name(descendant.tag) == "image":
                label_image_ids.add(id(descendant))

    result: List[Rect] = []
    for element, matrix, _ in owned:
        if local_name(element.tag) == "image" and id(element) in label_image_ids:
            bbox = svg_image_bbox(element, matrix)
            if bbox is not None:
                result.append(bbox)

    if not result:
        for element, matrix in foreign_objects:
            bbox = rendered_foreign_object_bbox(element, matrix)
            if bbox is not None:
                result.append(bbox)

    for element, matrix, ancestors in owned:
        if local_name(element.tag) == "text":
            bbox = svg_text_bbox(element, matrix, ancestors)
            if bbox is not None:
                result.append(bbox)
    return result


def is_svg_stroke_path(element: ET.Element) -> bool:
    pointer_events = element.get("pointer-events", "")
    style = element.get("style", "").replace(" ", "").lower()
    fill = element.get("fill", "").replace(" ", "").lower()
    return "stroke" in pointer_events or fill == "none" or "fill:none" in style


def rendered_edge_arrowheads(
    group: ET.Element,
    cell_id: str,
) -> List[List[Point]]:
    arrowheads: List[List[Point]] = []
    for element, matrix, _ in walk_owned_with_context(group, IDENTITY, cell_id):
        if local_name(element.tag) != "path" or is_svg_stroke_path(element):
            continue
        for path in parse_path(element.get("d", "")):
            transformed = [transform_point(matrix, point) for point in path]
            if len(transformed) >= 2:
                arrowheads.append(transformed)
    return arrowheads


def svg_groups(root: ET.Element) -> Dict[str, ET.Element]:
    result: Dict[str, ET.Element] = {}
    for element in root.iter():
        cell_id = element.get("data-cell-id")
        if cell_id is not None:
            result.setdefault(cell_id, element)
    return result


def rendered_cell_bbox(group: ET.Element, cell_id: str) -> Optional[Rect]:
    candidates: List[Rect] = []
    for element, matrix in walk_owned(group, IDENTITY, cell_id):
        if local_name(element.tag) not in {
            "rect",
            "ellipse",
            "circle",
            "line",
            "polyline",
            "polygon",
            "path",
        }:
            continue
        if element.get("pointer-events") == "none":
            continue
        bbox = svg_shape_bbox(element, matrix)
        if bbox is not None and bbox.width >= 0 and bbox.height >= 0:
            candidates.append(bbox)
    return union_rects(candidates)


def rendered_edge_route(group: ET.Element, cell_id: str) -> Optional[List[Point]]:
    fallback: Optional[List[Point]] = None
    for element, matrix in walk_owned(group, IDENTITY, cell_id):
        if local_name(element.tag) != "path":
            continue
        paths = parse_path(element.get("d", ""))
        if not paths:
            continue
        transformed = [
            transform_point(matrix, point) for point in max(paths, key=len)
        ]
        if len(transformed) < 2:
            continue
        if fallback is None:
            fallback = transformed

        pointer_events = element.get("pointer-events", "")
        style = element.get("style", "").replace(" ", "").lower()
        fill = element.get("fill", "").replace(" ", "").lower()
        # The main connector is normally the open, unfilled path. Arrowhead
        # paths are closed filled triangles and should not become the route.
        if (
            "stroke" in pointer_events
            or fill == "none"
            or "fill:none" in style
        ):
            return transformed
    return fallback


# ---------------------------------------------------------------------------
# Validator


class Validator:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.report: Optional[Report] = None
        self.rendered_routes: Dict[Tuple[int, str], List[Point]] = {}
        self.rendered_rects: Dict[Tuple[int, str], Rect] = {}

    def add(
        self,
        severity: str,
        code: str,
        message: str,
        page: Optional[str] = None,
        cell: Optional[str] = None,
    ) -> None:
        assert self.report is not None
        self.report.findings.append(Finding(severity, code, message, page, cell))

    def label_targets(self, page: Page) -> List[Tuple[str, str, str]]:
        """Return (label cell, kind, owning box/edge) tuples for visible labels."""
        targets: List[Tuple[str, str, str]] = []
        for edge_id in page.edge_ids:
            cell = page.cells[edge_id]
            if (
                has_label_content(cell.get("value", ""))
                and style_map(cell.get("style", "")).get("noLabel") != "1"
            ):
                targets.append((edge_id, "edge", edge_id))

        for cell_id in page.vertex_ids:
            cell = page.cells[cell_id]
            if (
                not has_label_content(cell.get("value", ""))
                or style_map(cell.get("style", "")).get("noLabel") == "1"
            ):
                continue
            if is_edge_label_cell(page, cell_id):
                edge_id = page.parents.get(cell_id)
                if edge_id in page.edge_ids:
                    targets.append((cell_id, "edge", edge_id))
                continue
            if is_text_cell(cell):
                parent_id = page.parents.get(cell_id)
                if parent_id is not None and is_box_cell(page, parent_id):
                    targets.append((cell_id, "child", parent_id))
                # Standalone text cells are commonly used for ports and other
                # intentional external annotations, so they have no owning box.
                continue
            if is_box_cell(page, cell_id) and style_map(cell.get("style", "")).get(
                "noLabel"
            ) != "1":
                targets.append((cell_id, "box", cell_id))
        return targets

    def check_rendered_labels(
        self,
        page: Page,
        groups: Dict[str, ET.Element],
        rendered_rects: Dict[str, Rect],
        routes: Dict[str, List[Point]],
        arrowheads: Dict[str, List[List[Point]]],
    ) -> None:
        label_tolerance = getattr(self.args, "label_tolerance", 1.0)
        box_rects = {
            cell_id: rect
            for cell_id, rect in rendered_rects.items()
            if is_box_cell(page, cell_id)
        }

        for label_id, kind, owner_id in self.label_targets(page):
            if is_effectively_hidden(page, label_id):
                continue
            group = groups.get(label_id)
            if group is None:
                self.add(
                    "warning",
                    "label-not-rendered",
                    "label has no matching SVG cell group",
                    page.name,
                    label_id,
                )
                continue
            label_rects = rendered_label_bboxes(group, label_id)
            label_rect = union_rects(label_rects)
            if label_rect is None:
                self.add(
                    "warning",
                    "label-bounds-unknown",
                    "could not determine rendered label bounds",
                    page.name,
                    label_id,
                )
                continue

            if kind in {"box", "child"}:
                box_rect = rendered_rects.get(owner_id)
                if box_rect is None:
                    self.add(
                        "warning",
                        "label-box-bounds-unknown",
                        f"could not determine rendered bounds for owning box {owner_id!r}",
                        page.name,
                        label_id,
                    )
                else:
                    overflow = rect_overflow(label_rect, box_rect, label_tolerance)
                    if overflow:
                        details = ", ".join(
                            f"{side} {amount:.1f}px" for side, amount in overflow.items()
                        )
                        self.add(
                            "error",
                            "label-outside-box",
                            f"rendered label extends outside its owning box ({details})",
                            page.name,
                            label_id,
                        )
                continue

            # Edge labels are intentionally drawn over or immediately beside
            # their own connector. They must not drift into otherwise empty
            # space, boxes, arrowheads, or unrelated connectors.
            owner_route = routes.get(owner_id)
            if owner_route is not None:
                distance = route_to_rect_distance(owner_route, label_rect)
                if distance > self.args.edge_label_distance:
                    self.add(
                        "error",
                        "edge-label-detached",
                        f"edge label is {distance:.1f}px from its connector {owner_id!r}",
                        page.name,
                        label_id,
                    )

            for box_id, box_rect in box_rects.items():
                if positive_overlap(label_rect, box_rect):
                    self.add(
                        "error",
                        "edge-label-box-overlap",
                        f"edge label overlaps box {box_id!r}",
                        page.name,
                        label_id,
                    )

            for other_edge_id, route in routes.items():
                if other_edge_id == owner_id:
                    continue
                if any(
                    segment_intersects_rect(first, second, label_rect)
                    for first, second in segments(route)
                ):
                    self.add(
                        "error",
                        "edge-label-edge-overlap",
                        f"edge label overlaps connector {other_edge_id!r}",
                        page.name,
                        label_id,
                    )

            reported_arrow_edges: set[str] = set()
            for arrow_edge_id, paths in arrowheads.items():
                if arrow_edge_id in reported_arrow_edges:
                    continue
                for path in paths:
                    arrow_rect = bbox_from_points(path)
                    if arrow_rect is None or not positive_overlap(label_rect, arrow_rect):
                        continue
                    if not any(
                        segment_intersects_rect(first, second, label_rect)
                        for first, second in segments(path)
                    ):
                        # An arrowhead can be wholly inside a label rectangle,
                        # in which case no boundary segment crosses the label.
                        continue
                    self.add(
                        "error",
                        "edge-label-arrow-overlap",
                        f"edge label overlaps arrowhead of edge {arrow_edge_id!r}",
                        page.name,
                        label_id,
                    )
                    reported_arrow_edges.add(arrow_edge_id)
                    break

        # A left/right-aligned standalone annotation placed immediately beside
        # a shape boundary is normally a boundary label (for example, a memory
        # address). Its text center should sit on that horizontal boundary.
        for cell_id in page.vertex_ids:
            cell = page.cells[cell_id]
            styles = style_map(cell.get("style", ""))
            if (
                not is_text_cell(cell)
                or is_edge_label_cell(page, cell_id)
                or page.parents.get(cell_id) not in {"1", None}
                or styles.get("align") not in {"left", "right"}
                or not has_label_content(cell.get("value", ""))
            ):
                continue
            group = groups.get(cell_id)
            if group is None:
                continue
            annotation = union_rects(rendered_label_bboxes(group, cell_id))
            if annotation is None:
                continue
            for box_id, box_rect in box_rects.items():
                horizontal_gap = min(
                    abs(annotation.right - box_rect.x),
                    abs(annotation.x - box_rect.right),
                )
                if horizontal_gap > self.args.annotation_boundary_gap:
                    continue
                boundary_delta = min(
                    abs(annotation.center.y - box_rect.y),
                    abs(annotation.center.y - box_rect.bottom),
                )
                if self.args.alignment_tolerance < boundary_delta <= 20.0:
                    self.add(
                        "warning",
                        "boundary-label-misaligned",
                        f"annotation center is {boundary_delta:.1f}px from the nearby boundary of box {box_id!r}",
                        page.name,
                        cell_id,
                    )
                    break

    def validate_file(self, path: Path) -> Report:
        self.report = Report(str(path), [])
        self.rendered_routes.clear()
        self.rendered_rects.clear()
        source_is_png = is_drawio_png(path)
        try:
            if source_is_png:
                tree = ET.ElementTree(extract_embedded_diagram(path))
            else:
                tree = ET.parse(path)
        except PngFormatError as error:
            self.add("error", "png-parse", str(error))
            return self.report
        except EmbeddedDiagramError as error:
            self.add("error", "embedded-diagram", str(error))
            return self.report
        except (ET.ParseError, OSError) as error:
            self.add("error", "xml-parse", str(error))
            return self.report

        root = tree.getroot()
        if local_name(root.tag) != "mxfile":
            self.add("error", "root-element", "document root must be <mxfile>")
            return self.report

        diagrams = children(root, "diagram")
        if not diagrams:
            self.add("error", "no-pages", "<mxfile> contains no <diagram> pages")
            return self.report

        seen_page_ids: set[str] = set()
        with tempfile.TemporaryDirectory(prefix="drawio-validate-") as temporary:
            temporary_path = Path(temporary)
            render_source = path
            if source_is_png:
                render_source = temporary_path / "embedded.drawio"
                tree.write(render_source, encoding="utf-8", xml_declaration=True)
            for index, diagram in enumerate(diagrams, start=1):
                page_id = diagram.get("id", f"page-{index}")
                page_name = diagram.get("name", page_id)
                if page_id in seen_page_ids:
                    self.add(
                        "error",
                        "duplicate-page-id",
                        f"duplicate diagram id {page_id!r}",
                        page_name,
                    )
                seen_page_ids.add(page_id)

                models = children(diagram, "mxGraphModel")
                if not models:
                    self.add(
                        "error",
                        "compressed-diagram",
                        "page has no child <mxGraphModel>; compressed/encoded diagram data is unsupported",
                        page_name,
                    )
                    continue
                if len(models) > 1:
                    self.add(
                        "error",
                        "multiple-models",
                        "page has more than one <mxGraphModel>",
                        page_name,
                    )
                model = models[0]

                roots = children(model, "root")
                if not roots:
                    self.add("error", "missing-root", "<mxGraphModel> has no <root>", page_name)
                    continue
                if len(roots) > 1:
                    self.add(
                        "error",
                        "multiple-roots",
                        "<mxGraphModel> has more than one <root>",
                        page_name,
                    )
                model_root = roots[0]

                page = self.make_page(index, page_name, page_id, model, model_root)
                self.validate_page(page)
                if self.args.no_render:
                    self.check_static_routes(page)
                else:
                    output = temporary_path / f"page-{index}.svg"
                    if self.args.render_dir:
                        render_dir = Path(self.args.render_dir)
                        render_dir.mkdir(parents=True, exist_ok=True)
                        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", path.name)
                        output = render_dir / f"{safe_name}-page-{index}.svg"
                    self.render_page(render_source, page, output)

        return self.report

    def make_page(
        self,
        index: int,
        name: str,
        page_id: str,
        model: ET.Element,
        model_root: ET.Element,
    ) -> Page:
        cell_elements = [
            element
            for element in model_root.iter()
            if local_name(element.tag) == "mxCell"
        ]
        cells: Dict[str, ET.Element] = {}
        duplicate_ids: set[str] = set()
        for element in cell_elements:
            cell_id = element.get("id")
            if not cell_id:
                self.add("error", "missing-cell-id", "mxCell has no id", name)
                continue
            if cell_id in cells:
                duplicate_ids.add(cell_id)
            else:
                cells[cell_id] = element
        for duplicate_id in duplicate_ids:
            self.add(
                "error",
                "duplicate-cell-id",
                f"duplicate cell id {duplicate_id!r}",
                name,
                duplicate_id,
            )

        parents = {
            cell_id: element.get("parent")
            for cell_id, element in cells.items()
        }
        vertex_ids = [
            cell_id
            for cell_id, element in cells.items()
            if element.get("vertex") == "1"
        ]
        edge_ids = [
            cell_id
            for cell_id, element in cells.items()
            if element.get("edge") == "1"
        ]
        geometry = {
            cell_id: geometry_element
            for cell_id, element in cells.items()
            if (geometry_element := child(element, "mxGeometry")) is not None
        }
        return Page(
            index,
            name,
            page_id,
            model,
            model_root,
            cells,
            parents,
            vertex_ids,
            edge_ids,
            geometry,
            {},
            {},
        )

    def validate_page(self, page: Page) -> None:
        label = page.name
        if "0" not in page.cells:
            self.add(
                "error",
                "missing-root-cell",
                'page is missing mxCell id="0"',
                label,
            )
        elif page.parents.get("0") is not None:
            self.add(
                "error",
                "root-parent",
                'mxCell id="0" must not have a parent',
                label,
                "0",
            )
        if "1" not in page.cells:
            self.add(
                "error",
                "missing-layer-cell",
                'page is missing mxCell id="1"',
                label,
            )
        elif page.parents.get("1") != "0":
            self.add(
                "error",
                "layer-parent",
                'mxCell id="1" must have parent="0"',
                label,
                "1",
            )

        for cell_id, element in page.cells.items():
            if cell_id not in {"0", "1"}:
                parent_id = page.parents.get(cell_id)
                if not parent_id:
                    self.add("error", "missing-parent", "cell has no parent", label, cell_id)
                elif parent_id not in page.cells:
                    self.add(
                        "error",
                        "unknown-parent",
                        f"parent {parent_id!r} does not exist",
                        label,
                        cell_id,
                    )
            if element.get("vertex") == "1" and element.get("edge") == "1":
                self.add(
                    "error",
                    "vertex-edge-cell",
                    "cell cannot be both a vertex and an edge",
                    label,
                    cell_id,
                )

        for cell_id in page.cells:
            seen: set[str] = set()
            current: Optional[str] = cell_id
            while current is not None:
                if current in seen:
                    self.add(
                        "error",
                        "parent-cycle",
                        "parent references contain a cycle",
                        label,
                        cell_id,
                    )
                    break
                seen.add(current)
                current = page.parents.get(current)

        for cell_id in page.vertex_ids:
            if is_edge_label_cell(page, cell_id):
                continue
            element = page.cells[cell_id]
            geo = page.geometry.get(cell_id)
            if geo is None:
                self.add("error", "missing-geometry", "vertex has no mxGeometry", label, cell_id)
                continue
            width = parse_float(geo, "width")
            height = parse_float(geo, "height")
            if width is None or height is None:
                self.add(
                    "error",
                    "invalid-geometry",
                    "vertex width and height must be finite numbers",
                    label,
                    cell_id,
                )
                continue
            if width < 0 or height < 0:
                self.add(
                    "error",
                    "negative-size",
                    "vertex width and height cannot be negative",
                    label,
                    cell_id,
                )
            elif width <= EPSILON or height <= EPSILON:
                self.add(
                    "warning",
                    "zero-size",
                    "vertex has zero width or height",
                    label,
                    cell_id,
                )
            if (
                parse_float(geo, "x", 0.0) is None
                or parse_float(geo, "y", 0.0) is None
            ):
                self.add(
                    "error",
                    "invalid-geometry",
                    "vertex x and y must be finite numbers",
                    label,
                    cell_id,
                )
            rect = rect_for(page, cell_id)
            if rect is not None and width >= 0 and height >= 0:
                page.rects[cell_id] = rect

            if is_effectively_hidden(page, cell_id):
                continue

        for cell_id in page.edge_ids:
            element = page.cells[cell_id]
            source = element.get("source")
            target = element.get("target")
            if not source or not target:
                severity = "warning" if self.args.allow_floating else "error"
                self.add(
                    severity,
                    "unconnected-edge",
                    "edge must have both source and target IDs",
                    label,
                    cell_id,
                )
            else:
                if source not in page.cells:
                    self.add(
                        "error",
                        "unknown-source",
                        f"source {source!r} does not exist",
                        label,
                        cell_id,
                    )
                elif source not in page.vertex_ids:
                    self.add(
                        "error",
                        "source-not-vertex",
                        f"source {source!r} is not a box/shape vertex",
                        label,
                        cell_id,
                    )
                if target not in page.cells:
                    self.add(
                        "error",
                        "unknown-target",
                        f"target {target!r} does not exist",
                        label,
                        cell_id,
                    )
                elif target not in page.vertex_ids:
                    self.add(
                        "error",
                        "target-not-vertex",
                        f"target {target!r} is not a box/shape vertex",
                        label,
                        cell_id,
                    )
                if (
                    source == target
                    and style_map(element.get("style", "")).get(
                        "validationAllowSelfLoop"
                    )
                    != "1"
                ):
                    self.add(
                        "warning",
                        "self-loop",
                        "edge source and target are the same shape; add validationAllowSelfLoop=1 after reviewing its rendered route",
                        label,
                        cell_id,
                    )
                if source in page.cells and is_effectively_hidden(page, source):
                    self.add(
                        "warning",
                        "hidden-source",
                        f"source shape {source!r} is hidden",
                        label,
                        cell_id,
                    )
                if target in page.cells and is_effectively_hidden(page, target):
                    self.add(
                        "warning",
                        "hidden-target",
                        f"target shape {target!r} is hidden",
                        label,
                        cell_id,
                    )

            geo = page.geometry.get(cell_id)
            if geo is None:
                self.add(
                    "error",
                    "missing-edge-geometry",
                    "edge has no mxGeometry",
                    label,
                    cell_id,
                )
            elif geo.get("relative") != "1":
                self.add(
                    "error",
                    "edge-not-relative",
                    'connected edge geometry must use relative="1"',
                    label,
                    cell_id,
                )

        for cell_id, element in page.cells.items():
            if (
                cell_id not in {"0", "1"}
                and element.get("vertex") != "1"
                and element.get("edge") != "1"
            ):
                self.add(
                    "warning",
                    "untyped-cell",
                    "cell is neither a vertex nor an edge",
                    label,
                    cell_id,
                )

        self.check_box_overlaps(page)

    def check_box_overlaps(self, page: Page) -> None:
        visible = [
            cell_id
            for cell_id in page.vertex_ids
            if is_box_cell(page, cell_id)
            and not is_effectively_hidden(page, cell_id)
            and cell_id in page.rects
        ]
        for first, second in combinations(visible, 2):
            # Containment is intentional for groups/swimlanes and their children;
            # unrelated boxes with positive-area intersection are not.
            if is_ancestor(page, first, second) or is_ancestor(page, second, first):
                continue
            first_rect = page.rects[first]
            second_rect = page.rects[second]
            if positive_overlap(first_rect, second_rect):
                self.add(
                    "error",
                    "box-overlap",
                    f"boxes overlap: {first!r} and {second!r}",
                    page.name,
                    first,
                )

    def check_static_routes(self, page: Page) -> None:
        routes: Dict[str, List[Point]] = {}
        for edge_id in page.edge_ids:
            route = static_edge_route(page, edge_id)
            if route is None:
                continue
            routes[edge_id] = route
            edge = page.cells[edge_id]
            source = edge.get("source")
            target = edge.get("target")
            for first, second in segments(route):
                for vertex_id in page.vertex_ids:
                    if not is_box_cell(page, vertex_id):
                        continue
                    if vertex_id in {source, target} or is_effectively_hidden(page, vertex_id):
                        continue
                    if is_ancestor(page, vertex_id, source or "") or is_ancestor(
                        page, vertex_id, target or ""
                    ):
                        continue
                    if vertex_id in page.rects and segment_intersects_rect(
                        first,
                        second,
                        page.rects[vertex_id].inflate(self.args.clearance),
                    ):
                        self.add(
                            "error",
                            "edge-box-overlap",
                            f"edge route intersects box {vertex_id!r}",
                            page.name,
                            edge_id,
                        )
                        break

        self.check_edge_crossings(page, routes)

    def check_edge_crossings(
        self,
        page: Page,
        routes: Dict[str, List[Point]],
    ) -> None:
        for first_id, second_id in combinations(routes, 2):
            first = page.cells[first_id]
            second = page.cells[second_id]
            first_endpoints = {first.get("source"), first.get("target")}
            second_endpoints = {second.get("source"), second.get("target")}
            shared_endpoints = first_endpoints & second_endpoints
            overlap = max(
                (
                    collinear_overlap_length(a, b, c, d)
                    for a, b in segments(routes[first_id])
                    for c, d in segments(routes[second_id])
                ),
                default=0.0,
            )
            if overlap > self.args.edge_overlap_tolerance:
                self.add(
                    "warning",
                    "edge-overlap",
                    f"edge routes share {overlap:.1f}px: {first_id!r} and {second_id!r}",
                    page.name,
                    first_id,
                )
                continue
            if shared_endpoints:
                continue
            if any(
                segments_intersect(a, b, c, d)
                for a, b in segments(routes[first_id])
                for c, d in segments(routes[second_id])
            ):
                self.add(
                    "warning",
                    "edge-crossing",
                    f"edge routes cross: {first_id!r} and {second_id!r}",
                    page.name,
                    first_id,
                )

    def render_page(self, source: Path, page: Page, output: Path) -> None:
        drawio = find_drawio(self.args.drawio)
        if not executable_available(drawio):
            severity = "error" if self.args.require_render else "warning"
            self.add(
                severity,
                "renderer-unavailable",
                f"draw.io CLI not found at {drawio!r}",
                page.name,
            )
            self.check_static_routes(page)
            return

        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            output.unlink()
        except FileNotFoundError:
            pass

        command = [
            drawio,
            "--disable-update",
            "--export",
            "--format",
            "svg",
            "--output",
            str(output),
            "--size",
            "diagram",
            "--theme",
            "light",
            "--border",
            "10",
            "--page-index",
            str(page.index),
            "--uncompressed",
            str(source),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=self.args.timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            severity = "error" if self.args.require_render else "warning"
            self.add(
                severity,
                "render-failed",
                f"draw.io SVG export failed: {error}",
                page.name,
            )
            self.check_static_routes(page)
            return
        if result.returncode != 0 or not output.is_file():
            details = (result.stderr or result.stdout).strip()
            severity = "error" if self.args.require_render else "warning"
            message = f"draw.io SVG export failed (exit {result.returncode})"
            if details:
                message += f": {details[-300:]}"
            self.add(severity, "render-failed", message, page.name)
            self.check_static_routes(page)
            return

        try:
            svg_root = ET.parse(output).getroot()
        except (ET.ParseError, OSError) as error:
            self.add(
                "error",
                "svg-parse",
                f"rendered SVG is invalid: {error}",
                page.name,
            )
            return
        self.inspect_rendered_page(page, svg_root)

    def inspect_rendered_page(self, page: Page, svg_root: ET.Element) -> None:
        groups = svg_groups(svg_root)
        rendered_rects: Dict[str, Rect] = {}
        for cell_id in page.vertex_ids:
            if is_edge_label_cell(page, cell_id) or is_effectively_hidden(page, cell_id):
                continue
            group = groups.get(cell_id)
            if group is None:
                self.add(
                    "error",
                    "shape-not-rendered",
                    "vertex has no matching SVG cell group",
                    page.name,
                    cell_id,
                )
                continue
            rect = rendered_cell_bbox(group, cell_id)
            if rect is None:
                self.add(
                    "warning",
                    "shape-bounds-unknown",
                    "could not determine rendered shape bounds",
                    page.name,
                    cell_id,
                )
            else:
                rendered_rects[cell_id] = rect
                self.rendered_rects[(page.index, cell_id)] = rect

        routes: Dict[str, List[Point]] = {}
        arrowheads: Dict[str, List[List[Point]]] = {}
        for edge_id in page.edge_ids:
            edge = page.cells[edge_id]
            source = edge.get("source")
            target = edge.get("target")
            if not source or not target:
                continue
            group = groups.get(edge_id)
            if group is None:
                self.add(
                    "error",
                    "edge-not-rendered",
                    "edge has no matching SVG cell group",
                    page.name,
                    edge_id,
                )
                continue
            arrowheads[edge_id] = rendered_edge_arrowheads(group, edge_id)
            route = rendered_edge_route(group, edge_id)
            if route is None or len(route) < 2:
                self.add(
                    "error",
                    "edge-route-missing",
                    "could not determine rendered edge route",
                    page.name,
                    edge_id,
                )
                continue
            routes[edge_id] = route
            self.rendered_routes[(page.index, edge_id)] = route

            source_rect = rendered_rects.get(source)
            target_rect = rendered_rects.get(target)
            if source_rect is not None:
                distance = point_to_rect_boundary_distance(route[0], source_rect)
                if distance > self.args.endpoint_tolerance:
                    self.add(
                        "error",
                        "source-disconnected",
                        f"rendered edge starts {distance:.1f}px from source shape {source!r}",
                        page.name,
                        edge_id,
                    )
            if target_rect is not None:
                distance = point_to_rect_boundary_distance(route[-1], target_rect)
                if distance > self.args.endpoint_tolerance:
                    self.add(
                        "error",
                        "target-disconnected",
                        f"rendered edge ends {distance:.1f}px from target shape {target!r}",
                        page.name,
                        edge_id,
                    )

            for endpoint_kind, endpoint, endpoint_id, endpoint_rect in (
                ("source", route[0], source, source_rect),
                ("target", route[-1], target, target_rect),
            ):
                if endpoint_rect is None or endpoint_id is None:
                    continue
                endpoint_cell = page.cells.get(endpoint_id)
                endpoint_style = (
                    endpoint_cell.get("style", "") if endpoint_cell is not None else ""
                )
                endpoint_styles = style_map(endpoint_style)
                if (
                    endpoint_styles.get("shape") in {"ellipse", "rhombus"}
                    or has_style_token(endpoint_style, "ellipse")
                    or has_style_token(endpoint_style, "rhombus")
                ):
                    continue
                near_horizontal_corner = min(
                    abs(endpoint.x - endpoint_rect.x),
                    abs(endpoint.x - endpoint_rect.right),
                ) <= self.args.corner_tolerance
                near_vertical_corner = min(
                    abs(endpoint.y - endpoint_rect.y),
                    abs(endpoint.y - endpoint_rect.bottom),
                ) <= self.args.corner_tolerance
                if near_horizontal_corner and near_vertical_corner:
                    self.add(
                        "warning",
                        "edge-endpoint-at-corner",
                        f"rendered {endpoint_kind} endpoint attaches at a corner of shape {endpoint_id!r}",
                        page.name,
                        edge_id,
                    )

            for first, second in segments(route):
                for vertex_id, rect in rendered_rects.items():
                    if not is_box_cell(page, vertex_id):
                        continue
                    if vertex_id in {source, target} or is_effectively_hidden(
                        page, vertex_id
                    ):
                        continue
                    if is_ancestor(page, vertex_id, source) or is_ancestor(
                        page, vertex_id, target
                    ):
                        continue
                    if segment_intersects_rect(
                        first,
                        second,
                        rect.inflate(self.args.clearance),
                    ):
                        self.add(
                            "error",
                            "rendered-edge-box-overlap",
                            f"rendered edge route intersects box {vertex_id!r}",
                            page.name,
                            edge_id,
                        )
                        break

        self.check_rendered_labels(
            page,
            groups,
            rendered_rects,
            routes,
            arrowheads,
        )
        self.check_edge_crossings(page, routes)


def executable_available(value: str) -> bool:
    return Path(value).is_file() or shutil.which(value) is not None


def find_drawio(explicit: Optional[str]) -> str:
    if explicit:
        return explicit
    return shutil.which("drawio") or shutil.which("draw.io") or DEFAULT_DRAWIO


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate draw.io XML structure and rendered geometry."
    )
    parser.add_argument(
        "files",
        nargs="+",
        type=Path,
        help=".drawio, .drawio.xml, or .drawio.png files to validate",
    )
    parser.add_argument(
        "--no-render",
        action="store_true",
        help="skip draw.io SVG rendering and use XML geometry only (no rendered label checks)",
    )
    parser.add_argument(
        "--require-render",
        action="store_true",
        help="fail if draw.io cannot render the page to SVG",
    )
    parser.add_argument("--drawio", help="path to the draw.io CLI executable")
    parser.add_argument(
        "--render-dir",
        help="keep rendered SVGs in this directory",
    )
    parser.add_argument(
        "--clearance",
        type=float,
        default=1.0,
        help="extra pixels around boxes for edge collision checks (default: 1)",
    )
    parser.add_argument(
        "--endpoint-tolerance",
        type=float,
        default=16.0,
        help="allowed rendered distance from an edge path endpoint to a shape (default: 16)",
    )
    parser.add_argument(
        "--label-tolerance",
        type=float,
        default=1.0,
        help="allowed rendered label overflow beyond its owning box in pixels (default: 1)",
    )
    parser.add_argument(
        "--edge-label-distance",
        type=float,
        default=12.0,
        help="maximum gap between an edge label and its own connector in pixels (default: 12)",
    )
    parser.add_argument(
        "--edge-overlap-tolerance",
        type=float,
        default=4.0,
        help="allowed collinear overlap between connector routes in pixels (default: 4)",
    )
    parser.add_argument(
        "--corner-tolerance",
        type=float,
        default=4.0,
        help="distance from both sides treated as a connector attached at a box corner (default: 4)",
    )
    parser.add_argument(
        "--annotation-boundary-gap",
        type=float,
        default=40.0,
        help="maximum gap used to identify standalone boundary annotations (default: 40)",
    )
    parser.add_argument(
        "--alignment-tolerance",
        type=float,
        default=3.0,
        help="allowed boundary-label center misalignment in pixels (default: 3)",
    )
    parser.add_argument(
        "--allow-floating",
        action="store_true",
        help="allow edges without both endpoints, reported as warnings",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="treat warnings as failures",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="draw.io render timeout in seconds (default: 120)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON",
    )
    return parser.parse_args(argv)


def finding_location(finding: Finding) -> str:
    location = []
    if finding.page is not None:
        location.append(f"page={finding.page!r}")
    if finding.cell is not None:
        location.append(f"cell={finding.cell!r}")
    return f" ({', '.join(location)})" if location else ""


def print_human(report: Report, strict: bool) -> None:
    result = report.as_dict(strict)
    status = "PASS" if result["ok"] else "FAIL"
    print(
        f"{status}: {report.path} "
        f"({result['errors']} errors, {result['warnings']} warnings)"
    )
    for finding in report.findings:
        print(
            f"  {finding.severity.upper()} {finding.code}: "
            f"{finding.message}{finding_location(finding)}"
        )


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    validator = Validator(args)
    reports = [validator.validate_file(path) for path in args.files]

    if args.json:
        payload = [report.as_dict(args.strict) for report in reports]
        print(json.dumps(payload[0] if len(payload) == 1 else payload, indent=2))
    else:
        for report in reports:
            print_human(report, args.strict)

    return 0 if all(report.as_dict(args.strict)["ok"] for report in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
