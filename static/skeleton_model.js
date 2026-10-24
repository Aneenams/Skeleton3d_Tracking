// skeleton_model.js - anatomical 3D skeleton (three.js) driven by MediaPipe 3D pose.
// Coordinates: metres, origin = hip centre, +x viewer-right, +y up, +z toward viewer (mirror view).
import * as THREE from 'three';
const { Vector3 } = THREE;

export const HAND_CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

export const MAT = {
  bone:  new THREE.MeshStandardMaterial({ color: 0xece4d0, roughness: 0.5 }),
  cart:  new THREE.MeshStandardMaterial({ color: 0xc8bea4, roughness: 0.7 }),
  tooth: new THREE.MeshStandardMaterial({ color: 0xfaf6ea, roughness: 0.3 }),
  dark:  new THREE.MeshStandardMaterial({ color: 0x0c0c10, roughness: 0.95 }),
  LEFT:  new THREE.MeshStandardMaterial({ color: 0xe4f7e4, emissive: 0x00c030, emissiveIntensity: 0.8, roughness: 0.5 }),
  RIGHT: new THREE.MeshStandardMaterial({ color: 0xfff0dc, emissive: 0xff7a00, emissiveIntensity: 0.8, roughness: 0.5 }),
};

const UPV = new Vector3(0, 1, 0);
const _a = new Vector3(), _s = new Vector3();

// shared unit geometries
const SPHERE = new THREE.SphereGeometry(1, 16, 12);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
const SHAFT = (() => {            // bone shaft: thin in the middle, flared at both ends
  const pts = [], n = 14;
  for (let i = 0; i <= n; i++) { const y = -0.5 + i / n; pts.push(new THREE.Vector2(0.72 + 0.55 * Math.pow(Math.abs(2 * y), 5), y)); }
  return new THREE.LatheGeometry(pts, 14);
})();

function mesh(geo, mat, parent, pos = [0,0,0], scl = [1,1,1], rot = [0,0,0]) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos); m.scale.set(...scl); m.rotation.set(...rot);
  parent.add(m); return m;
}

function basis(right, upHint) {          // orthonormal right/up/forward frame
  const r = right.clone().normalize();
  const u = upHint.clone().addScaledVector(r, -upHint.dot(r));
  if (u.lengthSq() < 1e-8) u.set(0, 1, 0).addScaledVector(r, -r.y);
  u.normalize();
  return { r, u, f: new Vector3().crossVectors(r, u) };
}

function place(obj, origin, r, u, f, sx, sy = sx, sz = sx) {
  obj.matrixAutoUpdate = false;
  obj.matrix.makeBasis(r, u, f).scale(_s.set(sx, sy, sz)).setPosition(origin);
  obj.matrixWorldNeedsUpdate = true;
}

// ---------------------------------------------------------------- Bone
class Bone {
  constructor(parent, r, mode = 'long') {
    this.r = r; this.mode = mode;
    this.g = new THREE.Group(); this.g.visible = false; parent.add(this.g);
    this.shaft = new THREE.Mesh(mode === 'none' ? CYL : SHAFT, MAT.bone); this.g.add(this.shaft);
    this.knobs = [];
    const n = mode === 'long' ? 4 : mode === 'ball' ? 2 : 0;
    for (let i = 0; i < n; i++) { const k = new THREE.Mesh(SPHERE, MAT.bone); this.g.add(k); this.knobs.push(k); }
  }
  setMat(m) { this.shaft.material = m; this.knobs.forEach(k => k.material = m); }
  hide() { this.g.visible = false; }
  set(a, b, sc) {
    _a.subVectors(b, a); const L = _a.length();
    if (L < 1e-4) { this.g.visible = false; return; }
    this.g.visible = true;
    this.g.position.addVectors(a, b).multiplyScalar(0.5);
    this.g.quaternion.setFromUnitVectors(UPV, _a.multiplyScalar(1 / L));
    const r = this.r * sc;
    this.shaft.scale.set(r, L, r);
    if (this.mode === 'long') {
      const kr = r * 1.35, off = r * 0.62;
      this.knobs.forEach((k, i) => { k.position.set((i % 2 ? -1 : 1) * off, (i < 2 ? 0.5 : -0.5) * L, 0); k.scale.set(kr, kr * 0.95, kr); });
    } else if (this.mode === 'ball') {
      this.knobs.forEach((k, i) => { k.position.set(0, (i ? -0.5 : 0.5) * L, 0); k.scale.setScalar(r * 1.25); });
    }
  }
}

