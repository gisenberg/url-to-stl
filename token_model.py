"""QR encoding, physical constraints, and a single watertight printable solid."""

import io
import json
import math
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

import manifold3d as manifold
import numpy as np
import qrcode
import trimesh
import zxingcpp
from PIL import Image, ImageDraw


class InputError(ValueError):
    pass


def number(data, key, default, minimum, maximum):
    try:
        value = float(data.get(key, default))
    except (TypeError, ValueError) as error:
        raise InputError(f"{key.replace('_', ' ').capitalize()} must be a number.") from error
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise InputError(f"{key.replace('_', ' ').capitalize()} must be between {minimum} and {maximum}.")
    return value


def measurement_mm(data, key, default, minimum, maximum):
    unit = data.get(f"{key}_unit", "mm")
    if unit not in ("mm", "in"):
        raise InputError(f"{key.replace('_', ' ').capitalize()} unit must be millimeters or inches.")
    try:
        value = float(data.get(key, default if unit == "mm" else default / 25.4))
    except (TypeError, ValueError) as error:
        raise InputError(f"{key.replace('_', ' ').capitalize()} must be a number.") from error
    value *= 25.4 if unit == "in" else 1
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise InputError(
            f"{key.replace('_', ' ').capitalize()} must be between {minimum:g} and {maximum:g} mm."
        )
    return round(value, 6)


def color(data, key, default):
    value = data.get(key, default)
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise InputError("Colors must be six-digit hex values.")
    return value.upper()


def luminance(hex_color):
    rgb = [int(hex_color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    return sum(v * w for v, w in zip(linear, (0.2126, 0.7152, 0.0722)))


TOKEN_SHAPES = {"circle", "square", "rectangle", "pentagon", "hexagon"}
CORNER_STYLES = {"default", "sharp", "softened", "rounded", "custom"}
EDGE_PROFILES = {"straight", "chamfered", "rounded", "inset", "tapered"}
TOKEN_PRESETS = {"custom", "business-card"}
TOKEN_ICONS = {"none", "instagram", "x", "facebook", "linkedin", "youtube", "tiktok"}
QR_MODULE_STYLES = {"square", "rounded", "dots", "faceted", "triangle"}
QR_FINDER_STYLES = {"square", "rounded", "circle"}
QR_FINDER_CENTER_STYLES = {"square", "rounded", "circle", "diamond"}
QR_CENTER_ICONS = {"none", "blank", "instagram", "x", "facebook", "linkedin", "youtube", "tiktok"}
FONT_AWESOME_BRANDS = json.loads(
    (Path(__file__).resolve().parent / "assets" / "fontawesome-brands.json").read_text(encoding="utf-8")
)["icons"]


def regular_polygon(sides, width, start_angle):
    points = [
        (math.cos(start_angle + math.tau * index / sides), math.sin(start_angle + math.tau * index / sides))
        for index in range(sides)
    ]
    xs, ys = zip(*points)
    scale = width / (max(xs) - min(xs))
    center_x, center_y = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    return [(round((x - center_x) * scale, 6), round((y - center_y) * scale, 6)) for x, y in points]


def rounded_polygon(points, radius, segments=8):
    rounded = []
    for index, point in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        incoming = (previous[0] - point[0], previous[1] - point[1])
        outgoing = (following[0] - point[0], following[1] - point[1])
        incoming_length = math.hypot(*incoming)
        outgoing_length = math.hypot(*outgoing)
        incoming = (incoming[0] / incoming_length, incoming[1] / incoming_length)
        outgoing = (outgoing[0] / outgoing_length, outgoing[1] / outgoing_length)
        angle = math.acos(max(-1, min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1])))
        tangent = min(radius / math.tan(angle / 2), incoming_length * 0.45, outgoing_length * 0.45)
        actual_radius = tangent * math.tan(angle / 2)
        bisector = (incoming[0] + outgoing[0], incoming[1] + outgoing[1])
        bisector_length = math.hypot(*bisector)
        center_distance = actual_radius / math.sin(angle / 2)
        center = (
            point[0] + bisector[0] / bisector_length * center_distance,
            point[1] + bisector[1] / bisector_length * center_distance,
        )
        start = math.atan2(
            point[1] + incoming[1] * tangent - center[1], point[0] + incoming[0] * tangent - center[0]
        )
        end = math.atan2(
            point[1] + outgoing[1] * tangent - center[1], point[0] + outgoing[0] * tangent - center[0]
        )
        while end <= start:
            end += math.tau
        rounded.extend(
            (
                round(center[0] + actual_radius * math.cos(start + (end - start) * step / segments), 6),
                round(center[1] + actual_radius * math.sin(start + (end - start) * step / segments), 6),
            )
            for step in range(segments)
        )
    return rounded


def normalize_outline(outline, width, height):
    current_width, current_height = outline_dimensions(outline)
    return [(round(x * width / current_width, 6), round(y * height / current_height, 6)) for x, y in outline]


