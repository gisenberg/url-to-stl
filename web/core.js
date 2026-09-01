import QRCode from 'qrcode';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export class InputError extends Error {}

const SQRT2 = Math.sqrt(2);
const encoder = new TextEncoder();

function number(data, key, fallback, minimum, maximum) {
  const raw = data[key] === undefined || data[key] === '' ? fallback : data[key];
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InputError(`${label(key)} must be a number.`);
  if (value < minimum || value > maximum) {
    throw new InputError(`${label(key)} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function label(key) {
  const text = key.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.slice(1);
}

function color(data, key, fallback) {
  const value = data[key] || fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new InputError('Colors must be six-digit hex values.');
  }
  return value.toUpperCase();
}

function luminance(hex) {
  const values = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = values.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') throw new InputError('Enter a website URL.');
  let value = raw.trim();
  if (!value || encoder.encode(value).length > 1500 || [...value].some(char => /\s/.test(char) || char.codePointAt(0) < 32)) {
    throw new InputError('Enter a URL without spaces, up to 1,500 UTF-8 bytes.');
  }
  if (!value.includes('://')) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError('Enter a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[<>"{}|\\^`]/.test(value)) {
    throw new InputError('Enter a valid HTTP or HTTPS URL without credentials.');
  }
  return value;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

export function createToken(data, profile) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('Expected token settings.');
  if (!profile) throw new InputError('The printer profile has not loaded yet.');
  const url = normalizeUrl(data.url || '');
  const nozzle = profile.nozzle;
  const requestedDiameter = number(data, 'diameter', 60, 25, 200);
  const maximumLayer = Math.min(0.3, nozzle * 0.75);
  const layerHeight = number(data, 'layer_height', 0.2, 0.08, maximumLayer);
  const firstLayer = number(data, 'first_layer', 0.2, 0.08, maximumLayer);
  const requestedBase = number(data, 'base', 1, 0.6, 8);
  const requestedRelief = number(data, 'relief', 1, 0.24, 2);
  const baseLayers = Math.max(1, Math.ceil((requestedBase - firstLayer) / layerHeight - 1e-8) + 1);
  const qrLayers = Math.max(2, Math.ceil(requestedRelief / layerHeight - 1e-8));
  const base = round(firstLayer + (baseLayers - 1) * layerHeight);
  const relief = round(qrLayers * layerHeight);
  const warnings = [];
  if (Math.abs(base - requestedBase) > 1e-6 || Math.abs(relief - requestedRelief) > 1e-6) {
    warnings.push(`Heights rounded up to complete layers: ${formatNumber(base)} mm base + ${formatNumber(relief)} mm QR.`);
  }
  const correction = data.correction || 'M';
  if (!['M', 'Q', 'H'].includes(correction)) throw new InputError('Error correction must be M, Q, or H.');
  const treatment = data.treatment || 'raised';
  if (!['raised', 'inset'].includes(treatment)) throw new InputError('QR treatment must be raised or inset.');
  if (treatment === 'inset') {
    warnings.push('Inset mode uses an inverted light-on-dark QR. Test the physical token with every phone that must scan it.');
  }
  let qr;
  try {
    qr = QRCode.create(url, { errorCorrectionLevel: correction });
  } catch {
    throw new InputError('This URL is too long for a QR code.');
  }
  const modules = qr.modules.size;
  const matrix = Array.from({ length: modules }, (_, row) =>
    Array.from({ length: modules }, (_, column) => Boolean(qr.modules.get(row, column))));
  const minimumModule = Math.max(0.6, nozzle * 2);
  const minimumDiameter = Math.ceil(SQRT2 * (modules + 8) * minimumModule + 2);
  if (minimumDiameter > 200) {
    throw new InputError(`This URL needs a token over 200 mm across for a ${formatNumber(nozzle)} mm nozzle. Shorten the URL.`);
  }
  const diameter = Math.max(requestedDiameter, minimumDiameter);
  if (diameter > profile.max_diameter) {
    throw new InputError(`This QR needs a ${formatNumber(diameter)} mm token, but this bed allows ${formatNumber(profile.max_diameter)} mm with prime-tower clearance. Shorten the URL.`);
  }
  if (diameter > requestedDiameter) {
    warnings.push(`Diameter increased to ${formatNumber(minimumDiameter)} mm so every QR module is printable with a ${formatNumber(nozzle)} mm nozzle.`);
  }
  const moduleSize = (diameter - 2) / (SQRT2 * (modules + 8));
  if (moduleSize < 1.2) warnings.push(`QR modules are ${moduleSize.toFixed(2)} mm wide. Print a scan test; 1.2 mm or larger is more forgiving.`);
  const baseColor = color(data, 'base_color', '#F5F0E5');
  const qrColor = color(data, 'qr_color', '#181818');
  const light = luminance(baseColor);
  const dark = luminance(qrColor);
  if (light <= dark || (light + 0.05) / (dark + 0.05) < 4.5) {
    throw new InputError('Use a light base and a dark QR with stronger contrast.');
  }
  const filaments = ['base_filament', 'qr_filament'].map((key, index) => {
    const slot = number(data, key, index + 1, 1, profile.filament_count);
    if (!Number.isInteger(slot)) throw new InputError('Filament numbers must be whole numbers.');
    return slot;
  });
  if (filaments[0] === filaments[1]) throw new InputError('Base and QR must use different project filaments.');
  return {
    url,
    diameter,
    minimum_diameter: minimumDiameter,
    base,
    relief,
    height: round(base + relief),
    layer_height: layerHeight,
    first_layer: firstLayer,
    base_layers: baseLayers,
    qr_layers: qrLayers,
    change_layer: baseLayers + 1,
    change_z: round(base + layerHeight),
    modules,
    module_size: moduleSize,
    quiet_modules: 4,
    matrix,
    base_color: baseColor,
    qr_color: qrColor,
    base_filament: filaments[0],
    qr_filament: filaments[1],
    warnings,
    correction,
    treatment,
    scan_verified: false,
  };
}

