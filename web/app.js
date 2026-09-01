import * as THREE from './vendor/three.module.js';
import ManifoldModule from 'manifold-3d';
import jsQR from 'jsqr';
import {
  buildMesh,
  createToken,
  encodeBambu3mf,
  encodeBinaryStl,
  parseTemplate,
  tokenFilename,
} from './core.js';

const $ = id => document.getElementById(id);
const form = $('settings');
const buttons = [$('download-3mf'), $('download-stl'), $('download-png')];
let template, defaultTemplateBytes, profile, token, valid = false, exporting = false;
let generation = 0, timer;
const canvas = $('token-canvas');
const viewport = $('viewport');
let renderer, scene, camera, group, bedGroup;
let azimuth = -.2, elevation = 1.03, distance = 100;
let bedSpan = 256;
let drag = null;
const manifoldReady = ManifoldModule({ locateFile: name => new URL(name, import.meta.url).href }).then(module => {
  module.setup();
  return module;
});

function notice(text, type = '') {
  const el = document.createElement('div');
  el.className = `notice ${type}`;
  el.textContent = text;
  $('messages').append(el);
}
function enableDownloads(enabled) {
  valid = enabled;
  for (const b of buttons) b.disabled = !enabled || exporting;
}
function values() {
  return Object.fromEntries(new FormData(form));
}
function updateFields() {
  $('diameter-display').innerHTML = `${Number($('diameter').value)} <small>mm</small>`;
  $('base-hex').textContent = $('base_color').value.toUpperCase();
  $('qr-hex').textContent = $('qr_color').value.toUpperCase();
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
  $('diameter-min').textContent = `${minimum} mm minimum`;
  $('diameter-max').textContent = `${maximum} mm maximum`;
  updateFields();
}
function invalidate() {
  enableDownloads(false);
  generation++;
  $('preview-status').hidden = false;
  $('preview-status').textContent = 'Updating preview…';
  $('scan-metric').textContent = 'Updating…';
  updateFields();
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
}
async function refresh() {
  const current = generation;
  try {
    const next = createToken(values(), profile);
    if (current !== generation) return;
    token = next;
    applyDiameterLimits(token);
    $('messages').replaceChildren();
    token.warnings.forEach(w => notice(w));
    $('module-metric').textContent = `${token.module_size.toFixed(2)} mm`;
    $('height-metric').textContent = `${token.height.toFixed(2).replace(/0$/, '')} mm`;
    $('scan-metric').textContent = '✓ Verified';
    $('dimension-text').textContent = `Ø ${token.diameter} mm`;
    $('swap-title').textContent = `Change before layer ${token.change_layer}`;
    $('base-track').style.flex = token.base_layers;
    $('qr-track').style.flex = token.qr_layers;
    $('base-track').style.background = token.base_color;
    $('qr-track').style.background = token.qr_color;
    $('base-track-label').textContent = `1–${token.base_layers} · Base`;
    $('qr-track-label').textContent = `${token.change_layer}–${token.base_layers + token.qr_layers} · QR`;
    $('swap-description').textContent = `Filament ${token.base_filament} → ${token.qr_filament} at Z ${token.change_z} mm (first QR layer). Base ends at ${token.base} mm. No manual pause.`;
    drawScan();
    const scanContext = $('scan-canvas').getContext('2d', { willReadFrequently: true });
    const scan = jsQR(scanContext.getImageData(0, 0, $('scan-canvas').width, $('scan-canvas').height).data,
      $('scan-canvas').width, $('scan-canvas').height, { inversionAttempts: 'dontInvert' });
    if (!scan || scan.data !== token.url) throw new Error('The preview failed its independent QR scan check. Increase size or contrast.');
    token.scan_verified = true;
    updateModel();
    $('preview-status').hidden = true;
    canvas.style.opacity = '1';
    $('scan-canvas').style.opacity = '1';
    enableDownloads(true);
  } catch (error) {
    if (current !== generation) return;
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
  const ctx = target.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#E7E8E5';
  ctx.fillRect(0, 0, 900, 900);
  ctx.fillStyle = token.base_color;
  ctx.beginPath(); ctx.arc(450, 450, 435, 0, Math.PI * 2); ctx.fill();
  const pitch = token.module_size * 870 / token.diameter;
  const start = 450 - token.modules * pitch / 2;
  ctx.fillStyle = token.qr_color;
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
  scene.add(new THREE.AmbientLight(0xffffff, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(-40, 80, 45); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -100; sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100; sun.shadow.camera.bottom = -100;
  sun.shadow.normalBias = .08;
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
    distance = Math.max(bedSpan*.75, Math.min(bedSpan*3.2, distance * (e.deltaY > 0 ? 1.08 : .92)));
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
  distance = bedSpan*1.68;
  $('bed-reference').textContent = `${profile.printer.replace('Bambu Lab ', '')} BED · ${profile.bed_width} × ${profile.bed_depth} MM`;
  render();
}
function updateModel() {
  if (!renderer) return;
  disposeGroup(group);
  group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(token.diameter/2, token.diameter/2, token.base, 192),
    new THREE.MeshStandardMaterial({color: token.base_color, roughness: .8, metalness: 0}));
  base.position.y = token.base/2; base.castShadow = true; base.receiveShadow = true; group.add(base);
  const count = token.matrix.flat().filter(Boolean).length;
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(token.module_size, token.relief, token.module_size),
    new THREE.MeshStandardMaterial({color: token.qr_color, roughness: .92}), count);
  const transform = new THREE.Matrix4();
  const offset = token.modules*token.module_size/2;
  let i = 0;
  token.matrix.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) {
      transform.makeTranslation((c+.5)*token.module_size-offset,
        token.base+token.relief/2, (r+.5)*token.module_size-offset);
      blocks.setMatrixAt(i++, transform);
    }
  }));
  blocks.castShadow = true; blocks.receiveShadow = true; group.add(blocks);
  scene.add(group);
  distance = bedSpan * 1.68;
  render();
}
function render() {
  if (!renderer) return;
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width/height;
  camera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation),
    distance*Math.cos(elevation)*Math.cos(azimuth));
  camera.lookAt(0, token ? token.base/2 : 0, 0);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
