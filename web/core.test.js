import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ManifoldModule from 'manifold-3d';
import {
  InputError,
  buildMesh,
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

test('builds every supported token shape as printable watertight geometry', () => {
  const shapes = new Map([
    ['circle', 40], ['square', 30], ['rectangle', 40], ['pentagon', 51], ['hexagon', 44],
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