def shape_outline(shape, width, height=None, corner_style="default", corner_radius=4):
    height = width if height is None else height
    if shape == "circle":
        return [
            (
                round(width / 2 * math.cos(math.tau * index / 256), 6),
                round(width / 2 * math.sin(math.tau * index / 256), 6),
            )
            for index in range(256)
        ]
    if shape in ("square", "rectangle"):
        points = [
            (width / 2, height / 2),
            (-width / 2, height / 2),
            (-width / 2, -height / 2),
            (width / 2, -height / 2),
        ]
    else:
        points = regular_polygon(
            5 if shape == "pentagon" else 6, width, math.pi / 2 if shape == "pentagon" else 0
        )
    if corner_style == "sharp" or (corner_style == "default" and shape in ("pentagon", "hexagon")):
        return points
    if corner_style == "default":
        radius = min(
            4 if shape == "square" else 5,
            (width if shape == "square" else height) * (0.07 if shape == "square" else 0.1),
        )
    elif corner_style == "softened":
        radius = min(1.2, width * 0.03)
    elif corner_style == "rounded":
        radius = min(4, width * 0.08)
    else:
        radius = corner_radius
    return normalize_outline(rounded_polygon(points, radius), width, height)


def outline_dimensions(outline):
    xs, ys = zip(*outline)
    return round(max(xs) - min(xs), 6), round(max(ys) - min(ys), 6)


def inset_outline(outline, width, height, inset):
    if inset <= 0:
        return outline
    return [
        (round(x * (width - 2 * inset) / width, 6), round(y * (height - 2 * inset) / height, 6))
        for x, y in outline
    ]


def module_size_for_outline(outline, modules, center_x=0, center_y=0, clearance=1):
    qr_half = math.inf
    for index, (ax, ay) in enumerate(outline):
        bx, by = outline[(index + 1) % len(outline)]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        distance = abs(dx * (center_y - ay) - dy * (center_x - ax)) / length
        square_projection = (abs(dx) + abs(dy)) / length
        qr_half = min(qr_half, (distance - clearance) / square_projection)
    return max(0, 2 * qr_half / (modules + 8))


def module_size_for_shape(
    shape, width, height, modules, corner_style="default", perimeter_inset=0, clearance=1, corner_radius=4
):
    outline = shape_outline(shape, width, height, corner_style, corner_radius)
    return module_size_for_outline(
        inset_outline(outline, width, height, perimeter_inset), modules, clearance=clearance
    )


def minimum_shape_width(
    shape, modules, minimum_module, corner_style="default", perimeter_inset=0, clearance=1, corner_radius=4
):
    low, high = 25.0, 200.0
    if (
        module_size_for_shape(
            shape, high, high, modules, corner_style, perimeter_inset, clearance, corner_radius
        )
        < minimum_module
    ):
        return math.inf
    for _ in range(48):
        middle = (low + high) / 2
        if (
            module_size_for_shape(
                shape, middle, middle, modules, corner_style, perimeter_inset, clearance, corner_radius
            )
            >= minimum_module
        ):
            high = middle
        else:
            low = middle
    return math.ceil(high - 1e-7)


def edge_slices(profile, size, base):
    if profile == "straight":
        return [(0, 0), (base, 0)]
    if profile == "chamfered":
        height = min(size, base * 0.8)
        slices = [(0, size), (height, 0)]
    elif profile == "rounded":
        height = min(size, base * 0.8)
        slices = [
            (
                round(height * math.sin(math.pi / 2 * step / 6), 6),
                round(size * math.cos(math.pi / 2 * step / 6), 6),
            )
            for step in range(7)
        ]
    elif profile == "inset":
        height = min(0.4, base * 0.5)
        slices = [(0, size), (height, size), (height, 0)]
    else:
        slices = [(0, size), (base, 0)]
    if slices[-1][0] < base - 1e-7:
        slices.append((base, 0))
    return slices


def top_edge_slices(profile, size, height):
    if profile == "straight":
        return [(0, 0), (height, 0)]
    if profile == "chamfered":
        effect = min(size, height * 0.8)
        slices = [(0, 0), (height - effect, 0), (height, size)]
    elif profile == "rounded":
        effect = min(size, height * 0.8)
        slices = [
            (
                round(height - effect + effect * math.sin(math.pi / 2 * step / 6), 6),
                round(size * (1 - math.cos(math.pi / 2 * step / 6)), 6),
            )
            for step in range(7)
        ]
        if slices[0][0] > 1e-7:
            slices.insert(0, (0, 0))
    elif profile == "inset":
        effect = min(0.4, height * 0.5)
        slices = [(0, 0), (height - effect, 0), (height - effect, size), (height, size)]
    else:
        slices = [(0, 0), (height, size)]
    return slices


def combined_base_slices(bottom_profile, bottom_size, top_profile, top_size, height):
    if top_profile == "straight":
        return edge_slices(bottom_profile, bottom_size, height)
    if bottom_profile == "straight":
        return top_edge_slices(top_profile, top_size, height)
    lower_height = height / 2
    lower = edge_slices(bottom_profile, bottom_size, lower_height)
    upper = [
        (round(z + lower_height, 6), inset)
        for z, inset in top_edge_slices(top_profile, top_size, height - lower_height)
    ]
    return lower + upper[1:]


def rectangle_outline(cx, cy, width, height):
    return [
        (round(cx + width / 2, 6), round(cy + height / 2, 6)),
        (round(cx - width / 2, 6), round(cy + height / 2, 6)),
        (round(cx - width / 2, 6), round(cy - height / 2, 6)),
        (round(cx + width / 2, 6), round(cy - height / 2, 6)),
    ]


