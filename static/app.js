import * as THREE from './vendor/three.module.js';

const $ = id => document.getElementById(id);
const form = $('settings');
const buttons = [$('download-3mf'), $('download-stl'), $('download-png')];
let session, template = 'default', profile, token, valid = false, exporting = false;
let generation = 0, timer, controller;
const canvas = $('token-canvas');
const viewport = $('viewport');
let renderer, scene, camera, group;
let azimuth = -.2, elevation = 1.03, distance = 100;
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
  $('base-hex').textContent = $('base_color').value.toUpperCase();
  $('qr-hex').textContent = $('qr_color').value.toUpperCase();
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
  ctx.clearRect(0, 0, 900, 900);
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
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({opacity: .10}));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.04; floor.receiveShadow = true;
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
    const d = token?.diameter || 60;
    distance = Math.max(d*1.4, Math.min(d*5, distance * (e.deltaY > 0 ? 1.08 : .92)));
    render();
  }, {passive: false});
}
function updateModel() {
  if (!renderer) return;
  if (group) {
    group.traverse(obj => {obj.geometry?.dispose(); obj.material?.dispose();});
    scene.remove(group);
  }
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
  distance = token.diameter * 2.25;
  render();
}
function render() {
  if (!renderer) return;
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width/height;
  camera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation),
    distance*Math.cos(elevation)*Math.cos(azimuth));
  camera.lookAt(0, token?.base || 0, 0);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
function switchView(view) {
  const top = view === 'top';
  canvas.hidden = top; $('scan-canvas').hidden = !top; $('orbit-hint').hidden = top;
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
  const maxLayer = Math.min(.3, profile.nozzle*.75);
  for (const id of ['layer_height', 'first_layer']) {
    const select = $(id);
    for (const opt of select.options) opt.disabled = Number(opt.value)>maxLayer;
    if (Number(select.value)>maxLayer) select.value = '0.12';
  }
}
async function download(kind) {
  if (!valid || exporting) return;
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
$('view-3d').addEventListener('click', () => switchView('3d'));
$('view-top').addEventListener('click', () => switchView('top'));
for (const kind of ['3mf', 'stl', 'png']) $(`download-${kind}`).addEventListener('click', () => download(kind));
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
