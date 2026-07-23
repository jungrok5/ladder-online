// 3D 무대 (Three.js + Kenney Mini Characters) — 사다리타기 버전
// room.html 의 클래식 스크립트에서 window.L3D 로 호출한다. WebGL/로딩 실패 시
// ready=false 로 남아 room.html 이 자동으로 2D 연출로 폴백한다.
//
// 연출: 바닥에 사다리(세로 레일 + 가로대)를 그리고, 캐릭터들이 자기 출발 칸
// 위에서 걸어 내려오며 가로대에서 옆 칸으로 꺾여 결과에 도착한다.
// - 골(결과)은 구름으로 가려져 있다가 마지막 근처에서 걷힌다.
// - 1인칭 모드: 내 캐릭터 시야로 따라가며 본다. 골에 도착하면 결과 텍스트가 정면에 보인다.
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
const SPEED = 3.1;          // 기본 하강 속도(월드 단위/초)
const CLOUD_CLEAR_AHEAD = 2.6; // 골 z 로부터 이 거리 안에 들면 구름이 걷힘
const UP = new THREE.Vector3(0, 1, 0);

let renderer, labelRenderer, scene, camera, clock, ground;
let ready = false, running = false, revealMode = false;
const loader = new GLTFLoader();
const modelCache = new Map();  // idx -> Promise<{scene, animations, scale, yOffset}>
const chars = new Map();       // playerId -> char object
let banners = [];
let tweens = [];               // 진행중 애니메이션 (now => done?)

let currentN = 0;
let trackGroup = null;         // 사다리 + 결과 라벨 + 구름을 담는 그룹
let trackSig = '';             // 트랙 재생성 판단용 서명
let zStartG = -6, zEndG = 6;   // 출발/도착 z
let resultLabels = [];         // 결과 CSS2D 라벨
let cloudPuffs = [];           // 골 앞을 가리는 구름 (칸별)

let walkSpeed = SPEED;         // 이번 연출의 하강 속도(길이에 맞춰 조정)
let fpMode = false;            // 1인칭 모드
let myPlayerId = null;         // 내 캐릭터 id (1인칭 대상)

const camPos = new THREE.Vector3(0, 8, 10);
const camLook = new THREE.Vector3(0, 0, 0);
const curLook = new THREE.Vector3(0, 0, 0);
const _fwd = new THREE.Vector3(), _eye = new THREE.Vector3(), _lk = new THREE.Vector3();

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
    scene.fog = new THREE.Fog(0x0f1226, 34, 130);

    camera = new THREE.PerspectiveCamera(50, 1, 0.08, 240);
    camera.position.copy(camPos);
    camera.lookAt(curLook);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202440, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.55);
    dir.position.set(5, 11, 7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 90;
    dir.shadow.camera.left = -24; dir.shadow.camera.right = 24;
    dir.shadow.camera.top = 24; dir.shadow.camera.bottom = -24;
    scene.add(dir);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 220),
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

// 사다리 전체가 화면에 들어오도록 카메라 거리를 이분탐색으로 맞춤 (오버뷰용)
function fitCamera() {
  if (!camera || !currentN) { camPos.set(0, 8, 10); camLook.set(0, 0, 0); return; }
  const halfX = (currentN * LANE_DX) / 2 + 1.0;
  const yTop = TARGET_H + 0.8;
  const corners = [];
  for (const sx of [-halfX, halfX])
    for (const sz of [zStartG - 0.6, zEndG + 0.6])
      for (const sy of [0, yTop]) corners.push(new THREE.Vector3(sx, sy, sz));
  const look = new THREE.Vector3(0, 0.3, (zStartG + zEndG) / 2);
  const viewDir = new THREE.Vector3(0, 0.82, 0.58).normalize();

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
  let lo = 5, hi = 160;
  for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  const dist = hi * 1.03;
  camPos.copy(look).addScaledVector(viewDir, dist);
  camLook.copy(look);
}

