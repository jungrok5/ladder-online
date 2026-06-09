// Playwright 헤드리스 스모크: 3D 무대 콘솔 에러 0 확인 + 스크린샷 캡처.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync('docs', { recursive: true });

const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
await sleep(800);

const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  return page;
}

async function api(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

try {
  // 호스트: 생성 페이지에서 방 만들기
  const host = await newPage('host');
  await host.goto(BASE + '/', { waitUntil: 'networkidle' });
  await host.fill('#title', '점심 사다리 🍜');
  // 4칸 → 6칸으로
  await host.click('#plus'); await host.click('#plus');
  const inputs = await host.$$('#results input');
  const labels = ['꽝', '커피', '꽝', '당첨', '꽝', '디저트'];
  for (let i = 0; i < inputs.length; i++) await inputs[i].fill(labels[i] || `결과${i+1}`);
  await host.screenshot({ path: 'docs/create.png' });
  await Promise.all([
    host.waitForURL(/\/r\//),
    host.click('#create'),
  ]);
  const roomId = host.url().split('/r/')[1].split('#')[0];
  console.log('room:', roomId);

  // 참가자 5명 API 로 합류 (칸 선택)
  for (let i = 0; i < 5; i++) await api(`/api/rooms/${roomId}/join`, { name: ['철수','영희','민수','지현','상현'][i], lane: i });

  await sleep(2500); // 3D 로딩 + 캐릭터 spawn
  await host.screenshot({ path: 'docs/lobby.png' });

  // 시작 → 사다리 하강 연출
  await host.click('#startBtn');
  await sleep(2600);
  await host.screenshot({ path: 'docs/reveal.png' });

  // 도착 완료까지 대기
  await sleep(6000);
  await host.screenshot({ path: 'docs/finished.png' });

  console.log('charCount:', await host.evaluate(() => window.L3D && window.L3D.charCount && window.L3D.charCount()));
  console.log('has3d:', await host.evaluate(() => document.body.classList.contains('has3d')));
} catch (e) {
  errors.push('스크립트 예외: ' + e.message);
  console.error(e);
} finally {
  await browser.close();
  srv.kill('SIGTERM');
}

if (errors.length) {
  console.error('\n❌ 콘솔/페이지 에러 발견:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log('\n✅ 스모크 통과: 콘솔 에러 0, 스크린샷 4장 저장(docs/)');
process.exit(0);