def circle_outline(cx, cy, radius, segments=32):
    return [
        (
            round(cx + radius * math.cos(math.tau * index / segments), 6),
            round(cy + radius * math.sin(math.tau * index / segments), 6),
        )
        for index in range(segments)
    ]


def icon_outlines(icon, center_x, center_y, size):
    if icon == "none":
        return []
    return [
        [(round(center_x + x * size, 6), round(center_y + y * size, 6)) for x, y in outline]
        for outline in FONT_AWESOME_BRANDS[icon]["outlines"]
    ]


def rounded_rectangle_outline(cx, cy, width, height, radius, segments=4):
    points = []
    corners = [
        (cx + width / 2 - radius, cy + height / 2 - radius, 0),
        (cx - width / 2 + radius, cy + height / 2 - radius, math.pi / 2),
        (cx - width / 2 + radius, cy - height / 2 + radius, math.pi),
        (cx + width / 2 - radius, cy - height / 2 + radius, math.pi * 1.5),
    ]
    for corner_x, corner_y, start in corners:
        for step in range(segments + 1):
            angle = start + math.pi / 2 * step / segments
            points.append(
                (round(corner_x + radius * math.cos(angle), 6), round(corner_y + radius * math.sin(angle), 6))
            )
    return points


def is_finder_cell(row, column, modules):
    return (
        (row < 7 and column < 7) or (row < 7 and column >= modules - 7) or (row >= modules - 7 and column < 7)
    )


def finder_center_outline(style, center_x, center_y, pitch):
    if style == "circle":
        return circle_outline(center_x, center_y, 1.5 * pitch, 40)
    if style == "rounded":
        return rounded_rectangle_outline(center_x, center_y, 3 * pitch, 3 * pitch, pitch * 0.7, 8)
    if style == "diamond":
        radius = 1.65 * pitch
        return [
            (round(center_x, 6), round(center_y + radius, 6)),
            (round(center_x - radius, 6), round(center_y, 6)),
            (round(center_x, 6), round(center_y - radius, 6)),
            (round(center_x + radius, 6), round(center_y, 6)),
        ]
    return rectangle_outline(center_x, center_y, 3 * pitch, 3 * pitch)


def finder_outlines(style, center_style, left, bottom, pitch):
    outlines = []
    center_x = left + 3.5 * pitch
    center_y = bottom + 3.5 * pitch
    if style == "circle":
        for step in range(32):
            a, b = math.tau * step / 32, math.tau * (step + 1) / 32
            outlines.append(
                [
                    (
                        round(center_x + 3.5 * pitch * math.cos(a), 6),
                        round(center_y + 3.5 * pitch * math.sin(a), 6),
                    ),
                    (
                        round(center_x + 3.5 * pitch * math.cos(b), 6),
                        round(center_y + 3.5 * pitch * math.sin(b), 6),
                    ),
                    (
                        round(center_x + 2.5 * pitch * math.cos(b), 6),
                        round(center_y + 2.5 * pitch * math.sin(b), 6),
                    ),
                    (
                        round(center_x + 2.5 * pitch * math.cos(a), 6),
                        round(center_y + 2.5 * pitch * math.sin(a), 6),
                    ),
                ]
            )
        outlines.append(finder_center_outline(center_style, center_x, center_y, pitch))
        return outlines
    if style == "rounded":
        stroke = pitch
        radius = pitch * 0.5
        outlines.append(rounded_rectangle_outline(center_x, bottom + 6.5 * pitch, 7 * pitch, stroke, radius))
        outlines.append(rounded_rectangle_outline(center_x, bottom + 0.5 * pitch, 7 * pitch, stroke, radius))
        outlines.append(rounded_rectangle_outline(left + 0.5 * pitch, center_y, stroke, 5.2 * pitch, radius))
        outlines.append(rounded_rectangle_outline(left + 6.5 * pitch, center_y, stroke, 5.2 * pitch, radius))
        outlines.append(finder_center_outline(center_style, center_x, center_y, pitch))
        return outlines
    outlines.append(rectangle_outline(center_x, bottom + 6.5 * pitch, 7 * pitch, pitch))
    outlines.append(rectangle_outline(center_x, bottom + 0.5 * pitch, 7 * pitch, pitch))
    outlines.append(rectangle_outline(left + 0.5 * pitch, center_y, pitch, 5 * pitch))
    outlines.append(rectangle_outline(left + 6.5 * pitch, center_y, pitch, 5 * pitch))
    outlines.append(finder_center_outline(center_style, center_x, center_y, pitch))
    return outlines


