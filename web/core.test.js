import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ManifoldModule from 'manifold-3d';
import {
  InputError,
  buildMaterialMeshes,
  buildMesh,
  buildPreviewParts,
  createToken,
  encodeBambu3mf,
  encodeBinaryStl,
  inspect3mf,
  parseTemplate,
  tokenFilename,
} from './core.js';

const profileBytes = new Uint8Array(await readFile(new URL('../profiles/x2d-04-pla.3mf', import.meta.url)));
const parsed = parseTemplate(profileBytes, 'X2D test profile');
const manifold = await ManifoldModule();
manifold.setup();

test('parses the bundled X2D project profile', () => {
  assert.equal(parsed.profile.printer, 'Bambu Lab X2D');
  assert.equal(parsed.profile.nozzle, 0.4);
  assert.equal(parsed.profile.bed_width, 256);
  assert.equal(parsed.profile.bed_depth, 256);
  assert.equal(parsed.profile.max_diameter, 196);
  assert.equal(parsed.profile.filament_count, 2);
});

test('creates the default token with exact layer boundaries', () => {
  const token = createToken({ url: 'https://example.com' }, parsed.profile);
  assert.equal(token.diameter, 60);
  assert.equal(token.minimum_diameter, 40);
  assert.equal(token.base, 1);
  assert.equal(token.relief, 1);
  assert.equal(token.base_layers, 5);
  assert.equal(token.qr_layers, 5);
  assert.equal(token.change_layer, 6);
  assert.equal(token.change_z, 1.2);
  assert.equal(token.modules, 25);
});

test('clamps the token to the QR-specific printable minimum', () => {
  const small = createToken({ url: 'https://example.com', diameter: 25 }, parsed.profile);
  assert.equal(small.diameter, 40);
  assert.match(small.warnings[0], /Width increased to 40 mm/);
  const dense = createToken({
    url: 'https://www.google.com/maps/place/Space+Needle/@47.6205,-122.3493,17z',
    diameter: 40,
  }, parsed.profile);
  assert.equal(dense.diameter, 53);
});

test('rejects invalid URLs, dimensions, colors, and filament assignments', () => {
  for (const input of [
    { url: '' },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:secret@example.com' },
    { url: 'https://example.com', diameter: Number.NaN },
    { url: 'https://example.com', shape: 'triangle' },
    { url: 'https://example.com', corner_style: 'scalloped' },
    { url: 'https://example.com', edge_profile: 'ogee' },
    { url: 'https://example.com', edge_size: 3 },
    { url: 'https://example.com', module_style: 'hearts' },
    { url: 'https://example.com', finder_style: 'flower' },
    { url: 'https://example.com', finder_center_style: 'star' },
    { url: 'https://example.com', finder_style: 'square', finder_center_style: 'diamond' },
    { url: 'https://example.com', finder_style: 'rounded', finder_center_style: 'diamond' },
    { url: 'https://example.com', finder_style: 'circle', finder_center_style: 'square' },
    { url: 'https://example.com', padding: 26 },
    { url: 'https://example.com', padding_unit: 'cm' },
    { url: 'https://example.com', shape: 'square', corner_style: 'custom', corner_radius: 31 },
    { url: 'https://example.com', center_icon: 'myspace' },
    { url: 'https://example.com', module_style: 'dots', center_icon: 'instagram' },
    { url: 'https://example.com', finder_style: 'rounded', center_icon: 'instagram' },
    { url: 'https://example.com', treatment: 'raised', construction: 'two-piece' },
    { url: 'https://example.com', treatment: 'flat', construction: 'two-piece' },
    { url: 'https://example.com', construction: 'hinged' },
    { url: 'https://example.com', base_color: '#000000', qr_color: '#FFFFFF' },
    { url: 'https://example.com', base_filament: 1, qr_filament: 1 },
  ]) assert.throws(() => createToken(input, parsed.profile), InputError);
});

test('builds one watertight manifold and a structurally valid binary STL', () => {
  const token = createToken({ url: 'https://example.com' }, parsed.profile);
  const mesh = buildMesh(manifold, token);
  assert.ok(mesh.triangles.length > 0);
  assert.ok(mesh.volume > 0);
  assert.deepEqual(mesh.bounds.min.map(value => Math.round(value)), [-30, -30, 0]);
  assert.deepEqual(mesh.bounds.max.map(value => Math.round(value)), [30, 30, 2]);
  const stl = encodeBinaryStl(mesh);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getUint32(80, true), mesh.triangles.length / 3);
  assert.equal(stl.length, 84 + mesh.triangles.length / 3 * 50);
});