class Ball {                              // a joint ball
  constructor(parent, r) { this.r = r; this.m = new THREE.Mesh(SPHERE, MAT.bone); this.m.visible = false; parent.add(this.m); }
  set(p, sc) { this.m.visible = true; this.m.position.copy(p); this.m.scale.setScalar(this.r * sc); }
  setMat(m) { this.m.material = m; }
  hide() { this.m.visible = false; }
}

// ---------------------------------------------------------------- static parts
function plateGeometry(pts, depth) {
  const s = new THREE.Shape();
  s.moveTo(...pts[0]); pts.slice(1).forEach(p => s.lineTo(...p)); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: depth * 0.4, bevelSegments: 1 });
  g.translate(0, 0, -depth / 2); return g;
}

function buildThorax(g) {                 // local frame: origin = neck base, y up, z forward (units: metres at shoulder width 0.40)
  const n = 10;
  for (let k = 0; k < n; k++) {
    const frac = k / (n - 1), yk = -0.02 - 0.027 * k;
    const a = 0.078 + 0.055 * Math.sin(Math.PI * (0.1 + 0.75 * frac));       // barrel shape
    const floating = k >= 7;
    const drop = floating ? 0.05 + 0.01 * (k - 7) : 0.015 + 0.004 * k;
    const phiMax = (floating ? 0.72 : 0.97) * Math.PI;
    const zTarget = floating ? 0.05 : 0.075 + 0.04 * Math.min(1, (-(yk - drop)) / 0.22);
    const c = (zTarget + 0.07) / (1 - Math.cos(phiMax)), zc = c - 0.07;
    for (const sgn of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const u = i / 14, phi = u * phiMax;
        pts.push(new Vector3(sgn * (0.028 * (1 - u) + 0.016 * u + (a - 0.028) * Math.sin(phi)), yk - drop * u, zc - c * Math.cos(phi)));
      }
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, 0.0062, 6, false), MAT.bone));
    }
  }
  // sternum: manubrium, body, xiphoid
  mesh(SPHERE, MAT.bone, g, [0, -0.0375, 0.080], [0.027, 0.029, 0.007], [-0.18, 0, 0]);
  mesh(SPHERE, MAT.bone, g, [0, -0.1275, 0.098], [0.017, 0.065, 0.006], [-0.18, 0, 0]);
  mesh(new THREE.CylinderGeometry(0.011, 0.003, 0.035, 8), MAT.bone, g, [0, -0.2075, 0.108], [1, 1, 0.5], [-0.18, 0, 0]);
  // scapulae (shoulder blades) on the back
  const sg = plateGeometry([[-0.04,0.06],[0.045,0.055],[0.05,0.03],[0.012,-0.02],[0,-0.085],[-0.03,-0.075],[-0.045,0]], 0.006);
  for (const sgn of [-1, 1]) mesh(sg, MAT.bone, g, [sgn * 0.118, -0.095, -0.062], [sgn * 0.8, 0.8, 1], [0, -sgn * 0.65, 0]);
}

function buildPelvis(g) {                 // local frame: origin = hip centre
  for (const sgn of [-1, 1]) {
    mesh(SPHERE, MAT.bone, g, [sgn * 0.125, 0.065, 0.0], [0.105, 0.078, 0.016], [0.0, -sgn * 0.95, sgn * 0.18]);    // ilium wing
    mesh(SPHERE, MAT.bone, g, [sgn * 0.075, -0.075, -0.035], [0.03, 0.055, 0.028]);                    // ischium
    mesh(SPHERE, MAT.bone, g, [sgn * 0.04, -0.07, 0.06], [0.04, 0.018, 0.02]);                         // pubis
    mesh(new THREE.TorusGeometry(0.026, 0.007, 8, 20), MAT.bone, g, [sgn * 0.075, -0.065, 0.015], [1, 1, 1], [0, sgn * 0.9, 0]);   // obturator ring
    mesh(new THREE.TorusGeometry(0.03, 0.007, 8, 20), MAT.bone, g, [sgn * 0.088, 0, 0], [1, 1, 1], [0, sgn * 1.35, 0]);            // hip socket rim
  }
  mesh(SPHERE, MAT.bone, g, [0, -0.075, 0.075], [0.014, 0.014, 0.014]);                                  // pubic symphysis
  const sac = plateGeometry([[-0.05,0.09],[0.05,0.09],[0.03,-0.02],[0.012,-0.085],[-0.012,-0.085],[-0.03,-0.02]], 0.028);
  mesh(sac, MAT.cart, g, [0, 0.0, -0.075], [1, 1, 1], [-0.35, 0, 0]);                                    // sacrum + coccyx
}

