# 🎟️ jebi-online 작업 핸드오프 (제비뽑기 온라인)

> **새 세션 시작용 문서.** 이 세션에는 참고용 `ladder-online`과 작업 대상 `jebi-online`
> 두 레포를 붙여 시작하세요. **이 파일을 먼저 읽고**, `ladder-online`의 코드를 골격으로
> 재사용해 `jebi-online`을 구현합니다. 작업/커밋/푸시는 **`jebi-online` 레포**에 합니다.
> (참고: `rps-online` → `ladder-online` 핸드오프와 동일한 방식. ladder는 rps를 베꼈고,
> jebi는 ladder를 벱니다.)

## 0. 한 줄 요약
RPS·사다리와 **동일한 아키텍처**(무DB·인메모리·폴링·zero-dep Node 서버·정적 HTML, 3D 연출 +
2D 폴백)로 **제비뽑기 온라인**을 만든다. 방장이 N개의 제비에 결과(자유 입력)를 숨겨 넣고 →
링크 공유 → 각자 제비를 직접 고르고 → 방장이 시작하면 결과가 **랜덤 순열로 제비에 배정**되며 →
캐릭터가 자기 제비를 뽑아 **펼치는 순간** 결과가 공개된다.

## 1. 사다리와의 관계 (핵심!)
제비뽑기의 결과 배정은 **그냥 무작위 순열**이다. 즉 `ladder-online`에서 사다리 생성·경로추적
(`buildLadder`/`tracePath`/`computeMapping`)을 **Fisher–Yates 셔플 한 줄(`buildMapping`)로 교체**
하면 서버 로직은 거의 그대로다. 차이는 오직 **연출**(사다리 하강 → 제비 뽑아 펼치기)과
**용어**(lane→slot 등), 그리고 **결과 기본 숨김**이다.

## 2. 시작 절차 (새 세션에서)
1. 작업 브랜치: `jebi-online`에서 세션이 지정한 브랜치(없으면 `claude/jebi-online-<slug>`).
2. `ladder-online/`의 다음 파일을 **그대로 베껴 골격으로** 사용:
   - `server.js` — 순수 Node http 서버(라우팅·정적서빙·gzip·캐시·MIME·룸 저장소·12h 정리)
   - `public/index.html`(생성), `public/room.html`(폴링 SPA), `public/style.css`
   - `public/scene.js` — 3D 무대(Three.js 동봉·Kenney 캐릭터 로딩·카메라 자동 프레이밍·2D 폴백)
   - `public/vendor/*`(three.module.js + jsm), `public/assets/characters/*`(Kenney GLB) **복사**
   - `render.yaml`, `package.json`, `.gitignore`, `test/`
3. 게임 부분만 제비뽑기 로직(3~6장)으로 교체.
4. **에셋 결정(7장)**: Kenney에서 제비/종이/카드/두루마리/티켓 프롭을 찾고, 적당하면 그걸로
   제비를 표현. 없으면 Three.js 기본 도형(둥근 박스/평면)으로.

## 3. 게임 모델 / 룸 상태
```js
room = {
  id, hostToken, createdAt,
  title,                         // 예: "점심 제비뽑기"
  status: 'lobby' | 'revealing' | 'finished',
  slotCount: N,                  // 제비 수 = 결과 수 = 최대 인원, 2..MAX_SLOTS
  results: [N strings],          // 각 제비에 담길 결과(자유 입력)
  resultsHidden: true,           // 기본: 뽑기 전 숨김 (제비뽑기의 묘미)
  drawMode: 'pick' | 'random',   // 기본 'pick'(제비 직접 선택)
  players: [{ id, name, slot: int|null }],  // slot = 고른 제비 인덱스(0..N-1)
  mapping: null | int[N],        // 제비 인덱스 -> 결과 인덱스 (시작 시 셔플로 확정, 순열)
}
```
> 결정사항(확정): **결과 숨김**, **pick 모드**, **3D 캐릭터 연출**.

## 4. 결과 배정 (서버, `/start` 시) — 사다리 생성 대체
```js
// 0..N-1 의 무작위 순열 (암호학적). 제비 인덱스 s 는 results[mapping[s]] 를 가진다.
function buildMapping(N) {
  const m = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [m[i], m[j]] = [m[j], m[i]];
  }
  return m;
}
```
- 항상 전단사(순열) → 모든 결과가 정확히 한 번씩 배정됨(테스트에서 assert).
- 플레이어가 고른 제비 `slot` 의 최종 결과 = `results[mapping[slot]]`.

## 5. API (ladder와 동일한 형태, 용어만 교체)
- `POST /api/rooms` `{ title, slotCount, results[], drawMode, resultsHidden }` → 검증 후 `{ roomId, hostToken }`
- `POST /api/rooms/:id/join` `{ name, slot? }`
  - `pick`: 빈 제비면 배정, 점유면 409, `slot` 없으면 가장 작은 빈 제비. 범위 밖 400.
  - `random`: slot=null → `/start`에서 일괄 랜덤 배정.
  - lobby 아닐 때 join 거부(관전). 이름 미입력 시 **랜덤 닉네임**(아래 8장).
- `POST /api/rooms/:id/start` `{ hostToken }` → 참가 ≥ 2, random이면 빈 제비 랜덤 배정,
  **mapping 셔플 생성**, `status='revealing'`.
- `GET /api/rooms/:id` → `publicState`. **시작 전에는 `mapping` 절대 노출 금지**, 결과도
  `resultsHidden`이면 시작 전 숨김(= `(!resultsHidden || started) ? results : null`).
- `POST /api/rooms/:id/finish` → 멱등, `revealing → finished`.
- `POST /api/rooms/:id/reset` `{ hostToken }` → lobby (mapping 초기화, pick 제비 유지 / random은 비움).

