// A8 · Class-based 3D models driven by measured values (contract I5).
// Usage (Vite/npm `three`, or the import map in demo.html):
//   import { renderObject } from './lib3d.js';
//   const ctl = renderObject(el, { cls: 'red-dwarf', temp_K: 3200 });   ctl.setView('ir', 4.4); ctl.flare(); ctl.dispose();
// Classes: red-dwarf | star | brown-dwarf | mira | young-star | asteroid | comet.  Option: binary:true (two bodies orbiting).
// Every model is an ILLUSTRATION: shape and surface are not observed; colour/size/period come from data when given.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function kelvinRGB(K) {   // blackbody colour approximation (Tanner Helland)
  const t = K / 100; let r, g, b;
  r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  b = t >= 66 ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const c = v => Math.min(255, Math.max(0, v)) / 255; return new THREE.Color(c(r), c(g), c(b));
}

export const DEFAULTS = {   // used only when the data has no value; the UI must label these "assumed"
  'red-dwarf': { temp_K: 3200 }, star: { temp_K: 5800 }, 'brown-dwarf': { temp_K: 1000 }, mira: { temp_K: 2600, period_days: 245 },
  'young-star': { temp_K: 4000 }, asteroid: {}, comet: {},
};

const NOISE = `
vec3 hash3(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));return -1.0+2.0*fract(sin(p)*43758.5453123);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);vec3 u=f*f*(3.0-2.0*f);
 return mix(mix(mix(dot(hash3(i),f),dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
            mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);}
float fbm(vec3 p){float s=0.0,a=.5;for(int i=0;i<5;i++){s+=a*noise(p);p*=2.03;a*=.5;}return s;}
vec3 irRamp(float x, vec3 e){ return pow(vec3(x), e); }`;   // same curve as the photos: black stays black, white stays white, the tint fills the middle

// "SPHEREx infrared" view: the same false colour as the photos (web/src/ui/lib/palette.ts, processing/palette.py; keep in sync).
// wavelength (µm) -> tint, linear in between: shorter is bluer, longer is redder.
const IR_STOPS = [[0.9, [.25, .45, 1]], [1.35, [.1, .75, 1]], [2.0, [.15, 1, .75]], [3.1, [1, .72, .15]], [4.1, [1, .45, .1]], [4.7, [1, .2, .12]]];
export const IR_DEFAULT_UM = 3.1;   // used when the caller gives no band
export function irTint(lamUm) {
  if (!(lamUm > IR_STOPS[0][0])) return IR_STOPS[0][1];
  for (let i = 1; i < IR_STOPS.length; i++) {
    const [l1, c1] = IR_STOPS[i]; if (lamUm > l1) continue;
    const [l0, c0] = IR_STOPS[i - 1], f = (lamUm - l0) / (l1 - l0);
    return c0.map((v, k) => v + f * (c1[k] - v));
  }
  return IR_STOPS[IR_STOPS.length - 1][1];
}
const irExponent = lamUm => new THREE.Vector3(...irTint(lamUm).map(t => 0.9 + 1.5 * (1 - t)));

// One shader for every glowing body; `mode` picks the surface: 0 star (granulation+spots), 1 brown dwarf (bands), 2 mira (big convection cells)
function bodyMaterial(color, mode) {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, col: { value: color }, spots: { value: 1 }, ir: { value: 0 }, irPow: { value: irExponent(IR_DEFAULT_UM) }, flare: { value: 0 }, mode: { value: mode },
                flareDir: { value: new THREE.Vector3(0.4, 0.5, 0.77).normalize() } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){ vN=normalize(normalMatrix*normal); vP=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: NOISE + `uniform float time,spots,ir,flare,mode; uniform vec3 col,flareDir,irPow; varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){
        vec3 p=normalize(vP); float mu=max(dot(vN,vV),0.0); float b;
        if(mode<0.5){ float g=fbm(p*9.0+vec3(0.,time*.05,0.))*.5+.5; float sp=smoothstep(.18,.32,fbm(p*3.1+vec3(7.0)))*spots;
          b=(.78+.35*g)*(1.0-.62*sp)*(.35+.65*pow(mu,.55)); }
        else if(mode<1.5){ float lat=p.y*7.0+fbm(p*3.0+vec3(time*.03,0.,0.))*1.6; float band=.5+.5*sin(lat);
          float storm=smoothstep(.25,.4,fbm(p*5.0+vec3(3.0,time*.02,0.)))*.35;
          b=(.55+.45*band-storm)*(.25+.75*pow(mu,.8)); }
        else { float cells=fbm(p*2.2+vec3(time*.02)); b=(.7+.6*cells)*(.4+.6*pow(mu,.4)); }
        float f=flare*smoothstep(.75,1.0,dot(p,flareDir));
        vec3 hot=pow(col,vec3(1.6))*1.25;
        vec3 c=mix(hot*b, vec3(1.0,.97,.9)*1.6, f);
        gl_FragColor=vec4(mix(c, irRamp(clamp(b*.95,0.,1.),irPow)+vec3(1.,.9,.6)*f, ir),1.0);
      }`,
  });
}

