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


@dataclass
class Token:
    url: str
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
        return f"qr-{host}-{sha256(self.url.encode()).hexdigest()[:8]}"

    def info(self):
        return {
            "url": self.url,
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
        """Top view of the selected raised or inverted inset treatment."""
        img = Image.new("RGB", (size, size), "#E7E8E5")
        draw = ImageDraw.Draw(img)
        scale = (size - 32) / self.diameter
        center = size / 2
        r = self.diameter * scale / 2
        inset = self.treatment == "inset"
        draw.ellipse(
            (center - r, center - r, center + r, center + r),
            fill=self.qr_color if inset else self.base_color,
        )
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
        base_solid = manifold.Manifold.cylinder(self.base, self.diameter / 2, circular_segments=256)
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
        printable_section = (
            manifold.CrossSection.circle(self.diameter / 2, circular_segments=256) - qr_section
            if self.treatment == "inset"
            else qr_section
        )
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
    requested_diameter = number(data, "diameter", 60, 25, 200)
    layer = number(data, "layer_height", 0.2, 0.08, min(0.3, nozzle * 0.75))
    first = number(data, "first_layer", 0.2, 0.08, min(0.3, nozzle * 0.75))
    requested_base = number(data, "base", 1, 0.6, 8)
    requested_relief = number(data, "relief", 1, 0.24, 2)
    base_layers = max(1, math.ceil((requested_base - first) / layer - 1e-8) + 1)
    qr_layers = max(2, math.ceil(requested_relief / layer - 1e-8))
    base = round(first + (base_layers - 1) * layer, 6)
    relief = round(qr_layers * layer, 6)
    warnings = []
    if abs(base - requested_base) > 1e-6 or abs(relief - requested_relief) > 1e-6:
        warnings.append(f"Heights rounded up to complete layers: {base:g} mm base + {relief:g} mm QR.")
    correction = data.get("correction", "M")
    if correction not in ("M", "Q", "H"):
        raise InputError("Error correction must be M, Q, or H.")
    treatment = data.get("treatment", "raised")
    if treatment not in ("raised", "inset"):
        raise InputError("QR treatment must be raised or inset.")
    if treatment == "inset":
        warnings.append(
            "Inset mode uses an inverted light-on-dark QR. "
            "Test the physical token with every phone that must scan it."
        )
    qr = qrcode.QRCode(error_correction=getattr(qrcode.constants, "ERROR_CORRECT_" + correction), border=0)
    qr.add_data(url)
    try:
        qr.make(fit=True)
    except qrcode.exceptions.DataOverflowError as error:
        raise InputError("This URL is too long for a QR code.") from error
    matrix = qr.get_matrix()
    # The entire QR plus four-module border fits inside a circle with 1 mm edge clearance.
    min_module = max(0.6, nozzle * 2)
    minimum_diameter = math.ceil(math.sqrt(2) * (len(matrix) + 8) * min_module + 2)
    if minimum_diameter > 200:
        raise InputError(
            f"This URL needs a token over 200 mm across for a {nozzle:g} mm nozzle. Shorten the URL."
        )
    diameter = max(requested_diameter, minimum_diameter)
    if diameter > requested_diameter:
        warnings.append(
            f"Diameter increased to {minimum_diameter:g} mm so every QR module is printable with a {nozzle:g} mm nozzle."
        )
    module = (diameter - 2) / (math.sqrt(2) * (len(matrix) + 8))
    if module < 1.2:
        warnings.append(
            f"QR modules are {module:.2f} mm wide. Print a scan test; 1.2 mm or larger is more forgiving."
        )
    base_color = color(data, "base_color", "#F5F0E5")
    qr_color = color(data, "qr_color", "#181818")
    light, dark = luminance(base_color), luminance(qr_color)
    if light <= dark or (light + 0.05) / (dark + 0.05) < 4.5:
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