// 1인칭 대상 캐릭터 (내 캐릭터 우선, 없으면 아무나)
function fpTarget() {
  if (myPlayerId && chars.has(myPlayerId)) return chars.get(myPlayerId);
  const first = chars.values().next();
  return first.done ? null : first.value;
}

function loop() {
  if (!running || !ready) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  if (tweens.length) tweens = tweens.filter((t) => !t(now));

  const c0 = fpMode ? fpTarget() : null;
  if (c0) {
    // TPS(3인칭): 캐릭터 뒤·위에서 내려다보며 진행 방향(+z)을 향한다.
    // 시선은 항상 +z 고정(회전 없음 → 안 어지러움), 위치만 캐릭터를 따라간다.
    // 캐릭터가 시야를 가리지 않고 골(앞쪽)도 함께 보인다.
    const p = c0.group.position;
    _eye.set(p.x, p.y + 2.7, p.z - 3.4);       // 더 뒤·더 위 (뒤 = -z)
    _lk.set(p.x, p.y + 0.15, p.z + 4.5);        // 앞쪽 골(+z)을 살짝 내려다봄
    camera.position.lerp(_eye, Math.min(1, dt * 6));
    curLook.lerp(_lk, Math.min(1, dt * 6));
    camera.up.set(0, 1, 0);
    camera.lookAt(curLook);
  } else {
    camera.position.lerp(camPos, Math.min(1, dt * 2.5));
    curLook.lerp(camLook, Math.min(1, dt * 2.5));
    camera.lookAt(curLook);
  }

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
  let move = walkSpeed * dt;
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
      c.group.rotation.y = Math.atan2(dx, dz); // 진행 방향(모델 정면 = +z)
      move = 0;
    }
  }
  // 골 근처에 오면 구름이 걷히고 결과 라벨이 드러난다
  if (!c.revealed && c.endLane != null && p.z > zEndG - CLOUD_CLEAR_AHEAD) {
    c.revealed = true;
    revealGoal(c.endLane);
  }
  if (c.wpIdx >= c.path.length) {
    c.walking = false;
    c.group.rotation.y = 0;
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

// ---- 골 결과 라벨: 마지막 근처에서 드러남(구름 없이 부드럽게 페이드인) ----
function revealGoal(lane) {
  const lab = resultLabels[lane];
  if (lab) lab.el.classList.remove('clouded');
}

function resetGoals() {
  // 리플레이/재시작 대비: 강조(hit)만 초기화 (결과는 항상 보임)
  resultLabels.forEach((l) => l.el.classList.remove('hit'));
  for (const c of chars.values()) c.revealed = false;
}

function revealAllGoals() {
  resultLabels.forEach((l) => l.el.classList.remove('clouded'));
}

// ---- 사다리 트랙 ----
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

  if (trackGroup) { scene.remove(trackGroup); disposeGroup(trackGroup); }
  resultLabels.forEach((l) => l.obj && l.obj.parent && l.obj.parent.remove(l.obj));
  resultLabels = [];
  cloudPuffs = [];
  trackGroup = new THREE.Group();

  const railMat = new THREE.MeshStandardMaterial({ color: 0x3a4170, roughness: .9 });
  const rungMat = new THREE.MeshStandardMaterial({ color: 0x6c7bff, roughness: .6, emissive: 0x222a66 });
  const railLen = (zEndG - 0.5) - (zStartG + 0.5);
  const railGeo = new THREE.BoxGeometry(RAIL_W, 0.06, railLen);
  const started = state.status !== 'lobby';

  for (let c = 0; c < N; c++) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(xOf(c), 0.03, (zStartG + zEndG) / 2);
    rail.receiveShadow = true;
    trackGroup.add(rail);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: 0x2a3160, roughness: 1 })
    );
    pad.position.set(xOf(c), 0.025, zStartG + 0.2);
    pad.receiveShadow = true;
    trackGroup.add(pad);

    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(LANE_DX * 0.82, 0.08, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x222a55, roughness: .8 })
    );
    tile.position.set(xOf(c), 0.04, zEndG + 0.15);
    tile.receiveShadow = true;
    trackGroup.add(tile);

    // 결과 라벨: 항상 처음부터 보임(도착 시 강조만).
    // 칸이 많을 때 가로로 겹치지 않도록 3단 높이로 엇갈리게 배치.
    const txt = results[c] != null ? results[c] : '?';
    const yLab = 0.55 + (c % 3) * 0.6;
    const lab = makeLabel('result', txt, yLab);
    lab.obj.position.set(xOf(c), yLab, zEndG + 0.15);
    lab.laneIndex = c;
    trackGroup.add(lab.obj);
    resultLabels.push(lab);
  }

  // 가로대 (사다리 확정 후에만)
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
              target: pos.clone(), lockAnim: false, walking: false, path: null, wpIdx: 0, onArrive: null,
              endLane: null, revealed: false };
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
    if (meId !== undefined) myPlayerId = meId;
    const players = state.players || [];
    currentN = state.laneCount || players.length || 1;

    // 트랙 재생성 판단 (연출 중엔 보류)
    const sig = JSON.stringify([currentN, !!state.ladder, state.results, state.status]);
    if (sig !== trackSig && !revealMode) { trackSig = sig; buildTrack(state); fitCamera(); }

    const seen = new Set();
    players.forEach((p) => {
      seen.add(p.id);
      const c = chars.get(p.id);
      const homePos = (state.status === 'finished') ? endPos(p.lane, state) : startPos(p.lane);
      if (!c) { spawn(p, homePos); return; }
      c.nick.el.textContent = p.name;
      c.nick.el.classList.toggle('me', p.id === meId);
      if (revealMode || c.walking) return;
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
}

// 1인칭 모드 토글
export function setFirstPerson(on) {
  fpMode = !!on;
}

// 사다리 하강 연출. state 에는 ladder/mapping/results 가 모두 들어있어야 한다.
export function reveal(state, meId, onDone) {
  if (!ready) { onDone && onDone(); return; }
  if (meId !== undefined) myPlayerId = meId;
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onDone && onDone(); };
  try {
    revealMode = true;
    resetGoals(); // 결과 다시 가리기(리플레이 대비)
    // 길이에 맞춰 하강 속도 조정 (너무 오래 걸리지 않게, 약 8~14초)
    walkSpeed = SPEED; // 캐릭터 이동속도는 기존 그대로(고정). 서스펜스는 길이로 조절.

    const players = (state.players || []).filter((p) => p.lane != null);
    if (!players.length) { revealAllGoals(); endReveal(); finish(); return; }

    const drum = banner('r3d-drum', '🪜 출발! 누가 어디로?');
    let remaining = players.length;

    players.forEach((p) => {
      const c = chars.get(p.id);
      if (!c) { if (--remaining === 0) onAllDone(); return; }
      const { wp, end } = pathFor(state, p.lane);
      c.group.position.copy(wp[0]);
      c.path = wp; c.wpIdx = 1; c.walking = true; c.lockAnim = true;
      c.endLane = end; c.revealed = false;
      c.nick.el.classList.remove('win');
      c.onArrive = () => {
        revealGoal(end);
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
      revealAllGoals();
      drum.remove();
      // 1인칭에선 골 라벨이 카메라에 붙어 잘 안 보이므로, 최종 배너에 내 결과를 같이 표시
      let msg = '결과 확정! 🎉';
      try {
        const meP = (state.players || []).find((p) => p.id === myPlayerId && p.lane != null);
        if (meP && state.mapping && state.results) {
          const r = state.results[state.mapping[meP.lane]];
          if (r != null) msg = `🎉 내 결과: ${r}`;
        }
      } catch (e) {}
      banner('r3d-verdict', msg);
      const flash = document.createElement('div'); flash.className = 'flashbang';
      document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      setTimeout(() => { endReveal(); finish(); }, 2600);
    }
  } catch (e) {
    console.warn('[L3D] reveal 오류 → 종료', e);
    revealAllGoals(); endReveal(); finish();
  }
}

export const isReady = () => ready;
export const charCount = () => chars.size; // 디버그/테스트용