function glowSprite(color, scale, opacity = .75) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.55)'); gr.addColorStop(.6, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity }));
  s.scale.set(scale, scale, 1); return s;
}

function rock(seed = 1) {   // irregular asteroid / comet nucleus: displaced icosahedron
  const geo = new THREE.IcosahedronGeometry(1, 5); const pos = geo.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); const n = v.clone().normalize();
    const d = 1 + .22 * Math.sin(n.x * 3.1 * seed + 1.3) * Math.cos(n.y * 2.3 + seed) + .12 * Math.sin(n.z * 7.7 + n.x * 5.1) + .05 * Math.sin(n.y * 17.0);
    v.copy(n.multiplyScalar(d)); pos.setXYZ(i, v.x, v.y * .78, v.z);
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a7d70, roughness: .95, metalness: .05, flatShading: true }));
}

function body(cls, p) {
  const T = p.temp_K ?? DEFAULTS[cls]?.temp_K ?? 5000; const color = kelvinRGB(T);
  if (cls === 'brown-dwarf') color.multiplyScalar(.45);   // cool dwarfs glow almost only in the infrared: keep the look dark
  const g = new THREE.Group(); const parts = { color };
  if (cls === 'asteroid' || cls === 'comet') {
    const r = rock(p.seed ?? 1.7); g.add(r); parts.mesh = r;
    if (cls === 'comet') {
      const coma = glowSprite(new THREE.Color(0x9fd8ff), 6, .55); g.add(coma); parts.coma = coma;
      const n = 1500, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const t = Math.pow(Math.random(), 1.6) * 14; const s = .15 + t * .12;
        a.set([t + 1, (Math.random() - .5) * s, (Math.random() - .5) * s], i * 3); }
      const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(a, 3));
      const tail = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xbfe6ff, size: .07, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(tail); parts.tail = tail;
    }
    return { g, parts, lit: true };
  }
  const mode = cls === 'brown-dwarf' ? 1 : cls === 'mira' ? 2 : 0;
  const mat = bodyMaterial(color, mode); const m = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), mat);
  g.add(m); parts.mesh = m; parts.mat = mat;
  const glow = glowSprite(color, cls === 'brown-dwarf' ? 2.6 : cls === 'mira' ? 5.5 : 4.6, cls === 'brown-dwarf' ? .25 : .75); m.add(glow); parts.glow = glow;
  if (cls === 'young-star') {   // dusty disk + two jets (T Tauri)
    const n = 4000, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = 1.8 + Math.pow(Math.random(), .7) * 4.5, th = Math.random() * 6.283; a.set([r * Math.cos(th), (Math.random() - .5) * .12 * r, r * Math.sin(th)], i * 3); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(a, 3));
    const disk = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xd9a066, size: .05, transparent: true, opacity: .7 }));
    disk.rotation.x = .35; g.add(disk); parts.disk = disk;
    for (const s of [1, -1]) { const jet = new THREE.Mesh(new THREE.ConeGeometry(.25, 5, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x9fc8ff, transparent: true, opacity: .25, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      jet.position.y = s * 3.4; jet.rotation.x = s > 0 ? Math.PI : 0; jet.rotation.z = .35 * s; g.add(jet); }
  }
  if (cls === 'red-dwarf' || cls === 'star' || cls === 'young-star') {   // flare loop
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(.75, .45, .45), new THREE.Vector3(1.1, .85, .75), new THREE.Vector3(1.0, 1.0, .5), new THREE.Vector3(.55, .82, .25)]);
    const arc = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, .035, 8, false), new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
    m.add(arc); parts.arc = arc;
  }
  return { g, parts, lit: false };
}

