'use strict';
/*
 * 의존성 없는 테스트 하니스 (Node 18+ 의 전역 fetch 사용).
 *   node test/test.js
 * 서버 로직(순열성 등) 단위 테스트 + 실제 HTTP 통합 테스트를 함께 수행한다.
 */

const assert = require('assert');
const mod = require('../server.js');
const { server, buildLadder, computeMapping, tracePath, sanitizeLaneCount, sanitizeResults, MAX_LANES } = mod;

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------------------
// 1) 단위 테스트: 사다리 생성 / 매핑
// ---------------------------------------------------------------------------
section('사다리 매핑 (전단사) 단위 테스트');
for (let N = 2; N <= 12; N++) {
  for (let trial = 0; trial < 200; trial++) {
    const ladder = buildLadder(N);
    // 인접 가로대 금지 검증
    for (let r = 0; r < ladder.rows; r++)
      for (let c = 0; c < N - 2; c++)
        assert.ok(!(ladder.H[r][c] && ladder.H[r][c + 1]), `인접 가로대 발견 N=${N} r=${r} c=${c}`);
    const mapping = computeMapping(ladder, N);
    // 순열인지 (0..N-1 정확히 한 번씩)
    const sorted = [...mapping].sort((a, b) => a - b);
    for (let i = 0; i < N; i++) assert.strictEqual(sorted[i], i, `N=${N} 매핑이 순열이 아님: ${mapping}`);
    // computeMapping 과 tracePath 일치
    for (let s = 0; s < N; s++) assert.strictEqual(mapping[s], tracePath(ladder, N, s));
  }
}
ok('N=2..12, 각 200회: 매핑은 항상 0..N-1의 순열이며 인접 가로대 없음');

section('입력 정규화 단위 테스트');
assert.strictEqual(sanitizeLaneCount(1), 2, '최소 2');
assert.strictEqual(sanitizeLaneCount(999), MAX_LANES, '상한 클램프');
assert.strictEqual(sanitizeLaneCount('5'), 5, '문자열 숫자 허용');
assert.strictEqual(sanitizeLaneCount(null), 2, 'null → 최소');
assert.strictEqual(sanitizeLaneCount(4.7), 4, '소수 내림');
ok('sanitizeLaneCount 범위/형변환');
const rs = sanitizeResults(['a', '', 'x'.repeat(40)], 4);
assert.strictEqual(rs.length, 4, '길이를 칸 수에 맞춤');
assert.strictEqual(rs[1], '결과 2', '빈 칸 기본값');
assert.strictEqual(rs[2].length, 24, '결과 길이 제한 24');
ok('sanitizeResults 길이/기본값/슬라이스');

