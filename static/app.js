import * as THREE from './vendor/three.module.js';

const $ = id => document.getElementById(id);
const form = $('settings');
const buttons = [
  $('download-3mf'), $('download-menu-toggle'), $('download-3mf-menu'), $('download-stl'), $('download-png'),
];
let session, template = 'default', profile, token, valid = false, exporting = false;
let generation = 0, timer, controller;
const canvas = $('token-canvas');
const viewport = $('viewport');
let renderer, scene, camera, group, bedGroup;
let viewMode = 'detail';
let azimuth = -.55, elevation = .42, distance = 110;
let bedSpan = 256;
let drag = null;

function notice(text, type = '') {
  const el = document.createElement('div');
  el.className = `notice ${type}`;
  el.textContent = text;
  $('messages').append(el);
}
function enableDownloads(enabled) {
  valid = enabled;
  for (const b of buttons) b.disabled = !enabled || exporting;
  if (!enabled) setDownloadMenu(false);
}
function setDownloadMenu(open, focus = false) {
  const toggle = $('download-menu-toggle');
  const menu = $('download-menu');
  const show = Boolean(open && !toggle.disabled);
  menu.hidden = !show;
  toggle.setAttribute('aria-expanded', String(show));
  if (show && focus) $('download-3mf-menu').focus();
}
function values() {
  return { ...Object.fromEntries(new FormData(form)), template };
}
async function post(path, data, signal) {
  const response = await fetch(path, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Token-Studio': session }, body: JSON.stringify(data) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({error: `Request failed (${response.status}).`}));
    throw new Error(error.error || 'The local generator could not complete this request.');
  }
  return response;
}
function updateFields() {
  $('diameter-display').innerHTML = `${Number($('diameter').value)} <small>mm</small>`;
  const shape = $('shape').value;
  $('size-label').textContent = shape === 'circle' ? 'Diameter' : 'Width';
  $('shape-note').textContent = {
    circle: 'The classic round token with the most even edge clearance.',
    square: 'A compact tile that uses the available area efficiently.',
    rectangle: 'A landscape badge with extra room beside the QR field.',
    pentagon: 'A directional marker whose top point is easy to orient.',
    hexagon: 'A durable tile that packs and sorts neatly.',
  }[shape];
  $('corner_style').disabled = shape === 'circle';
  const edgeProfile = $('edge_profile').value;
  $('edge_size').disabled = edgeProfile === 'straight';
  $('edge-note').textContent = {
    straight: 'A clean vertical perimeter with no lower-edge shaping.',
    chamfered: 'A flat lower bevel removes the sharp build-plate edge.',
    rounded: 'A segmented lower radius makes the token more comfortable to handle.',
    inset: 'A crisp recessed foot creates a shadow line around the token.',
    tapered: 'The wall angles inward toward the build plate across the full base thickness.',
  }[edgeProfile];
  const inset = $('treatment').value === 'inset';
  $('relief').min = String(inset ? Math.max(.24, Number($('layer_height').value) * 5) : .24);
  $('relief-label').textContent = inset ? 'Light cover thickness' : 'Raised QR';
  $('qr-filament-label').textContent = inset ? 'Top filament' : 'QR filament';
  $('treatment-note').textContent = inset
    ? 'The dark base shows through the QR openings. After one AMS swap, at least five light layers form an opaque top field.'
    : 'The dark QR rises above the light base and begins immediately after one AMS swap.';
}
function applyDiameterLimits(next) {
  const control = $('diameter');
  const minimum = Math.ceil(next.minimum_diameter);
  const maximum = Math.floor(profile?.max_diameter || 200);
  control.min = String(minimum);
  control.max = String(maximum);
  if (Number(control.value) < minimum || Number(control.value) !== next.diameter) {
    control.value = String(next.diameter);
  }
  $('relief').value = String(next.relief);
  $('diameter-min').textContent = `${minimum} mm minimum`;
  $('diameter-max').textContent = `${maximum} mm maximum`;
  updateFields();
}
function invalidate() {
  enableDownloads(false);
  generation++;
  controller?.abort();
  $('preview-status').hidden = false;
  $('preview-status').textContent = 'Updating preview…';
  $('scan-metric').textContent = 'Updating…';
  updateFields();
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
}
async function refresh() {
  const current = generation;
  controller = new AbortController();
  try {
    const response = await post('/api/preview', values(), controller.signal);
    const next = await response.json();
    if (current !== generation) return;
    token = next;
    applyDiameterLimits(token);
    $('messages').replaceChildren();
    token.warnings.forEach(w => notice(w));
    $('module-metric').textContent = `${token.module_size.toFixed(2)} mm`;
    $('height-metric').textContent = `${token.height.toFixed(2).replace(/0$/, '')} mm`;
    $('scan-metric').textContent = '✓ Verified';
    const width = Number(token.shape_width.toFixed(2));
    const height = Number(token.shape_height.toFixed(2));
    $('dimension-text').textContent = token.shape === 'circle' ? `Ø ${width} mm` : `${width} × ${height} mm`;
    $('swap-title').textContent = `Change before layer ${token.change_layer}`;
    $('base-track').style.flex = token.base_layers;
    $('qr-track').style.flex = token.qr_layers;
    $('base-track').style.background = token.base_color;
    $('qr-track').style.background = token.qr_color;
    $('base-track').style.color = token.treatment === 'inset' ? '#ffffff' : '#20342b';
    $('qr-track').style.color = token.treatment === 'inset' ? '#20342b' : '#ffffff';
    $('base-track-label').textContent = `1–${token.base_layers} · Base`;
    $('qr-track-label').textContent = `${token.change_layer}–${token.base_layers + token.qr_layers} · ${token.treatment === 'inset' ? 'Top field' : 'QR'}`;
    $('swap-description').textContent = token.treatment === 'inset'
      ? `Dark filament ${token.base_filament} → light filament ${token.qr_filament} at Z ${token.change_z} mm. ${token.qr_layers} light layers form the top field around the recessed dark QR. No manual pause.`
      : `Filament ${token.base_filament} → ${token.qr_filament} at Z ${token.change_z} mm (first QR layer). Base ends at ${token.base} mm. No manual pause.`;
    drawScan();
    updateModel();
    $('preview-status').hidden = true;
    canvas.style.opacity = '1';
    $('scan-canvas').style.opacity = '1';
    enableDownloads(true);
  } catch (error) {
    if (error.name === 'AbortError' || current !== generation) return;
    enableDownloads(false);
    $('messages').replaceChildren();
    notice(error.message, 'error');
    $('preview-status').hidden = false;
    $('preview-status').textContent = 'Adjust settings to generate a valid token';
    $('scan-metric').textContent = 'Needs attention';
    canvas.style.opacity = '.2';
    $('scan-canvas').style.opacity = '.2';
  }
}