function buildSkull(g) {                  // local frame: origin = ear midpoint, z forward
  mesh(SPHERE, MAT.bone, g, [0, 0.03, -0.01], [0.076, 0.082, 0.092]);                                    // cranium
  mesh(SPHERE, MAT.bone, g, [0, -0.035, 0.065], [0.045, 0.04, 0.035]);                                   // maxilla
  for (const sgn of [-1, 1]) {
    mesh(SPHERE, MAT.bone, g, [sgn * 0.05, -0.012, 0.062], [0.016, 0.012, 0.014]);                       // cheekbone
    mesh(SPHERE, MAT.dark, g, [sgn * 0.034, 0.008, 0.066], [0.019, 0.02, 0.014]);                        // eye socket
    mesh(BOX, MAT.bone, g, [sgn * 0.054, -0.03, 0.01], [0.012, 0.06, 0.02]);                             // jaw ramus
  }
  mesh(SPHERE, MAT.dark, g, [0, -0.018, 0.096], [0.009, 0.015, 0.01]);                                   // nasal cavity
  mesh(new THREE.TorusGeometry(0.052, 0.011, 8, 22, Math.PI), MAT.bone, g, [0, -0.065, 0.015], [1, 1, 1], [Math.PI / 2, 0, 0]);   // jaw
  for (let i = -3; i <= 3; i++) {                                                                        // teeth
    const x = (i) * 0.0085, z = 0.099 - Math.pow(x / 0.045, 2) * 0.02;
    mesh(BOX, MAT.tooth, g, [x, -0.056, z], [0.0075, 0.011, 0.007]);
    mesh(BOX, MAT.tooth, g, [x, -0.074, z - 0.012], [0.0075, 0.011, 0.007]);
  }
}

function makeVertebra(parent, w, d, h) {
  const g = new THREE.Group(); g.visible = false; g.matrixAutoUpdate = false; parent.add(g);
  mesh(CYL, MAT.bone, g, [0, 0, 0], [w / 2, h * 0.8, d / 2]);                                            // body
  mesh(CYL, MAT.cart, g, [0, -h * 0.5, 0], [w / 2 * 0.95, h * 0.22, d / 2 * 0.95]);                      // disc
  mesh(BOX, MAT.bone, g, [0, -h * 0.1, -d / 2 - 0.012], [0.007, h * 0.9, 0.03], [0.5, 0, 0]);            // spinous process
  for (const sgn of [-1, 1]) mesh(BOX, MAT.bone, g, [sgn * (w / 2 + 0.005), 0, -d * 0.25], [0.014, 0.007, 0.009]);  // transverse
  return g;
}

// ---------------------------------------------------------------- the model
const SIDES = [
  { name: 'LEFT',  sgn: -1, sh: 11, el: 13, wr: 15, pk: 17, ix: 19, th: 21, hip: 23, kn: 25, an: 27, he: 29, to: 31 },
  { name: 'RIGHT', sgn:  1, sh: 12, el: 14, wr: 16, pk: 18, ix: 20, th: 22, hip: 24, kn: 26, an: 28, he: 30, to: 32 },
];

