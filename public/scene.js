// 3D 무대 (Three.js + Kenney Mini Characters) — 사다리타기 버전
// room.html 의 클래식 스크립트에서 window.L3D 로 호출한다. WebGL/로딩 실패 시
// ready=false 로 남아 room.html 이 자동으로 2D 연출로 폴백한다.
//
// 연출: 바닥에 사다리(세로 레일 + 가로대)를 그리고, 캐릭터들이 자기 출발 칸
// 위에서 카메라 쪽으로 걸어 내려오며 가로대에서 옆 칸으로 꺾여 결과에 도착한다.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from '/vendor/jsm/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from '/vendor/jsm/utils/SkeletonUtils.js';

// ---- 튜닝 상수 ----
const MODELS = [
  'character-female-a', 'character-male-a', 'character-female-b', 'character-male-b',
  'character-female-c', 'character-male-c', 'character-female-d', 'character-male-d',
  'character-female-e', 'character-male-e', 'character-female-f', 'character-male-f',
];
const TARGET_H = 1.2;       // 캐릭터 목표 키(월드 단위)
const LANE_DX = 1.7;        // 칸(세로줄) 간격
const ROW_DZ = 0.78;        // 가로대 행 간격
const RAIL_W = 0.07;        // 레일 두께
const SPEED = 3.1;          // 캐릭터 하강 속도(월드 단위/초)
const UP = new THREE.Vector3(0, 1, 0);

let renderer, labelRenderer, scene, camera, clock, ground;
let ready = false, running = false, revealMode = false;
const loader = new GLTFLoader();
const modelCache = new Map();  // idx -> Promise<{scene, animations, scale, yOffset}>
const chars = new Map();       // playerId -> char object
let banners = [];

let currentN = 0;
let trackGroup = null;         // 사다리 + 결과 라벨을 담는 그룹
let trackSig = '';             // 트랙 재생성 판단용 서명
let zStartG = -6, zEndG = 6;   // 출발/도착 z (geometry 계산 후 갱신)
let lanesG = [];               // 칸별 x 좌표
let resultLabels = [];         // 결과 CSS2D 라벨 엘리먼트

const camPos = new THREE.Vector3(0, 8, 10);
const camLook = new THREE.Vector3(0, 0, 0);
const curLook = new THREE.Vector3(0, 0, 0);

const xOf = (c) => (c - (currentN - 1) / 2) * LANE_DX;

function hashIdx(id) {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % MODELS.length;
}

function loadModel(idx) {
  if (modelCache.has(idx)) return modelCache.get(idx);
  const p = new Promise((resolve, reject) => {
    loader.load(`/assets/characters/${MODELS[idx]}.glb`, (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const h = Math.max(0.001, box.max.y - box.min.y);
      const scale = TARGET_H / h;
      gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      resolve({ scene: gltf.scene, animations: gltf.animations, scale, yOffset: -box.min.y * scale });
    }, undefined, reject);
  });
  modelCache.set(idx, p);
  return p;
}

export function init(container) {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1226);
    scene.fog = new THREE.Fog(0x0f1226, 28, 100);

    camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
    camera.position.copy(camPos);
    camera.lookAt(curLook);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202440, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.55);
    dir.position.set(5, 11, 7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 70;
    dir.shadow.camera.left = -20; dir.shadow.camera.right = 20;
    dir.shadow.camera.top = 20; dir.shadow.camera.bottom = -20;
    scene.add(dir);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x161a36, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    clock = new THREE.Clock();
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) loop(); });
    running = true;
    ready = true;
    loop();
    return true;
  } catch (e) {
    console.warn('[L3D] init 실패 → 2D 폴백', e);
    ready = false;
    return false;
  }
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fitCamera();
}