function drawScan() {
  const target = $('scan-canvas');
  target.width = 900; target.height = 900;
  const ctx = target.getContext('2d');
  ctx.fillStyle = '#E7E8E5';
  ctx.fillRect(0, 0, 900, 900);
  const inset = token.treatment === 'inset';
  const scale = 870 / Math.max(token.shape_width, token.shape_height);
  ctx.fillStyle = inset ? token.qr_color : token.base_color;
  ctx.beginPath();
  token.outline.forEach(([x, y], index) => {
    const px = 450 + x * scale;
    const py = 450 - y * scale;
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath(); ctx.fill();
  const pitch = token.module_size * scale;
  const start = 450 - token.modules * pitch / 2;
  ctx.fillStyle = inset ? token.base_color : token.qr_color;
  token.matrix.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) ctx.fillRect(Math.round(start + c*pitch), Math.round(start + r*pitch),
      Math.round(start+(c+1)*pitch)-Math.round(start+c*pitch),
      Math.round(start+(r+1)*pitch)-Math.round(start+r*pitch));
  }));
}
function setupScene() {
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
  } catch {
    $('view-detail').disabled = true;
    $('view-3d').disabled = true;
    switchView('top');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0xffffff, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, .1, 1000);
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.position.set(-40, 80, 45); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -100; sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100; sun.shadow.camera.bottom = -100;
  sun.shadow.normalBias = .01;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xebf2dc, 1.2);
  fill.position.set(40, 25, -50); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.ShadowMaterial({opacity: .06}));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.18; floor.receiveShadow = true;
  scene.add(floor);
  new ResizeObserver(render).observe(viewport);
  canvas.addEventListener('pointerdown', e => {
    drag = {x: e.clientX, y: e.clientY}; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    azimuth -= (e.clientX - drag.x) * .008;
    elevation = Math.max(.12, Math.min(1.55, elevation + (e.clientY-drag.y)*.008));
    drag = {x: e.clientX, y: e.clientY}; render();
  });
  canvas.addEventListener('pointerup', () => {drag = null;});
  canvas.addEventListener('pointercancel', () => {drag = null;});
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const minimum = viewMode === 'detail' && token ? token.diameter * 1.25 : bedSpan * .75;
    distance = Math.max(minimum, Math.min(bedSpan*3.2, distance * (e.deltaY > 0 ? 1.08 : .92)));
    render();
  }, {passive: false});
}
function disposeGroup(current) {
  if (!current) return;
  current.traverse(obj => {
    obj.geometry?.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach(material => material.dispose());
    else obj.material?.dispose();
  });
  scene.remove(current);
}
function updateBed() {
  if (!renderer || !profile?.bed_points?.length) return;
  disposeGroup(bedGroup);
  bedGroup = new THREE.Group();
  const shape = new THREE.Shape();
  profile.bed_points.forEach(([x, z], index) => {
    if (index === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  });
  shape.closePath();
  const plate = new THREE.Mesh(new THREE.ShapeGeometry(shape),
    new THREE.MeshStandardMaterial({color: 0xdde2d7, roughness: .95, metalness: .04, side: THREE.DoubleSide}));
  plate.rotation.x = -Math.PI/2; plate.position.y = -.08; plate.receiveShadow = true;
  bedGroup.add(plate);

  const borderPoints = profile.bed_points.map(([x, z]) => new THREE.Vector3(x, -.055, -z));
  borderPoints.push(borderPoints[0].clone());
  const border = new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPoints),
    new THREE.LineBasicMaterial({color: 0x899687}));
  bedGroup.add(border);

  const halfWidth = profile.bed_width/2, halfDepth = profile.bed_depth/2;
  const gridPoints = [];
  for (let x = Math.ceil(-halfWidth/20)*20; x < halfWidth; x += 20) {
    gridPoints.push(new THREE.Vector3(x, -.05, -halfDepth), new THREE.Vector3(x, -.05, halfDepth));
  }
  for (let z = Math.ceil(-halfDepth/20)*20; z < halfDepth; z += 20) {
    gridPoints.push(new THREE.Vector3(-halfWidth, -.05, z), new THREE.Vector3(halfWidth, -.05, z));
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints),
    new THREE.LineBasicMaterial({color: 0xbcc5b8, transparent: true, opacity: .5}));
  bedGroup.add(grid);
  scene.add(bedGroup);
  bedSpan = Math.max(profile.bed_width, profile.bed_depth);
  if (viewMode === 'bed') distance = bedSpan*1.68;
  $('bed-reference').textContent = `${profile.printer.replace('Bambu Lab ', '')} BED · ${profile.bed_width} × ${profile.bed_depth} MM`;
  render();
}
function updateModel() {
  if (!renderer) return;
  disposeGroup(group);
  group = new THREE.Group();
  const makeTokenShape = () => {
    const shape = new THREE.Shape();
    token.outline.forEach(([x, y], index) => {
      if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
    shape.closePath();
    return shape;
  };
  const createBaseGeometry = () => {
    const points = token.outline.map(([x, y]) => new THREE.Vector2(x, y));
    const triangles = THREE.ShapeUtils.triangulateShape(points, []);
    const positions = [];
    const indices = [];
    for (const [height, inset] of token.edge_slices) {
      const scaleX = (token.shape_width - 2 * inset) / token.shape_width;
      const scaleY = (token.shape_height - 2 * inset) / token.shape_height;
      token.outline.forEach(([x, y]) => positions.push(x * scaleX, height, -y * scaleY));
    }
    const count = token.outline.length;
    triangles.forEach(([a, b, c]) => {
      indices.push(c, b, a);
      const top = (token.edge_slices.length - 1) * count;
      indices.push(top + a, top + b, top + c);
    });
    for (let slice = 0; slice < token.edge_slices.length - 1; slice++) {
      const lower = slice * count;
      const upper = (slice + 1) * count;
      for (let point = 0; point < count; point++) {
        const next = (point + 1) % count;
        indices.push(lower + point, lower + next, upper + next, lower + point, upper + next, upper + point);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };
  const base = new THREE.Mesh(createBaseGeometry(),
    new THREE.MeshStandardMaterial({color: token.base_color, roughness: .8, metalness: 0}));
  base.castShadow = true; base.receiveShadow = true; group.add(base);
  const inset = token.treatment === 'inset';
  const offset = token.modules*token.module_size/2;
  if (inset) {
    const topShape = makeTokenShape();
    const hole = new THREE.Path();
    hole.moveTo(-offset, -offset); hole.lineTo(-offset, offset);
    hole.lineTo(offset, offset); hole.lineTo(offset, -offset); hole.closePath();
    topShape.holes.push(hole);
    const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(topShape, {depth: token.relief, bevelEnabled: false, curveSegments: 192}),
      new THREE.MeshStandardMaterial({color: token.qr_color, roughness: .92}));
    ring.rotation.x = -Math.PI/2; ring.position.y = token.base;
    ring.castShadow = true; ring.receiveShadow = true; group.add(ring);
  }
  const count = token.matrix.flat().filter(value => inset ? !value : value).length;
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(token.module_size, token.relief, token.module_size),
    new THREE.MeshStandardMaterial({color: token.qr_color, roughness: .92}), count);
  const transform = new THREE.Matrix4();
  let i = 0;
  token.matrix.forEach((row, r) => row.forEach((dark, c) => {
    if (inset ? !dark : dark) {
      transform.makeTranslation((c+.5)*token.module_size-offset,
        token.base+token.relief/2, (r+.5)*token.module_size-offset);
      blocks.setMatrixAt(i++, transform);
    }
  }));
  blocks.castShadow = true; blocks.receiveShadow = true; group.add(blocks);
  scene.add(group);
  distance = viewMode === 'detail' ? Math.max(token.diameter * 1.85, 90) : bedSpan * 1.68;
  updateViewLabels();
  render();
}
function render() {
  if (!renderer) return;
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width/height;
  camera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation),
    distance*Math.cos(elevation)*Math.cos(azimuth));
  camera.lookAt(0, token ? token.height/2 : 0, 0);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
function switchView(view) {
  const top = view === 'top';
  viewMode = view;
  if (view === 'detail') {
    azimuth = -.55; elevation = .42;
    distance = token ? Math.max(token.diameter * 1.85, 90) : 110;
  } else if (view === 'bed') {
    azimuth = -.2; elevation = 1.03; distance = bedSpan * 1.68;
  }
  canvas.hidden = top; $('scan-canvas').hidden = !top; $('orbit-hint').hidden = top;
  $('bed-reference').hidden = top;
  for (const mode of ['detail', '3d', 'top']) {
    const active = mode === (view === 'bed' ? '3d' : view);
    $(`view-${mode}`).classList.toggle('active', active);
    $(`view-${mode}`).setAttribute('aria-pressed', String(active));
  }
  updateViewLabels();
  render();
}
function updateViewLabels() {
  if (!profile || !token || viewMode === 'top') return;
  if (viewMode === 'detail') {
    const edge = token.edge_profile === 'straight' ? '' : ` · ${token.edge_profile.toUpperCase()} EDGE`;
    $('bed-reference').textContent = `${token.shape.toUpperCase()} ${token.treatment.toUpperCase()} · ${token.relief} MM ${token.treatment === 'inset' ? 'DEEP' : 'HIGH'}${edge}`;
    $('orbit-hint').textContent = 'TRUE DEPTH · DRAG TO ROTATE · SCROLL TO ZOOM';
  } else {
    $('bed-reference').textContent = `${profile.printer.replace('Bambu Lab ', '')} BED · ${profile.bed_width} × ${profile.bed_depth} MM`;
    $('orbit-hint').textContent = 'DRAG TO ROTATE · SCROLL TO ZOOM';
  }
}
function showProfile(next) {
  profile = next;
  $('printer-name').textContent = `${profile.printer} · ${profile.nozzle} mm`;
  $('profile-detail').textContent = `${profile.filament_count} project filaments · ${profile.bed}`;
  for (const id of ['base_filament', 'qr_filament']) {
    const select = $(id); select.replaceChildren();
    profile.filaments.forEach((name, i) => select.add(new Option(`Filament ${i+1}`, String(i+1))));
  }
  $('qr_filament').value = '2';
  $('diameter').max = String(Math.floor(profile.max_diameter));
  $('diameter-max').textContent = `${Math.floor(profile.max_diameter)} mm maximum`;
  const maxLayer = Math.min(.3, profile.nozzle*.75);
  for (const id of ['layer_height', 'first_layer']) {
    const select = $(id);
    for (const opt of select.options) opt.disabled = Number(opt.value)>maxLayer;
    if (Number(select.value)>maxLayer) select.value = '0.12';
  }
  updateBed();
}
async function download(kind) {
  if (!valid || exporting) return;
  setDownloadMenu(false);
  exporting = true; buttons.forEach(b => {b.disabled = true;});
  $('download-3mf').firstElementChild.textContent = 'Building watertight geometry…';
  const data = values();
  try {
    const response = await post(`/api/export/${kind}`, data);
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] || `qr-token.${kind}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    notice(kind === '3mf' ? 'Bambu project downloaded with the automatic filament change included.' : `${kind.toUpperCase()} downloaded.${kind === 'stl' ? ' The layer change is included only in the 3MF export.' : ''}`, 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    exporting = false;
    buttons.forEach(b => {b.disabled = !valid;});
    $('download-3mf').firstElementChild.textContent = 'Download Bambu 3MF';
  }
}

form.addEventListener('submit', e => {e.preventDefault();});
form.addEventListener('input', e => {if (e.target.id !== 'template-file') invalidate();});
$('view-detail').addEventListener('click', () => switchView('detail'));
$('view-3d').addEventListener('click', () => switchView('bed'));
$('view-top').addEventListener('click', () => switchView('top'));
$('download-3mf').addEventListener('click', () => download('3mf'));
$('download-3mf-menu').addEventListener('click', () => download('3mf'));
$('download-stl').addEventListener('click', () => download('stl'));
$('download-png').addEventListener('click', () => download('png'));
$('download-menu-toggle').addEventListener('click', event => {
  event.stopPropagation();
  const open = $('download-menu').hidden;
  setDownloadMenu(open, open);
});
$('download-menu-toggle').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setDownloadMenu(true, true);
  }
});
$('download-menu').addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', () => setDownloadMenu(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('download-menu').hidden) {
    setDownloadMenu(false);
    $('download-menu-toggle').focus();
  }
});
$('template-file').addEventListener('change', async () => {
  const file = $('template-file').files[0];
  if (!file) return;
  if (file.size > 32*1024*1024) {notice('Choose a template smaller than 32 MB.', 'error'); return;}
  generation++;
  controller?.abort();
  clearTimeout(timer);
  enableDownloads(false);
  try {
    const body = new FormData(); body.append('file', file);
    const response = await fetch('/api/template', {method: 'POST', headers: {'X-Token-Studio': session}, body});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    template = result.template; showProfile(result.profile);
    $('reset-profile').hidden = false; invalidate();
  } catch (error) {await refresh(); notice(error.message, 'error');}
});
$('reset-profile').addEventListener('click', async () => {
  const result = await (await fetch('/api/config')).json();
  session = result.session; template = 'default'; showProfile(result.profile);
  $('reset-profile').hidden = true; $('template-file').value = ''; invalidate();
});

setupScene();
try {
  const result = await (await fetch('/api/config')).json();
  session = result.session; showProfile(result.profile);
  updateFields(); await refresh();
} catch (error) {
  notice(`Could not connect to the local generator: ${error.message}`, 'error');
  $('preview-status').textContent = 'Local server is unavailable';
}