test('builds an inset QR as one recessed watertight solid', () => {
  const token = createToken({ url: 'https://example.com', treatment: 'inset', relief: 0.24 }, parsed.profile);
  const mesh = buildMesh(manifold, token);
  assert.equal(token.treatment, 'inset');
  assert.equal(token.base_color, '#181818');
  assert.equal(token.qr_color, '#F5F0E5');
  assert.equal(token.qr_layers, 5);
  assert.equal(token.relief, 1);
  const variableLayer = createToken({
    url: 'https://example.com', treatment: 'inset', relief: 0.24, layer_height: 0.28,
  }, parsed.profile);
  assert.equal(variableLayer.qr_layers, 5);
  assert.equal(variableLayer.relief, 1.4);
  assert.ok(mesh.triangles.length > 0);
  assert.ok(mesh.volume > 0);
  assert.deepEqual(mesh.bounds.min.map(value => Math.round(value)), [-30, -30, 0]);
  assert.deepEqual(mesh.bounds.max.map(value => Math.round(value)), [30, 30, 2]);
});

test('builds a flat token as complementary flush material parts', () => {
  const token = createToken({ url: 'https://example.com', treatment: 'flat', base: 1 }, parsed.profile);
  assert.equal(token.height, 1);
  assert.equal(token.relief, 0);
  assert.equal(token.change_layer, null);
  assert.equal(token.change_z, null);
  const mesh = buildMesh(manifold, token);
  const parts = buildMaterialMeshes(manifold, token);
  assert.deepEqual(parts.map(part => part.name), ['Background', 'QR']);
  assert.deepEqual(parts.map(part => part.filament), [1, 2]);
  assert.ok(parts.every(part => part.mesh.triangles.length > 0 && part.mesh.volume > 0));
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + part.mesh.volume, 0) - mesh.volume) < 1e-4);
});

test('builds an inset base and cap as independent printable pieces', () => {
  const token = createToken({
    url: 'https://example.com', treatment: 'inset', construction: 'two-piece',
  }, parsed.profile);
  assert.equal(token.change_layer, null);
  const parts = buildMaterialMeshes(manifold, token);
  assert.deepEqual(parts.map(part => part.name), ['Dark base', 'Light QR cap']);
  assert.equal(parts[0].mesh.bounds.min[2], 0);
  assert.equal(parts[0].mesh.bounds.max[2], token.base);
  assert.equal(parts[1].mesh.bounds.min[2], 0);
  assert.equal(parts[1].mesh.bounds.max[2], token.relief);
  const mesh = buildMesh(manifold, token);
  assert.ok(mesh.bounds.max[0] - mesh.bounds.min[0] > token.shape_width * 2);
});

test('builds every supported token shape as printable watertight geometry', () => {
  const shapes = new Map([
    ['circle', 40], ['square', 30], ['rectangle', 30], ['pentagon', 51], ['hexagon', 44],
  ]);
  for (const [shape, minimumWidth] of shapes) {
    const token = createToken({
      url: 'https://example.com', shape, treatment: 'inset', diameter: 25,
    }, parsed.profile);
    const mesh = buildMesh(manifold, token);
    assert.equal(token.shape, shape);
    assert.equal(token.minimum_diameter, minimumWidth);
    assert.equal(token.diameter, minimumWidth);
    assert.ok(token.module_size >= 0.8);
    assert.ok(token.shape_height <= token.shape_width + 1e-5);
    assert.ok(mesh.triangles.length > 0);
    assert.ok(mesh.volume > 0);
  }
});

test('rectangle width and height are independent and QR-safe', () => {
  const token = createToken({
    url: 'https://example.com', shape: 'rectangle', diameter: 92, shape_height: 38, treatment: 'inset',
  }, parsed.profile);
  assert.equal(token.shape_width, 92);
  assert.equal(token.shape_height, 38);
  assert.equal(token.minimum_diameter, 30);
  assert.equal(token.minimum_height, 30);
  assert.ok(token.module_size >= .8);
  assert.ok(buildMesh(manifold, token).volume > 0);
});

