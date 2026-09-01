"""Build the static project site and a deterministic local-app archive."""

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE_SOURCE = ROOT / "site"
DEFAULT_OUTPUT = ROOT / "_site"
ARCHIVE_ROOT = "qr-token-studio"
EXCLUDED_PARTS = {
    ".git",
    ".github",
    ".pages-build-temp",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "_site",
    "generated",
    "scripts",
    "site",
}
EXCLUDED_FILES = {"startup.log"}


def is_packaged(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return not EXCLUDED_PARTS.intersection(relative.parts) and path.name not in EXCLUDED_FILES


def add_deterministic_file(archive: zipfile.ZipFile, source: Path, destination: Path) -> None:
    info = zipfile.ZipInfo(destination.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, source.read_bytes(), compresslevel=9)


def build(output: Path) -> Path:
    output = output.resolve()
    if output == ROOT or not output.is_relative_to(ROOT):
        raise ValueError("The Pages output directory must be inside the repository.")

    temporary = ROOT / ".pages-build-temp"
    for path in (temporary, output):
        resolved = path.resolve()
        if resolved == ROOT or not resolved.is_relative_to(ROOT):
            raise ValueError("Refusing to replace a directory outside the repository.")
        if resolved.exists():
            shutil.rmtree(resolved)

    shutil.copytree(SITE_SOURCE, temporary)
    (temporary / ".nojekyll").touch()
    (temporary / "assets").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "preview.png", temporary / "assets" / "preview.png")
    shutil.copy2(
        ROOT / "examples" / "qr-example.com-100680ad.png",
        temporary / "assets" / "example-token.png",
    )
    (temporary / "examples").mkdir(exist_ok=True)
    shutil.copy2(
        ROOT / "examples" / "qr-example.com-100680ad.3mf",
        temporary / "examples" / "qr-example.com-100680ad.3mf",
    )
    downloads = temporary / "downloads"
    downloads.mkdir(exist_ok=True)
    package = downloads / "qr-token-studio.zip"
    with zipfile.ZipFile(package, "w") as archive:
        for source in sorted(ROOT.rglob("*")):
            if source.is_file() and is_packaged(source):
                destination = Path(ARCHIVE_ROOT) / source.relative_to(ROOT)
                add_deterministic_file(archive, source, destination)
    with zipfile.ZipFile(package) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("The generated application archive failed its integrity check.")
    temporary.replace(output)
    return output


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    built = build(destination)
    print(f"Built GitHub Pages site at {built}")