export class SkeletonModel {
  constructor(scene) {
    this.root = new THREE.Group(); scene.add(this.root);
    this.thorax = new THREE.Group(); this.root.add(this.thorax); buildThorax(this.thorax);
    this.pelvis = new THREE.Group(); this.root.add(this.pelvis); buildPelvis(this.pelvis);
    this.skull = new THREE.Group(); this.root.add(this.skull); buildSkull(this.skull);
    this.skull.matrixAutoUpdate = false;
    this.thorax.matrixAutoUpdate = false; this.pelvis.matrixAutoUpdate = false;

    this.vert = [];                          // 5 lumbar, 12 thoracic, 7 cervical
    for (let i = 0; i < 5; i++)  this.vert.push(makeVertebra(this.root, 0.052 - 0.002 * i, 0.036, 0.026));
    for (let i = 0; i < 12; i++) this.vert.push(makeVertebra(this.root, 0.044 - 0.0012 * i, 0.030, 0.021));
    for (let j = 0; j < 7; j++)  this.vert.push(makeVertebra(this.root, 0.028 - 0.0009 * j, 0.022, 0.0165));

    this.limb = {};
    for (const S of SIDES) {
      this.limb[S.name] = {
        clav: new Bone(this.root, 0.0095), hum: new Bone(this.root, 0.0165),
        rad: new Bone(this.root, 0.008), uln: new Bone(this.root, 0.0085),
        fingers: HAND_CONN.map(() => new Bone(this.root, 0.0042, 'ball')),
        fb: [0, 1, 2].map(() => new Bone(this.root, 0.0045, 'ball')),
        neck: new Bone(this.root, 0.014), fem: new Bone(this.root, 0.0235),
        tib: new Bone(this.root, 0.0185), fib: new Bone(this.root, 0.009),
        heel: new Bone(this.root, 0.013, 'ball'), foot: new Bone(this.root, 0.012),
        toes: [0, 1, 2].map(() => new Bone(this.root, 0.0045, 'none')),
        shBall: new Ball(this.root, 0.027), hipBall: new Ball(this.root, 0.027),
        troch: new Ball(this.root, 0.017), knee: new Ball(this.root, 0.024),
      };
    }
  }