function requiredEntry(archive, name, maximum = 4_000_000) {
  const value = archive[name];
  if (!value || value.length > maximum) throw new InputError('Choose a Bambu Studio project 3MF containing printer settings.');
  return value;
}

export function parseTemplate(bytes, name = 'Bambu project') {
  let archive;
  try {
    const required = new Set(['3D/3dmodel.model', 'Metadata/project_settings.config']);
    archive = unzipSync(bytes, { filter: file => required.has(file.name) && file.originalSize <= 4_000_000 });
  } catch {
    throw new InputError('Choose a valid Bambu Studio project 3MF.');
  }
  const modelText = strFromU8(requiredEntry(archive, '3D/3dmodel.model'));
  if (/<!DOCTYPE|<!ENTITY/i.test(modelText)) throw new InputError('XML entities are not supported in templates.');
  let settings;
  try {
    settings = JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/project_settings.config')));
  } catch {
    throw new InputError('Choose a Bambu Studio project 3MF containing printer settings.');
  }
  const application = modelText.match(/<metadata\s+name=["']Application["']>([^<]+)<\/metadata>/i)?.[1] || '';
  const filamentSettings = settings.filament_settings_id;
  if (!application.startsWith('BambuStudio-') || !Array.isArray(filamentSettings) || filamentSettings.length < 2 || filamentSettings.length > 16) {
    throw new InputError('Save this template as a project in Bambu Studio with 2 to 16 filaments first.');
  }
  const nozzle = Number(settings.nozzle_diameter?.[0]);
  const points = settings.printable_area?.map(point => String(point).trim().split('x').map(Number));
  if (!Number.isFinite(nozzle) || nozzle < 0.2 || nozzle > 0.8 || !Array.isArray(points) || points.length < 4 || points.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value)))) {
    throw new InputError('Template is missing a supported nozzle size or bed outline.');
  }
  const materialTypes = settings.filament_type || ['PLA'];
  if (materialTypes.some(type => type !== materialTypes[0])) throw new InputError('Use the same material type for all template filaments, such as PLA.');
  const template = { application, settings, nozzle, points, filament_count: filamentSettings.length };
  return { template, profile: profileInfo(template, name) };
}