test('business-card preset right-aligns the QR and supports printable social icons', () => {
  for (const icon of ['none', 'instagram', 'x', 'facebook', 'linkedin', 'youtube', 'tiktok']) {
    const token = createToken({ url: 'https://example.com', preset: 'business-card', icon, treatment: 'inset' }, parsed.profile);
    assert.equal(token.shape, 'rectangle');
    assert.equal(token.shape_width, 85.6);
    assert.equal(token.shape_height, 54);
    assert.ok(token.qr_offset_x > 0);
    assert.equal(token.icon, icon);
    if (icon === 'none') assert.equal(token.icon_size, 0);
    else {
      assert.equal(token.icon_size, 18);
      assert.ok(token.icon_center_x < 0);
      assert.ok(token.icon_outlines.length > 0);
    }
    const mesh = buildMesh(manifold, token);
    assert.ok(mesh.triangles.length > 0);
    assert.ok(mesh.volume > 0);
  }
});

test('print-safe module and finder styles produce printable geometry', () => {
  for (const module_style of ['square', 'rounded', 'dots', 'faceted', 'triangle']) {
    for (const finder_style of ['square', 'rounded', 'circle']) {
      const token = createToken({
        url: 'https://example.com', diameter: 80, treatment: 'inset', module_style, finder_style,
      }, parsed.profile);
      assert.equal(token.module_style, module_style);
      assert.equal(token.finder_style, finder_style);
      assert.ok(token.feature_outlines.length > 0);
      const mesh = buildMesh(manifold, token);
      assert.ok(mesh.triangles.length > 0);
      assert.ok(mesh.volume > 0);
    }
  }
});

test('independent finder frame and center styles produce printable geometry', () => {
  const combinations = [
    ['square', 'square'], ['square', 'rounded'], ['square', 'circle'],
    ['rounded', 'square'], ['rounded', 'rounded'], ['rounded', 'circle'],
    ['circle', 'rounded'], ['circle', 'circle'], ['circle', 'diamond'],
  ];
  for (const [finder_style, finder_center_style] of combinations) {
    const token = createToken({
      url: 'https://example.com', diameter: 80, treatment: 'inset', finder_style, finder_center_style,
    }, parsed.profile);
    assert.equal(token.finder_style, finder_style);
    assert.equal(token.finder_center_style, finder_center_style);
    assert.ok(buildMesh(manifold, token).volume > 0);
  }
});

test('center badges reserve a protected area and force high error correction', () => {
  for (const center_icon of ['blank', 'instagram', 'x', 'facebook', 'linkedin', 'youtube', 'tiktok']) {
    const token = createToken({
      url: 'https://example.com', diameter: 80, treatment: 'inset',
      module_style: 'square', finder_style: 'square', center_icon, correction: 'M',
    }, parsed.profile);
    assert.equal(token.correction, 'H');
    assert.ok(token.center_span_modules >= 5);
    assert.equal(token.center_span_modules % 2, 1);
    assert.equal(token.center_icon_size === 0, center_icon === 'blank');
    assert.ok(token.warnings.some(warning => warning.includes('High error correction')));
    assert.ok(buildMesh(manifold, token).volume > 0);
  }
});

test('every top-edge profile produces matching printable and preview geometry', () => {
  for (const top_profile of ['straight', 'chamfered', 'rounded', 'inset', 'tapered']) {
    const token = createToken({
      url: 'https://example.com', shape: 'rectangle', shape_height: 45,
      top_profile, top_size: .8, treatment: 'inset',
    }, parsed.profile);
    assert.equal(token.top_profile, top_profile);
    assert.deepEqual(token.top_slices[0], [0, 0]);
    assert.equal(token.top_slices.at(-1)[0], token.relief);
    assert.equal(token.top_slices.at(-1)[1], top_profile === 'straight' ? 0 : .8);
    const mesh = buildMesh(manifold, token);
    const preview = buildPreviewParts(manifold, token);
    assert.ok(mesh.triangles.length > 0);
    assert.ok(preview.base.triangles.length > 0);
    assert.ok(preview.top.triangles.length > 0);
  }
});