def styled_module_outline(style, center_x, center_y, pitch, row=0, column=0):
    if style == "dots":
        return circle_outline(center_x, center_y, pitch * 0.48, 24)
    if style == "faceted":
        radius = pitch * 0.49
        cut = pitch * 0.16
        return [
            (round(center_x + radius - cut, 6), round(center_y + radius, 6)),
            (round(center_x - radius + cut, 6), round(center_y + radius, 6)),
            (round(center_x - radius, 6), round(center_y + radius - cut, 6)),
            (round(center_x - radius, 6), round(center_y - radius + cut, 6)),
            (round(center_x - radius + cut, 6), round(center_y - radius, 6)),
            (round(center_x + radius - cut, 6), round(center_y - radius, 6)),
            (round(center_x + radius, 6), round(center_y - radius + cut, 6)),
            (round(center_x + radius, 6), round(center_y + radius - cut, 6)),
        ]
    if style == "rounded":
        return rounded_rectangle_outline(center_x, center_y, pitch * 0.96, pitch * 0.96, pitch * 0.22)
    if style == "triangle":
        radius = pitch * 0.49
        points = [
            (center_x, center_y + radius),
            (center_x - radius, center_y + radius * 0.2),
            (center_x - radius, center_y - radius),
            (center_x + radius, center_y - radius),
            (center_x + radius, center_y + radius * 0.2),
        ]
        if (row + column) % 2:
            points = [(2 * center_x - x, 2 * center_y - y) for x, y in points]
        return [(round(x, 6), round(y, 6)) for x, y in points]
    return rectangle_outline(center_x, center_y, pitch, pitch)