// ---------------------------------------------------------------------------
// 2) 통합 테스트 (실제 HTTP)
// ---------------------------------------------------------------------------
async function http(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function integration() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  section(`통합 테스트 (포트 ${port})`);

  // 방 생성 + 검증
  let r = await http(base, 'POST', '/api/rooms', {
    title: '점심 사다리', laneCount: 4, results: ['꽝', '당첨', '꽝', '커피'], laneMode: 'pick', resultsHidden: false,
  });
  assert.strictEqual(r.status, 200); assert.ok(r.data.roomId && r.data.hostToken);
  const room = r.data.roomId, host = r.data.hostToken;
  ok('방 생성 → roomId/hostToken 반환');

  // 시작 전: ladder/mapping 미노출, 결과는 공개(resultsHidden=false)
  r = await http(base, 'GET', `/api/rooms/${room}`);
  assert.strictEqual(r.data.status, 'lobby');
  assert.strictEqual(r.data.ladder, null, '시작 전 ladder 노출 금지');
  assert.strictEqual(r.data.mapping, null, '시작 전 mapping 노출 금지');
  assert.deepStrictEqual(r.data.results, ['꽝', '당첨', '꽝', '커피'], '공개 결과는 로비에서도 보임');
  ok('시작 전 ladder/mapping 미노출 (결과는 공개 설정이라 노출)');

  // 숨김 방: 시작 전 결과 null
  let h = await http(base, 'POST', '/api/rooms', { laneCount: 3, results: ['1','2','3'], resultsHidden: true });
  let hg = await http(base, 'GET', `/api/rooms/${h.data.roomId}`);
  assert.strictEqual(hg.data.results, null, 'resultsHidden=true 면 시작 전 결과 null');
  ok('resultsHidden 방: 시작 전 결과 숨김');

  // join: 칸 선택
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수', lane: 0 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.lane, 0);
  ok('join: 0번 칸 배정');

  // 칸 충돌 → 409
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '영희', lane: 0 });
  assert.strictEqual(r.status, 409, '점유된 칸 → 409');
  ok('join: 점유된 칸 거부(409)');

  // 범위 밖 → 400
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '범위', lane: 99 });
  assert.strictEqual(r.status, 400, '범위 밖 칸 → 400');
  ok('join: 범위 밖 칸 거부(400)');

  // lane 미지정 → 가장 작은 빈 칸
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '영희' });
  assert.strictEqual(r.data.lane, 1, '빈 칸 자동 배정(1)');
  ok('join: lane 미지정 시 최소 빈 칸 자동 배정');

  // 이름 중복 → 자동 변경
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수', lane: 2 });
  assert.strictEqual(r.data.name, '철수2', '이름 중복 방지');
  ok('join: 이름 중복 시 접미사 부여');

  // 방장 아님 → start 거부
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: 'wrong' });
  assert.strictEqual(r.status, 403);
  ok('start: 잘못된 토큰 거부(403)');

  // start
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: host });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, 'revealing');
  assert.ok(r.data.ladder && Array.isArray(r.data.mapping), '시작 후 ladder/mapping 노출');
  const sorted = [...r.data.mapping].sort((a, b) => a - b);
  assert.deepStrictEqual(sorted, [0, 1, 2, 3], 'mapping 은 순열');
  ok('start: ladder/mapping 노출, mapping 순열 확인');

  // 시작 후 join 거부
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '지각', lane: 3 });
  assert.strictEqual(r.status, 409);
  ok('start 후 join 거부(409, 관전)');

  // finish (멱등)
  r = await http(base, 'POST', `/api/rooms/${room}/finish`, {});
  assert.strictEqual(r.data.status, 'finished');
  ok('finish: revealing → finished');

  // reset (방장)
  r = await http(base, 'POST', `/api/rooms/${room}/reset`, { hostToken: host });
  assert.strictEqual(r.data.status, 'lobby');
  assert.strictEqual(r.data.ladder, null, 'reset 후 ladder 초기화');
  // pick 모드: 칸 유지
  assert.ok(r.data.players.every((p) => p.lane != null), 'pick 모드 reset 시 칸 유지');
  ok('reset: lobby 복귀, 사다리 초기화, pick 칸 유지');

  // 최소 인원 미달 start
  let r2 = await http(base, 'POST', '/api/rooms', { laneCount: 4, results: ['a','b','c','d'] });
  await http(base, 'POST', `/api/rooms/${r2.data.roomId}/join`, { name: 'solo', lane: 0 });
  r = await http(base, 'POST', `/api/rooms/${r2.data.roomId}/start`, { hostToken: r2.data.hostToken });
  assert.strictEqual(r.status, 400, '2명 미만 start 거부');
  ok('start: 2명 미만 거부(400)');

  // random 모드: 시작 시 칸 일괄 배정 + reset 시 칸 비움
  let rr = await http(base, 'POST', '/api/rooms', { laneCount: 5, results: ['a','b','c','d','e'], laneMode: 'random' });
  for (const nm of ['a','b','c']) await http(base, 'POST', `/api/rooms/${rr.data.roomId}/join`, { name: nm });
  let rg = await http(base, 'GET', `/api/rooms/${rr.data.roomId}`);
  assert.ok(rg.data.players.every((p) => p.lane == null), 'random: 로비에선 lane null');
  r = await http(base, 'POST', `/api/rooms/${rr.data.roomId}/start`, { hostToken: rr.data.hostToken });
  const lanes = r.data.players.map((p) => p.lane);
  assert.ok(lanes.every((l) => l != null), 'random: 시작 후 모두 배정');
  assert.strictEqual(new Set(lanes).size, lanes.length, 'random: 칸 중복 없음');
  ok('random 모드: 시작 시 빈 칸 랜덤 배정(중복 없음)');

  // 이름 없이 참여 → 랜덤 닉네임 부여
  let anon = await http(base, 'POST', '/api/rooms', { laneCount: 4, results: ['a','b','c','d'] });
  let a1 = await http(base, 'POST', `/api/rooms/${anon.data.roomId}/join`, { lane: 0 });
  let a2 = await http(base, 'POST', `/api/rooms/${anon.data.roomId}/join`, { name: '   ', lane: 1 });
  assert.ok(a1.data.name && a1.data.name.trim().length > 0, '이름 없이 join 시 랜덤 이름');
  assert.ok(!/^참가자/.test(a1.data.name), '기본값(참가자N)이 아닌 랜덤 이름');
  assert.ok(a2.data.name && a2.data.name.trim().length > 0, '공백 이름도 랜덤 이름으로 대체');
  ok('join: 이름 없이 참여 시 랜덤 닉네임 부여');

  // 디렉터리 트래버설 가드
  r = await fetch(base + '/../server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(r, 200, '트래버설로 server.js 노출 금지');
  const enc = await fetch(base + '/%2e%2e/server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(enc, 200, '인코딩 트래버설 차단');
  ok('정적 트래버설 가드 (../server.js 비노출)');

  // 없는 방
  r = await http(base, 'GET', '/api/rooms/zzzzzz');
  assert.strictEqual(r.status, 404);
  ok('없는 방 → 404');

  await new Promise((r) => server.close(r));
}

integration().then(() => {
  console.log(`\n✅ 모든 테스트 통과 (${passed}개)\n`);
  process.exit(0);
}).catch((e) => {
  console.error('\n❌ 테스트 실패:', e && e.message);
  console.error(e);
  process.exit(1);
});