export function bedGeometry(template) {
  const xs = template.points.map(point => point[0]);
  const ys = template.points.map(point => point[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const width = maximumX - minimumX;
  const depth = maximumY - minimumY;
  const center = [(minimumX + maximumX) / 2, (minimumY + maximumY) / 2];
  return {
    width,
    depth,
    center,
    points: template.points.map(([x, y]) => [round(x - center[0]), round(y - center[1])]),
    max_diameter: Math.max(0, Math.min(width, depth) - 60),
  };
}

export function profileInfo(template, name = 'Bambu project') {
  const settings = template.settings;
  const geometry = bedGeometry(template);
  return {
    name,
    printer: settings.printer_model || 'Bambu Lab',
    printer_preset: settings.printer_settings_id || '',
    nozzle: template.nozzle,
    filaments: settings.filament_settings_id,
    filament_count: template.filament_count,
    bed: settings.curr_bed_type || '',
    bed_width: geometry.width,
    bed_depth: geometry.depth,
    bed_points: geometry.points,
    max_diameter: geometry.max_diameter,
    application: template.application,
  };
}

export function buildMesh(module, token) {
  const { Manifold, CrossSection } = module;
  const base = Manifold.cylinder(token.base, token.diameter / 2, -1, 256);
  const outlines = [];
  const offset = token.modules * token.module_size / 2;
  for (let row = 0; row < token.modules; row++) {
    let column = 0;
    while (column < token.modules) {
      if (!token.matrix[row][column]) {
        column++;
        continue;
      }
      const start = column;
      while (column < token.modules && token.matrix[row][column]) column++;
      const width = (column - start) * token.module_size;
      const height = token.module_size;
      const chamfer = 0.01;
      const x = start * token.module_size - offset;
      const y = offset - (row + 1) * token.module_size;
      outlines.push([
        [x + chamfer, y], [x + width - chamfer, y], [x + width, y + chamfer],
        [x + width, y + height - chamfer], [x + width - chamfer, y + height],
        [x + chamfer, y + height], [x, y + height - chamfer], [x, y + chamfer],
      ].map(point => point.map(value => round(value))));
    }
  }
  const overlap = Math.min(0.02, token.first_layer / 4);
  const crossSection = new CrossSection(outlines);
  let printableSection = crossSection;
  let circle;
  if (token.treatment === 'inset') {
    circle = CrossSection.circle(token.diameter / 2, 256);
    printableSection = circle.subtract(crossSection);
  }
  const relief = printableSection.extrude(token.relief + overlap).translate([0, 0, token.base - overlap]);
  const solid = base.add(relief);
  try {
    if (solid.status() !== 'NoError' || solid.isEmpty() || solid.volume() <= 0) throw new Error('Geometry construction failed.');
    const raw = solid.getMesh();
    const vertices = new Float32Array(raw.vertProperties);
    const triangles = new Uint32Array(raw.triVerts);
    const bounds = solid.boundingBox();
    if (triangles.length === 0 || Math.abs(bounds.min[2]) > 1e-5 || Math.abs(bounds.max[2] - token.height) > 1e-4) {
      throw new Error('Geometry failed its solid bounds check.');
    }
    return { vertices, triangles, volume: solid.volume(), bounds };
  } finally {
    solid.delete();
    relief.delete();
    if (printableSection !== crossSection) printableSection.delete();
    circle?.delete();
    crossSection.delete();
    base.delete();
  }
}

export function encodeBinaryStl(mesh) {
  const triangleCount = mesh.triangles.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = encoder.encode('QR Token Studio watertight solid');
  new Uint8Array(buffer, 0, header.length).set(header);
  view.setUint32(80, triangleCount, true);
  const position = index => [mesh.vertices[index * 3], mesh.vertices[index * 3 + 1], mesh.vertices[index * 3 + 2]];
  let offset = 84;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const a = position(mesh.triangles[triangle * 3]);
    const b = position(mesh.triangles[triangle * 3 + 1]);
    const c = position(mesh.triangles[triangle * 3 + 2]);
    const u = b.map((value, index) => value - a[index]);
    const v = c.map((value, index) => value - a[index]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) || 1;
    for (const value of normal.map(component => component / length)) { view.setFloat32(offset, value, true); offset += 4; }
    for (const point of [a, b, c]) for (const value of point) { view.setFloat32(offset, value, true); offset += 4; }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function preparedSettings(template, token) {
  const settings = structuredClone(template.settings);
  const count = template.filament_count;
  const colors = [...(settings.filament_colour || [])];
  while (colors.length < count) colors.push('#FFFFFF');
  colors.length = count;
  colors[token.base_filament - 1] = token.base_color;
  colors[token.qr_filament - 1] = token.qr_color;
  settings.filament_colour = colors;
  settings.default_filament_colour = [...colors];
  settings.filament_is_mixed = Array(count).fill('0');
  settings.filament_multi_colour = [...colors];
  settings.filament_map = Array(count).fill('1');
  settings.filament_map_2 = Array(count).fill('1');
  settings.filament_nozzle_map = Array(count).fill('1');
  settings.single_extruder_multi_material = '1';
  settings.layer_height = formatNumber(token.layer_height);
  settings.initial_layer_print_height = formatNumber(token.first_layer);
  settings.sparse_infill_density = '100%';
  settings.sparse_infill_pattern = 'zig-zag';
  settings.wall_loops = '2';
  settings.top_one_wall_type = 'not apply';
  settings.top_shell_layers = '4';
  settings.bottom_shell_layers = '3';
  settings.enable_support = '0';
  settings.spiral_mode = '0';
  settings.print_sequence = 'by layer';
  settings.brim_type = 'no_brim';
  settings.enable_prime_tower = '1';
  settings.wall_generator = 'arachne';
  settings.from = 'project';
  settings.name = 'project_settings';
  const blocks = Math.max(1, settings.nozzle_diameter?.length || 1);
  const expected = count * count * blocks;
  let matrix = Array.isArray(settings.flush_volumes_matrix) && settings.flush_volumes_matrix.length === expected
    ? settings.flush_volumes_matrix.map(String)
    : Array.from({ length: expected }, (_, index) => index % (count + 1) === 0 ? '0' : '600');
  for (let block = 0; block < blocks; block++) {
    const index = block * count * count + (token.base_filament - 1) * count + token.qr_filament - 1;
    matrix[index] = String(Math.max(280, Number(matrix[index]) || 0));
  }
  settings.flush_volumes_matrix = matrix;
  settings.wipe_tower_x = ['18'];
  settings.wipe_tower_y = ['18'];
  return settings;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function metadata(key, value) {
  return `<metadata key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`;
}

function meshXml(mesh) {
  let vertices = '';
  for (let index = 0; index < mesh.vertices.length; index += 3) {
    vertices += `<vertex x="${formatNumber(mesh.vertices[index], 9)}" y="${formatNumber(mesh.vertices[index + 1], 9)}" z="${formatNumber(mesh.vertices[index + 2], 9)}"/>`;
  }
  let triangles = '';
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    triangles += `<triangle v1="${mesh.triangles[index]}" v2="${mesh.triangles[index + 1]}" v3="${mesh.triangles[index + 2]}"/>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build/></model>`;
}

function formatNumber(value, significant = 12) {
  if (Number.isInteger(value)) return String(value);
  return Number(value).toPrecision(significant).replace(/(?:\.0+|(\.\d+?)0+)(e|$)/, '$1$2');
}

export async function tokenFilename(token) {
  const host = new URL(token.url).hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 48) || 'token';
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token.url)));
  const suffix = [...hash.slice(0, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  return `qr-${host}-${suffix}`;
}

export function encodeBambu3mf(template, profile, token, mesh, filename, pngBytes) {
  if (token.diameter > profile.max_diameter) throw new InputError(`Token is too large for this bed with prime-tower clearance. Maximum diameter: ${formatNumber(profile.max_diameter)} mm.`);
  const [centerX, centerY] = bedGeometry(template).center;
  const triangleCount = mesh.triangles.length / 3;
  const settings = preparedSettings(template, token);
  const date = new Date().toISOString().slice(0, 10);
  const partName = token.treatment === 'inset' ? 'Base and inset QR field' : 'Base and raised QR';
  const rootModel = `<?xml version="1.0" encoding="utf-8"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" unit="millimeter" requiredextensions="p"><metadata name="Application">${xmlEscape(template.application)}</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Title">${xmlEscape(filename)}</metadata><metadata name="CreationDate">${date}</metadata><metadata name="Description">QR Token Studio ${token.treatment} treatment. Change before layer ${token.change_layer}, top Z ${formatNumber(token.change_z)} mm.</metadata><resources><object id="2" type="model"><components><component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources><build><item objectid="2" printable="1" transform="1 0 0 0 1 0 0 0 1 ${formatNumber(centerX)} ${formatNumber(centerY)} 0"/></build></model>`;
  const modelSettings = `<?xml version="1.0" encoding="utf-8"?><config><object id="2">${metadata('name', filename)}${metadata('extruder', token.base_filament)}<metadata face_count="${triangleCount}"/><part id="1" subtype="normal_part">${metadata('name', partName)}${metadata('matrix', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1')}<mesh_stat face_count="${triangleCount}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part></object><plate>${metadata('plater_id', 1)}${metadata('plater_name', 'QR Token')}${metadata('locked', 'false')}${metadata('filament_map_mode', 'Manual')}${metadata('gcode_file', '')}${metadata('thumbnail_file', 'Metadata/plate_1.png')}<model_instance>${metadata('object_id', 2)}${metadata('instance_id', 0)}${metadata('identify_id', 1)}</model_instance></plate><assemble/></config>`;
  const events = `<?xml version="1.0" encoding="utf-8"?><custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="${formatNumber(token.change_z)}" type="2" extruder="${token.qr_filament}" color="${token.qr_color}" extra="" gcode="tool_change"/><mode value="MultiAsSingle"/></plate></custom_gcodes_per_layer>`;
  const relationships = target => `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/></Types>';
  const report = { ...token, profile, mesh: { watertight: true, triangles: triangleCount, volume_mm3: round(mesh.volume, 3) } };
  delete report.matrix;
  const entries = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships('/3D/3dmodel.model')),
    '3D/_rels/3dmodel.model.rels': strToU8(relationships('/3D/Objects/object_1.model')),
    '3D/3dmodel.model': strToU8(rootModel),
    '3D/Objects/object_1.model': strToU8(meshXml(mesh)),
    'Metadata/project_settings.config': strToU8(JSON.stringify(settings, null, 2)),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/custom_gcode_per_layer.xml': strToU8(events),
    'Metadata/plate_1.png': pngBytes,
    'Metadata/qr_token.json': strToU8(JSON.stringify(report, null, 2)),
  };
  return zipSync(entries, { level: 6 });
}

export function inspect3mf(bytes) {
  const archive = unzipSync(bytes);
  return {
    names: Object.keys(archive).sort(),
    events: strFromU8(requiredEntry(archive, 'Metadata/custom_gcode_per_layer.xml')),
    settings: JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/project_settings.config'))),
    report: JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/qr_token.json'))),
  };
}
