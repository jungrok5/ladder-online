// 광고 슬롯 로더 — 쿠팡 파트너스 + 카카오 애드핏.
//
// ⚙️  ID를 채우기 전까지는 아무것도 렌더하지 않습니다(빈 화면 그대로 유지).
//     등록 후 아래 window.ADS 값만 채우면 자동으로 켜집니다.
//
//   - 카카오 애드핏: 광고단위 코드(DAN-xxxxxxxx)를 adfit.main / adfit.result 에.
//   - 쿠팡 파트너스: 다이나믹 배너의 id(숫자) + trackingCode(문자)를 coupang 에.
window.ADS = {
  // 카카오 애드핏 — 슬롯별 광고단위(권장: 서로 다른 단위)
  adfit: {
    main: '',     // 메인(생성) 페이지 하단
    result: '',   // 결과 카드
    width: 320,
    height: 100,
  },
  // 쿠팡 파트너스 다이나믹 배너
  coupang: {
    id: 995865,                  // 발급 id (숫자)
    trackingCode: 'AF9050118',   // 발급 trackingCode (문자)
    subId: 'ladderonline',  // 채널 아이디(게임별 성과 분리)
    slot: 'both',                // 배너 위치: 'main' | 'result' | 'both'
    template: 'carousel',
    width: 360,
    height: 140,
  },
  disclosure: '이 게시물은 쿠팡 파트너스 활동의 일환으로 일정액의 수수료를 받습니다.',
};

(function () {
  let coupangLoading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function adLabel() {
    const l = document.createElement('div');
    l.className = 'ad-label'; l.textContent = 'AD';
    return l;
  }

  // 카카오 애드핏: <ins> 삽입 후 ba.min.js 로 렌더. SPA에서 새 ins를 위해 스크립트를 함께 추가.
  function mountAdfit(el, unit) {
    const a = window.ADS.adfit;
    const ins = document.createElement('ins');
    ins.className = 'kakao_ad_area';
    ins.style.display = 'none';
    ins.setAttribute('data-ad-unit', unit);
    ins.setAttribute('data-ad-width', String(a.width));
    ins.setAttribute('data-ad-height', String(a.height));
    el.appendChild(ins);
    const s = document.createElement('script');
    s.src = '//t1.daumcdn.net/kas/static/ba.min.js'; s.async = true;
    el.appendChild(s);
  }

  // 쿠팡 파트너스 다이나믹 배너 — 컨테이너 안에 인라인 스크립트를 넣어
  // 위젯이 '이 위치'에 배너를 그리도록 한다(외부에서 호출하면 엉뚱한 곳에 붙음).
  function mountCoupang(el) {
    const c = window.ADS.coupang;
    const inject = () => {
      const cfg = {
        id: c.id, template: c.template, trackingCode: c.trackingCode,
        subId: c.subId || null, width: String(c.width), height: String(c.height),
      };
      const s = document.createElement('script');
      s.text = 'new PartnersCoupang.G(' + JSON.stringify(cfg) + ');';
      el.appendChild(s);
      const d = document.createElement('p');
      d.className = 'ad-disclosure'; d.textContent = window.ADS.disclosure;
      el.appendChild(d);
    };
    if (window.PartnersCoupang) { inject(); return; }
    if (!coupangLoading) coupangLoading = loadScript('https://ads-partners.coupang.com/g.js');
    coupangLoading.then(inject).catch(() => {});
  }

  window.Ads = {
    // el: 광고를 넣을 컨테이너, slot: 'main' | 'result'
    mount(el, slot) {
      if (!el || el.dataset.adMounted) return;
      const cfg = window.ADS; let any = false;
      const unit = cfg.adfit && cfg.adfit[slot];
      if (unit) { el.appendChild(adLabel()); mountAdfit(el, unit); any = true; }
      const cp = cfg.coupang;
      if (cp && cp.id && cp.trackingCode && (cp.slot === slot || cp.slot === 'both')) {
        if (!any) el.appendChild(adLabel());
        mountCoupang(el); any = true;
      }
      if (any) el.dataset.adMounted = '1';
    },
    clear(el) { if (el) { el.innerHTML = ''; delete el.dataset.adMounted; } },
  };
})();