// 사다리 전체(폭·길이·라벨 높이)가 화면에 들어오도록 카메라 거리를 이분탐색으로 맞춤
function fitCamera() {
  if (!camera || !currentN) { camPos.set(0, 8, 10); camLook.set(0, 0, 0); return; }
  const halfX = (currentN * LANE_DX) / 2 + 1.0;
  const yTop = TARGET_H + 0.8;
  const corners = [];
  for (const sx of [-halfX, halfX])
    for (const sz of [zStartG - 0.6, zEndG + 0.6])
      for (const sy of [0, yTop]) corners.push(new THREE.Vector3(sx, sy, sz));
  const look = new THREE.Vector3(0, 0.3, (zStartG + zEndG) / 2);
  const viewDir = new THREE.Vector3(0, 0.82, 0.58).normalize(); // look → 카메라 방향(위+앞)

  const probe = camera.clone();
  const fits = (dist) => {
    probe.position.copy(look).addScaledVector(viewDir, dist);
    probe.up.copy(UP);
    probe.lookAt(look);
    probe.updateMatrixWorld(true);
    probe.updateProjectionMatrix();
    for (const c of corners) {
      const v = c.clone().project(probe);
      if (Math.abs(v.x) > 0.97 || Math.abs(v.y) > 0.97 || v.z > 1) return false;
    }
    return true;
  };
  let lo = 5, hi = 90;
  for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  const dist = hi * 1.03;
  camPos.copy(look).addScaledVector(viewDir, dist);
  camLook.copy(look);
}

function loop() {
  if (!running || !ready) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  camera.position.lerp(camPos, Math.min(1, dt * 2.5));
  curLook.lerp(camLook, Math.min(1, dt * 2.5));
  camera.lookAt(curLook);

  for (const c of chars.values()) {
    if (c.mixer) c.mixer.update(dt);
    if (c.walking) {
      advanceWalk(c, dt);
    } else if (!c.lockAnim) {
      const d = c.group.position.distanceTo(c.target);
      c.group.position.lerp(c.target, Math.min(1, dt * 6));
      play(c, d > 0.06 ? 'walk' : 'idle');
    }
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// 경로(waypoints)를 따라 캐릭터를 전진시킨다.
function advanceWalk(c, dt) {
  play(c, 'walk');
  let move = SPEED * dt;
  const p = c.group.position;
  while (move > 0 && c.wpIdx < c.path.length) {
    const tgt = c.path[c.wpIdx];
    const dx = tgt.x - p.x, dz = tgt.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= move) {
      p.x = tgt.x; p.z = tgt.z;
      move -= dist;
      c.wpIdx++;
    } else {
      const k = move / dist;
      p.x += dx * k; p.z += dz * k;
      // 진행 방향으로 회전 (모델 정면 = +z)
      c.group.rotation.y = Math.atan2(dx, dz);
      move = 0;
    }
  }
  if (c.wpIdx >= c.path.length) {
    c.walking = false;
    c.group.rotation.y = 0; // 도착하면 정면(카메라)
    c.lockAnim = false;
    if (c.onArrive) { const f = c.onArrive; c.onArrive = null; f(); }
  }
}

function makeLabel(cls, text, y) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text || '';
  const obj = new CSS2DObject(el);
  obj.position.set(0, y, 0);
  obj.center.set(0.5, 1);
  return { el, obj };
}

function play(c, name, opts) {
  const action = c.actions[name] || c.actions['idle'] || c.actions['static'];
  if (!action || c.current === action) return;
  const o = opts || {};
  action.reset();
  if (o.once) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
  else action.setLoop(THREE.LoopRepeat, Infinity);
  action.fadeIn(0.2).play();
  if (c.current) c.current.fadeOut(0.2);
  c.current = action;
}

// ---- 사다리 트랙 (레일 + 가로대 + 결과 라벨) ----
function zOfRow(r, rows) {
  const inTop = zStartG + 0.9, inBot = zEndG - 0.9;
  return inTop + (inBot - inTop) * ((r + 0.5) / rows);
}