export function renderObject(el, params = {}) {
  const cls = params.cls || 'star'; const p = { ...DEFAULTS[cls], ...params };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(45, 1, .01, 5000);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minDistance = 1.6; controls.maxDistance = 200;
  { const n = 1500, a = new Float32Array(n * 3);   // background stars
    for (let i = 0; i < n; i++) { const u = Math.random() * 2 - 1, th = Math.random() * 6.283, r = 900, s = Math.sqrt(1 - u * u); a.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(a, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0xcfd8ff, transparent: true, opacity: .6 }))); }
  const bodies = [body(cls, p)];
  if (p.binary) { const b2 = body(cls, { ...p, temp_K: p.temp2_K ?? p.temp_K, seed: 2.9 }); b2.g.scale.setScalar(p.scale2 ?? .85); bodies.push(b2); }
  bodies.forEach(b => scene.add(b.g));
  let sunR = 0;   // reference Sun (sun_ratio = R☉/R★), beside the star; clamped so both stay visible
  if (p.sun_ratio > 0) {
    sunR = Math.min(8, Math.max(.04, p.sun_ratio));
    const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), bodyMaterial(kelvinRGB(5772), 0));
    sun.scale.setScalar(sunR); sun.position.set(1.6 + sunR * 1.3, 0, 0); scene.add(sun);
  }
  if (bodies.some(b => b.lit)) { scene.add(new THREE.AmbientLight(0xffffff, .25)); const sun = new THREE.DirectionalLight(0xfff4e0, 2.2); sun.position.set(-5, 2, 4); scene.add(sun); }
  camera.position.set(0, .6, p.binary ? 9 : (cls === 'comet' ? 14 : 5.2 + sunR * 2.2)); if (sunR) controls.target.set(.8 + sunR * .65, 0, 0); if (cls === 'comet') controls.target.set(4, 0, 0);
  const size = () => { const w = el.clientWidth || 400, h = el.clientHeight || 400; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(el); size();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let flareT = -1, alive = true, spin = !reduce; const clock = new THREE.Clock();
  function tick() {
    if (!alive) return; const dt = clock.getDelta(), t = clock.elapsedTime;
    bodies.forEach((b, i) => {
      const q = b.parts; if (q.mat) q.mat.uniforms.time.value = t;
      if (spin) b.g.rotation.y += dt * (b.lit ? .25 : .12);
      if (cls === 'mira' || p.pulse) { const ph = 2 * Math.PI * t / 8; b.g.scale.setScalar(1 + (p.pulse ?? .12) * Math.sin(ph)); q.mat.uniforms.col.value = kelvinRGB(p.temp_K * (1 + .08 * Math.sin(ph))); }   // 8 s ≙ one period (sped up)
      if (cls === 'young-star' && q.mat) q.mat.uniforms.col.value = kelvinRGB(p.temp_K).multiplyScalar(.8 + .2 * Math.sin(t * 1.7) * Math.sin(t * .37));
      if (p.binary) { const a = t * .4 + i * Math.PI, r = i ? 2.4 : 1.8; b.g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); }
    });
    if (flareT >= 0) { flareT += dt; const f = flareT < .25 ? flareT / .25 : Math.max(0, 1 - (flareT - .25) / 2.2);
      bodies.forEach(b => { if (b.parts.mat) b.parts.mat.uniforms.flare.value = f; if (b.parts.arc) b.parts.arc.material.opacity = f * .9; });
      if (flareT > 2.6) flareT = -1; }
    controls.update(); renderer.render(scene, camera); requestAnimationFrame(tick);
  }
  tick();
  return {
    // 'ir' takes the wavelength (µm) of the band shown next to the model, so both carry the same tint
    setView(v, lamUm = IR_DEFAULT_UM) { const ir = v === 'ir';
      bodies.forEach(b => { if (b.parts.mat) { b.parts.mat.uniforms.ir.value = ir ? 1 : 0; b.parts.mat.uniforms.irPow.value = irExponent(lamUm); }
        if (b.parts.glow) b.parts.glow.material.color = ir ? new THREE.Color(...irTint(lamUm)) : b.parts.color; }); },
    setTemp(K) { p.temp_K = K; bodies.forEach(b => { const c = kelvinRGB(K); b.parts.color = c; if (b.parts.mat) b.parts.mat.uniforms.col.value = c; if (b.parts.glow) b.parts.glow.material.color = c; }); },
    setSpots(on) { bodies.forEach(b => b.parts.mat && (b.parts.mat.uniforms.spots.value = on ? 1 : 0)); },
    setSpin(on) { spin = on; },
    flare() { flareT = 0; },
    dispose() { alive = false; ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); },
  };
}
