'use strict';

/*
 * 아주 심플한 온라인 사다리타기 (Amidakuji)
 *
 * - 데이터베이스 없음: 모든 방 상태는 서버 메모리(rooms 객체)에 저장됩니다.
 *   서버를 재시작하면 진행 중이던 방은 사라집니다(잠깐 즐기는 용도).
 * - 의존성 없음: Node 내장 http 모듈만 사용. `node server.js` 로 바로 실행됩니다.
 * - 실시간 갱신은 WebSocket 대신 클라이언트 폴링으로 처리합니다.
 *
 * 게임 흐름: 방장이 칸 수와 각 칸의 결과(자유 입력)를 정해 방을 만든다 →
 *   링크를 공유 → 참가자들이 출발 칸을 직접 고른다 → 방장이 시작하면 랜덤
 *   사다리가 생성되고, 각자 경로를 타고 내려가 결과에 도착한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 5000;     // 메모리 보호: 동시 보관 방 수 상한
const MIN_LANES = 2;
const MAX_LANES = 12;       // 가독성 상한 (모바일에서도 잘 보이는 범위)
const HARD_CAP_LANES = 50;  // 어떤 경우에도 넘지 않는 안전 한계
const MAX_RESULT_LEN = 24;  // 각 결과 텍스트 길이 제한
const MAX_NAME_LEN = 20;

/** @type {Record<string, Room>} 메모리 저장소 */
const rooms = Object.create(null);

// ---------------------------------------------------------------------------
// 게임 로직
// ---------------------------------------------------------------------------

const LANE_MODES = ['pick', 'random'];

function randomId(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 헷갈리는 0,O,1,l 제외
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)]; // 예측 불가(암호학적)
  return out;
}

// 이름 없이 참여할 때 붙여줄 랜덤 닉네임 (형용사 + 동물)
const NAME_ADJ = ['날쌘', '용감한', '귀여운', '빛나는', '행복한', '멋진', '엉뚱한', '느긋한', '씩씩한', '잽싼', '든든한', '통큰', '명랑한', '슬기로운', '폭신한', '겁없는'];
const NAME_NOUN = ['호랑이', '토끼', '판다', '여우', '너구리', '다람쥐', '펭귄', '고양이', '강아지', '사자', '곰', '부엉이', '수달', '햄스터', '코알라', '문어'];
function randomName() {
  return `${NAME_ADJ[crypto.randomInt(NAME_ADJ.length)]} ${NAME_NOUN[crypto.randomInt(NAME_NOUN.length)]}`;
}
// 방에 아직 없는 랜덤 닉네임을 고른다(자동 부여용 → 숫자 접미사 없이 깔끔하게).
function uniqueRandomName(room) {
  for (let i = 0; i < 50; i++) {
    const n = randomName();
    if (!room.players.some((p) => p.name === n)) return n;
  }
  // 조합이 동난 극단적 경우에만 숫자 폴백
  const base = randomName();
  let n = 2, name = base;
  while (room.players.some((p) => p.name === name)) name = `${base}${n++}`;
  return name;
}

function token() {
  return randomId(16);
}

/** 입력값을 안전한 칸 수(정수, 범위 내)로 강제한다. */
function sanitizeLaneCount(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return MIN_LANES;
  return Math.max(MIN_LANES, Math.min(MAX_LANES, Math.min(HARD_CAP_LANES, n)));
}

/** 결과 배열을 칸 수에 맞게 정규화한다(길이 자르기, 빈 칸 기본값 채움). */
function sanitizeResults(arr, laneCount) {
  const out = [];
  for (let i = 0; i < laneCount; i++) {
    const raw = Array.isArray(arr) ? arr[i] : undefined;
    const txt = (typeof raw === 'string' ? raw : '').trim().slice(0, MAX_RESULT_LEN);
    out.push(txt || `결과 ${i + 1}`);
  }
  return out;
}