test('builds every edge profile as one printable solid without changing the QR surface', () => {
  for (const edge_profile of ['straight', 'chamfered', 'rounded', 'inset', 'tapered']) {
    const token = createToken({
      url: 'https://example.com', shape: 'pentagon', corner_style: 'rounded', edge_profile,
      edge_size: .8, treatment: 'inset',
    }, parsed.profile);
    const mesh = buildMesh(manifold, token);
    assert.equal(token.edge_profile, edge_profile);
    assert.deepEqual(token.edge_slices[0][0], 0);
    assert.deepEqual(token.edge_slices.at(-1), [token.base, 0]);
    assert.equal(token.shape_width, 60);
    assert.ok(mesh.triangles.length > 0);
    assert.ok(mesh.volume > 0);
  }
});

test('corner treatments preserve the requested envelope and printable geometry', () => {
  for (const shape of ['square', 'rectangle', 'pentagon', 'hexagon']) {
    for (const corner_style of ['default', 'sharp', 'softened', 'rounded']) {
      const token = createToken({ url: 'https://example.com', shape, corner_style }, parsed.profile);
      const mesh = buildMesh(manifold, token);
      assert.equal(token.corner_style, corner_style);
      assert.equal(token.shape_width, 60);
      assert.ok(mesh.triangles.length > 0);
      assert.ok(mesh.volume > 0);
    }
  }
});

test('exact corner radius and border padding convert inches to millimeters', () => {
  const token = createToken({
    url: 'https://example.com', shape: 'rectangle', diameter: 90, shape_height: 50,
    corner_style: 'custom', corner_radius: .25, corner_radius_unit: 'in',
    padding: .125, padding_unit: 'in', treatment: 'inset',
  }, parsed.profile);
  assert.equal(token.corner_radius, 6.35);
  assert.equal(token.padding, 3.175);
  assert.equal(token.shape_width, 90);
  assert.equal(token.shape_height, 50);
  assert.deepEqual(token.outline[0], [45, 18.65]);
  assert.ok(buildMesh(manifold, token).volume > 0);
  const compact = createToken({ url: 'https://example.com', shape: 'square', padding: 0 }, parsed.profile);
  const padded = createToken({ url: 'https://example.com', shape: 'square', padding: 8 }, parsed.profile);
  assert.ok(padded.minimum_diameter > compact.minimum_diameter);
  assert.ok(padded.module_size < compact.module_size);
});

test('packages the native Bambu settings and exactly one layer tool change', async () => {
  const token = createToken({ url: 'https://example.com' }, parsed.profile);
  token.scan_verified = true;
  const mesh = buildMesh(manifold, token);
  const filename = await tokenFilename(token);
  assert.equal(filename, 'qr-circle-raised-example.com-100680ad');
  const project = encodeBambu3mf(parsed.template, parsed.profile, token, mesh, filename, new Uint8Array([1, 2, 3]));
  const contents = inspect3mf(project);
  assert.ok(contents.names.includes('3D/Objects/object_1.model'));
  assert.match(contents.events, /top_z="1\.2"/);
  assert.match(contents.events, /extruder="2"/);
  assert.equal((contents.events.match(/<layer\s/g) || []).length, 1);
  assert.equal(contents.settings.layer_height, '0.2');
  assert.equal(contents.settings.initial_layer_print_height, '0.2');
  assert.equal(contents.settings.machine_start_gcode, parsed.template.settings.machine_start_gcode);
  assert.equal(contents.report.mesh.watertight, true);
});

test('packages flat and two-piece modes as two material parts without a fake layer event', async () => {
  for (const settings of [
    { treatment: 'flat' },
    { treatment: 'inset', construction: 'two-piece' },
  ]) {
    const token = createToken({ url: 'https://example.com', ...settings }, parsed.profile);
    token.scan_verified = true;
    const mesh = buildMesh(manifold, token);
    const parts = buildMaterialMeshes(manifold, token);
    const filename = await tokenFilename(token);
    const project = encodeBambu3mf(
      parsed.template, parsed.profile, token, mesh, filename, new Uint8Array([1, 2, 3]), parts,
    );
    const contents = inspect3mf(project);
    assert.ok(contents.names.includes('3D/Objects/object_1.model'));
    assert.ok(contents.names.includes('3D/Objects/object_2.model'));
    assert.equal((contents.events.match(/<layer\s/g) || []).length, 0);
    assert.equal(contents.report.parts.length, 2);
    assert.equal(contents.report.change_z, null);
  }
});
