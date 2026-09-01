"""Local-only browser app and command-line generator. Never contacts a printer."""

import argparse
import io
import json
import secrets
import threading
import webbrowser
from collections import OrderedDict
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from werkzeug.serving import make_server

from bambu_project import DEFAULT_TEMPLATE, export_project, profile_info, read_template
from token_model import InputError, create_token

APP_DIR = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=str(APP_DIR / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
SESSION = secrets.token_urlsafe(32)
templates = OrderedDict()
template_lock = threading.Lock()
default_template = read_template(DEFAULT_TEMPLATE)


@app.before_request
def local_only():
    if request.host.split(":")[0] not in ("127.0.0.1", "localhost"):
        return jsonify(error="Local connections only."), 403
    if request.method == "POST":
        if request.headers.get("X-Token-Studio") != SESSION:
            return jsonify(error="Refresh this page to reconnect to the local app."), 403
        if request.headers.get("Origin") not in (None, request.host_url.rstrip("/")):
            return jsonify(error="Cross-origin requests are not allowed."), 403


@app.after_request
def headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    return response


@app.errorhandler(InputError)
def invalid(error):
    return jsonify(error=str(error)), 400


@app.errorhandler(413)
def too_large(error):
    return jsonify(error="Template must be smaller than 32 MB."), 413


@app.get("/")
def index():
    return send_file(APP_DIR / "static" / "index.html")


@app.get("/api/config")
def config():
    return jsonify(session=SESSION, profile=profile_info(default_template, "X2D · 0.4 mm · PLA Matte"))


def resolve_input():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise InputError("Expected a JSON request.")
    key = data.get("template", "default")
    if not isinstance(key, str):
        raise InputError("Invalid template.")
    if key == "default":
        template = default_template
    else:
        with template_lock:
            template = templates.get(key)
        if template is None:
            raise InputError("Template expired. Import it again.")
    token = create_token(data, template["nozzle"], template["filament_count"])
    return data, template, token


@app.post("/api/preview")
def preview():
    _, template, token = resolve_input()
    result = token.info()
    result["profile"] = profile_info(template)
    return jsonify(result)


@app.post("/api/template")
def upload_template():
    source = request.files.get("file")
    if source is None:
        raise InputError("Choose a Bambu Studio project 3MF.")
    template = read_template(io.BytesIO(source.read()))
    key = secrets.token_urlsafe(16)
    with template_lock:
        templates[key] = template
        while len(templates) > 8:
            templates.popitem(last=False)
    return jsonify(
        template=key, profile=profile_info(template, Path(source.filename or "Custom template").name)
    )


@app.post("/api/export/<kind>")
def export(kind):
    if kind not in ("3mf", "stl", "png"):
        raise InputError("Unknown export format.")
    _, template, token = resolve_input()
    if kind == "png":
        data = token.png(1024)
    else:
        mesh = token.mesh()
        data = export_project(template, token, mesh) if kind == "3mf" else mesh.export(file_type="stl")
    return send_file(
        io.BytesIO(data),
        mimetype="image/png" if kind == "png" else "application/octet-stream",
        as_attachment=True,
        download_name=f"{token.filename}.{kind}",
    )


def main():
    parser = argparse.ArgumentParser(
        description="QR Token Studio: local circular QR tokens with Bambu AMS layer changes."
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--url", help="Generate files instead of starting the browser app.")
    parser.add_argument("--output", type=Path, default=Path.cwd() / "generated")
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    parser.add_argument("--diameter", type=float, default=60)
    parser.add_argument("--base", type=float, default=2)
    parser.add_argument("--relief", type=float, default=0.6)
    parser.add_argument("--layer-height", type=float, default=0.2)
    parser.add_argument("--first-layer", type=float, default=0.2)
    args = parser.parse_args()
    if args.url:
        template = read_template(args.template)
        token = create_token(vars(args), template["nozzle"], template["filament_count"])
        mesh = token.mesh()
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=True)
        files = {
            ".3mf": export_project(template, token, mesh),
            ".stl": mesh.export(file_type="stl"),
            ".png": token.png(1024),
        }
        for suffix, data in files.items():
            dest = output / (token.filename + suffix)
            dest.write_bytes(data)
            print(dest)
        report = token.info()
        report.pop("matrix")
        (output / (token.filename + ".json")).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return
    address = f"http://127.0.0.1:{args.port}"
    server = make_server("127.0.0.1", args.port, app, threaded=True)
    print(f"QR Token Studio: {address}", flush=True)
    print("Local only. No URLs are fetched and no print jobs are sent.", flush=True)
    if not args.no_browser:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