  // S = PoseSmoother (pose[33].{p,v}, hands, root). o = {head, follow, raised:{LEFT,RIGHT}, lowerVis}
  update(S, o) {
    if (!S || !S.have) { this.root.visible = false; return; }
    const P = S.pose.map(q => q.p), vis = S.pose.map(q => q.v);
    const ok = (...i) => true;
    const okLo = (...i) => true;
    if (!ok(11, 12)) { this.root.visible = false; return; }
    this.root.visible = true;
    this.root.position.copy(o.follow ? S.root : _a.set(0, 0, 0));

    const Ls = P[11], Rs = P[12], Lh = P[23], Rh = P[24];
    const N = Ls.clone().add(Rs).multiplyScalar(0.5);
    const H = Lh.clone().add(Rh).multiplyScalar(0.5);
    const sc = Math.max(Ls.distanceTo(Rs), 0.15) / 0.40;
    const sp = Math.max(Lh.distanceTo(Rh), 0.08) / 0.18;
    const bodyUp = N.clone().sub(H);
    const tb = basis(Rs.clone().sub(Ls), bodyUp);          // thorax frame
    const pb = basis(Rh.clone().sub(Lh), bodyUp);          // pelvis frame

    place(this.thorax, N, tb.r, tb.u, tb.f, sc);
    const havePelvis = okLo(23, 24);
    this.pelvis.visible = havePelvis;
    place(this.pelvis, H, pb.r, pb.u, pb.f, sp);

    // ---------- spine: Hermite curve from sacrum to neck base, with S-curve ----------
    const P0 = H.clone().addScaledVector(pb.u, 0.085 * sp).addScaledVector(pb.f, -0.06 * sp);
    const P1 = N.clone().addScaledVector(tb.f, -0.06 * sc);
    const len = P0.distanceTo(P1);
    const T0 = pb.u.clone().multiplyScalar(len), T1 = tb.u.clone().multiplyScalar(len);
    const fw = new Vector3();
    const spineAt = (t, out) => {
      t = Math.min(1, Math.max(0, t));
      const t2 = t * t, t3 = t2 * t;
      out.set(0, 0, 0).addScaledVector(P0, 2*t3 - 3*t2 + 1).addScaledVector(T0, t3 - 2*t2 + t)
         .addScaledVector(P1, -2*t3 + 3*t2).addScaledVector(T1, t3 - t2);
      fw.copy(pb.f).lerp(tb.f, t).normalize();
      return out.addScaledVector(fw, 0.012 * sc * Math.cos(2 * Math.PI * t));        // lordosis / kyphosis
    };
    const pa = new Vector3(), pbv = new Vector3(), pos = new Vector3(), up = new Vector3(), fh = new Vector3(), rr = new Vector3(), ff = new Vector3();
    const putVert = (idx, p, u, f, ky = 1) => {
      rr.crossVectors(u, f).normalize(); ff.crossVectors(rr, u);
      place(this.vert[idx], p, rr, u, ff, sc, sc * ky, sc); this.vert[idx].visible = true;
    };
    for (let i = 0; i < 17; i++) {
      const t = i < 5 ? 0.03 + i * (0.27 / 4) : 0.35 + (i - 5) * (0.65 / 11);
      spineAt(t, pos); spineAt(t - 0.02, pa); spineAt(t + 0.02, pbv);
      up.subVectors(pbv, pa).normalize();
      fh.copy(pb.f).lerp(tb.f, t);
      putVert(i, pos, up, fh);
    }
    // cervical: straight line from neck base to skull base
    const headOk = ok(7, 8);
    let hb = null, B;
    const midEars = new Vector3();
    if (headOk) {
      midEars.addVectors(P[7], P[8]).multiplyScalar(0.5);
      hb = basis(P[8].clone().sub(P[7]), midEars.clone().sub(N));
      B = midEars.clone().addScaledVector(hb.u, -0.04 * sc).addScaledVector(hb.f, -0.02 * sc);
    } else B = P1.clone().addScaledVector(tb.u, 0.11 * sc);
    const nd = B.clone().sub(P1), nlen = nd.length(); nd.normalize();
    const ky = Math.min(1.8, Math.max(0.8, (nlen / 7) / (0.0165 * sc * 1.1)));
    for (let j = 0; j < 7; j++) {
      pos.copy(P1).addScaledVector(nd, nlen * (j + 0.5) / 7);
      fh.copy(tb.f); if (hb) fh.lerp(hb.f, (j + 0.5) / 7);
      putVert(17 + j, pos, nd, fh, ky);
    }

    // ---------- skull ----------
    this.skull.visible = !!(o.head && headOk);
    if (this.skull.visible) {
      const es = P[7].distanceTo(P[8]) / 0.15;
      place(this.skull, midEars, hb.r, hb.u, hb.f, es);
    }

    // ---------- limbs ----------
    const A = new Vector3(), Bv = new Vector3(), n = new Vector3(), d = new Vector3();
    const perp = (dir) => n.copy(tb.r).addScaledVector(dir, -tb.r.dot(dir)).normalize();
    const stTop = N.clone().addScaledVector(tb.u, -0.005 * sc).addScaledVector(tb.f, 0.078 * sc);
    for (const s of SIDES) {
      const L = this.limb[s.name];
      const all = [L.clav, L.hum, L.rad, L.uln, ...L.fingers, ...L.fb, L.neck, L.fem, L.tib, L.fib, L.heel, L.foot, ...L.toes];
      all.forEach(b => b.hide()); [L.shBall, L.hipBall, L.troch, L.knee].forEach(b => b.hide());
      const mat = o.raised && o.raised[s.name] ? MAT[s.name] : MAT.bone;

      // clavicle + shoulder + arm
      if (ok(s.sh)) {
        A.copy(P[s.sh]).addScaledVector(tb.u, 0.015 * sc).addScaledVector(tb.f, -0.01 * sc);
        L.clav.set(stTop, A, sc); L.clav.setMat(MAT.bone);
        L.shBall.set(P[s.sh], sc); L.shBall.setMat(mat);
      }
      if (ok(s.sh, s.el)) {
        L.hum.set(P[s.sh], P[s.el], sc); L.hum.setMat(mat);
        if (ok(s.wr)) {
          d.subVectors(P[s.wr], P[s.el]).normalize(); perp(d);
          const off = 0.011 * sc;
          A.copy(P[s.el]).addScaledVector(n, off);  Bv.copy(P[s.wr]).addScaledVector(n, off * 0.5);  L.rad.set(A, Bv, sc); L.rad.setMat(mat);
          A.copy(P[s.el]).addScaledVector(n, -off); Bv.copy(P[s.wr]).addScaledVector(n, -off * 0.5); L.uln.set(A, Bv, sc); L.uln.setMat(mat);
          const h = S.hands[s.name];
          if (h) HAND_CONN.forEach(([a, b], i) => { L.fingers[i].set(h[a], h[b], sc); L.fingers[i].setMat(mat); });
          else if (ok(s.pk, s.ix, s.th)) [s.pk, s.ix, s.th].forEach((idx, i) => { L.fb[i].set(P[s.wr], P[idx], sc); L.fb[i].setMat(mat); });
        }
      }

      // legs
      if (havePelvis && okLo(s.hip)) {
        const out = pb.r.clone().multiplyScalar(s.sgn);
        const tr = P[s.hip].clone().addScaledVector(out, 0.045 * sp).addScaledVector(pb.u, -0.02 * sp);
        L.hipBall.set(P[s.hip], sc);
        if (okLo(s.kn)) {
          L.neck.set(P[s.hip], tr, sc); L.troch.set(tr, sc);
          L.fem.set(tr, P[s.kn], sc);
          if (okLo(s.an)) {
            d.subVectors(P[s.an], P[s.kn]).normalize(); perp(d);
            A.copy(P[s.kn]).addScaledVector(n, 0.04 * sc * s.sgn); Bv.copy(P[s.an]).addScaledVector(n, 0.025 * sc * s.sgn);
            L.fib.set(A, Bv, sc);
            L.tib.set(P[s.kn], P[s.an], sc);
            L.knee.set(P[s.kn], sc);
            if (okLo(s.he, s.to)) {
              L.heel.set(P[s.an], P[s.he], sc); L.foot.set(P[s.he], P[s.to], sc);
              d.subVectors(P[s.to], P[s.he]).normalize(); perp(d);
              [-1, 0, 1].forEach((j, i) => { A.copy(P[s.to]); Bv.copy(P[s.to]).addScaledVector(d, 0.05 * sc).addScaledVector(n, j * 0.018 * sc); L.toes[i].set(A, Bv, sc); });
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- smoothing of incoming data
export class PoseSmoother {
  constructor(alpha = 0.4) {
    this.alpha = alpha; this.have = false; this.fps = 0;
    const mk = () => Array.from({ length: 33 }, () => ({ p: new Vector3(), v: 0 }));
    this.pose = mk(); this.tpose = mk();
    this.hands = { LEFT: null, RIGHT: null }; this.thands = { LEFT: null, RIGHT: null };
    this.root = new Vector3(); this.troot = new Vector3();
  }
  push(d) {
    if (!d || !d.pose) { this.have = false; for (const s of ['LEFT', 'RIGHT']) this.hands[s] = this.thands[s] = null; return; }
    
    // Default straight-leg coordinates (relative to hip origin)
    const defaults = {
      23: [-0.09, 0, 0], 24: [0.09, 0, 0],                 // Hips
      25: [-0.10, -0.45, 0], 26: [0.10, -0.45, 0],         // Knees
      27: [-0.10, -0.88, 0], 28: [0.10, -0.88, 0],         // Ankles
      29: [-0.10, -0.93, -0.05], 30: [0.10, -0.93, -0.05], // Heels
      31: [-0.11, -0.95, 0.12], 32: [0.11, -0.95, 0.12]    // Toes
    };

    d.pose.forEach((q, i) => {
      // 1. If the camera clearly sees the joint, use live tracking
      if (q[3] > 0.4) {
        this.tpose[i].p.set(q[0], q[1], q[2]);
      } 
      // 2. If it's a hidden lower-body joint, force it to stand straight
      else if (defaults[i]) {
        this.tpose[i].p.set(...defaults[i]);
      }
      // 3. For hidden upper-body joints on the very first frame, use the initial guess
      else if (!this.have) {
        this.tpose[i].p.set(q[0], q[1], q[2]); 
      }
      this.tpose[i].v = q[3];
    });

    this.troot.set(d.root[0], d.root[1], 0); this.fps = d.fps || 0;
    for (const s of ['LEFT', 'RIGHT']) {
      const h = d.hands && d.hands[s];
      if (!h) { this.hands[s] = this.thands[s] = null; continue; }
      if (!this.thands[s]) { this.thands[s] = h.map(q => new Vector3(...q)); this.hands[s] = h.map(q => new Vector3(...q)); }
      else h.forEach((q, i) => this.thands[s][i].set(q[0], q[1], q[2]));
    }
    if (!this.have) { this.pose.forEach((s, i) => { s.p.copy(this.tpose[i].p); s.v = this.tpose[i].v; }); this.root.copy(this.troot); this.have = true; }
  }
  step() {
    if (!this.have) return;
    const a = this.alpha;
    this.pose.forEach((s, i) => { s.p.lerp(this.tpose[i].p, a); s.v = this.tpose[i].v; });
    this.root.lerp(this.troot, a);
    for (const s of ['LEFT', 'RIGHT']) if (this.hands[s]) this.hands[s].forEach((v, i) => v.lerp(this.thands[s][i], a));
  }
}
