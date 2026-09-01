# QR Token Studio

A free local generator for circular QR tokens with an automatic Bambu Studio filament change.
Enter a URL, set the dimensions, and download a project `.3mf` or a single-solid `.stl`.
The app never fetches the entered URL, contacts a printer, or uploads a design.

[Project site](https://gisenberg.github.io/url-to-stl/) · [Download the packaged app](https://gisenberg.github.io/url-to-stl/downloads/qr-token-studio.zip)

## Start

Double-click `Start.vbs` on Windows.
The launcher opens the app at <http://127.0.0.1:8765> without leaving a terminal window open.
The first launch requires Python 3.12 or newer and an internet connection to install the pinned dependencies.
After that, the application and its 3D preview work offline.
All browser libraries are bundled locally.
If startup fails, check `startup.log` in this folder.

For an explicit terminal launch:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py
```

Press Ctrl+C in that terminal to stop the server.
The hidden launcher server also stops when Windows shuts down.
Reopening the launcher reuses an existing local instance.

## Print

1. Enter the destination URL.
2. Choose token diameter, base thickness, QR relief, and contrasting colors.
   The diameter slider starts at the minimum printable size for the current URL and nozzle.
3. Download **Bambu 3MF**.
4. Open it **as a project** in Bambu Studio, preserving its settings.
5. Slice and confirm the preview shows one filament change and a dark QR over a light base.
6. Map the two project filaments to the desired physical AMS slots in the print dialog.
7. Print one token and test it with your phone before printing a batch.

The default profile is Bambu Lab X2D, 0.4 mm standard nozzles, Bambu PLA Matte, and Textured PEI Plate.
Both project filaments are assigned to the main extruder for a single AMS swap.
The app does not claim to know which physical AMS slots contain your spools.
Those are selected at print time.

Under **Layer settings & custom profile**, you can import another Bambu Studio project with two or more filaments of the same material.
Its printer, nozzle, material temperatures, and native machine G-code are retained.
Only its settings are read; its models, existing layer changes, variable layer profiles, thumbnails, and sliced G-code are not copied into the generated token.
The imported profile lasts for the current server session.
The supplied X2D profile is the one validated end to end; other printer profiles should be checked in their slicer before printing.

## What is automated

The base and QR heights round up to whole layers, taking the first layer’s height into account.
For the default 1 mm base with 0.2 mm first and subsequent layers, layers 1 through 5 print in the base color.
The automatic tool change is saved before layer 6, whose top Z is **1.2 mm**.
The QR geometry starts at **1.0 mm** and is 1 mm tall by default.
That distinction prevents changing the final base layer to the QR color.

The project stores the event in `Metadata/custom_gcode_per_layer.xml` as a `ToolChange` event in `MultiAsSingle` mode.
There is no manual pause and no hand-written printer command inserted by the generator.
Bambu Studio uses the native profile to produce the AMS commands when you slice.
Changing layer height or scaling Z later in the slicer can move the intended boundary, so regenerate the project after changing those values.

STL stores geometry only.
Download 3MF to retain the automatic layer change.
The PNG export is a top-view preview, not a replacement for the 3D model.

## Geometry and print safeguards

- Four blank QR modules on every side fit inside the circle, with another 1 mm of radial edge clearance.
- The diameter is clamped to the minimum that keeps every QR module printable with the selected nozzle.
- The 3D preview shows the token at real scale on the selected profile’s print bed.
- The foreground must be darker than the background and pass a contrast check.
- Every preview is independently decoded with ZXing before export is enabled.
- Geometry uses a 2D union and a 3D boolean union to produce one watertight solid.
- A 0.01 mm corner relief prevents diagonal QR cells from creating non-manifold edges when an STL reader welds vertices.
- Print settings preserve two walls on top surfaces, avoiding hollow centers in isolated QR modules.
- The prime tower is kept separate from the centered token, and the export reserves bed clearance for it.
- Exports contain source geometry and settings, not pre-sliced G-code.

Preview colors are illustrative.
Use opaque, contrasting filaments of the same material and verify an actual print with the phones that will scan it.
Shorter URLs give larger QR modules at the same token diameter.

## Command line

```powershell
.venv\Scripts\python.exe server.py --url https://example.com --diameter 60 --base 1 --relief 1 --output generated
```

This writes matching 3MF, STL, PNG, and JSON metadata files.
Optional arguments include `--template path\to\project.3mf`, `--layer-height 0.16`, and `--first-layer 0.2`.
Regenerating the same URL in the same output folder replaces its previous files.

## Validation

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe tests\validate_bambu.py --workdir ..\..\work\bambu-validation --report validation\bambu-report.json
```

The native integration test checks successful slicing, exactly one filament change, correct filament selection on every model layer, and decoding of the actual sliced QR toolpaths.
It covers standard layers, a different first-layer height, and reversed filament assignments.
It never starts a print job.
The included validation report records the tested Bambu Studio version and results.

Bambu Studio 02.07.01.62 logs `Invalid T command` for the X2D profile’s own end-of-print commands `T65279` and `T65535`, including on an untouched native cube baseline.
The CLI returns success and reports no slicing warnings for the token cases.
The generator preserves that native machine G-code instead of rewriting firmware-specific commands.
Physical printing has not been tested.

## Files

- `server.py`: local HTTP app and command-line interface.
- `token_model.py`: QR encoding, dimensional constraints, preview, and solid geometry.
- `bambu_project.py`: template inspection and Bambu project export.
- `static/`: browser UI and bundled Three.js renderer.
- `profiles/`: native Bambu printer settings and provenance.
- `examples/`: an example.com token ready to open as a Bambu project.
- `tests/`: geometry, security, metadata, and native slicer validation.

The server binds only to `127.0.0.1` and rejects cross-origin writes.
Only open templates you trust, since imported templates supply the printer’s native machine G-code.

## GitHub Pages

The project site is built from `site/` by `.github/workflows/pages.yml` on every push to `main`.
Unit tests, lint, and formatting checks must pass before the Pages artifact is built.
The workflow packages the current repository into the downloadable ZIP, copies the validated example and application screenshot, and deploys the resulting static artifact through GitHub Pages.
The generator itself remains a local Python application because GitHub Pages cannot run its geometry and Bambu project backend.
