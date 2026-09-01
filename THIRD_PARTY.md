# Third-party components

Three.js 0.185.1 is bundled in `static/vendor` under its MIT license.
Its license is included as `static/vendor/THREE-LICENSE.txt`.

The static browser generator uses pinned copies of fflate 0.8.3 under the MIT license, jsQR 1.4.0 under the Apache License 2.0, Manifold 3D 3.5.1 under the Apache License 2.0, and node-qrcode 1.5.4 under the MIT license.
The Pages build publishes each runtime library license under `licenses/` beside the bundled application.
esbuild 0.28.2 builds the browser bundle under its MIT license and is not included in the deployed runtime.

Python dependencies are pinned in `requirements.txt` and retain their respective licenses.
They include Flask, Manifold, NumPy, Pillow, python-qrcode, trimesh, and ZXing-C++.
Their installed packages include their license notices.

The Bambu 3MF layer-event format was informed by the existing MIT-licensed HueForge 3MF Export project and verified against Bambu Studio’s source and native exports.
The original HueForge exporter’s notice is included as `HUEFORGE-LICENSE.txt`.
The generator does not require that separate repository.

Bambu Studio profile data is described in `profiles/PROVENANCE.md`.
