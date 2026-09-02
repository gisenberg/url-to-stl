"""Bambu project packaging; use native printer settings, never invent machine G-code."""

import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from token_model import InputError

CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
ET.register_namespace("", CORE)
ET.register_namespace("p", PROD)


def xml(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def read_template(source):
    try:
        with zipfile.ZipFile(source) as archive:
            for name in ("3D/3dmodel.model", "Metadata/project_settings.config"):
                if archive.getinfo(name).file_size > 4_000_000:
                    raise InputError("Template metadata is too large.")
            model_xml = archive.read("3D/3dmodel.model")
            if b"<!DOCTYPE" in model_xml.upper() or b"<!ENTITY" in model_xml.upper():
                raise InputError("XML entities are not supported in templates.")
            root = ET.fromstring(model_xml)
            settings = json.loads(archive.read("Metadata/project_settings.config"))
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError, ValueError) as error:
        raise InputError("Choose a Bambu Studio project 3MF containing printer settings.") from error
    application = next((e.text for e in root if e.attrib.get("name") == "Application"), "")
    if not application or not application.startswith("BambuStudio-") or not isinstance(settings, dict):
        raise InputError("Save this template as a project in Bambu Studio first.")
    filaments = settings.get("filament_settings_id", [])
    if not isinstance(filaments, list) or not 2 <= len(filaments) <= 16:
        raise InputError("The template must contain 2 to 16 configured project filaments.")
    try:
        nozzle = float(settings["nozzle_diameter"][0])
        if not math.isfinite(nozzle) or not 0.2 <= nozzle <= 0.8:
            raise ValueError()
        points = [[float(v) for v in point.strip().split("x")] for point in settings["printable_area"]]
        if len(points) < 4 or any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in points):
            raise ValueError()
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise InputError("Template is missing a supported nozzle size or bed outline.") from error
    if any(t != settings.get("filament_type", ["PLA"])[0] for t in settings.get("filament_type", [])):
        raise InputError("Use the same material type for all template filaments, such as PLA.")
    return {
        "application": application,
        "settings": settings,
        "nozzle": nozzle,
        "points": points,
        "filament_count": len(filaments),
    }


def bed_geometry(template):
    points = template["points"]
    xs, ys = zip(*points)
    minimum_x, maximum_x = min(xs), max(xs)
    minimum_y, maximum_y = min(ys), max(ys)
    width, depth = maximum_x - minimum_x, maximum_y - minimum_y
    center_x, center_y = (minimum_x + maximum_x) / 2, (minimum_y + maximum_y) / 2
    return {
        "width": width,
        "depth": depth,
        "center": (center_x, center_y),
        "points": [[round(x - center_x, 6), round(y - center_y, 6)] for x, y in points],
        "max_width": max(0, width - 60),
        "max_height": max(0, depth - 60),
        "max_diameter": max(0, min(width, depth) - 60),
    }


def profile_info(template, name="Bambu project"):
    s = template["settings"]
    geometry = bed_geometry(template)
    return {
        "name": name,
        "printer": s.get("printer_model", "Bambu Lab"),
        "printer_preset": s.get("printer_settings_id", ""),
        "nozzle": template["nozzle"],
        "filaments": s["filament_settings_id"],
        "filament_count": template["filament_count"],
        "bed": s.get("curr_bed_type", ""),
        "bed_width": geometry["width"],
        "bed_depth": geometry["depth"],
        "bed_points": geometry["points"],
        "max_width": geometry["max_width"],
        "max_height": geometry["max_height"],
        "max_diameter": geometry["max_diameter"],
        "application": template["application"],
    }