## 6. 클라이언트 연출 (3D 기본 + 2D 폴백)
- **로비**: 중앙에 N개의 제비(말린 종이/카드)를 통/홀더에 꽂아 보여주고, 캐릭터는 자기 제비
  근처에 대기. HUD에서 빈 제비를 눌러 선택(pick). 공유 링크 복사(**제목+링크**), 방장 "시작".
- **공개(revealing)**: "🥁 두구두구" → 각 캐릭터가 자기 제비를 뽑아 **펼치는(언롤/플립)** 애니메이션
  → 결과 텍스트가 머리 위로 떠오름. **내 제비를 맨 마지막에** 공개(쫄깃) — RPS `playReveal`의
  순차 공개·`failsafe`·중복가드(`done`) 패턴 재사용. 완료 후 `/finish` 호출.
- **결과(finished)**: 각 캐릭터가 펼친 제비(결과 라벨)를 든 채 정렬. 방장 "다시 섞기"(reset).
- **제비 표현**: 7장 에셋 결정에 따라 (a) Kenney 프롭 GLB 또는 (b) Three.js 기본 도형
  (둥근 박스/평면). 결과 텍스트는 **CSS2D 라벨**(ladder의 `.result`/`.nick` 패턴) 또는
  `CanvasTexture`로 제비 면에 인쇄.
- **2D 폴백**: 카드들이 뒷면으로 깔려 있다가 `rotateY` 플립으로 결과 공개 + 강조. (ladder의
  `reveal2D` SVG 패턴을 카드 플립으로 변형)

## 7. 에셋 결정 (착수 시 사용자 지시 반영)
- **캐릭터**: `ladder-online/public/assets/characters/`의 Kenney Mini Characters를 **그대로 복사·재사용**.
- **제비/종이 프롭**: Kenney(CC0)에서 **scroll/paper/card/ticket/envelope/box** 류 3D 프롭이
  있는지 먼저 탐색(예: Boardgame/Generic Items 계열). *적당한 GLB가 있으면 그것으로* 제비를 표현,
  **없으면 원래 계획대로** Three.js 기본 도형(평면/박스)으로 제비를 만들고 펼침 애니메이션을 준다.
- 어떤 경우든 **외부 CDN 의존 없이** `public/`에 동봉(라이선스 파일 포함).

## 8. RPS·사다리에서 얻은 교훈 (반드시 반영)
- **이름 미입력 → 랜덤 닉네임**: `randomName()`(형용사+동물) + `uniqueRandomName(room)`으로
  **방에 없는 닉네임을 골라** 부여(숫자 접미사 방지). 직접 입력 이름 중복만 숫자 접미사.
- **시작 전 비밀 누출 금지**: `publicState`에서 `mapping` 제외, 숨김이면 `results`도 제외.
- **클라 전역 상수 누락 금지**, **HTML `no-store` / vendor·assets `immutable`**,
  **토큰·방ID `crypto.randomInt`**, **자원 상한**(MAX_ROOMS, MAX_SLOTS≈12·하드캡 50, 이름 슬라이스),
  **입력 검증**(slotCount 정수·범위, results.length===slotCount·길이 제한, drawMode 화이트리스트),
  **연출 failsafe 타이머 + 중복 실행 가드**, **정적 트래버설 가드**, **인터벌 `.unref()`**, **12h 룸 정리**.
- ladder는 1초 인터벌이 불필요했음(마감 없음) → jebi도 동일하게 **12h 정리 인터벌만**.

## 9. 검증 (ladder와 동일)
- **무의존성 Node 하니스**(`test/test.js`, Node 전역 fetch):
  - 단위: `buildMapping`이 N=2..12에서 항상 0..N-1 **순열**인지(다회 반복) + 입력 정규화.
  - 통합(실제 HTTP): 방 생성/검증, join 제비 충돌·범위·자동배정, 이름중복·**랜덤닉네임(숫자없음)**,
    **시작 전 mapping/results 미노출**, start(토큰·최소인원), random 배정, finish, reset(제비 유지),
    트래버설 가드, 404. `npm test`로 실행.
- **Playwright 헤드리스 스모크**(`test/smoke.mjs`, `--use-gl=swiftshader`): 3D 무대 콘솔 에러 0 +
  스크린샷(`docs/`). 브라우저는 `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
- 푸시: `git push -u origin <branch>`, 네트워크 실패 시 지수 백오프 재시도.

## 10. 참고 파일 (ladder-online)
- `server.js` — 서버 골격 전체(복사 후 사다리 로직만 `buildMapping`으로 교체, lane→slot 용어 변경)
- `public/scene.js` — Three.js 동봉·Kenney 로딩·카메라 자동 프레이밍·2D 폴백(연출만 제비 펼치기로)
- `public/room.html` — 폴링/렌더/연출(`playReveal`·`failsafe`·copy)·importmap 패턴
- `public/index.html` — 칸(제비) 수 스텝퍼 + 결과 자유 입력 생성 페이지
- `test/test.js`, `test/smoke.mjs` — 검증 하니스
- `render.yaml`, `README.md` — 배포/문서 패턴(서비스 `name`은 고유하게: 예 `jebi-online` 선점 시
  `jebi-online-xx`로 붙으므로, 충돌하면 더 고유한 이름으로. branch는 배포 브랜치와 일치시킬 것)

---
**첫 행동 제안:** ladder 골격 이식(server/scene/html/css/vendor/assets/test 복사) → `buildMapping`으로
교체 + lane→slot 용어 정리 → 제비 펼치기 3D 연출(+2D 폴백) → 테스트 통과 → README·스크린샷 →
Render 배포. (결정사항: 결과 숨김 · pick · 3D 캐릭터.)