function buildTrack(state) {
  const N = state.laneCount;
  const ladder = state.ladder; // {rows, H} | null
  const results = state.results || [];
  const rows = ladder ? ladder.rows : Math.max(8, Math.round(N * 1.8) + 4);
  const trackLen = Math.max(7, rows * ROW_DZ);
  zStartG = -trackLen / 2 - 0.9;
  zEndG = trackLen / 2 + 0.9;
  lanesG = [];
  for (let c = 0; c < N; c++) lanesG.push(xOf(c));

  if (trackGroup) { scene.remove(trackGroup); disposeGroup(trackGroup); }
  resultLabels.forEach((l) => l.obj && l.obj.parent && l.obj.parent.remove(l.obj));
  resultLabels = [];
  trackGroup = new THREE.Group();

  const railMat = new THREE.MeshStandardMaterial({ color: 0x3a4170, roughness: .9 });
  const rungMat = new THREE.MeshStandardMaterial({ color: 0x6c7bff, roughness: .6, emissive: 0x222a66 });
  const railLen = (zEndG - 0.5) - (zStartG + 0.5);
  const railGeo = new THREE.BoxGeometry(RAIL_W, 0.06, railLen);

  for (let c = 0; c < N; c++) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(xOf(c), 0.03, (zStartG + zEndG) / 2);
    rail.receiveShadow = true;
    trackGroup.add(rail);

    // 출발 패드
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: 0x2a3160, roughness: 1 })
    );
    pad.position.set(xOf(c), 0.025, zStartG + 0.2);
    pad.receiveShadow = true;
    trackGroup.add(pad);

    // 결과 타일 + 라벨 (결과가 공개된 경우)
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(LANE_DX * 0.82, 0.08, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x222a55, roughness: .8 })
    );
    tile.position.set(xOf(c), 0.04, zEndG + 0.15);
    tile.receiveShadow = true;
    trackGroup.add(tile);

    const txt = results[c] != null ? results[c] : '?';
    const lab = makeLabel('result', txt, 0.6);
    lab.obj.position.set(xOf(c), 0.6, zEndG + 0.15);
    lab.laneIndex = c;
    trackGroup.add(lab.obj);
    resultLabels.push(lab);
  }

  // 가로대 (사다리가 확정된 경우에만 — 시작 전 비밀 유지)
  if (ladder) {
    const rungGeo = new THREE.BoxGeometry(LANE_DX - RAIL_W, 0.07, 0.14);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < N - 1; c++) {
        if (!ladder.H[r][c]) continue;
        const rung = new THREE.Mesh(rungGeo, rungMat);
        rung.position.set((xOf(c) + xOf(c + 1)) / 2, 0.05, zOfRow(r, rows));
        rung.castShadow = true;
        trackGroup.add(rung);
      }
    }
  }

  scene.add(trackGroup);
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }
  });
}

// 출발 칸 s 의 경로 waypoint 배열 (x,0,z)
function pathFor(state, s) {
  const N = state.laneCount;
  const { rows, H } = state.ladder;
  const wp = [];
  let pos = s;
  wp.push(new THREE.Vector3(xOf(s), 0, zStartG + 0.2));
  for (let r = 0; r < rows; r++) {
    const zr = zOfRow(r, rows);
    wp.push(new THREE.Vector3(xOf(pos), 0, zr));
    let np = pos;
    if (pos > 0 && H[r][pos - 1]) np = pos - 1;
    else if (pos < N - 1 && H[r][pos]) np = pos + 1;
    if (np !== pos) { wp.push(new THREE.Vector3(xOf(np), 0, zr)); pos = np; }
  }
  wp.push(new THREE.Vector3(xOf(pos), 0, zEndG + 0.15));
  return { wp, end: pos };
}

async function spawn(player, pos) {
  const idx = hashIdx(player.id);
  const m = await loadModel(idx);
  if (chars.has(player.id)) return;
  const group = new THREE.Group();
  const model = cloneSkinned(m.scene);
  model.scale.setScalar(m.scale);
  model.position.y = m.yOffset;
  group.add(model);
  group.position.copy(pos);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of m.animations) actions[clip.name] = mixer.clipAction(clip);

  const nick = makeLabel('nick', player.name, TARGET_H + 0.35);
  group.add(nick.obj);

  const c = { group, model, mixer, actions, current: null, nick,
              target: pos.clone(), lockAnim: false, walking: false, path: null, wpIdx: 0, onArrive: null };
  chars.set(player.id, c);
  scene.add(group);
  play(c, 'idle');
}

