import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import pytest
import trimesh
import zxingcpp
from PIL import Image, ImageDraw

from bambu_project import DEFAULT_TEMPLATE, export_project, profile_info, read_template
from token_model import InputError, create_token


@pytest.fixture(scope="module")
def template():
    return read_template(DEFAULT_TEMPLATE)


@pytest.fixture(scope="module")
def token():
    return create_token({"url": "https://example.com"})


@pytest.fixture(scope="module")
def mesh(token):
    return token.mesh()


def test_printed_top_geometry_decodes_exact_url(token, mesh):
    """Decode a raster of actual mesh top faces, independent of the preview renderer."""
    image = Image.new("RGB", (1200, 1200), "white")
    draw = ImageDraw.Draw(image)
    scale = 1100 / token.diameter
    top = token.base + token.relief
    for face in mesh.triangles:
        if np.allclose(face[:, 2], top, atol=1e-7):
            points = [(round(600 + x * scale), round(600 - y * scale)) for x, y, _ in face]
            draw.polygon(points, fill="black")
    result = zxingcpp.read_barcode(image)
    assert result is not None
    assert result.text == token.url


def test_single_solid_geometry_and_stl_roundtrip(token, mesh):
    assert mesh.is_watertight
    assert mesh.is_winding_consistent
    neighbors = [[] for _ in mesh.faces]
    for a, b in mesh.face_adjacency:
        neighbors[a].append(b)
        neighbors[b].append(a)
    visited, pending = set(), [0]
    while pending:
        face = pending.pop()
        if face not in visited:
            visited.add(face)
            pending.extend(neighbors[face])
    assert len(visited) == len(mesh.faces)
    assert np.allclose(mesh.bounds, [[-30, -30, 0], [30, 30, 2]])
    solid = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
    assert solid.is_watertight
    assert abs(solid.volume - mesh.volume) < 0.01


def test_inset_geometry_is_connected_watertight_and_scannable():
    token = create_token({"url": "https://example.com", "treatment": "inset"})
    mesh = token.mesh()
    assert token.treatment == "inset"
    assert mesh.is_watertight
    assert mesh.is_winding_consistent
    assert np.allclose(mesh.bounds, [[-30, -30, 0], [30, 30, 2]])
    test_printed_top_geometry_decodes_exact_url(token, mesh)


def test_full_quiet_zone_fits_inside_circle(token):
    half = (len(token.matrix) + 8) * token.module / 2
    assert math.hypot(half, half) <= token.diameter / 2 - 1 + 1e-9


def test_default_heights_and_swap_layer(token):
    assert token.base == token.relief == 1
    assert token.base_layers == token.qr_layers == 5
    assert token.change_z == 1.2


@pytest.mark.parametrize(
    "layer,first,base,expected_base,expected_layer,expected_z",
    [
        (0.2, 0.2, 2, 2, 11, 2.2),
        (0.16, 0.2, 2, 2.12, 14, 2.28),
        (0.12, 0.2, 2, 2, 17, 2.12),
        (0.2, 0.28, 2, 2.08, 11, 2.28),
    ],
)
def test_swap_targets_first_qr_layer_with_nonuniform_first_layer(
    layer, first, base, expected_base, expected_layer, expected_z
):
    token = create_token(
        {"url": "https://example.com", "layer_height": layer, "first_layer": first, "base": base}
    )
    assert token.base == expected_base
    assert token.base_layers + 1 == expected_layer
    assert token.change_z == expected_z
    assert token.change_z - token.layer_height == pytest.approx(token.base)


def test_3mf_contains_tool_change_and_native_printer_settings(template, token, mesh):
    blob = export_project(template, token, mesh)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        assert z.testzip() is None
        events = ET.fromstring(z.read("Metadata/custom_gcode_per_layer.xml"))
        layers = events.findall("./plate/layer")
        assert len(layers) == 1
        assert layers[0].attrib == {
            "top_z": "1.2",
            "type": "2",
            "extruder": "2",
            "color": "#181818",
            "extra": "",
            "gcode": "tool_change",
        }
        assert events.find("./plate/mode").get("value") == "MultiAsSingle"
        settings = json.loads(z.read("Metadata/project_settings.config"))
        for key in (
            "machine_start_gcode",
            "machine_end_gcode",
            "change_filament_gcode",
            "nozzle_diameter",
            "filament_flow_ratio",
            "filament_self_index",
        ):
            assert settings[key] == template["settings"][key]
        assert settings["filament_map"] == ["1", "1"]
        assert settings["layer_height"] == settings["initial_layer_print_height"] == "0.2"
        assert settings["print_sequence"] == "by layer"
        assert settings["top_one_wall_type"] == "not apply"
        assert "Metadata/plate_1.gcode" not in z.namelist()
        root = ET.fromstring(z.read("Metadata/model_settings.config"))
        assert root.find('./object/metadata[@key="extruder"]').get("value") == "1"