def prepare_settings(template, token):
    settings = deepcopy(template["settings"])
    count = template["filament_count"]
    colors = list(settings.get("filament_colour", ["#FFFFFF"] * count))
    colors = (colors + ["#FFFFFF"] * count)[:count]
    colors[token.base_filament - 1] = token.base_color
    colors[token.qr_filament - 1] = token.qr_color
    settings["filament_colour"] = colors
    settings["default_filament_colour"] = colors.copy()
    settings["filament_is_mixed"] = ["0"] * count
    settings["filament_multi_colour"] = colors.copy()
    # filament_self_index is indexed by filament AND extruder variant on X2D.
    # Preserve the native array rather than collapsing it to the filament count.
    # Both colors use the main extruder and its AMS, including on the dual-nozzle X2D.
    settings["filament_map"] = ["1"] * count
    settings["filament_map_2"] = ["1"] * count
    settings["filament_nozzle_map"] = ["1"] * count
    settings["single_extruder_multi_material"] = "1"
    settings["layer_height"] = f"{token.layer_height:g}"
    settings["initial_layer_print_height"] = f"{token.first_layer:g}"
    settings["sparse_infill_density"] = "100%"
    settings["sparse_infill_pattern"] = "zig-zag"
    settings["wall_loops"] = "2"
    # The native "one wall on top surfaces" option leaves isolated QR modules
    # hollow at this scale. Keep the second wall so their centers print dark.
    settings["top_one_wall_type"] = "not apply"
    settings["top_shell_layers"] = "4"
    settings["bottom_shell_layers"] = "3"
    settings["enable_support"] = "0"
    settings["spiral_mode"] = "0"
    settings["print_sequence"] = "by layer"
    settings["brim_type"] = "no_brim"
    settings["enable_prime_tower"] = "1"
    settings["wall_generator"] = "arachne"
    settings["from"] = "project"
    settings["name"] = "project_settings"
    # Preserve native purge values; do not lower an existing material transition.
    matrix = settings.get("flush_volumes_matrix", [])
    blocks = max(1, len(settings.get("nozzle_diameter", ["0.4"])))
    expected = count * count * blocks
    if len(matrix) != expected:
        matrix = ["0" if r == c else "600" for _ in range(blocks) for r in range(count) for c in range(count)]
    else:
        matrix = [str(v) for v in matrix]
    for block in range(blocks):
        for source, destination in (
            (token.base_filament, token.qr_filament),
            (token.qr_filament, token.base_filament),
        ):
            index = block * count * count + (source - 1) * count + destination - 1
            matrix[index] = str(max(280, float(matrix[index])))
    settings["flush_volumes_matrix"] = matrix
    # A token sits at the center. Keep the prime tower well away from it.
    settings["wipe_tower_x"] = ["18"]
    settings["wipe_tower_y"] = ["18"]
    return settings


