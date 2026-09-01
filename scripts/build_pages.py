"""Assemble the entirely static QR Token Studio for GitHub Pages."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "_site"


def replace_directory(path: Path) -> None:
    resolved = path.resolve()
    if resolved == ROOT or not resolved.is_relative_to(ROOT):
        raise ValueError("Refusing to replace a directory outside the repository.")
    if resolved.exists():
        shutil.rmtree(resolved)


def build(output: Path) -> Path:
    output = output.resolve()
    if output == ROOT or not output.is_relative_to(ROOT):
        raise ValueError("The Pages output directory must be inside the repository.")
    browser_bundle = ROOT / "web" / "dist" / "app.js"
    if not browser_bundle.is_file():
        raise RuntimeError("Run `npm run build:web` before building GitHub Pages.")

    temporary = ROOT / ".pages-build-temp"
    for path in (temporary, output):
        replace_directory(path)
    temporary.mkdir()

    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/static/style.css"', 'href="style.css"')
    html = html.replace('src="/static/app.js"', 'src="app.js"')
    html = html.replace(
        'href="/" aria-label="QR Token Studio home"', 'href="./" aria-label="QR Token Studio home"'
    )
    html = html.replace("LOCAL WORKSPACE", "BROWSER WORKSPACE")
    html = html.replace('<span class="version">/ 01</span>', '<span class="version">/ STATIC</span>')
    html = html.replace("Generated entirely on your computer.", "Generated entirely in your browser.")
    html = html.replace("No cloud. No tracking.", "No uploads. No tracking.")
    (temporary / "index.html").write_text(html, encoding="utf-8", newline="\n")
    shutil.copy2(ROOT / "static" / "style.css", temporary / "style.css")
    shutil.copy2(ROOT / "site" / "favicon.svg", temporary / "favicon.svg")
    shutil.copy2(browser_bundle, temporary / "app.js")
    shutil.copy2(ROOT / "web" / "dist" / "manifold.wasm", temporary / "manifold.wasm")
    shutil.copytree(ROOT / "web" / "dist" / "licenses", temporary / "licenses")
    shutil.copy2(ROOT / "THIRD_PARTY.md", temporary / "THIRD_PARTY.md")
    shutil.copytree(ROOT / "static" / "vendor", temporary / "vendor")
    (temporary / "profiles").mkdir()
    shutil.copy2(ROOT / "profiles" / "x2d-04-pla.3mf", temporary / "profiles" / "x2d-04-pla.3mf")
    (temporary / ".nojekyll").touch()
    temporary.replace(output)
    return output


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    built = build(destination)
    print(f"Built GitHub Pages app at {built}")
