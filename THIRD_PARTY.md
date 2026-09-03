# Third-party components

Three.js 0.185.1 is bundled in `static/vendor` under its MIT license.
Its license is included as `static/vendor/THREE-LICENSE.txt`.

The static browser generator uses pinned copies of fflate 0.8.3 under the MIT license, jsQR 1.4.0 under the Apache License 2.0, Manifold 3D 3.5.1 under the Apache License 2.0, and node-qrcode 1.5.4 under the MIT license.
The Pages build publishes each runtime library license under `licenses/` beside the bundled application.
esbuild 0.28.2 builds the browser bundle under its MIT license and is not included in the deployed runtime.
Font Awesome Free Brands 7.3.1 supplies the Instagram, X, Facebook, LinkedIn, YouTube, and TikTok vector paths under CC BY 4.0.
The generated geometry retains attribution to Fonticons, Inc., and the Pages build publishes the Font Awesome license beside the application.
svg-pathdata 8.0.0 converts those SVG paths into printable polygon outlines at build time under its MIT license.

The Bambu 3MF layer-event format was informed by the existing MIT-licensed HueForge 3MF Export project and verified against Bambu Studio’s source and native exports.
The original HueForge exporter’s notice is included as `HUEFORGE-LICENSE.txt`.
The generator does not require that separate repository.

Bambu Studio profile data is described in `profiles/PROVENANCE.md`.
