// main.js - three.js scene, mouse orbit, live data from Flask (/stream), UI
import * as THREE from 'three';
import { SkeletonModel, PoseSmoother } from './skeleton_model.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);

// lights: soft sky fill, warm key from the front, blue rim + dim fill from behind (for orbiting)
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x20202a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.7);  key.position.set(1.5, 2.5, 3);   scene.add(key);
const rim = new THREE.DirectionalLight(0x6aa8ff, 1.2);  rim.position.set(-2, 1.5, -2);   scene.add(rim);
const back = new THREE.DirectionalLight(0xffffff, 0.8); back.position.set(0, 1.5, -3);    scene.add(back);

// stage floor
const floorY = -1.0;
const grid = new THREE.GridHelper(8, 32, 0x2c3e5e, 0x172033); grid.position.y = floorY; scene.add(grid);
const disc = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64),
  new THREE.MeshBasicMaterial({ color: 0x0f1626, transparent: true, opacity: 0.85 }));
disc.rotation.x = -Math.PI / 2; disc.position.y = floorY - 0.002; scene.add(disc);

const model = new SkeletonModel(scene);
const smoother = new PoseSmoother(0.4);       // lower = smoother, higher = snappier

// ---------------- orbit camera (drag to rotate, wheel to zoom) ----------------
const DEFAULT_VIEW = { theta: 0, phi: 1.42, dist: 4.2 };
const view = { ...DEFAULT_VIEW };
const target = new THREE.Vector3(0, 0.1, 0);
function placeCamera() {
  camera.position.set(
    target.x + view.dist * Math.sin(view.phi) * Math.sin(view.theta),
    target.y + view.dist * Math.cos(view.phi),
    target.z + view.dist * Math.sin(view.phi) * Math.cos(view.theta));
  camera.lookAt(target);
}
let drag = null;
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => drag = null);
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  view.theta -= (e.clientX - drag.x) * 0.007;
  view.phi = Math.min(2.8, Math.max(0.3, view.phi - (e.clientY - drag.y) * 0.005));
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('wheel', e => { e.preventDefault(); view.dist = Math.min(9, Math.max(1.5, view.dist * (1 + e.deltaY * 0.001))); }, { passive: false });

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

// ---------------- UI ----------------
const $ = id => document.getElementById(id);
const opts = { head: false, follow: true, lowerVis: 0.4, raised: { LEFT: false, RIGHT: false } };
$('head').onchange = e => opts.head = e.target.checked;
$('follow').onchange = e => opts.follow = e.target.checked;
$('cam').onchange = e => $('preview').style.display = e.target.checked ? 'block' : 'none';
$('reset').onclick = () => Object.assign(view, DEFAULT_VIEW);
$('legs').onchange = e => opts.lowerVis = e.target.checked ? 0.25 : 0.4;

// ---------------- raised-hand logic (3D: y is up, so wrist ABOVE shoulder means larger y) ----------------
function updateRaised(S) {
  for (const [k, sh, wr] of [['LEFT', 11, 15], ['RIGHT', 12, 16]]) {
    const a = S.pose[sh], b = S.pose[wr];
    if (a.v < 0.5 || b.v < 0.5) opts.raised[k] = false;
    else if (b.p.y > a.p.y + 0.04) opts.raised[k] = true;      // clearly above  -> ON
    else if (b.p.y < a.p.y) opts.raised[k] = false;            // back below     -> OFF  (hysteresis)
  }
}

// ---------------- live data ----------------
let lastMsg = 0;
function connect() {
  const es = new EventSource('/stream');
  es.onmessage = e => { lastMsg = performance.now(); smoother.push(JSON.parse(e.data)); };
  es.onerror = () => { es.close(); setTimeout(connect, 1000); };
}
connect();

// ---------------- render loop ----------------
function frame() {
  smoother.step();
  if (smoother.have) updateRaised(smoother);
  else opts.raised.LEFT = opts.raised.RIGHT = false;
  model.update(smoother, opts);
  placeCamera();
  renderer.render(scene, camera);

  const live = performance.now() - lastMsg < 1500;
  $('info').textContent = !live ? 'waiting for data…' : smoother.have
    ? `body tracked · ${smoother.fps} fps · left ${opts.raised.LEFT ? 'RAISED' : 'down'} · right ${opts.raised.RIGHT ? 'RAISED' : 'down'}`
    : 'no body in view';
  requestAnimationFrame(frame);
}
frame();
