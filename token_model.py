"""QR encoding, physical constraints, and a single watertight printable solid."""

import io
import math
import re
from dataclasses import dataclass
from hashlib import sha256
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
CORNER_STYLES = {"default", "sharp", "softened", "rounded"}
EDGE_PROFILES = {"straight", "chamfered", "rounded", "inset", "tapered"}
TOKEN_PRESETS = {"custom", "business-card"}
TOKEN_ICONS = {"none", "instagram", "x", "facebook", "linkedin", "youtube", "tiktok"}


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


def shape_outline(shape, width, height=None, corner_style="default"):
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
    else:
        radius = min(4, width * 0.08)
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


def module_size_for_shape(shape, width, height, modules, corner_style="default", perimeter_inset=0):
    outline = shape_outline(shape, width, height, corner_style)
    return module_size_for_outline(inset_outline(outline, width, height, perimeter_inset), modules)


def minimum_shape_width(shape, modules, minimum_module, corner_style="default", perimeter_inset=0):
    low, high = 25.0, 200.0
    if module_size_for_shape(shape, high, high, modules, corner_style, perimeter_inset) < minimum_module:
        return math.inf
    for _ in range(48):
        middle = (low + high) / 2
        if (
            module_size_for_shape(shape, middle, middle, modules, corner_style, perimeter_inset)
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


def rotated_rectangle(cx, cy, length, width, angle):
    cosine, sine = math.cos(angle), math.sin(angle)
    return [
        (round(cx + x * cosine - y * sine, 6), round(cy + x * sine + y * cosine, 6))
        for x, y in rectangle_outline(0, 0, length, width)
    ]


def icon_outlines(icon, center_x, center_y, size):
    if icon == "none":
        return []
    outlines = []

    def add_rect(x, y, width, height):
        outlines.append(
            rectangle_outline(center_x + x * size, center_y + y * size, width * size, height * size)
        )

    def add_circle(x, y, radius):
        outlines.append(circle_outline(center_x + x * size, center_y + y * size, radius * size))

    if icon == "instagram":
        stroke = 0.1
        add_rect(0, 0.4, 0.8, stroke)
        add_rect(0, -0.4, 0.8, stroke)
        add_rect(-0.4, 0, stroke, 0.8)
        add_rect(0.4, 0, stroke, 0.8)
        for step in range(16):
            a, b = math.tau * step / 16, math.tau * (step + 1) / 16
            outlines.append(
                [
                    (
                        round(center_x + 0.24 * math.cos(a) * size, 6),
                        round(center_y + 0.24 * math.sin(a) * size, 6),
                    ),
                    (
                        round(center_x + 0.24 * math.cos(b) * size, 6),
                        round(center_y + 0.24 * math.sin(b) * size, 6),
                    ),
                    (
                        round(center_x + 0.14 * math.cos(b) * size, 6),
                        round(center_y + 0.14 * math.sin(b) * size, 6),
                    ),
                    (
                        round(center_x + 0.14 * math.cos(a) * size, 6),
                        round(center_y + 0.14 * math.sin(a) * size, 6),
                    ),
                ]
            )
        add_circle(0.25, 0.25, 0.055)
    elif icon == "x":
        outlines.append(rotated_rectangle(center_x, center_y, size * 0.92, size * 0.12, math.pi * 0.29))
        outlines.append(rotated_rectangle(center_x, center_y, size * 0.92, size * 0.12, -math.pi * 0.29))
    elif icon == "facebook":
        add_rect(-0.06, -0.03, 0.16, 0.82)
        add_rect(0.12, 0.35, 0.48, 0.16)
        add_rect(0.1, 0.06, 0.42, 0.15)
    elif icon == "linkedin":
        add_circle(-0.34, 0.34, 0.09)
        add_rect(-0.34, -0.14, 0.16, 0.62)
        add_rect(-0.02, -0.14, 0.16, 0.62)
        add_rect(0.3, -0.14, 0.16, 0.62)
        add_rect(0.14, 0.15, 0.48, 0.15)
    elif icon == "youtube":
        stroke = 0.09
        add_rect(0, 0.34, 0.86, stroke)
        add_rect(0, -0.34, 0.86, stroke)
        add_rect(-0.43, 0, stroke, 0.68)
        add_rect(0.43, 0, stroke, 0.68)
        outlines.append(
            [
                (round(center_x - 0.12 * size, 6), round(center_y - 0.2 * size, 6)),
                (round(center_x - 0.12 * size, 6), round(center_y + 0.2 * size, 6)),
                (round(center_x + 0.24 * size, 6), round(center_y, 6)),
            ]
        )
    elif icon == "tiktok":
        add_rect(0.08, 0.06, 0.14, 0.68)
        add_rect(0.22, 0.35, 0.42, 0.14)
        add_circle(-0.12, -0.3, 0.2)
        add_circle(0.38, 0.25, 0.11)
    return outlines


@dataclass
class Token:
    url: str
    preset: str
    shape: str
    outline: list
    shape_width: float
    shape_height: float
    corner_style: str
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
    base_color: str
    qr_color: str
    warnings: list
    correction: str
    treatment: str
    base_filament: int
    qr_filament: int

    @property
    def change_z(self):
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
            "height": round(self.base + self.relief, 6),
            "layer_height": self.layer_height,
            "first_layer": self.first_layer,
            "base_layers": self.base_layers,
            "qr_layers": self.qr_layers,
            "change_layer": self.base_layers + 1,
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
            "base_color": self.base_color,
            "qr_color": self.qr_color,
            "base_filament": self.base_filament,
            "qr_filament": self.qr_filament,
            "warnings": self.warnings,
            "filename": self.filename,
            "correction": self.correction,
            "treatment": self.treatment,
            "scan_verified": True,
        }

    def png(self, size=768):
        """Top view of the selected raised or inset treatment."""
        img = Image.new("RGB", (size, size), "#E7E8E5")
        draw = ImageDraw.Draw(img)
        scale = (size - 32) / max(self.shape_width, self.shape_height)
        center = size / 2
        inset = self.treatment == "inset"
        fill = self.qr_color if inset else self.base_color
        draw.polygon([(center + x * scale, center - y * scale) for x, y in self.outline], fill=fill)
        pitch = self.module * scale
        half = len(self.matrix) * self.module / 2
        left = center + (self.qr_offset_x - half) * scale
        top = center - (self.qr_offset_y + half) * scale
        feature_fill = self.base_color if inset else self.qr_color
        for row, cells in enumerate(self.matrix):
            for col, dark in enumerate(cells):
                if dark:
                    draw.rectangle(
                        (
                            round(left + col * pitch),
                            round(top + row * pitch),
                            round(left + (col + 1) * pitch) - 1,
                            round(top + (row + 1) * pitch) - 1,
                        ),
                        fill=feature_fill,
                    )
        for outline in icon_outlines(self.icon, self.icon_center_x, self.icon_center_y, self.icon_size):
            draw.polygon([(center + x * scale, center - y * scale) for x, y in outline], fill=feature_fill)
        output = io.BytesIO()
        img.save(output, format="PNG")
        return output.getvalue()

    def mesh(self):
        """Union row runs into the base, avoiding overlapping STL shells."""
        token_section = manifold.CrossSection([self.outline])
        base_parts = []
        for (bottom_z, bottom_inset), (top_z, top_inset) in zip(self.edge_slices, self.edge_slices[1:]):
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
            base_parts.append(
                section.extrude(
                    top_z - bottom_z,
                    scale_top=(top_scale[0] / bottom_scale[0], top_scale[1] / bottom_scale[1]),
                ).translate((0, 0, bottom_z))
            )
        base_solid = manifold.Manifold.batch_boolean(base_parts, manifold.OpType.Add)
        outlines = []
        n = len(self.matrix)
        offset = n * self.module / 2
        overlap = min(0.02, self.first_layer / 4)
        for row, cells in enumerate(self.matrix):
            col = 0
            while col < n:
                if not cells[col]:
                    col += 1
                    continue
                start = col
                while col < n and cells[col]:
                    col += 1
                # A 10-micron corner relief prevents diagonal cells sharing a
                # zero-width vertical edge after STL welds equal coordinates.
                # Straight shared edges still join; QR module extents are unchanged.
                width, height, chamfer = (col - start) * self.module, self.module, 0.01
                outline = [
                    (chamfer, 0),
                    (width - chamfer, 0),
                    (width, chamfer),
                    (width, height - chamfer),
                    (width - chamfer, height),
                    (chamfer, height),
                    (0, height - chamfer),
                    (0, chamfer),
                ]
                x = start * self.module - offset + self.qr_offset_x
                y = offset - (row + 1) * self.module + self.qr_offset_y
                outlines.append([(round(x + u, 6), round(y + v, 6)) for u, v in outline])
        outlines.extend(icon_outlines(self.icon, self.icon_center_x, self.icon_center_y, self.icon_size))
        # Union in 2D first so shared row boundaries use a common coordinate grid.
        feature_section = manifold.CrossSection(outlines, manifold.FillRule.NonZero)
        feature_solid = feature_section.extrude(self.relief + overlap).translate((0, 0, self.base - overlap))
        relief = feature_solid
        if self.treatment == "inset":
            top_parts = []
            for (bottom_z, bottom_inset), (top_z, top_inset) in zip(self.top_slices, self.top_slices[1:]):
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
                top_parts.append(
                    section.extrude(
                        top_z - bottom_z,
                        scale_top=(top_scale[0] / bottom_scale[0], top_scale[1] / bottom_scale[1]),
                    ).translate((0, 0, self.base + bottom_z))
                )
            outer_relief = manifold.Manifold.batch_boolean(top_parts, manifold.OpType.Add)
            relief = outer_relief - feature_solid
        solid = base_solid + relief
        if solid.status() != manifold.Error.NoError:
            raise RuntimeError(f"Geometry construction failed: {solid.status()}")
        raw = solid.to_mesh64()
        mesh = trimesh.Trimesh(
            vertices=np.asarray(raw.vert_properties)[:, :3], faces=np.asarray(raw.tri_verts), process=False
        )
        if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
            raise RuntimeError("Geometry failed the watertight solid check.")
        return mesh


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
    corner_style = "rounded" if preset == "business-card" else data.get("corner_style", "default")
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
    icon = data.get("icon", "none")
    if icon not in TOKEN_ICONS:
        raise InputError("Brand icon is not supported.")
    if icon != "none" and preset != "business-card":
        raise InputError("Brand icons are available with the business-card preset.")
    layer = number(data, "layer_height", 0.2, 0.08, min(0.3, nozzle * 0.75))
    first = number(data, "first_layer", 0.2, 0.08, min(0.3, nozzle * 0.75))
    treatment = data.get("treatment", "raised")
    if treatment not in ("raised", "inset"):
        raise InputError("QR treatment must be raised or inset.")
    requested_base = number(data, "base", 1, 0.6, 8)
    requested_relief = number(data, "relief", 1, 0.24, 2)
    base_layers = max(1, math.ceil((requested_base - first) / layer - 1e-8) + 1)
    minimum_top_layers = 5 if treatment == "inset" else 2
    qr_layers = max(minimum_top_layers, math.ceil(requested_relief / layer - 1e-8))
    base = round(first + (base_layers - 1) * layer, 6)
    relief = round(qr_layers * layer, 6)
    warnings = []
    if abs(base - requested_base) > 1e-6 or abs(relief - requested_relief) > 1e-6:
        feature = "light top field" if treatment == "inset" else "QR"
        warnings.append(f"Heights rounded up to complete layers: {base:g} mm base + {relief:g} mm {feature}.")
    correction = data.get("correction", "M")
    if correction not in ("M", "Q", "H"):
        raise InputError("Error correction must be M, Q, or H.")
    qr = qrcode.QRCode(error_correction=getattr(qrcode.constants, "ERROR_CORRECT_" + correction), border=0)
    qr.add_data(url)
    try:
        qr.make(fit=True)
    except qrcode.exceptions.DataOverflowError as error:
        raise InputError("This URL is too long for a QR code.") from error
    matrix = qr.get_matrix()
    # The entire QR plus four-module quiet zone fits with 1 mm edge clearance.
    min_module = max(0.6, nozzle * 2)
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
            "rectangle", len(matrix), min_module, corner_style, perimeter_inset
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
        minimum_diameter = minimum_shape_width(shape, len(matrix), min_module, corner_style, perimeter_inset)
        minimum_height = outline_dimensions(
            shape_outline(shape, minimum_diameter, minimum_diameter, corner_style)
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
    outline = shape_outline(shape, diameter, shape_height, corner_style)
    shape_width, shape_height = outline_dimensions(outline)
    usable_outline = inset_outline(outline, shape_width, shape_height, perimeter_inset)
    if preset == "business-card":
        margin = 3
        module = (shape_height - 2 * (perimeter_inset + margin)) / (len(matrix) + 8)
        field_half = (len(matrix) + 8) * module / 2
        qr_offset_x = shape_width / 2 - perimeter_inset - margin - field_half
        module = min(module, module_size_for_outline(usable_outline, len(matrix), qr_offset_x, 0, 0))
        if module < min_module:
            raise InputError(
                f"This URL is too dense for the business-card preset with a {nozzle:g} mm nozzle. "
                "Shorten the URL or use a custom rectangle."
            )
    else:
        module = module_size_for_outline(usable_outline, len(matrix))
    slices = (
        combined_base_slices(edge_profile, edge_size, top_profile, top_size, base)
        if treatment == "raised"
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
    token = Token(
        url=url,
        preset=preset,
        shape=shape,
        outline=outline,
        shape_width=shape_width,
        shape_height=shape_height,
        corner_style=corner_style,
        edge_profile=edge_profile,
        edge_size=edge_size,
        edge_slices=slices,
        top_profile=top_profile,
        top_size=top_size,
        top_slices=top_edge_slices(top_profile, top_size, relief),
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
        base_color=base_color,
        qr_color=qr_color,
        warnings=warnings,
        correction=correction,
        treatment=treatment,
        base_filament=slots[0],
        qr_filament=slots[1],
    )
    decoded = zxingcpp.read_barcode(Image.open(io.BytesIO(token.png())))
    if decoded is None or decoded.text != url:
        raise InputError("The preview failed its independent QR scan check. Increase size or contrast.")
    return token
