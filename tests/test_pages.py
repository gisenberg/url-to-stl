import shutil

from scripts.build_pages import ROOT, build


def test_pages_build_is_the_generator_without_server_routes():
    output = ROOT / ".pages-build-test"
    try:
        build(output)
        html = (output / "index.html").read_text(encoding="utf-8")
        app = (output / "app.js").read_text(encoding="utf-8")
        assert "BROWSER WORKSPACE" in html
        assert "A LINK YOU CAN HOLD" not in html
        assert "Small token." not in html
        assert "Business card" in html
        assert "Brand icon" in html
        assert "QR modules" in html
        assert "Finder eyes" in html
        assert "Center badge" in html
        assert "Flat · dark code flush with a light face" in html
        assert "Two pieces · separate base and cap" in html
        assert "Download Bambu 3MF" in html
        assert "Download for Windows" not in html
        assert "/api/" not in app
        for relative in (
            "manifold.wasm",
            "profiles/x2d-04-pla.3mf",
            "vendor/three.module.js",
            "licenses/manifold-3d-LICENSE.txt",
        ):
            assert (output / relative).is_file()
    finally:
        if output.is_dir():
            shutil.rmtree(output)