@dataclass
class Token:
    url: str
    preset: str
    shape: str
    outline: list
    shape_width: float
    shape_height: float
    corner_style: str
    corner_radius: float
    padding: float
    edge_profile: str
    edge_size: float
    edge_slices: list
    top_profile: str
    top_size: float
    top_slices: list
    diameter: float
    minimum_diameter: float
    minimum_height: float
    base: float
    relief: float
    layer_height: float
    first_layer: float
    base_layers: int
    qr_layers: int
    matrix: list
    module: float
    qr_offset_x: float
    qr_offset_y: float
    icon: str
    icon_center_x: float
    icon_center_y: float
    icon_size: float
    module_style: str
    finder_style: str
    finder_center_style: str
    center_icon: str
    center_span_modules: int
    center_icon_size: float
    base_color: str
    qr_color: str
    warnings: list
    correction: str
    treatment: str
    construction: str
    base_filament: int
    qr_filament: int

    @property
    def change_z(self):
        if self.treatment == "flat" or self.construction == "two-piece":
            return None
        return round(self.base + self.layer_height, 6)

    @property
    def filename(self):
        host = re.sub(r"[^a-zA-Z0-9.-]", "-", urlsplit(self.url).hostname or "token")[:48]
        details = ["business-card" if self.preset == "business-card" else self.shape]
        if self.corner_style != "default":
            details.append(self.corner_style)
        if self.edge_profile != "straight":
            details.append(self.edge_profile)
        if self.top_profile != "straight":
            details.append(f"top-{self.top_profile}")
        if self.icon != "none":
            details.append(self.icon)
        if self.module_style != "square":
            details.append(self.module_style)
        if self.finder_style != "square":
            details.append(f"frame-{self.finder_style}")
        if self.finder_center_style != "square":
            details.append(f"eye-center-{self.finder_center_style}")
        if self.center_icon != "none":
            details.append(f"center-{self.center_icon}")
        if self.construction == "two-piece":
            details.append("two-piece")
        details.append(self.treatment)
        return f"qr-{'-'.join(details)}-{host}-{sha256(self.url.encode()).hexdigest()[:8]}"

    def info(self):
        return {
            "url": self.url,
            "preset": self.preset,
            "shape": self.shape,
            "outline": self.outline,
            "shape_width": self.shape_width,
            "shape_height": self.shape_height,
            "corner_style": self.corner_style,
            "corner_radius": self.corner_radius,
            "padding": self.padding,
            "edge_profile": self.edge_profile,
            "edge_size": self.edge_size,
            "edge_slices": self.edge_slices,
            "top_profile": self.top_profile,
            "top_size": self.top_size,
            "top_slices": self.top_slices,
            "diameter": self.diameter,
            "minimum_diameter": self.minimum_diameter,
            "minimum_height": self.minimum_height,
            "base": self.base,
            "relief": self.relief,
            "height": self.height,
            "layer_height": self.layer_height,
            "first_layer": self.first_layer,
            "base_layers": self.base_layers,
            "qr_layers": self.qr_layers,
            "change_layer": None if self.change_z is None else self.base_layers + 1,
            "change_z": self.change_z,
            "modules": len(self.matrix),
            "module_size": self.module,
            "quiet_modules": 4,
            "matrix": self.matrix,
            "qr_offset_x": self.qr_offset_x,
            "qr_offset_y": self.qr_offset_y,
            "icon": self.icon,
            "icon_center_x": self.icon_center_x,
            "icon_center_y": self.icon_center_y,
            "icon_size": self.icon_size,
            "icon_outlines": icon_outlines(self.icon, self.icon_center_x, self.icon_center_y, self.icon_size),
            "module_style": self.module_style,
            "finder_style": self.finder_style,
            "finder_center_style": self.finder_center_style,
            "center_icon": self.center_icon,
            "center_span_modules": self.center_span_modules,
            "center_icon_size": self.center_icon_size,
            "feature_outlines": self.feature_outlines(),
            "base_color": self.base_color,
            "qr_color": self.qr_color,
            "base_filament": self.base_filament,
            "qr_filament": self.qr_filament,
            "warnings": self.warnings,
            "filename": self.filename,
            "correction": self.correction,
            "treatment": self.treatment,
            "construction": self.construction,
            "scan_verified": True,
        }

    @property
    def height(self):
        return self.base if self.treatment == "flat" else round(self.base + self.relief, 6)

    def feature_outlines(self):
        outlines = []
        modules = len(self.matrix)
        offset = modules * self.module / 2
        center_span = 0 if self.center_icon == "none" else self.center_span_modules
        center_start = (modules - center_span) / 2
        center_end = center_start + center_span
        styled = (
            self.module_style != "square"
            or self.finder_style != "square"
            or self.finder_center_style != "square"
            or center_span
        )
        if styled:
            for row, cells in enumerate(self.matrix):
                for column, dark in enumerate(cells):
                    if not dark or is_finder_cell(row, column, modules):
                        continue
                    if center_start <= row < center_end and center_start <= column < center_end:
                        continue
                    center_x = (column + 0.5) * self.module - offset + self.qr_offset_x
                    center_y = offset - (row + 0.5) * self.module + self.qr_offset_y
                    outlines.append(
                        styled_module_outline(self.module_style, center_x, center_y, self.module, row, column)
                    )
            finder_positions = [
                (self.qr_offset_x - offset, self.qr_offset_y + offset - 7 * self.module),
                (self.qr_offset_x + offset - 7 * self.module, self.qr_offset_y + offset - 7 * self.module),
                (self.qr_offset_x - offset, self.qr_offset_y - offset),
            ]
            for left, bottom in finder_positions:
                outlines.extend(
                    finder_outlines(self.finder_style, self.finder_center_style, left, bottom, self.module)
                )
            if self.center_icon not in ("none", "blank"):
                outlines.extend(
                    icon_outlines(self.center_icon, self.qr_offset_x, self.qr_offset_y, self.center_icon_size)
                )
        else:
            for row, cells in enumerate(self.matrix):
                column = 0
                while column < modules:
                    if not cells[column]:
                        column += 1
                        continue
                    start = column
                    while column < modules and cells[column]:
                        column += 1
                    width, height, chamfer = (column - start) * self.module, self.module, 0.01
                    x = start * self.module - offset + self.qr_offset_x
                    y = offset - (row + 1) * self.module + self.qr_offset_y
                    outlines.append(
                        [
                            (round(x + chamfer, 6), round(y, 6)),
                            (round(x + width - chamfer, 6), round(y, 6)),
                            (round(x + width, 6), round(y + chamfer, 6)),
                            (round(x + width, 6), round(y + height - chamfer, 6)),
                            (round(x + width - chamfer, 6), round(y + height, 6)),
                            (round(x + chamfer, 6), round(y + height, 6)),
                            (round(x, 6), round(y + height - chamfer, 6)),
                            (round(x, 6), round(y + chamfer, 6)),
                        ]
                    )
        outlines.extend(icon_outlines(self.icon, self.icon_center_x, self.icon_center_y, self.icon_size))
        return outlines

    def png(self, size=768):
        """Top view of the selected raised or inset treatment."""
        img = Image.new("RGB", (size, size), "#E7E8E5")
        draw = ImageDraw.Draw(img)
        scale = (size - 32) / max(self.shape_width, self.shape_height)
        center = size / 2
        inset = self.treatment == "inset"
        fill = self.qr_color if inset else self.base_color
        draw.polygon([(center + x * scale, center - y * scale) for x, y in self.outline], fill=fill)
        feature_fill = self.base_color if inset else self.qr_color
        for outline in self.feature_outlines():
            draw.polygon([(center + x * scale, center - y * scale) for x, y in outline], fill=feature_fill)
        output = io.BytesIO()
        img.save(output, format="PNG")
        return output.getvalue()

    def _sliced_solid(self, slices, z_offset=0):
        token_section = manifold.CrossSection([self.outline])
        parts = []
        for (bottom_z, bottom_inset), (top_z, top_inset) in zip(slices, slices[1:]):
            if top_z <= bottom_z:
                continue
            bottom_scale = (
                (self.shape_width - 2 * bottom_inset) / self.shape_width,
                (self.shape_height - 2 * bottom_inset) / self.shape_height,
            )
            top_scale = (
                (self.shape_width - 2 * top_inset) / self.shape_width,
                (self.shape_height - 2 * top_inset) / self.shape_height,
            )
            section = token_section.scale(bottom_scale)
            parts.append(
                section.extrude(
                    top_z - bottom_z,
                    scale_top=(top_scale[0] / bottom_scale[0], top_scale[1] / bottom_scale[1]),
                ).translate((0, 0, z_offset + bottom_z))
            )
        return manifold.Manifold.batch_boolean(parts, manifold.OpType.Add)

    @staticmethod
    def _mesh_from_solid(solid):
        if solid.status() != manifold.Error.NoError:
            raise RuntimeError(f"Geometry construction failed: {solid.status()}")
        raw = solid.to_mesh64()
        mesh = trimesh.Trimesh(
            vertices=np.asarray(raw.vert_properties)[:, :3], faces=np.asarray(raw.tri_verts), process=False
        )
        if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
            raise RuntimeError("Geometry failed the watertight solid check.")
        return mesh

    def part_meshes(self):
        """Return independently printable material parts for flat or two-piece output."""
        if self.treatment not in ("flat", "inset"):
            raise RuntimeError("This token does not use independently modeled material parts.")
        base_solid = self._sliced_solid(self.edge_slices)
        overlap = min(0.02, self.first_layer / 4)
        feature_section = manifold.CrossSection(self.feature_outlines(), manifold.FillRule.NonZero)
        if self.treatment == "flat":
            cutter = feature_section.extrude(self.base + 2 * overlap).translate((0, 0, -overlap))
            feature_solid = base_solid ^ cutter
            background_solid = base_solid - cutter
            return [
                {
                    "name": "Background",
                    "filament": self.base_filament,
                    "mesh": self._mesh_from_solid(background_solid),
                },
                {"name": "QR", "filament": self.qr_filament, "mesh": self._mesh_from_solid(feature_solid)},
            ]
        if self.construction != "two-piece":
            raise RuntimeError("Inset material parts are available only in two-piece construction.")
        cap_outer = self._sliced_solid(self.top_slices)
        cutter = feature_section.extrude(self.relief + 2 * overlap).translate((0, 0, -overlap))
        cap_solid = cap_outer - cutter
        return [
            {"name": "Dark base", "filament": self.base_filament, "mesh": self._mesh_from_solid(base_solid)},
            {"name": "Light QR cap", "filament": self.qr_filament, "mesh": self._mesh_from_solid(cap_solid)},
        ]

    def mesh(self):
        """Build the single solid or a bed-ready pair of independent pieces."""
        base_solid = self._sliced_solid(self.edge_slices)
        if self.treatment == "flat":
            return self._mesh_from_solid(base_solid)
        if self.construction == "two-piece":
            parts = self.part_meshes()
            spacing = self.shape_width / 2 + 3
            parts[0]["mesh"].apply_translation((-spacing, 0, 0))
            parts[1]["mesh"].apply_translation((spacing, 0, 0))
            return trimesh.util.concatenate([part["mesh"] for part in parts])
        overlap = min(0.02, self.first_layer / 4)
        feature_section = manifold.CrossSection(self.feature_outlines(), manifold.FillRule.NonZero)
        feature_solid = feature_section.extrude(self.relief + overlap).translate((0, 0, self.base - overlap))
        relief = feature_solid
        if self.treatment == "inset":
            outer_relief = self._sliced_solid(self.top_slices, self.base)
            relief = outer_relief - feature_solid
        return self._mesh_from_solid(base_solid + relief)