def test_inset_3mf_keeps_one_layer_change(template):
    token = create_token({"url": "https://example.com", "treatment": "inset"})
    blob = export_project(template, token, token.mesh())
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        layers = ET.fromstring(archive.read("Metadata/custom_gcode_per_layer.xml")).findall("./plate/layer")
        report = json.loads(archive.read("Metadata/qr_token.json"))
    assert len(layers) == 1
    assert layers[0].attrib["top_z"] == "1.2"
    assert layers[0].attrib["extruder"] == "2"
    assert report["treatment"] == "inset"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), None, "bad", -1, 0])
def test_rejects_bad_dimensions(value):
    with pytest.raises(InputError):
        create_token({"url": "https://example.com", "diameter": value})


@pytest.mark.parametrize(
    "url",
    ["", "javascript:alert(1)", "file:///C:/secret", "https://a b.com", "https://user:password@example.com"],
)
def test_rejects_nonwebsite_urls(url):
    with pytest.raises(InputError):
        create_token({"url": url})


def test_clamps_diameter_to_printable_minimum():
    token = create_token({"url": "https://example.com", "diameter": 25})
    assert token.minimum_diameter == token.diameter == 40
    assert "Diameter increased to 40 mm" in token.warnings[0]


def test_minimum_diameter_tracks_qr_density():
    token = create_token(
        {
            "url": "https://www.google.com/maps/place/Space+Needle/@47.6205,-122.3493,17z",
            "diameter": 40,
        }
    )
    assert token.minimum_diameter == token.diameter == 53


def test_preserves_query_payload():
    token = create_token({"url": "https://example.com/path?q=a%20b&x=1#section", "diameter": 80})
    result = zxingcpp.read_barcode(Image.open(io.BytesIO(token.png())))
    assert result.text == token.url


@pytest.mark.parametrize(
    "url,correction",
    [
        ("https://example.com/one?token=a%20b&v=2", "M"),
        ("https://example.org/a-different-path#section", "Q"),
        ("https://example.net/caf%C3%A9", "H"),
        ("https://example.com/こんにちは", "M"),
    ],
)
def test_different_patterns_survive_stl_welding(url, correction):
    token = create_token({"url": url, "correction": correction, "diameter": 90})
    mesh = token.mesh()
    imported = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
    assert imported.is_watertight
    assert imported.is_winding_consistent
    test_printed_top_geometry_decodes_exact_url(token, imported)


@pytest.mark.parametrize(
    "data", [{"base_color": "#000000"}, {"qr_color": "#EEEEEE"}, {"qr_filament": 1}, {"base_filament": 1.5}]
)
def test_rejects_unscannable_colors_and_bad_filament_assignments(data):
    with pytest.raises(InputError):
        create_token({"url": "https://example.com", **data})


def test_template_rejects_geometry_only_archive():
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("3D/3dmodel.model", "<model/>")
    data.seek(0)
    with pytest.raises(InputError):
        read_template(data)


def test_local_api_security_and_real_download():
    from server import SESSION, app

    client = app.test_client()
    payload = {"url": "https://example.com"}
    assert client.post("/api/preview", json=payload).status_code == 403
    headers = {"X-Token-Studio": SESSION}
    assert (
        client.post(
            "/api/preview", json=payload, headers={**headers, "Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert client.get("/api/config", headers={"Host": "evil.example"}).status_code == 403
    preview = client.post("/api/preview", json=payload, headers=headers).json
    assert preview["change_layer"] == 6
    assert preview["minimum_diameter"] == 40
    assert preview["profile"]["bed_width"] == preview["profile"]["bed_depth"] == 256
    response = client.post("/api/export/3mf", json=payload, headers=headers)
    assert response.status_code == 200
    assert ".3mf" in response.headers["Content-Disposition"]
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        assert archive.testzip() is None


def test_template_upload_does_not_extract_or_retain_old_objects():
    from server import SESSION, app

    client = app.test_client()
    headers = {"X-Token-Studio": SESSION}
    response = client.post(
        "/api/template",
        data={"file": (io.BytesIO(DEFAULT_TEMPLATE.read_bytes()), "profile.3mf")},
        headers=headers,
    )
    assert response.status_code == 200
    preview = client.post(
        "/api/preview",
        json={"url": "https://example.com", "template": response.json["template"]},
        headers=headers,
    )
    assert preview.status_code == 200
    assert preview.json["profile"]["printer"] == "Bambu Lab X2D"


def test_profile_exposes_centered_bed_outline_and_valid_diameter(template):
    info = profile_info(template)
    assert info["bed_width"] == info["bed_depth"] == 256
    assert info["bed_points"] == [[-128, -128], [128, -128], [128, 128], [-128, 128]]
    assert info["max_diameter"] == 196
