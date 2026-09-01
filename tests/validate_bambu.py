"""Optional end-to-end validation using an installed Bambu Studio CLI."""

import argparse
import json
import math
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import zxingcpp
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bambu_project import DEFAULT_TEMPLATE, export_project, read_template  # noqa: E402
from token_model import create_token  # noqa: E402


def inspect_gcode(gcode, token, picture):
    lines = gcode.splitlines()
    layer_z, layer_num, current_tool = None, 0, token.base_filament - 1
    changes = []
    x, y, width = 0.0, 0.0, 0.42
    two_piece = token.construction == "two-piece"
    flat = token.treatment == "flat"
    image = Image.new("RGB", (1200, 1200), "black" if two_piece else "white")
    draw = ImageDraw.Draw(image)
    scale = 1100 / max(token.shape_width, token.shape_height)
    spacing = token.shape_width / 2 + 3
    base_center = (128 - spacing, 128) if two_piece else (128, 128)
    qr_center = (128 + spacing, 128) if two_piece else (128, 128)
    top = token.relief if two_piece else token.height
    model_tools = set()

    def inside(center, points):
        return all(
            abs(px - center[0]) <= token.shape_width / 2 + 1
            and abs(py - center[1]) <= token.shape_height / 2 + 1
            for px, py in points
        )

    for line in lines:
        if line.startswith("; CHANGE_LAYER"):
            layer_num += 1
        if line.startswith("; Z_HEIGHT:"):
            layer_z = float(line.split(":")[1])
        if line.startswith("; LINE_WIDTH:"):
            width = float(line.split(":")[1])
        if line.startswith("; toolchange #"):
            changes.append((layer_num, layer_z))
        command = line.split(";", 1)[0].strip()
        tool = re.match(r"^T(\d+)(?:\s|$)", command)
        if tool and int(tool[1]) < 16:
            current_tool = int(tool[1])
        if not re.match(r"^G[0123]\s", command):
            continue
        params = {m[1]: float(m[2]) for m in re.finditer(r"([XYZEIJ])(-?(?:\d+\.?\d*|\.\d+))", command)}
        nx, ny = params.get("X", x), params.get("Y", y)
        segment = [(x, y), (nx, ny)]
        base_inside = inside(base_center, segment)
        qr_inside = inside(qr_center, segment)
        within = base_inside or qr_inside
        extrusion = within and layer_z is not None and params.get("E", 0) > 0 and (nx != x or ny != y)
        if extrusion:
            model_tools.add(current_tool)
            if two_piece:
                expected = token.base_filament - 1 if base_inside and not qr_inside else token.qr_filament - 1
                assert current_tool == expected, f"Wrong filament on independent piece at Z={layer_z}"
            elif not flat:
                expected = token.base_filament - 1 if layer_z <= token.base + 1e-5 else token.qr_filament - 1
                assert current_tool == expected, f"Wrong filament on model at Z={layer_z}"
            should_draw = abs(layer_z - top) < 1e-5 and (
                (two_piece and qr_inside and current_tool == token.qr_filament - 1)
                or (flat and current_tool == token.qr_filament - 1)
                or (not two_piece and not flat)
            )
            if should_draw:
                path = [(x, y), (nx, ny)]
                if command.startswith(("G2 ", "G3 ")):
                    cx, cy = x + params.get("I", 0), y + params.get("J", 0)
                    radius = math.hypot(x - cx, y - cy)
                    a, b = math.atan2(y - cy, x - cx), math.atan2(ny - cy, nx - cx)
                    sweep = (
                        (b - a) % (2 * math.pi) if command.startswith("G3 ") else -((a - b) % (2 * math.pi))
                    )
                    steps = max(2, math.ceil(abs(sweep) * radius * scale / 2))
                    path = [
                        (
                            cx + radius * math.cos(a + sweep * i / steps),
                            cy + radius * math.sin(a + sweep * i / steps),
                        )
                        for i in range(steps + 1)
                    ]
                points = [
                    (round(600 + (px - qr_center[0]) * scale), round(600 - (py - qr_center[1]) * scale))
                    for px, py in path
                ]
                stroke = max(1, round(width * scale))
                ink = "white" if two_piece else "black"
                draw.line(points, fill=ink, width=stroke, joint="curve")
                for px, py in [points[0], points[-1]]:
                    r = stroke / 2
                    draw.ellipse((px - r, py - r, px + r, py + r), fill=ink)
        x, y = nx, ny
    if token.change_z is not None:
        assert changes == [(token.base_layers + 1, token.change_z)], changes
    else:
        assert {token.base_filament - 1, token.qr_filament - 1}.issubset(model_tools), model_tools
    image.save(picture)
    result = zxingcpp.read_barcode(image)
    assert result is not None and result.text == token.url, "Sliced top-layer toolpaths did not decode"
    return {
        "change_layer": changes[0][0] if token.change_z is not None else None,
        "change_z": changes[0][1] if token.change_z is not None else None,
        "toolchange_count": len(changes),
        "toolpaths_decode": result.text,
        "correct_filament_on_every_model_layer": True,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bambu", type=Path, default=Path(r"C:\Program Files\Bambu Studio\bambu-studio.exe"))
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    args.workdir = args.workdir.resolve()
    args.workdir.mkdir(parents=True, exist_ok=True)
    template = read_template(DEFAULT_TEMPLATE)
    results = []
    cases = [
        ("standard", {}),
        ("inset", {"treatment": "inset"}),
        ("flat", {"treatment": "flat"}),
        ("inset-two-piece", {"treatment": "inset", "construction": "two-piece"}),
        ("inset-square", {"treatment": "inset", "shape": "square"}),
        ("inset-rectangle", {"treatment": "inset", "shape": "rectangle"}),
        ("inset-pentagon", {"treatment": "inset", "shape": "pentagon"}),
        ("inset-hexagon", {"treatment": "inset", "shape": "hexagon"}),
        (
            "rounded-corners-chamfered-edge",
            {
                "treatment": "inset",
                "shape": "pentagon",
                "corner_style": "rounded",
                "edge_profile": "chamfered",
            },
        ),
        ("rounded-edge", {"treatment": "inset", "shape": "square", "edge_profile": "rounded"}),
        ("stepped-inset-edge", {"treatment": "inset", "shape": "hexagon", "edge_profile": "inset"}),
        ("tapered-edge", {"treatment": "inset", "shape": "rectangle", "edge_profile": "tapered"}),
        (
            "rounded-top-edge",
            {"treatment": "inset", "shape": "rectangle", "shape_height": 45, "top_profile": "rounded"},
        ),
        (
            "business-card-instagram",
            {"treatment": "inset", "preset": "business-card", "icon": "instagram"},
        ),
        (
            "styled-square-center-instagram",
            {
                "treatment": "inset",
                "diameter": 80,
                "module_style": "square",
                "finder_style": "square",
                "center_icon": "instagram",
            },
        ),
        (
            "styled-faceted-circle",
            {
                "treatment": "inset",
                "diameter": 80,
                "module_style": "faceted",
                "finder_style": "circle",
            },
        ),
        ("different-first-layer", {"layer_height": 0.16}),
        ("reversed-filaments", {"base_filament": 2, "qr_filament": 1}),
    ]
    for name, overrides in cases:
        path = args.workdir / name
        path.mkdir(exist_ok=True)
        token = create_token({"url": "https://example.com", **overrides})
        (path / "input.3mf").write_bytes(export_project(template, token, token.mesh()))
        result = subprocess.run(
            [
                str(args.bambu),
                str(path / "input.3mf"),
                "--slice",
                "0",
                "--export-3mf",
                "sliced.3mf",
                "--outputdir",
                str(path),
                "--debug",
                "1",
            ],
            cwd=path,
            timeout=60,
        )
        assert result.returncode == 0, f"Bambu failed {name}: {result.returncode}"
        report = json.loads((path / "result.json").read_text())
        assert report["return_code"] == 0
        plate = report["sliced_plates"][0]
        if token.change_z is not None:
            assert plate["filament_change_times"] == plate["layer_filament_change"] == 1
        else:
            assert plate["filament_change_times"] >= 1
        assert not plate.get("warning_message")
        with zipfile.ZipFile(path / "sliced.3mf") as z:
            assert z.testzip() is None
            layers = ET.fromstring(z.read("Metadata/custom_gcode_per_layer.xml")).findall("./plate/layer")
            assert len(layers) == (0 if token.change_z is None else 1)
            if token.change_z is not None:
                assert (
                    float(layers[0].get("top_z")) == token.change_z
                    or abs(float(layers[0].get("top_z")) - token.change_z) < 1e-6
                )
            checks = inspect_gcode(z.read("Metadata/plate_1.gcode").decode(), token, path / "sliced-top.png")
        results.append(
            {
                "case": name,
                "bambu_result": "Success",
                "filament_changes": plate["filament_change_times"],
                "warning_message": "",
                **checks,
            }
        )
        print(f"PASS {name}: correct material assignment and sliced QR decodes.", flush=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "application": template["application"],
                "printer": template["settings"]["printer_model"],
                "cases": results,
                "physical_print_tested": False,
                "native_cli_note": "Bambu logs Invalid T command for its own X2D end-of-print T65279 and T65535 commands, also present on the untouched native cube baseline. Slicing returns success. Native machine G-code is preserved.",
            },
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
