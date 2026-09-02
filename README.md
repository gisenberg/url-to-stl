# QR Token Studio

QR Token Studio is a free browser-based generator for raised, inset, flat, or two-piece QR tokens with Bambu Studio AMS assignments.
Choose a circle, square, independently sized rectangle, pentagon, or hexagon.
The Business Card starting shape creates an 85.6 × 54 mm card with a right-aligned QR and an optional Font Awesome Instagram, X, Facebook, LinkedIn, YouTube, or TikTok brand mark.
QR styling includes classic blocks, rounded tiles, merged line runs, connected triangle groups, dots, faceted tiles, independently selected finder frames and centers, an optional perimeter outline, and protected center badges.
Enter a URL, set the dimensions, and download a Bambu project `.3mf`, watertight `.stl`, or QR preview `.png` directly from the web app.
The entered URL, imported profile, and generated geometry stay in the browser and are never uploaded.

[Open QR Token Studio](https://gisenberg.github.io/url-to-stl/)

## Use the web app

1. Enter the destination URL.
2. Choose a starting shape, dimensions, raised, inset, or flat QR treatment, base thickness, and feature depth.
   Rectangles have independent width and height controls.
   Open **Shape and edge details** for exact corner radii, physical border padding, and lower or top edge treatments.
   **QR appearance** stays open so its graphical module shape, finder-frame style, finder-center style, optional perimeter outline, and center badge controls remain visible.
   Center badges reserve a bounded light area and lock classic modules, square finder frames and centers, and High error correction because that combination survives native slicing.
   The size slider starts at the shape-specific minimum printable width for the current URL and nozzle.
3. Download **Bambu 3MF**.
   Use the arrow segment on the download button when you need geometry-only STL instead.
4. Open it **as a project** in Bambu Studio so its settings, material parts, and any layer event are retained.
5. Slice and confirm the preview shows a dark QR against a light surface with the expected filament assignments.
6. Map the two project filaments to the desired physical AMS slots in the print dialog.
7. Print one token and scan it with your phone before printing a batch.

The default profile is Bambu Lab X2D with 0.4 mm standard nozzles, Bambu PLA Matte, and Textured PEI Plate.
Both project filaments use the main extruder for one AMS swap.
The app does not assume which physical AMS slots contain your spools because those are selected at print time.
The generator uses fixed dark and light preview colors; assign the actual AMS spools and adjust their display colors in Bambu Studio.
The web app defaults to an inset treatment that prints a dark base first, then adds a light top field around openings that reveal the recessed dark QR.
The light top field is at least five complete layers thick to cover the dark base reliably.
Choose the raised treatment to print the original dark QR above a light base.
Choose two-piece construction with the inset treatment to place the dark base and perforated light cap as separate parts on the plate for alignment and bonding after printing.
Choose the flat treatment to create complementary light-background and dark-QR parts with one level top surface and no raised or recessed feature.

Under **Layer settings & custom profile**, you can import another Bambu Studio project with two or more filaments of the same material.
The browser reads its printer, nozzle, material, bed, and native machine settings from memory without uploading the file.
Its models, existing layer changes, variable layer profiles, thumbnails, and sliced G-code are not copied into the token.
The supplied X2D profile is validated end to end, while other printer profiles should be checked carefully in their slicer.

## What runs in the browser

The static GitHub Pages app performs the complete export pipeline without a web server.
It uses a pinned QR encoder, an independent QR decoder, Manifold WebAssembly solid geometry, ZIP processing, and the bundled X2D Bambu project profile.
The page makes same-origin requests only for its static JavaScript, WebAssembly, renderer, and profile files.

The base and QR heights round up to whole layers, taking the first layer height into account.
For the default 1 mm base with 0.2 mm first and subsequent layers, layers 1 through 5 print in the base color.
The automatic tool change is saved before layer 6, whose top Z is **1.2 mm**.
In raised mode, the dark QR geometry starts at **1.0 mm** and is 1 mm tall by default.
In inset mode, the dark base ends at **1.0 mm** and the light top field starts after the swap, leaving the dark QR recessed to the base surface.
The default 1 mm top field provides five light layers at 0.2 mm per layer.
That distinction prevents changing the final base layer to the QR color.
Flat mode assigns complementary background and QR volumes to separate filaments across the full token thickness.
Two-piece inset mode assigns the base and cap to separate filaments and lays them out with a 6 mm gap.

Raised and single-print inset projects store one event in `Metadata/custom_gcode_per_layer.xml` as a tool change in `MultiAsSingle` mode.
Flat and two-piece inset projects store filament assignments on two model parts without adding a fake layer event.
There is no manual pause and no hand-written printer command inserted by the generator.
Bambu Studio uses the native profile to produce the AMS commands when the project is sliced.
Changing layer height or scaling Z later in the slicer can move the intended boundary, so regenerate the project after changing those values.

STL stores geometry only.
Download 3MF to retain the automatic layer change.
The PNG export is a top-view preview rather than a replacement for the 3D model.

## Geometry and print safeguards

- Four quiet-zone modules on every side fit inside every shape with a configurable physical edge padding of 1 mm by default.
- The overall width is clamped to the shape-specific minimum that keeps every QR module printable with the selected nozzle.
- Corner treatments include shape default, sharp, softened, rounded, and an exact custom radius with millimeter or inch entry.
- Lower-edge treatments include a straight wall, chamfered foot, rounded foot, stepped inset, and a taper angled inward from the build plate.
- Top-edge treatments provide the inverse controls at the upper perimeter: straight, chamfered, rounded, stepped inset, or angled inward.
- QR sizing accounts for the narrowest treated top perimeter so the quiet zone retains its clearance.
- Token detail view uses a low camera angle and true depth to make raised or recessed geometry visible.
- Bed scale view shows the token at real scale on a gray representation of the selected profile’s print bed.
- Two-piece inset construction displays and exports the base and cap side by side on that bed.
- The generated preview uses a high-contrast dark QR and light surface.
- Print-safe QR patterns include classic blocks, rounded tiles, merged horizontal lines, connected triangle groups, dots, and faceted tiles.
- Line modules automatically use High error correction because native sliced toolpaths retain more reliable redundancy at their printable spacing.
- The optional perimeter outline follows the token shape outside the required four-module QR quiet zone.
- Finder treatments separate square, rounded, or circular outer frames from square, rounded, circular, or diamond centers.
- The UI limits the diamond center to the circular frame and prevents the circular-frame/square-center pairing because those alternatives fail independent scan checks.
- A clear center or social icon badge removes only a bounded central module region, preserves the quiet zone and finder eyes, locks classic modules with square finder frames and centers, and forces High error correction.
- Every browser preview is independently decoded with jsQR before export is enabled.
- Manifold WebAssembly performs the 2D and 3D boolean operations that produce watertight single or complementary material parts.
- A 0.01 mm corner relief prevents diagonal QR cells from creating non-manifold edges when an STL reader welds vertices.
- Print settings preserve two walls on top surfaces to avoid hollow centers in isolated QR modules.
- The prime tower is kept separate from the centered token, and the export reserves bed clearance for it.
- Exports contain source geometry and settings without pre-sliced G-code.

Preview colors are illustrative.
Use opaque, contrasting filaments of the same material and verify an actual print with the phones that will scan it.
Shorter URLs give larger QR modules at the same token width.

## Local static development

Install Node.js 24 or newer, then build and serve the same files deployed to GitHub Pages.

```powershell
npm ci
npm run test:web
npm run build:web
python scripts/build_pages.py
python -m http.server 8768 --directory _site
```

Open <http://127.0.0.1:8768/>.
The generated `_site` directory has no API dependency and can be hosted by any ordinary static file server.

## Python CLI and local server

The original Python implementation remains as an independently tested command-line exporter and optional local Flask app.
It is useful for batch generation and cross-checking the browser implementation.

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py --url https://example.com --shape rectangle --diameter 92 --shape-height 50 --corner-style custom --corner-radius 0.25 --corner-radius-unit in --padding 2 --finder-style rounded --finder-center-style circle --edge-profile chamfered --top-profile rounded --treatment inset --base 1 --relief 1 --output generated
```

Omit the generation arguments to run the Flask workspace at <http://127.0.0.1:8765/>.
Windows users can also double-click `Start.vbs`.

## Validation

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check .
npm ci
npm run test:web
npm run check:web
npm run build:web
.venv\Scripts\python.exe tests\validate_bambu.py --workdir ..\..\work\bambu-validation --report validation\bambu-report.json
```

The native integration test checks every supported inset shape and lower-edge treatment, flat and two-piece modes, a rounded top edge, an Instagram business card, triangle-group and line module treatments, perimeter framing, and representative styled center-badge combinations for successful slicing, correct filament selection, and decoding of the actual sliced QR toolpaths.
Browser-generated raised, inset, flat, and two-piece 3MF projects have also been passed through the installed Bambu Studio CLI and checked for watertight geometry, correct material assignment, and decodable sliced QR toolpaths.
No validation command starts a print job.

Bambu Studio 02.07.01.62 logs `Invalid T command` for the X2D profile’s own end-of-print commands `T65279` and `T65535`, including on an untouched native cube baseline.
The CLI returns success and reports no slicing warnings for the token cases.
The generator preserves that native machine G-code instead of rewriting firmware-specific commands.
Physical printing has not been tested.

## Files

- `web/`: static browser generator source and Node tests.
- `static/`: shared workspace markup, styles, and the bundled Three.js renderer.
- `scripts/build_web.mjs`: pinned browser bundle and license assembly.
- `scripts/build_pages.py`: static GitHub Pages artifact assembly.
- `profiles/`: native Bambu printer settings and provenance.
- `server.py`: optional local HTTP app and command-line interface.
- `token_model.py`: Python QR constraints, preview, and solid geometry reference.
- `bambu_project.py`: Python template inspection and Bambu project export reference.
- `tests/`: Python geometry, security, metadata, and native slicer validation.
- `validation/`: recorded validation results.

The Pages workflow installs pinned Python and Node dependencies, runs both test suites, builds the browser bundle, and deploys the static app after every push to `main`.
Only import Bambu templates you trust because an imported template supplies the machine G-code retained in its generated project.