function createRoom(body) {
  let id;
  do { id = randomId(6); } while (rooms[id]);
  const laneCount = sanitizeLaneCount(body.laneCount);
  const room = {
    id,
    title: (body.title || '사다리타기').toString().slice(0, 40),
    laneCount,
    results: sanitizeResults(body.results, laneCount),
    resultsHidden: body.resultsHidden === true, // 기본: 공개
    laneMode: LANE_MODES.includes(body.laneMode) ? body.laneMode : 'pick',
    ladderLength: LADDER_LENGTHS[body.ladderLength] ? body.ladderLength : 'medium',
    hostToken: token(),
    status: 'lobby', // 'lobby' | 'revealing' | 'finished'
    createdAt: Date.now(),
    players: [], // { id, name, lane: int|null }
    ladder: null, // { rows, H: bool[rows][laneCount-1] }
    mapping: null, // int[laneCount] : 출발 칸 -> 도착 칸 (순열)
  };
  rooms[id] = room;
  return room;
}

/** 현재 점유된 칸(set). */
function takenLanes(room) {
  const set = new Set();
  for (const p of room.players) if (p.lane != null) set.add(p.lane);
  return set;
}

/** 가장 작은 빈 칸을 찾는다. 없으면 -1. */
function firstFreeLane(room) {
  const taken = takenLanes(room);
  for (let i = 0; i < room.laneCount; i++) if (!taken.has(i)) return i;
  return -1;
}

/**
 * 랜덤 사다리를 생성한다.
 * - 인접 가로대 금지(같은 행에서 한 세로줄이 좌/우 동시에 연결되지 않도록).
 *   덕분에 경로 추적이 항상 전단사(bijection)가 된다.
 */
// 길이 프리셋: 값이 클수록 사다리가 길고(가로대 많고) 복잡·재밌어진다.
const LADDER_LENGTHS = { short: 1.0, medium: 1.7, long: 2.8, xlong: 4.2 };

function buildLadder(N, length) {
  const factor = LADDER_LENGTHS[length] || LADDER_LENGTHS.medium;
  const rows = Math.max(6, Math.min(64, Math.round(N * factor) + 4)); // 지정 길이에 따른 행 수
  const H = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(N - 1).fill(false);
    for (let c = 0; c < N - 1; c++) {
      // 바로 왼쪽 칸에 가로대가 있으면 건너뛴다(인접 금지)
      if (c > 0 && row[c - 1]) continue;
      if (Math.random() < 0.45) row[c] = true;
    }
    H.push(row);
  }
  return { rows, H };
}

/** 출발 칸 s 에서 사다리를 타고 내려간 도착 칸을 반환한다. */
function tracePath(ladder, N, s) {
  let pos = s;
  for (let r = 0; r < ladder.rows; r++) {
    const row = ladder.H[r];
    if (pos > 0 && row[pos - 1]) pos -= 1;
    else if (pos < N - 1 && row[pos]) pos += 1;
  }
  return pos;
}

/** 모든 출발 칸의 도착 칸을 계산한다(0..N-1의 순열). */
function computeMapping(ladder, N) {
  const mapping = new Array(N);
  for (let s = 0; s < N; s++) mapping[s] = tracePath(ladder, N, s);
  return mapping;
}

// 아무도 자리가 안 바뀌는(전부 제자리) 심심한 사다리를 피한다 — 최소 한 명은 이동하게 재생성.
function buildLadderNonTrivial(N, length) {
  let ladder = buildLadder(N, length);
  for (let t = 0; t < 16 && N >= 2; t++) {
    const m = computeMapping(ladder, N);
    if (m.some((v, i) => v !== i)) break; // 뒤섞임 있음 → OK
    ladder = buildLadder(N, length);       // 항등(전부 제자리)이면 다시 생성
  }
  return ladder;
}

/** 클라이언트에 보낼 상태. 시작 전에는 ladder/mapping 을 노출하지 않는다. */
function publicState(room) {
  const started = room.status !== 'lobby';
  return {
    id: room.id,
    title: room.title,
    laneCount: room.laneCount,
    laneMode: room.laneMode,
    resultsHidden: room.resultsHidden,
    // 결과는 공개(resultsHidden=false)면 항상, 숨김이면 시작 후에만 노출
    results: (!room.resultsHidden || started) ? room.results : null,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, name: p.name, lane: p.lane })),
    ladder: started ? room.ladder : null,   // 시작 전 절대 노출 금지
    mapping: started ? room.mapping : null,  // 시작 전 절대 노출 금지
  };
}