function startPos(lane) {
  return new THREE.Vector3(lane != null ? xOf(lane) : 0, 0, zStartG + 0.2);
}
function endPos(lane, state) {
  const dest = (state.mapping && lane != null) ? state.mapping[lane] : lane;
  return new THREE.Vector3(xOf(dest != null ? dest : 0), 0, zEndG + 0.15);
}

export function sync(state, meId) {
  if (!ready) return;
  try {
    const players = state.players || [];
    currentN = state.laneCount || players.length || 1;

    // 트랙 재생성 판단 (칸 수 / 사다리 유무 / 결과 텍스트 변화)
    const sig = JSON.stringify([currentN, !!state.ladder, state.results]);
    if (sig !== trackSig) { trackSig = sig; buildTrack(state); fitCamera(); }

    const seen = new Set();
    players.forEach((p) => {
      seen.add(p.id);
      const c = chars.get(p.id);
      const homePos = (state.status === 'finished') ? endPos(p.lane, state) : startPos(p.lane);
      if (!c) { spawn(p, homePos); return; }
      c.nick.el.textContent = p.name;
      c.nick.el.classList.toggle('me', p.id === meId);
      if (revealMode || c.walking) return; // 연출 중에는 위치 건드리지 않음
      c.target = homePos;
      c.lockAnim = false;
      if (state.status === 'finished') {
        c.group.position.copy(homePos);
        c.group.rotation.y = 0;
        c.lockAnim = true;
        play(c, c.actions['emote-yes'] ? 'emote-yes' : 'idle', { once: !!c.actions['emote-yes'] });
        c.nick.el.classList.add('win');
      } else {
        c.nick.el.classList.remove('win');
      }
    });
    for (const [id, c] of chars) {
      if (!seen.has(id)) { scene.remove(c.group); chars.delete(id); }
    }
  } catch (e) { console.warn('[L3D] sync 오류', e); }
}

function banner(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  document.body.appendChild(el);
  banners.push(el);
  return el;
}

export function endReveal() {
  revealMode = false;
  banners.forEach((b) => b.remove());
  banners = [];
  document.querySelectorAll('.flashbang').forEach((e) => e.remove());
  resultLabels.forEach((l) => l.el.classList.remove('hit'));
}

// 사다리 하강 연출. state 에는 ladder/mapping/results 가 모두 들어있어야 한다.
export function reveal(state, meId, onDone) {
  if (!ready) { onDone && onDone(); return; }
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onDone && onDone(); };
  try {
    revealMode = true;
    const players = (state.players || []).filter((p) => p.lane != null);
    if (!players.length) { endReveal(); finish(); return; }

    const drum = banner('r3d-drum', '🪜 출발! 누가 어디로?');
    let remaining = players.length;

    players.forEach((p) => {
      const c = chars.get(p.id);
      if (!c) { if (--remaining === 0) onAllDone(); return; }
      const { wp, end } = pathFor(state, p.lane);
      c.group.position.copy(wp[0]);
      c.path = wp; c.wpIdx = 1; c.walking = true; c.lockAnim = true;
      c.nick.el.classList.remove('win');
      c.onArrive = () => {
        // 도착: 결과 타일 강조 + 만세
        const lab = resultLabels[end];
        if (lab) lab.el.classList.add('hit');
        c.nick.el.classList.add('win');
        c.lockAnim = true;
        play(c, c.actions['emote-yes'] ? 'emote-yes' : 'jump', { once: true });
        if (navigator.vibrate) navigator.vibrate(30);
        if (--remaining === 0) onAllDone();
      };
    });

    function onAllDone() {
      drum.remove();
      banner('r3d-verdict', '결과 확정! 🎉');
      const flash = document.createElement('div'); flash.className = 'flashbang';
      document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      setTimeout(() => { endReveal(); finish(); }, 2200);
    }
  } catch (e) {
    console.warn('[L3D] reveal 오류 → 종료', e);
    endReveal(); finish();
  }
}

export const isReady = () => ready;
export const charCount = () => chars.size; // 디버그/테스트용