function switchView(view) {
  const top = view === 'top';
  canvas.hidden = top; $('scan-canvas').hidden = !top; $('orbit-hint').hidden = top;
  $('bed-reference').hidden = top;
  $('view-3d').classList.toggle('active', !top); $('view-top').classList.toggle('active', top);
  $('view-3d').setAttribute('aria-pressed', String(!top)); $('view-top').setAttribute('aria-pressed', String(top));
  render();
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
  exporting = true; buttons.forEach(b => {b.disabled = true;});
  $('download-3mf').firstElementChild.textContent = kind === 'png' ? 'Preparing preview…' : 'Building watertight geometry…';
  try {
    const filename = await tokenFilename(token);
    const pngBlob = await canvasBlob($('scan-canvas'), 'image/png');
    let blob;
    if (kind === 'png') {
      blob = pngBlob;
    } else {
      const module = await manifoldReady;
      const mesh = buildMesh(module, token);
      if (kind === 'stl') {
        blob = new Blob([encodeBinaryStl(mesh)], { type: 'model/stl' });
      } else {
        const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
        blob = new Blob([encodeBambu3mf(template, profile, token, mesh, filename, pngBytes)], { type: 'model/3mf' });
      }
    }
    saveBlob(blob, `${filename}.${kind}`);
    notice(kind === '3mf' ? 'Bambu project downloaded with the automatic filament change included.' : `${kind.toUpperCase()} downloaded.${kind === 'stl' ? ' The layer change is included only in the 3MF export.' : ''}`, 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    exporting = false;
    buttons.forEach(b => {b.disabled = !valid;});
    $('download-3mf').firstElementChild.textContent = 'Download Bambu 3MF';
  }
}

function canvasBlob(source, type) {
  return new Promise((resolve, reject) => source.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the preview image.')), type));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

form.addEventListener('submit', e => {e.preventDefault();});
form.addEventListener('input', e => {if (e.target.id !== 'template-file') invalidate();});
$('view-3d').addEventListener('click', () => switchView('3d'));
$('view-top').addEventListener('click', () => switchView('top'));
for (const kind of ['3mf', 'stl', 'png']) $(`download-${kind}`).addEventListener('click', () => download(kind));
$('template-file').addEventListener('change', async () => {
  const file = $('template-file').files[0];
  if (!file) return;
  if (file.size > 32*1024*1024) {notice('Choose a template smaller than 32 MB.', 'error'); return;}
  generation++;
  clearTimeout(timer);
  enableDownloads(false);
  try {
    const result = parseTemplate(new Uint8Array(await file.arrayBuffer()), file.name);
    template = result.template;
    showProfile(result.profile);
    $('reset-profile').hidden = false; invalidate();
  } catch (error) {
    await refresh();
    notice(error.message, 'error');
  }
});
$('reset-profile').addEventListener('click', async () => {
  const result = parseTemplate(defaultTemplateBytes, 'X2D · 0.4 mm · PLA Matte');
  template = result.template;
  showProfile(result.profile);
  $('reset-profile').hidden = true; $('template-file').value = ''; invalidate();
});

setupScene();
try {
  const [response] = await Promise.all([fetch('./profiles/x2d-04-pla.3mf'), manifoldReady]);
  if (!response.ok) throw new Error(`profile request failed (${response.status})`);
  defaultTemplateBytes = new Uint8Array(await response.arrayBuffer());
  const result = parseTemplate(defaultTemplateBytes, 'X2D · 0.4 mm · PLA Matte');
  template = result.template;
  showProfile(result.profile);
  updateFields(); await refresh();
} catch (error) {
  notice(`Could not start the browser generator: ${error.message}`, 'error');
  $('preview-status').textContent = 'Browser generator is unavailable';
}