// ---------------------------------------------------------------------------
// HTTP 유틸
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return; // 끊긴 연결엔 쓰지 않음(중복/에러 방지)
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { data = ''; req.destroy(); finish({}); } // 과대 페이로드 차단 + 대기 종료
    });
    req.on('end', () => { try { finish(data ? JSON.parse(data) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));   // 끊김/오류 시에도 핸들러가 멈추지 않도록
    req.on('close', () => finish({}));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const GZIP_TYPES = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt']);

// ---- 레이트 리미팅 (IP 기준, 인메모리·무의존성) ----
const RL_WINDOW = 60 * 1000;   // 1분 창
const RL_GENERAL = 3000;       // IP당 1분 전체 API 요청 상한(공유 IP 여유 + 폭주 차단)
const RL_CREATE = 30;          // IP당 1분 방 생성 상한
const rlGeneral = new Map();   // ip -> { count, resetAt }
const rlCreate = new Map();

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip']; // Cloudflare(=Render 엣지)가 설정 → 위조 불가
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(map, key, limit) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW }; map.set(key, e); }
  e.count++;
  return e.count <= limit; // true = 허용
}
function send429(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
  res.end(JSON.stringify({ error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }));
}

// ---- 정적 파일 인메모리 캐시 (디스크 읽기·gzip 1회만) ----
// 파일은 배포(프로세스 재시작) 전엔 바뀌지 않으므로 메모리에 보관해도 안전하다.
const fileCache = new Map(); // filePath -> { buf, gz, mime, immutable }

function sendCached(res, req, e) {
  if (res.writableEnded || res.destroyed) return;
  const headers = {
    'Content-Type': e.mime,
    'Cache-Control': e.immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
  };
  const acceptsGzip = req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && e.gz) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers); res.end(e.gz);
  } else {
    res.writeHead(200, headers); res.end(e.buf);
  }
}

