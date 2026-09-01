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


def shape_outline(shape, width, corner_style="default"):
    if shape == "circle":
        return [
            (
                round(width / 2 * math.cos(math.tau * index / 256), 6),
                round(width / 2 * math.sin(math.tau * index / 256), 6),
            )
            for index in range(256)
        ]
    height = width * 0.72 if shape == "rectangle" else width
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


def module_size_for_shape(shape, width, modules, corner_style="default"):
    outline = shape_outline(shape, width, corner_style)
    qr_half = math.inf
    for index, (ax, ay) in enumerate(outline):
        bx, by = outline[(index + 1) % len(outline)]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        distance = abs(dx * ay - dy * ax) / length
        square_projection = (abs(dx) + abs(dy)) / length
        qr_half = min(qr_half, (distance - 1) / square_projection)
    return max(0, 2 * qr_half / (modules + 8))


def minimum_shape_width(shape, modules, minimum_module, corner_style="default"):
    low, high = 25.0, 200.0
    if module_size_for_shape(shape, high, modules, corner_style) < minimum_module:
        return math.inf
    for _ in range(48):
        middle = (low + high) / 2
        if module_size_for_shape(shape, middle, modules, corner_style) >= minimum_module:
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


@dataclass
class Token:
    url: str
    shape: str
    outline: list
    shape_width: float
    shape_height: float
    corner_style: str
    edge_profile: str
    edge_size: float
    edge_slices: list
    diameter: float
    minimum_diameter: float
    base: float
    relief: float
    layer_height: float
    first_layer: float
    base_layers: int
    qr_layers: int
    matrix: list
    module: float
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
        details = [self.shape]
        if self.corner_style != "default":
            details.append(self.corner_style)
        if self.edge_profile != "straight":
            details.append(self.edge_profile)
        details.append(self.treatment)
        return f"qr-{'-'.join(details)}-{host}-{sha256(self.url.encode()).hexdigest()[:8]}"

    def info(self):
        return {
            "url": self.url,
            "shape": self.shape,
            "outline": self.outline,
            "shape_width": self.shape_width,
            "shape_height": self.shape_height,
            "corner_style": self.corner_style,
            "edge_profile": self.edge_profile,
            "edge_size": self.edge_size,
            "edge_slices": self.edge_slices,
            "diameter": self.diameter,
            "minimum_diameter": self.minimum_diameter,
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
        left = center - len(self.matrix) * pitch / 2
        for row, cells in enumerate(self.matrix):
            for col, dark in enumerate(cells):
                if dark:
                    draw.rectangle(
                        (
                            round(left + col * pitch),
                            round(left + row * pitch),
                            round(left + (col + 1) * pitch) - 1,
                            round(left + (row + 1) * pitch) - 1,
                        ),
                        fill=self.base_color if inset else self.qr_color,
                    )
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
                x, y = start * self.module - offset, offset - (row + 1) * self.module
                outlines.append([(round(x + u, 6), round(y + v, 6)) for u, v in outline])
        # Union in 2D first so shared row boundaries use a common coordinate grid.
        qr_section = manifold.CrossSection(outlines)
        printable_section = token_section - qr_section if self.treatment == "inset" else qr_section
        relief = printable_section.extrude(self.relief + overlap).translate((0, 0, self.base - overlap))
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
    shape = data.get("shape", "circle")
    if shape not in TOKEN_SHAPES:
        raise InputError("Token shape is not supported.")
    corner_style = data.get("corner_style", "default")
    if corner_style not in CORNER_STYLES:
        raise InputError("Corner treatment is not supported.")
    if shape == "circle":
        corner_style = "default"
    edge_profile = data.get("edge_profile", "straight")
    if edge_profile not in EDGE_PROFILES:
        raise InputError("Edge treatment is not supported.")
    edge_size = number(data, "edge_size", 0.8, 0.4, 2)
    requested_diameter = number(data, "diameter", 60, 25, 200)
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
    minimum_diameter = minimum_shape_width(shape, len(matrix), min_module, corner_style)
    if minimum_diameter > 200:
        raise InputError(
            f"This URL needs a {shape} token over 200 mm wide for a {nozzle:g} mm nozzle. Shorten the URL."
        )
    diameter = max(requested_diameter, minimum_diameter)
    if diameter > requested_diameter:
        warnings.append(
            f"Width increased to {minimum_diameter:g} mm so every QR module is printable with a {nozzle:g} mm nozzle."
        )
    outline = shape_outline(shape, diameter, corner_style)
    shape_width, shape_height = outline_dimensions(outline)
    module = module_size_for_shape(shape, diameter, len(matrix), corner_style)
    slices = edge_slices(edge_profile, edge_size, base)
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
    token = Token(
        url,
        shape,
        outline,
        shape_width,
        shape_height,
        corner_style,
        edge_profile,
        edge_size,
        slices,
        diameter,
        minimum_diameter,
        base,
        relief,
        layer,
        first,
        base_layers,
        qr_layers,
        matrix,
        module,
        base_color,
        qr_color,
        warnings,
        correction,
        treatment,
        *slots,
    )
    decoded = zxingcpp.read_barcode(Image.open(io.BytesIO(token.png())))
    if decoded is None or decoded.text != url:
        raise InputError("The preview failed its independent QR scan check. Increase size or contrast.")
    return token