def export_project(template, token, mesh):
    geometry = bed_geometry(template)
    if token.shape_width > geometry["max_width"] or token.shape_height > geometry["max_height"]:
        raise InputError(
            "Token is too large for this bed with prime-tower clearance. "
            f"Maximum size: {geometry['max_width']:g} × {geometry['max_height']:g} mm."
        )
    project_parts = [{"name": "Token", "filament": token.base_filament, "mesh": mesh}]
    if token.treatment == "flat":
        project_parts = token.part_meshes()
    elif token.construction == "two-piece":
        project_parts = token.part_meshes()
        gap = 6
        if token.shape_width * 2 + gap <= geometry["max_width"]:
            offsets = [(-(token.shape_width / 2 + gap / 2), 0, 0), (token.shape_width / 2 + gap / 2, 0, 0)]
        elif token.shape_height * 2 + gap <= geometry["max_height"]:
            offsets = [(0, -(token.shape_height / 2 + gap / 2), 0), (0, token.shape_height / 2 + gap / 2, 0)]
        else:
            raise InputError(
                "Both inset pieces do not fit on this plate with prime-tower clearance. Reduce the token size."
            )
        for part, offset in zip(project_parts, offsets):
            part["mesh"] = part["mesh"].copy()
            part["mesh"].apply_translation(offset)
    cx, cy = geometry["center"]
    settings = prepare_settings(template, token)

    root = ET.Element(f"{{{CORE}}}model", {"unit": "millimeter", "requiredextensions": "p"})
    for name, value in [
        ("Application", template["application"]),
        ("BambuStudio:3mfVersion", "1"),
        ("Title", token.filename),
        ("CreationDate", datetime.now(timezone.utc).date().isoformat()),
        (
            "Description",
            f"QR Token Studio {token.shape} with {token.corner_style} corners, {token.padding:g} mm border padding, "
            f"a {token.edge_profile} lower edge, a {token.top_profile} top edge, {token.module_style} QR modules, "
            f"{token.finder_style} finder frames, {token.finder_center_style} finder centers, "
            f"and {token.outer_frame} outer framing. "
            f"{token.treatment.title()} QR treatment. "
            + (
                f"Change before layer {token.base_layers + 1}, top Z {token.change_z:g} mm."
                if token.change_z is not None
                else "Material assignments are stored on independent model parts."
            ),
        ),
    ]:
        ET.SubElement(root, f"{{{CORE}}}metadata", name=name).text = value
    root.set("xmlns:BambuStudio", "http://schemas.bambulab.com/package/2021")
    resources = ET.SubElement(root, f"{{{CORE}}}resources")
    root_id = len(project_parts) + 1
    obj = ET.SubElement(resources, f"{{{CORE}}}object", id=str(root_id), type="model")
    components = ET.SubElement(obj, f"{{{CORE}}}components")
    for index in range(len(project_parts)):
        ET.SubElement(
            components,
            f"{{{CORE}}}component",
            {
                "objectid": str(index + 1),
                f"{{{PROD}}}path": f"/3D/Objects/object_{index + 1}.model",
                "transform": "1 0 0 0 1 0 0 0 1 0 0 0",
            },
        )
    build = ET.SubElement(root, f"{{{CORE}}}build")
    ET.SubElement(
        build,
        f"{{{CORE}}}item",
        objectid=str(root_id),
        printable="1",
        transform=f"1 0 0 0 1 0 0 0 1 {cx:g} {cy:g} 0",
    )

    def mesh_model(part_mesh, object_id):
        model = ET.Element(f"{{{CORE}}}model", unit="millimeter")
        res = ET.SubElement(model, f"{{{CORE}}}resources")
        obj = ET.SubElement(res, f"{{{CORE}}}object", id=str(object_id), type="model")
        mesh_xml = ET.SubElement(obj, f"{{{CORE}}}mesh")
        vertices = ET.SubElement(mesh_xml, f"{{{CORE}}}vertices")
        for x, y, z in part_mesh.vertices:
            ET.SubElement(vertices, f"{{{CORE}}}vertex", x=f"{x:.9g}", y=f"{y:.9g}", z=f"{z:.9g}")
        triangles = ET.SubElement(mesh_xml, f"{{{CORE}}}triangles")
        for a, b, c in part_mesh.faces:
            ET.SubElement(triangles, f"{{{CORE}}}triangle", v1=str(a), v2=str(b), v3=str(c))
        ET.SubElement(model, f"{{{CORE}}}build")
        return xml(model)

    config = ET.Element("config")
    obj = ET.SubElement(config, "object", id=str(root_id))

    def meta(parent, key, value):
        ET.SubElement(parent, "metadata", key=key, value=str(value))

    meta(obj, "name", token.filename)
    if len(project_parts) == 1:
        meta(obj, "extruder", project_parts[0]["filament"])
    total_faces = sum(len(part["mesh"].faces) for part in project_parts)
    ET.SubElement(obj, "metadata", face_count=str(total_faces))
    for index, project_part in enumerate(project_parts, 1):
        part = ET.SubElement(obj, "part", id=str(index), subtype="normal_part")
        meta(part, "name", project_part["name"])
        meta(part, "extruder", project_part["filament"])
        meta(part, "matrix", "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1")
        ET.SubElement(
            part,
            "mesh_stat",
            face_count=str(len(project_part["mesh"].faces)),
            edges_fixed="0",
            degenerate_facets="0",
            facets_removed="0",
            facets_reversed="0",
            backwards_edges="0",
        )
    plate = ET.SubElement(config, "plate")
    for key, value in [
        ("plater_id", 1),
        ("plater_name", "QR Token"),
        ("locked", "false"),
        ("filament_map_mode", "Manual"),
        ("gcode_file", ""),
        ("thumbnail_file", "Metadata/plate_1.png"),
    ]:
        meta(plate, key, value)
    instance = ET.SubElement(plate, "model_instance")
    for key, value in [("object_id", root_id), ("instance_id", 0), ("identify_id", 1)]:
        meta(instance, key, value)
    ET.SubElement(config, "assemble")

    events = ET.Element("custom_gcodes_per_layer")
    plate_events = ET.SubElement(events, "plate")
    ET.SubElement(plate_events, "plate_info", id="1")
    if token.change_z is not None:
        ET.SubElement(
            plate_events,
            "layer",
            top_z=f"{token.change_z:g}",
            type="2",
            extruder=str(token.qr_filament),
            color=token.qr_color,
            extra="",
            gcode="tool_change",
        )
    ET.SubElement(plate_events, "mode", value="MultiAsSingle")

    def relationships(targets):
        rel = ET.Element("Relationships", xmlns=REL)
        for index, target in enumerate(targets, 1):
            ET.SubElement(
                rel,
                "Relationship",
                Target=target,
                Id=f"rel-{index}",
                Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel",
            )
        return xml(rel)

    types = ET.Element("Types", xmlns="http://schemas.openxmlformats.org/package/2006/content-types")
    for ext, typ in [
        ("rels", "application/vnd.openxmlformats-package.relationships+xml"),
        ("model", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"),
        ("png", "image/png"),
        ("config", "application/octet-stream"),
        ("xml", "application/xml"),
        ("json", "application/json"),
    ]:
        ET.SubElement(types, "Default", Extension=ext, ContentType=typ)
    report = token.info()
    report.pop("matrix")
    report.pop("outline")
    report.pop("feature_outlines")
    report["profile"] = profile_info(template)
    report["mesh"] = {
        "watertight": True,
        "triangles": total_faces,
        "volume_mm3": round(sum(part["mesh"].volume for part in project_parts), 3),
    }
    report["parts"] = [
        {"name": part["name"], "filament": part["filament"], "triangles": len(part["mesh"].faces)}
        for part in project_parts
    ]
    contents = {
        "[Content_Types].xml": xml(types),
        "_rels/.rels": relationships(["/3D/3dmodel.model"]),
        "3D/_rels/3dmodel.model.rels": relationships(
            [f"/3D/Objects/object_{index}.model" for index in range(1, len(project_parts) + 1)]
        ),
        "3D/3dmodel.model": xml(root),
        "Metadata/project_settings.config": json.dumps(settings, indent=2),
        "Metadata/model_settings.config": xml(config),
        "Metadata/custom_gcode_per_layer.xml": xml(events),
        "Metadata/plate_1.png": token.png(512),
        "Metadata/qr_token.json": json.dumps(report, indent=2, ensure_ascii=False),
    }
    for index, project_part in enumerate(project_parts, 1):
        contents[f"3D/Objects/object_{index}.model"] = mesh_model(project_part["mesh"], index)
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, data in contents.items():
            archive.writestr(path, data)
    result.seek(0)
    with zipfile.ZipFile(result) as archive:
        if archive.testzip():
            raise RuntimeError("3MF archive integrity check failed.")
    return result.getvalue()


DEFAULT_TEMPLATE = Path(__file__).parent / "profiles" / "x2d-04-pla.3mf"