function serveFile(res, filePath, req) {
  const hit = fileCache.get(filePath);
  if (hit) return sendCached(res, req, hit);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
    }
    const ext = path.extname(filePath);
    // 라이브러리/에셋(/vendor, /assets)은 불변 → 장기 캐시. 그 외(HTML/CSS)는 항상 최신.
    const immutable = /[\\/](vendor|assets)[\\/]/.test(filePath);
    const e = { buf, gz: null, mime: MIME[ext] || 'application/octet-stream', immutable };
    if (GZIP_TYPES.has(ext)) {
      zlib.gzip(buf, (gzErr, gz) => {
        if (!gzErr) e.gz = gz;
        fileCache.set(filePath, e);
        sendCached(res, req, e);
      });
    } else {
      fileCache.set(filePath, e);
      sendCached(res, req, e);
    }
  });
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // --- API ---
  if (pathname.startsWith('/api/')) {
    try {
      const ip = clientIp(req);
      if (!rateLimit(rlGeneral, ip, RL_GENERAL)) return send429(res);
      if (pathname === '/api/rooms' && req.method === 'POST' && !rateLimit(rlCreate, ip, RL_CREATE)) return send429(res);

      // 방 생성
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(rooms).length >= MAX_ROOMS) {
          return sendJson(res, 503, { error: '지금 방이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
        }
        const room = createRoom(body);
        return sendJson(res, 200, { roomId: room.id, hostToken: room.hostToken });
      }

      const m = pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/);
      if (m) {
        const room = rooms[m[1]];
        if (!room) return sendJson(res, 404, { error: '방을 찾을 수 없어요 (만료되었을 수 있어요).' });
        const action = m[2];

        if (!action && req.method === 'GET') {
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/join' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'lobby') return sendJson(res, 409, { error: '이미 시작되어 참가할 수 없어요. 관전만 가능합니다.' });
          if (room.players.length >= room.laneCount) return sendJson(res, 409, { error: '모든 칸이 찼어요.' });

          // 출발 칸 결정 (pick: 지정/빈칸 자동, random: 시작 시 일괄 배정 → 여기선 null)
          let lane = null;
          if (room.laneMode === 'pick') {
            const taken = takenLanes(room);
            if (body.lane != null) {
              const want = Math.floor(Number(body.lane));
              if (!Number.isInteger(want) || want < 0 || want >= room.laneCount) {
                return sendJson(res, 400, { error: '잘못된 칸이에요.' });
              }
              if (taken.has(want)) return sendJson(res, 409, { error: '이미 선택된 칸이에요. 다른 칸을 골라주세요.' });
              lane = want;
            } else {
              lane = firstFreeLane(room);
              if (lane < 0) return sendJson(res, 409, { error: '모든 칸이 찼어요.' });
            }
          }

          let name = (body.name || '').toString().trim().slice(0, MAX_NAME_LEN);
          if (!name) {
            name = uniqueRandomName(room); // 미입력 → 겹치지 않는 랜덤 닉네임(숫자 없음)
          } else if (room.players.some((p) => p.name === name)) {
            // 직접 입력한 이름이 겹칠 때만 숫자 접미사
            let n = 2;
            while (room.players.some((p) => p.name === `${name}${n}`)) n++;
            name = `${name}${n}`;
          }
          const player = { id: token(), name, lane };
          room.players.push(player);
          return sendJson(res, 200, { playerId: player.id, name: player.name, lane: player.lane });
        }

        if (action === '/start' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 시작할 수 있어요.' });
          if (room.players.length < 1) return sendJson(res, 400, { error: '최소 1명 이상이어야 시작할 수 있어요.' });

          // random 모드: 빈 칸에 랜덤 배정
          if (room.laneMode === 'random') {
            const free = [];
            const taken = takenLanes(room);
            for (let i = 0; i < room.laneCount; i++) if (!taken.has(i)) free.push(i);
            // Fisher–Yates
            for (let i = free.length - 1; i > 0; i--) {
              const j = crypto.randomInt(i + 1);
              [free[i], free[j]] = [free[j], free[i]];
            }
            let k = 0;
            for (const p of room.players) if (p.lane == null) p.lane = free[k++];
          }

          room.ladder = buildLadderNonTrivial(room.laneCount, room.ladderLength);
          room.mapping = computeMapping(room.ladder, room.laneCount);
          room.status = 'revealing';
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/finish' && req.method === 'POST') {
          // 연출이 끝났음을 표시(누구나 호출 가능 — 단순 상태 전이). 멱등.
          if (room.status === 'revealing') room.status = 'finished';
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/reset' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 다시 시작할 수 있어요.' });
          room.status = 'lobby';
          room.ladder = null;
          room.mapping = null;
          // 칸 선택(lane)은 유지 → 같은 멤버/칸으로 새 사다리를 굴릴 수 있음.
          // random 모드는 매번 새로 배정하도록 비운다.
          if (room.laneMode === 'random') room.players.forEach((p) => { p.lane = null; });
          return sendJson(res, 200, publicState(room));
        }
      }

      return sendJson(res, 404, { error: 'Unknown API' });
    } catch (e) {
      return sendJson(res, 500, { error: '서버 오류' });
    }
  }

  // --- 정적 페이지 ---
  if (pathname === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req);
  if (pathname === '/privacy') return serveFile(res, path.join(PUBLIC_DIR, 'privacy.html'), req);
  if (/^\/r\/[a-z0-9]+$/.test(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'room.html'), req);

  // 정적 자산 (디렉터리 탈출 방지): 인코딩 해제 후 정규화하고, PUBLIC_DIR 하위인지 엄격 확인
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return serveFile(res, filePath, req); // 파일이 없으면 serveFile 이 404 처리
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

// 레이트리밋 기록 정리 (만료 항목 제거 + 안전밸브) — 메모리 누수 방지
setInterval(() => {
  const now = Date.now();
  for (const map of [rlGeneral, rlCreate]) {
    if (map.size > 100000) { map.clear(); continue; } // 비정상 폭증 시 안전밸브
    for (const [k, e] of map) if (now >= e.resetAt) map.delete(k);
  }
}, 60 * 1000).unref();

// 오래된 방 정리 (12시간 지난 방 제거) — 메모리 누수 방지
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const id of Object.keys(rooms)) {
    if (rooms[id].createdAt < cutoff) delete rooms[id];
  }
}, 60 * 60 * 1000).unref();

// 테스트에서 로직을 직접 부르기 위해 export (require 시), 직접 실행 시 서버 listen
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🪜  사다리타기 서버 실행 중: http://localhost:${PORT}`);
  });
} else {
  module.exports = { server, buildLadder, buildLadderNonTrivial, tracePath, computeMapping, sanitizeLaneCount, sanitizeResults, MAX_LANES, MIN_LANES };
}