def create_token(data, nozzle=0.4, filament_count=2):
    if not isinstance(data, dict):
        raise InputError("Expected a JSON object.")
    url = data.get("url", "")
    if not isinstance(url, str):
        raise InputError("Enter a website URL.")
    url = url.strip()
    if not url or len(url.encode("utf-8")) > 1500 or any(c.isspace() or ord(c) < 32 for c in url):
        raise InputError("Enter a URL without spaces, up to 1,500 UTF-8 bytes.")
    if "://" not in url:
        url = "https://" + url
    try:
        parsed = urlsplit(url)
        valid = parsed.scheme in ("https", "http") and parsed.hostname and not parsed.username
        _ = parsed.port
    except ValueError as error:
        raise InputError("Enter a valid HTTP or HTTPS URL.") from error
    if not valid or re.search(r'[<>"{}|\\^`]', url):
        raise InputError("Enter a valid HTTP or HTTPS URL without credentials.")
    preset = data.get("preset", "custom")
    if preset not in TOKEN_PRESETS:
        raise InputError("Token preset is not supported.")
    shape = "rectangle" if preset == "business-card" else data.get("shape", "circle")
    if shape not in TOKEN_SHAPES:
        raise InputError("Token shape is not supported.")
    corner_style = "custom" if preset == "business-card" else data.get("corner_style", "default")
    if corner_style not in CORNER_STYLES:
        raise InputError("Corner treatment is not supported.")
    if shape == "circle":
        corner_style = "default"
    edge_profile = data.get("edge_profile", "straight")
    if edge_profile not in EDGE_PROFILES:
        raise InputError("Edge treatment is not supported.")
    edge_size = number(data, "edge_size", 0.8, 0.4, 2)
    top_profile = data.get("top_profile", "straight")
    if top_profile not in EDGE_PROFILES:
        raise InputError("Top edge treatment is not supported.")
    top_size = number(data, "top_size", 0.8, 0.4, 2)
    requested_diameter = 85.6 if preset == "business-card" else number(data, "diameter", 60, 25, 200)
    requested_shape_height = (
        54
        if preset == "business-card"
        else number(data, "shape_height", max(25, round(requested_diameter * 0.72, 6)), 25, 200)
        if shape == "rectangle"
        else requested_diameter
    )
    corner_radius = measurement_mm(data, "corner_radius", 3.2 if preset == "business-card" else 4, 0.1, 100)
    if shape == "circle":
        corner_radius = 0
    elif corner_style == "custom" and corner_radius > min(requested_diameter, requested_shape_height) / 2:
        raise InputError("Corner radius cannot exceed half the token's shortest side.")
    padding = measurement_mm(data, "padding", 1, 0, 25)
    icon = data.get("icon", "none")
    if icon not in TOKEN_ICONS:
        raise InputError("Brand icon is not supported.")
    if icon != "none" and preset != "business-card":
        raise InputError("Brand icons are available with the business-card preset.")
    module_style = data.get("module_style", "square")
    if module_style not in QR_MODULE_STYLES:
        raise InputError("QR module style is not supported.")
    finder_style = data.get("finder_style", "square")
    if finder_style not in QR_FINDER_STYLES:
        raise InputError("QR finder style is not supported.")
    finder_center_style = data.get(
        "finder_center_style", finder_style if finder_style in ("rounded", "circle") else "square"
    )
    if finder_center_style not in QR_FINDER_CENTER_STYLES:
        raise InputError("QR finder center style is not supported.")
    if (finder_center_style == "diamond" and finder_style != "circle") or (
        finder_style == "circle" and finder_center_style == "square"
    ):
        raise InputError("This finder frame and center combination is not reliably scannable.")
    center_icon = data.get("center_icon", "none")
    if center_icon not in QR_CENTER_ICONS:
        raise InputError("QR center icon is not supported.")
    if center_icon != "none" and (
        module_style != "square" or finder_style != "square" or finder_center_style != "square"
    ):
        raise InputError(
            "Center badges require classic blocks with square finder frames and centers for reliable sliced toolpaths."
        )
    layer = number(data, "layer_height", 0.2, 0.08, min(0.3, nozzle * 0.75))
    first = number(data, "first_layer", 0.2, 0.08, min(0.3, nozzle * 0.75))
    treatment = data.get("treatment", "raised")
    if treatment not in ("raised", "inset", "flat"):
        raise InputError("QR treatment must be raised, inset, or flat.")
    construction = data.get("construction", "single")
    if construction not in ("single", "two-piece"):
        raise InputError("Print construction is not supported.")
    if construction == "two-piece" and treatment != "inset":
        raise InputError("Two-piece construction is available only for inset tokens.")
    requested_base = number(data, "base", 1, 0.6, 8)
    requested_relief = number(data, "relief", 1, 0.24, 2)
    base_layers = max(1, math.ceil((requested_base - first) / layer - 1e-8) + 1)
    base = round(first + (base_layers - 1) * layer, 6)
    minimum_top_layers = 5 if treatment == "inset" else 2
    qr_layers = (
        base_layers
        if treatment == "flat"
        else max(minimum_top_layers, math.ceil(requested_relief / layer - 1e-8))
    )
    relief = 0 if treatment == "flat" else round(qr_layers * layer, 6)
    warnings = []
    if abs(base - requested_base) > 1e-6 or (treatment != "flat" and abs(relief - requested_relief) > 1e-6):
        feature = "light top field" if treatment == "inset" else "QR"
        if treatment == "flat":
            warnings.append(f"Thickness rounded up to complete layers: {base:g} mm.")
        else:
            warnings.append(
                f"Heights rounded up to complete layers: {base:g} mm base + {relief:g} mm {feature}."
            )
    correction = data.get("correction", "M")
    if correction not in ("M", "Q", "H"):
        raise InputError("Error correction must be M, Q, or H.")
    if center_icon != "none" and correction != "H":
        correction = "H"
        warnings.append("High error correction is required for a protected center badge.")
    qr = qrcode.QRCode(error_correction=getattr(qrcode.constants, "ERROR_CORRECT_" + correction), border=0)
    qr.add_data(url)
    try:
        qr.make(fit=True)
    except qrcode.exceptions.DataOverflowError as error:
        raise InputError("This URL is too long for a QR code.") from error
    matrix = qr.get_matrix()
    # The entire QR plus its four-module quiet zone fits with the requested physical edge padding.
    style_scale = {"square": 1, "rounded": 0.96, "dots": 0.96, "faceted": 0.96, "triangle": 0.96}[
        module_style
    ]
    min_module = max(0.6, nozzle * 2) / style_scale
    perimeter_inset = 0 if top_profile == "straight" else top_size
    qr_offset_x = 0
    qr_offset_y = 0
    if preset == "business-card":
        minimum_diameter = 85.6
        minimum_height = 54
        diameter = requested_diameter
        shape_height = requested_shape_height
    elif shape == "rectangle":
        minimum_side = minimum_shape_width(
            "rectangle",
            len(matrix),
            min_module,
            corner_style,
            perimeter_inset,
            padding,
            corner_radius,
        )
        minimum_diameter = minimum_height = minimum_side
        diameter = max(requested_diameter, minimum_diameter)
        shape_height = max(requested_shape_height, minimum_height)
        if diameter > requested_diameter:
            warnings.append(
                f"Width increased to {minimum_diameter:g} mm so every QR module is printable with a {nozzle:g} mm nozzle."
            )
        if shape_height > requested_shape_height:
            warnings.append(
                f"Height increased to {minimum_height:g} mm so the QR quiet zone remains printable."
            )
    else:
        minimum_diameter = minimum_shape_width(
            shape, len(matrix), min_module, corner_style, perimeter_inset, padding, corner_radius
        )
        minimum_height = outline_dimensions(
            shape_outline(shape, minimum_diameter, minimum_diameter, corner_style, corner_radius)
        )[1]
        diameter = max(requested_diameter, minimum_diameter)
        shape_height = diameter
        if diameter > requested_diameter:
            warnings.append(
                f"Width increased to {minimum_diameter:g} mm so every QR module is printable with a {nozzle:g} mm nozzle."
            )
    if minimum_diameter > 200 or minimum_height > 200:
        raise InputError(
            f"This URL needs a larger {shape} token than the supported 200 mm limit. Shorten the URL."
        )
    outline = shape_outline(shape, diameter, shape_height, corner_style, corner_radius)
    shape_width, shape_height = outline_dimensions(outline)
    usable_outline = inset_outline(outline, shape_width, shape_height, perimeter_inset)
    if preset == "business-card":
        margin = padding
        module = (shape_height - 2 * (perimeter_inset + margin)) / (len(matrix) + 8)
        field_half = (len(matrix) + 8) * module / 2
        qr_offset_x = shape_width / 2 - perimeter_inset - margin - field_half
        module = min(module, module_size_for_outline(usable_outline, len(matrix), qr_offset_x, 0, padding))
        if module < min_module:
            raise InputError(
                f"This URL is too dense for the business-card preset with a {nozzle:g} mm nozzle. "
                "Shorten the URL or use a custom rectangle."
            )
    else:
        module = module_size_for_outline(usable_outline, len(matrix), clearance=padding)
    slices = (
        combined_base_slices(edge_profile, edge_size, top_profile, top_size, base)
        if treatment in ("raised", "flat")
        else edge_slices(edge_profile, edge_size, base)
    )
    if module < 1.2:
        warnings.append(
            f"QR modules are {module:.2f} mm wide. Print a scan test; 1.2 mm or larger is more forgiving."
        )
    base_color = color(data, "base_color", "#181818" if treatment == "inset" else "#F5F0E5")
    qr_color = color(data, "qr_color", "#F5F0E5" if treatment == "inset" else "#181818")
    light = luminance(qr_color if treatment == "inset" else base_color)
    dark = luminance(base_color if treatment == "inset" else qr_color)
    if light <= dark or (light + 0.05) / (dark + 0.05) < 4.5:
        if treatment == "inset":
            raise InputError("Use a dark base and a light top field with stronger contrast.")
        raise InputError("Use a light base and a dark QR with stronger contrast.")
    slots = []
    for key, default in [("base_filament", 1), ("qr_filament", 2)]:
        slot = number(data, key, default, 1, filament_count)
        if slot != int(slot):
            raise InputError("Filament numbers must be whole numbers.")
        slots.append(int(slot))
    if slots[0] == slots[1]:
        raise InputError("Base and QR must use different project filaments.")
    icon_center_x = 0
    icon_center_y = 0
    icon_size = 0
    if preset == "business-card" and icon != "none":
        field_half = (len(matrix) + 8) * module / 2
        panel_left = -shape_width / 2 + perimeter_inset + 3
        panel_right = qr_offset_x - field_half - 3
        panel_width = panel_right - panel_left
        icon_size = min(18, panel_width - 4, shape_height - 2 * (perimeter_inset + 8))
        if icon_size < 8:
            raise InputError("The business-card layout does not have enough room for this icon.")
        icon_center_x = round((panel_left + panel_right) / 2, 6)
    center_span_modules = 0 if center_icon == "none" else max(5, math.floor(len(matrix) * 0.19) | 1)
    center_icon_size = (
        0 if center_icon in ("none", "blank") else round(center_span_modules * module * 0.62, 6)
    )
    token = Token(
        url=url,
        preset=preset,
        shape=shape,
        outline=outline,
        shape_width=shape_width,
        shape_height=shape_height,
        corner_style=corner_style,
        corner_radius=corner_radius,
        padding=padding,
        edge_profile=edge_profile,
        edge_size=edge_size,
        edge_slices=slices,
        top_profile=top_profile,
        top_size=top_size,
        top_slices=[] if treatment == "flat" else top_edge_slices(top_profile, top_size, relief),
        diameter=diameter,
        minimum_diameter=minimum_diameter,
        minimum_height=minimum_height,
        base=base,
        relief=relief,
        layer_height=layer,
        first_layer=first,
        base_layers=base_layers,
        qr_layers=qr_layers,
        matrix=matrix,
        module=module,
        qr_offset_x=round(qr_offset_x, 6),
        qr_offset_y=qr_offset_y,
        icon=icon,
        icon_center_x=icon_center_x,
        icon_center_y=icon_center_y,
        icon_size=round(icon_size, 6),
        module_style=module_style,
        finder_style=finder_style,
        finder_center_style=finder_center_style,
        center_icon=center_icon,
        center_span_modules=center_span_modules,
        center_icon_size=center_icon_size,
        base_color=base_color,
        qr_color=qr_color,
        warnings=warnings,
        correction=correction,
        treatment=treatment,
        construction=construction,
        base_filament=slots[0],
        qr_filament=slots[1],
    )
    decoded = zxingcpp.read_barcode(Image.open(io.BytesIO(token.png())))
    if decoded is None or decoded.text != url:
        raise InputError("The preview failed its independent QR scan check. Increase size or contrast.")
    return token
