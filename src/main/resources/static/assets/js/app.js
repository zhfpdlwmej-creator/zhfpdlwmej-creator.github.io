/*!
 * PromptSlim App — UI 바인딩 (엔진은 core.js, 토큰 계산은 token-worker.js)
 * 어떤 사용자 텍스트도 네트워크로 내보내지 않는다 (CSP connect-src 'none' 가 강제).
 */
(function () {
  'use strict';
  var C = window.PromptSlimCore;
  var $ = function (id) { return document.getElementById(id); };

  var input = $('input');
  var VIZ_LIMIT = 2000;      // 시각화 최대 토큰 수
  var LS = {
    theme: 'promptslim.theme',
    prices: 'promptslim.prices',
    rate: 'promptslim.usdkrw',
    viz: 'promptslim.viz',
    tab: 'promptslim.tab',
    cmpMode: 'promptslim.cmpmode',
    draft: 'promptslim.draft'
  };

  /* =====================================================================
   * 토스트
   * ===================================================================== */
  var toastEl = $('toast'), toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  /* =====================================================================
   * 테마 (light → dark → system 순환)
   * ===================================================================== */
  var mql = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(pref) {
    var dark = pref === 'dark' || (pref === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.setAttribute('data-theme-pref', pref);
  }
  function themePref() { try { return localStorage.getItem(LS.theme) || 'system'; } catch (e) { return 'system'; } }
  $('themeBtn').addEventListener('click', function () {
    var order = ['light', 'dark', 'system'];
    var next = order[(order.indexOf(themePref()) + 1) % 3];
    try { localStorage.setItem(LS.theme, next); } catch (e) {}
    applyTheme(next);
    toast(next === 'light' ? '☀️ 라이트 모드' : next === 'dark' ? '🌙 다크 모드' : '🖥️ 시스템 설정 따름');
  });
  mql.addEventListener('change', function () { applyTheme(themePref()); });

  /* =====================================================================
   * 단가 (localStorage 덮어쓰기 지원)
   * ===================================================================== */
  function loadPrices() {
    var map = {};
    try { map = JSON.parse(localStorage.getItem(LS.prices) || '{}') || {}; } catch (e) { map = {}; }
    return C.MODELS.map(function (m) {
      var p = typeof map[m.id] === 'number' && map[m.id] >= 0 ? map[m.id] : m.price;
      return Object.assign({}, m, { price: p, customized: p !== m.price });
    });
  }
  var models = loadPrices();
  $('priceAsOf').textContent = C.PRICE_AS_OF;

  // 환율 (원/달러) — localStorage 덮어쓰기 지원
  function loadRate() {
    try {
      var v = parseFloat(localStorage.getItem(LS.rate));
      if (!isNaN(v) && v > 0) return v;
    } catch (e) {}
    return C.DEFAULT_USD_KRW;
  }
  var usdKrw = loadRate();
  function won(usd) { return C.formatKRW(usd * usdKrw); }
  function syncRateLabel() { $('rateNow').textContent = usdKrw.toLocaleString('ko-KR'); }
  syncRateLabel();

  /* =====================================================================
   * 토큰 워커
   * ===================================================================== */
  var worker = null, workerReady = false, reqSeq = 0, lastDoneReq = 0;
  var statusEl = $('tokStatus');
  function setStatus(state, label) {
    statusEl.setAttribute('data-state', state);
    statusEl.querySelector('.label').textContent = label;
  }
  try {
    worker = new Worker('assets/js/token-worker.js', { type: 'module' });
    worker.onmessage = function (ev) {
      var msg = ev.data || {};
      if (msg.type === 'ready') {
        workerReady = true;
        setStatus('ready', '정밀 토큰 계산');
        requestCount(input.value); // 로딩 전 입력분 재계산
        return;
      }
      if (msg.type === 'error') {
        workerReady = false;
        setStatus('fallback', '근사 모드 (오프라인)');
        render(input.value, { count: C.estimateTokensHeuristic(input.value), approx: true });
        return;
      }
      if (msg.type === 'result') {
        if (msg.id < lastDoneReq) return; // 뒤늦게 도착한 옛 결과 무시
        lastDoneReq = msg.id;
        // 압축 직전 원문의 토큰 수 — 절감량 기준점 확정
        if (msg.ok && msg.beforeCount != null && baseline && baseline.pending) {
          baseline.tokens = msg.beforeCount;
          baseline.pending = false;
        }
        if (msg.ok) render(currentTextOf(msg.id), { count: msg.count, segments: msg.segments, truncated: msg.truncated, approx: false });
      }
    };
    worker.onerror = function () {
      workerReady = false;
      setStatus('fallback', '근사 모드');
      render(input.value, { count: C.estimateTokensHeuristic(input.value), approx: true });
    };
  } catch (e) {
    setStatus('fallback', '근사 모드');
  }

  // 요청 id → 그 시점 텍스트 (결과 수신 시 입력이 바뀌었으면 버린다)
  var reqTexts = {};
  function currentTextOf(id) { var t = reqTexts[id]; delete reqTexts[id]; return t == null ? input.value : t; }

  // 요청은 매번 보내고, 결과는 id(lastDoneReq)와 요청 시점 텍스트로 걸러낸다.
  // 토큰화는 워커에서 수 ms~수십 ms 수준이고 입력은 디바운스되므로 큐잉이 필요 없다.
  function requestCount(text, beforeText) {
    if (!worker || !workerReady) {
      if (beforeText != null && baseline && baseline.pending) {
        baseline.tokens = C.estimateTokensHeuristic(beforeText);
        baseline.pending = false;
      }
      render(text, { count: C.estimateTokensHeuristic(text), approx: true });
      return;
    }
    var id = ++reqSeq;
    reqTexts[id] = text;
    var msg = { type: 'count', id: id, text: text, segments: true, limit: VIZ_LIMIT };
    if (beforeText != null) msg.before = beforeText;
    worker.postMessage(msg);
  }

  /* =====================================================================
   * 렌더링
   * ===================================================================== */
  var lastTokens = 0;
  var baseline = null; // { tokens, chars } — 압축 전 원본 기준점

  function fmt(n) { return C.formatNumber(n); }

  function renderStats(text) {
    var st = C.analyze(text);
    $('sChars').textContent = fmt(st.chars);
    $('sCharsNs').textContent = fmt(st.charsNoSpace);
    $('sWords').textContent = fmt(st.words);
    $('sLines').textContent = fmt(st.lines);
    $('sBytes').textContent = fmt(st.bytes);
    return st;
  }

  function renderModels(baseTokens, approx) {
    var primary = $('primaryModels');
    primary.innerHTML = '';
    models.filter(function (m) { return m.primary; }).forEach(function (m) {
      var tok = C.modelTokens(baseTokens, m);
      var li = document.createElement('li');
      li.className = 'model-row';
      li.innerHTML =
        '<span class="vendor vendor--' + m.vendor + '"></span>' +
        '<span class="name">' + m.name + ' <small>' + (m.exact && !approx ? '정확' : '≈ 추정') + '</small></span>' +
        '<span class="tok">' + fmt(tok) + '<small>토큰</small></span>' +
        '<span class="cost">' + won(C.costUSD(tok, m.price)) + '</span>';
      li.title = '입력 단가 $' + m.price + ' / 1M tokens (' + C.formatUSD(C.costUSD(tok, m.price)) + ')';
      primary.appendChild(li);
    });

    var rows = $('modelRows');
    rows.innerHTML = '';
    models.forEach(function (m) {
      var tok = C.modelTokens(baseTokens, m);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + m.name + (m.exact && !approx ? '' : ' <span style="opacity:.55">≈</span>') + '</td>' +
        '<td>' + fmt(tok) + '</td>' +
        '<td title="' + C.formatUSD(C.costUSD(tok, m.price)) + '">' + won(C.costUSD(tok, m.price)) + '</td>' +
        '<td title="' + C.formatUSD(C.costUSD(tok, m.price) * 1000) + '">' + won(C.costUSD(tok, m.price) * 1000) + '</td>';
      rows.appendChild(tr);
    });
  }

  // 시각화는 접힌 상태가 기본 — 접혀 있으면 DOM 렌더링을 미루고 결과만 보관한다
  var vizStash = null;
  function renderViz(segments, truncated, total) {
    vizStash = { segments: segments, truncated: truncated, total: total };
    if (!vizOpen) return;
    var viz = $('viz'), note = $('vizNote');
    if (!segments || !segments.length) {
      viz.innerHTML = '<p class="viz-empty">' + (input.value
        ? '토크나이저 로딩 후 표시됩니다.'
        : '텍스트를 입력하면 토큰 단위로 색칠해 보여줍니다.') + '</p>';
      note.classList.add('hidden');
      return;
    }
    var showIds = $('vizIds').checked;
    var frag = document.createDocumentFragment();
    segments.forEach(function (seg, i) {
      var span = document.createElement('span');
      span.className = 'tk tk-' + (i % 5);
      // 공백·개행 가시화
      var text = seg.t;
      var parts = text.split(/(\n| )/);
      parts.forEach(function (p) {
        if (p === '\n') { var nl = document.createElement('span'); nl.className = 'ws ws-nl'; span.appendChild(nl); }
        else if (p === ' ') { var dot = document.createElement('span'); dot.className = 'ws ws-dot'; span.appendChild(dot); }
        else if (p) span.appendChild(document.createTextNode(p));
      });
      span.title = (seg.ids.length > 1 ? seg.ids.length + ' tokens ' : '') + '[' + seg.ids.join(', ') + ']';
      if (showIds) {
        var idEl = document.createElement('sub');
        idEl.className = 'tk-id';
        idEl.textContent = seg.ids.join(',');
        span.appendChild(idEl);
      }
      frag.appendChild(span);
    });
    viz.innerHTML = '';
    viz.appendChild(frag);
    if (truncated) {
      note.textContent = '성능을 위해 처음 ' + fmt(VIZ_LIMIT) + '개 토큰까지만 표시합니다 (전체 ' + fmt(total) + ' 토큰).';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }

  function renderSavings() {
    var body = $('saveBody'), empty = $('saveEmpty');
    if (!baseline || !input.value) { body.classList.add('hidden'); empty.classList.remove('hidden'); return; }
    var after = lastTokens;
    var saved = Math.max(0, baseline.tokens - after);
    var pct = baseline.tokens ? Math.round(saved / baseline.tokens * 100) : 0;
    $('svBefore').textContent = fmt(baseline.tokens);
    $('svAfter').textContent = fmt(after);
    $('svPct').textContent = '-' + pct + '%';
    $('svBar').style.width = Math.max(2, 100 - pct) + '%';
    $('svChars').textContent = fmt(Math.max(0, baseline.chars - C.analyze(input.value).chars)) + '자';
    var baseModel = models.find(function (m) { return m.base; });
    var savedUsd = C.costUSD(saved, baseModel.price) * 1000;
    $('svCost').textContent = won(savedUsd);
    $('svCost').title = C.formatUSD(savedUsd);
    empty.classList.add('hidden');
    body.classList.remove('hidden');
  }

  function render(text, tok) {
    if (text !== input.value) return; // 입력이 바뀐 옛 결과
    var st = renderStats(text);
    lastTokens = tok.count || 0;
    renderModels(lastTokens, tok.approx);
    if (!tok.approx) renderViz(tok.segments, tok.truncated, tok.count);
    else renderViz(null);
    // 미니 통계 + 모바일 바
    $('miniStat').textContent = fmt(st.chars) + '자 · ' + fmt(lastTokens) + ' 토큰' + (tok.approx ? '≈' : '');
    $('miniStat').classList.toggle('hidden', !text);
    $('mbTokens').textContent = fmt(lastTokens) + (tok.approx ? '≈' : '');
    var baseModel = models.find(function (m) { return m.base; });
    $('mbCost').textContent = won(C.costUSD(lastTokens, baseModel.price));
    renderSavings();
  }

  /* =====================================================================
   * 입력 처리 (디바운스)
   * ===================================================================== */
  var debounceTimer = null;
  function onInput(immediate) {
    clearTimeout(debounceTimer);
    var run = function () {
      requestCount(input.value);
      try { sessionStorage.setItem(LS.draft, input.value.slice(0, 200000)); } catch (e) {}
    };
    if (immediate) run();
    else debounceTimer = setTimeout(run, input.value.length > 50000 ? 250 : 120);
  }
  input.addEventListener('input', function () {
    if (baseline && !input.value) baseline = null;
    hideDiff(); // 사용자가 직접 수정하면 이전 변경 내역은 더 이상 유효하지 않다
    onInput(false);
  });

  /* =====================================================================
   * Undo + 압축 작업
   * ===================================================================== */
  var history = new C.History(100);
  var undoBtn = $('undoBtn');
  function refreshUndo() {
    undoBtn.disabled = history.size() === 0;
    $('undoCount').textContent = history.size() ? '(' + history.size() + ')' : '';
  }

  function snapshot() {
    history.push({ text: input.value, baseline: baseline ? Object.assign({}, baseline) : null });
    refreshUndo();
  }

  undoBtn.addEventListener('click', function () {
    var snap = history.pop();
    if (!snap) return;
    input.value = snap.text;
    baseline = snap.baseline;
    refreshUndo();
    hideDiff();
    onInput(true);
    toast('↩️ 원복했습니다');
  });

  var OPS = {
    whitespace: { fn: C.cleanWhitespace, done: function (r) { return '공백·줄바꿈 정리 완료 (' + C.formatNumber(r.removedChars) + '자 감소)'; } },
    fillers: { fn: C.removeFillers, done: function (r) { return '인사말·수식어 ' + r.removedCount + '곳 정리'; } },
    minify: { fn: C.minifyJsonAndCode, done: function (r) { return 'JSON ' + r.jsonCount + '개 · 코드 ' + r.codeCount + '개 압축'; } },
    all: { fn: C.optimizeAll, done: function (r) { return '한 번에 압축 완료 (' + C.formatNumber(r.removedChars) + '자 감소)'; } }
  };

  function runOp(op) {
    if (!input.value.trim()) { toast('먼저 텍스트를 입력하세요'); return; }
    var def = OPS[op];
    if (!def) return;
    var before = input.value;
    var result = def.fn(before);
    if (!result.changed) {
      // 이미 압축된 상태 — 마지막 변경 내역이 지금 텍스트와 일치하면 다시 펼쳐 보여준다
      if (lastDiff && lastDiff.after === input.value) {
        renderDiff(lastDiff.before, lastDiff.after, lastDiff.label);
        diffCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        toast('이미 압축된 상태예요 — 이전 변경 내역을 다시 열었습니다');
      } else {
        toast('더 줄일 내용이 없습니다 ✨');
      }
      return;
    }
    // 기준점(압축 전 원문) — 토큰 수는 워커 응답으로 확정하므로 일단 pending
    if (!baseline) baseline = { tokens: lastTokens, chars: C.analyze(before).chars, pending: true };
    snapshot();
    input.value = result.text;
    clearTimeout(debounceTimer);
    requestCount(input.value, baseline.pending ? before : null);
    try { sessionStorage.setItem(LS.draft, input.value.slice(0, 200000)); } catch (e) {}
    renderDiff(before, result.text, OP_LABELS[op]);
    toast('✂️ ' + def.done(result));
  }

  /* =====================================================================
   * 변경 내역(diff) 카드 — 압축 직전/직후 비교
   * ===================================================================== */
  var OP_LABELS = { whitespace: '공백·줄바꿈 정리', fillers: '인사말·수식어 제거', minify: 'JSON/코드 Minify', all: '한 번에 압축' };
  var diffCard = $('diffCard');
  var lastDiff = null;   // { before, after, label } — 마지막 압축의 변경 내역
  var diffOpen = true;   // 접기/펼치기 상태 (카드 자체는 유효한 diff 가 있는 한 유지)

  // 입력이 압축 결과와 달라졌을 때(직접 수정/원복/비우기) — 내역이 무효화되므로 카드 제거
  function hideDiff() {
    lastDiff = null;
    diffCard.classList.add('hidden');
  }

  function applyDiffOpen() {
    $('diffBody').classList.toggle('hidden', !diffOpen);
    document.querySelectorAll('.diff-option').forEach(function (el) { el.classList.toggle('hidden', !diffOpen); });
    var btn = $('diffToggle');
    btn.setAttribute('aria-expanded', diffOpen ? 'true' : 'false');
    btn.querySelector('.diff-toggle-label').textContent = diffOpen ? '접기' : '펼치기';
    btn.querySelector('.diff-toggle-chevron').style.transform = diffOpen ? '' : 'rotate(180deg)';
  }
  $('diffToggle').addEventListener('click', function () {
    diffOpen = !diffOpen;
    applyDiffOpen();
  });

  function renderDiff(before, after, label) {
    lastDiff = { before: before, after: after, label: label };
    var ops = C.diffText(before, after);
    var st = C.diffStats(ops);
    var frag = document.createDocumentFragment();
    ops.forEach(function (o) {
      if (o.type === 'same') { frag.appendChild(document.createTextNode(o.text)); return; }
      var el = document.createElement(o.type === 'del' ? 'del' : 'ins');
      el.className = o.type === 'del' ? 'diff-del' : 'diff-ins';
      el.textContent = o.text;
      frag.appendChild(el);
    });
    var body = $('diffBody');
    body.innerHTML = '';
    body.appendChild(frag);
    $('diffMeta').textContent = '[' + label + '] 삭제 ' + fmt(st.del) + '자' + (st.ins ? ' · 추가/치환 ' + fmt(st.ins) + '자' : '');
    diffOpen = true;
    applyDiffOpen();
    diffCard.classList.remove('hidden');
  }

  document.querySelectorAll('[data-op]').forEach(function (btn) {
    btn.addEventListener('click', function () { runOp(btn.getAttribute('data-op')); });
  });

  /* =====================================================================
   * 복사 / 비우기 / 샘플 / 파일
   * ===================================================================== */
  function copyResult() {
    if (!input.value) { toast('복사할 내용이 없습니다'); return; }
    var done = function () { toast('📋 클립보드에 복사했습니다 (' + C.formatNumber(lastTokens) + ' 토큰)'); };
    var fail = function () {
      input.focus(); input.select();
      toast('자동 복사가 막혀 있어 전체 선택했습니다 — Ctrl+C 를 누르세요');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, fail);
    } else fail();
  }
  $('copyBtn').addEventListener('click', copyResult);
  $('mbCopy').addEventListener('click', copyResult);

  $('clearBtn').addEventListener('click', function () {
    if (!input.value) return;
    snapshot();
    input.value = '';
    baseline = null;
    hideDiff();
    onInput(true);
    toast('🗑️ 비웠습니다 — [원복]으로 되돌릴 수 있어요');
  });

  var SAMPLE = [
    '안녕하세요 ChatGPT님! 바쁘시겠지만 부탁 하나 드리려고 합니다.',
    '',
    '',
    '아래   상품 데이터를 분석해서    카테고리별 평균 가격을 알려 주실 수 있을까요?',
    '',
    '{',
    '    "products": [',
    '        { "name": "무선 키보드", "category": "주변기기", "price": 45000 },',
    '        { "name": "USB-C 허브",  "category": "주변기기", "price": 32000 },',
    '        { "name": "모니터 27인치", "category": "디스플레이", "price": 289000 }',
    '    ]',
    '}',
    '',
    '결과는 표로 정리해 주시면 정말 감사하겠습니다.',
    '늘 도움 주셔서 감사합니다! 좋은 하루 되세요~'
  ].join('\n');

  $('sampleBtn').addEventListener('click', function () {
    if (input.value.trim()) snapshot();
    input.value = SAMPLE;
    baseline = null;
    hideDiff();
    onInput(true);
    toast('샘플을 넣었습니다 — [한 번에 압축]을 눌러 보세요');
  });

  function readFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('5MB 이하 텍스트 파일만 열 수 있습니다'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      if (input.value.trim()) snapshot();
      input.value = String(reader.result || '');
      baseline = null;
      hideDiff();
      onInput(true);
      toast('📄 ' + file.name + ' 을(를) 불러왔습니다 (브라우저에서만 읽음)');
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다'); };
    reader.readAsText(file);
  }
  $('fileInput').addEventListener('change', function (e) {
    readFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  // 드래그&드롭
  var editorWrap = input.parentElement, dragDepth = 0;
  ['dragenter', 'dragover'].forEach(function (ev) {
    editorWrap.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragenter') dragDepth++;
      editorWrap.classList.add('dragging');
    });
  });
  editorWrap.addEventListener('dragleave', function () {
    if (--dragDepth <= 0) { dragDepth = 0; editorWrap.classList.remove('dragging'); }
  });
  editorWrap.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    editorWrap.classList.remove('dragging');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  /* =====================================================================
   * 토큰 시각화 토글
   * ===================================================================== */
  var viz = $('viz');
  function syncVizOptions() {
    viz.classList.toggle('show-ws', $('vizWs').checked);
  }
  $('vizWs').addEventListener('change', syncVizOptions);
  $('vizIds').addEventListener('change', function () {
    if (vizStash) renderViz(vizStash.segments, vizStash.truncated, vizStash.total);
  });
  syncVizOptions();

  // 접기/펼치기 (기본: 접힘, 선택은 브라우저에 기억)
  var vizOpen = false;
  try { vizOpen = localStorage.getItem(LS.viz) === '1'; } catch (e) {}
  function applyVizOpen() {
    $('vizBody').classList.toggle('hidden', !vizOpen);
    document.querySelectorAll('.viz-option').forEach(function (el) { el.classList.toggle('hidden', !vizOpen); });
    var btn = $('vizToggle');
    btn.setAttribute('aria-expanded', vizOpen ? 'true' : 'false');
    btn.querySelector('.viz-toggle-label').textContent = vizOpen ? '접기' : '펼치기';
    btn.querySelector('.viz-toggle-chevron').style.transform = vizOpen ? 'rotate(180deg)' : '';
    if (vizOpen && vizStash) renderViz(vizStash.segments, vizStash.truncated, vizStash.total);
  }
  $('vizToggle').addEventListener('click', function () {
    vizOpen = !vizOpen;
    try { localStorage.setItem(LS.viz, vizOpen ? '1' : '0'); } catch (e) {}
    applyVizOpen();
  });
  applyVizOpen();

  /* =====================================================================
   * 단가 다이얼로그
   * ===================================================================== */
  var dlg = $('priceDialog');
  $('priceBtn').addEventListener('click', function () {
    var box = $('priceFields');
    box.innerHTML = '';
    models.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'price-field';
      row.innerHTML = '<label for="pf-' + m.id + '">' + m.name + (m.exact ? '' : ' ≈') + '</label>' +
        '<input id="pf-' + m.id + '" data-model="' + m.id + '" type="number" min="0" step="0.01" value="' + m.price + '">';
      box.appendChild(row);
    });
    $('pf-rate').value = usdKrw;
    if (typeof dlg.showModal === 'function') dlg.showModal();
  });
  dlg.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { dlg.close(); }); });
  $('priceReset').addEventListener('click', function () {
    try { localStorage.removeItem(LS.prices); localStorage.removeItem(LS.rate); } catch (e) {}
    models = loadPrices();
    usdKrw = loadRate();
    syncRateLabel();
    dlg.close();
    onInput(true);
    toast('단가·환율을 기본값으로 복원했습니다');
  });
  $('priceSave').addEventListener('click', function () {
    var map = {};
    dlg.querySelectorAll('input[data-model]').forEach(function (inp) {
      var v = parseFloat(inp.value);
      if (!isNaN(v) && v >= 0) map[inp.getAttribute('data-model')] = v;
    });
    var r = parseFloat($('pf-rate').value);
    try {
      localStorage.setItem(LS.prices, JSON.stringify(map));
      if (!isNaN(r) && r > 0) localStorage.setItem(LS.rate, String(r));
    } catch (e) {}
    models = loadPrices();
    usdKrw = loadRate();
    syncRateLabel();
    dlg.close();
    onInput(true);
    toast('단가·환율을 저장했습니다');
  });

  /* =====================================================================
   * 탭 전환 — 토큰 계산기 / 코드·문서 비교
   * ===================================================================== */
  var currentView = 'calc';
  function switchView(view) {
    currentView = view;
    $('view-calc').classList.toggle('hidden', view !== 'calc');
    $('view-cmp').classList.toggle('hidden', view !== 'cmp');
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.setAttribute('aria-selected', btn.getAttribute('data-view') === view ? 'true' : 'false');
    });
    // 하단 고정 바(토큰·비용)는 계산기 탭에서만
    document.querySelector('.mobile-bar').style.display = view === 'calc' ? '' : 'none';
    try { localStorage.setItem(LS.tab, view); } catch (e) {}
  }
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.getAttribute('data-view')); });
  });

  /* =====================================================================
   * 코드·문서 비교
   * ===================================================================== */
  var cmpA = $('cmpA'), cmpB = $('cmpB'), cmpOut = $('cmpOut');
  var CONTEXT = 3;            // 변경 주변에 보여줄 동일 줄 수
  var PAIR_MAX = 400;         // 줄 안 단어 하이라이트를 시도할 최대 줄 길이

  // 결과 보기 모드: 'unified'(한 줄 ±) | 'split'(원본|수정본 나란히)
  var cmpMode = 'unified';
  try { if (localStorage.getItem(LS.cmpMode) === 'split') cmpMode = 'split'; } catch (e) {}
  function applyCmpMode() {
    document.querySelectorAll('[data-cmpmode]').forEach(function (btn) {
      btn.setAttribute('aria-selected', btn.getAttribute('data-cmpmode') === cmpMode ? 'true' : 'false');
    });
  }
  document.querySelectorAll('[data-cmpmode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      cmpMode = btn.getAttribute('data-cmpmode');
      try { localStorage.setItem(LS.cmpMode, cmpMode); } catch (e) {}
      applyCmpMode();
      renderCompare();
    });
  });
  applyCmpMode();

  function cmpLineEl(cls, oldNo, newNo, mark, content) {
    var row = document.createElement('div');
    row.className = 'cmp-row' + (cls ? ' ' + cls : '');
    var no1 = document.createElement('span'); no1.className = 'cmp-no'; no1.textContent = oldNo == null ? '' : oldNo;
    var no2 = document.createElement('span'); no2.className = 'cmp-no'; no2.textContent = newNo == null ? '' : newNo;
    var mk = document.createElement('span'); mk.className = 'cmp-mark'; mk.textContent = mark;
    var tx = document.createElement('span'); tx.className = 'cmp-text';
    if (typeof content === 'string') tx.textContent = content;
    else tx.appendChild(content);
    row.appendChild(no1); row.appendChild(no2); row.appendChild(mk); row.appendChild(tx);
    return row;
  }

  /** 변경된 줄 쌍 → 한 줄 — 지워진 단어(취소선)와 추가된 단어(초록)를 함께 표시 */
  function wordDiffBoth(lineA, lineB) {
    var frag = document.createDocumentFragment();
    C.diffText(lineA, lineB).forEach(function (o) {
      if (o.type === 'same') { frag.appendChild(document.createTextNode(o.text)); return; }
      var el = document.createElement(o.type === 'del' ? 'del' : 'ins');
      el.className = o.type === 'del' ? 'diff-del' : 'diff-ins';
      el.textContent = o.text;
      frag.appendChild(el);
    });
    return frag;
  }

  /** 변경된 줄 쌍의 한쪽만 — side('del'|'ins') 단어만 강조, same 은 평문 */
  function wordDiffSide(lineA, lineB, side) {
    var frag = document.createDocumentFragment();
    C.diffText(lineA, lineB).forEach(function (o) {
      if (o.type === 'same') { frag.appendChild(document.createTextNode(o.text)); return; }
      if (o.type !== side) return;
      var el = document.createElement(side === 'del' ? 'del' : 'ins');
      el.className = side === 'del' ? 'diff-del' : 'diff-ins';
      el.textContent = o.text;
      frag.appendChild(el);
    });
    return frag;
  }

  /** diffLines 결과 → 화면 행 모델 (통합/좌우 렌더러가 공유) */
  function buildCmpRows(ops, showAll) {
    var rows = [];
    var oldNo = 1, newNo = 1;

    function pushSame(lines, isFirst, isLast) {
      var hidden = [];
      lines.forEach(function (line, idx) {
        var nearHead = idx < CONTEXT && !isFirst;
        var nearTail = idx >= lines.length - CONTEXT && !isLast;
        var row = { kind: 'same', oldNo: oldNo, newNo: newNo, text: line };
        if (showAll || nearHead || nearTail) {
          if (hidden.length) { rows.push({ kind: 'sep', rows: hidden }); hidden = []; }
          rows.push(row);
        } else {
          hidden.push(row);
        }
        oldNo++; newNo++;
      });
      if (hidden.length) rows.push({ kind: 'sep', rows: hidden });
    }

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'same') { pushSame(op.lines, i === 0, i === ops.length - 1); continue; }
      if (op.type === 'del') {
        var next = ops[i + 1];
        if (next && next.type === 'ins') {
          var paired = Math.min(op.lines.length, next.lines.length);
          for (var p = 0; p < paired; p++) {
            var la = op.lines[p], lb = next.lines[p];
            if (la.length > PAIR_MAX || lb.length > PAIR_MAX) {
              rows.push({ kind: 'del', oldNo: oldNo++, text: la });
              rows.push({ kind: 'ins', newNo: newNo++, text: lb });
            } else {
              rows.push({ kind: 'mod', oldNo: oldNo++, newNo: newNo++, a: la, b: lb });
            }
          }
          for (var p2 = paired; p2 < op.lines.length; p2++) rows.push({ kind: 'del', oldNo: oldNo++, text: op.lines[p2] });
          for (var q2 = paired; q2 < next.lines.length; q2++) rows.push({ kind: 'ins', newNo: newNo++, text: next.lines[q2] });
          i++;
          continue;
        }
        op.lines.forEach(function (line) { rows.push({ kind: 'del', oldNo: oldNo++, text: line }); });
        continue;
      }
      op.lines.forEach(function (line) { rows.push({ kind: 'ins', newNo: newNo++, text: line }); });
    }
    return rows;
  }

  function renderCompare() {
    var a = cmpA.value, b = cmpB.value;
    var statsEl = $('cmpStats');
    cmpOut.innerHTML = '';
    // 한쪽이라도 비어 있으면 비교하지 않는다
    if (!a.trim() || !b.trim()) {
      cmpOut.innerHTML = '<p class="viz-empty p-4">' + (!a.trim() && !b.trim()
        ? '양쪽에 내용을 넣으면 줄 단위로 비교해 보여줍니다.'
        : (!b.trim() ? '오른쪽에 수정본을 넣으면 비교가 시작됩니다.' : '왼쪽에 원본을 넣으면 비교가 시작됩니다.')) + '</p>';
      statsEl.classList.add('hidden');
      return;
    }
    if (a === b) {
      cmpOut.innerHTML = '<p class="cmp-same-note text-sm font-medium text-brand-700 dark:text-brand-400">✅ 두 내용이 완전히 동일합니다.</p>';
      statsEl.classList.add('hidden');
      return;
    }

    var ops = C.diffLines(a, b);
    var st = C.diffLineStats(ops);
    $('cmpMod').textContent = fmt(st.mod);
    $('cmpIns').textContent = fmt(st.ins);
    $('cmpDel').textContent = fmt(st.del);
    statsEl.classList.remove('hidden');

    var rows = buildCmpRows(ops, $('cmpSameAll').checked);
    cmpOut.appendChild(cmpMode === 'split' ? renderSplitRows(rows) : renderUnifiedRows(rows));
  }

  /* ---------- 통합 보기 (한 줄에 ± 표시) ---------- */
  function renderUnifiedRows(rows) {
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      if (r.kind === 'sep') {
        frag.appendChild(sepEl(r.rows, function (hidden) {
          var sub = document.createDocumentFragment();
          hidden.forEach(function (h) { sub.appendChild(cmpLineEl('', h.oldNo, h.newNo, '', h.text)); });
          return sub;
        }));
        return;
      }
      if (r.kind === 'same') { frag.appendChild(cmpLineEl('', r.oldNo, r.newNo, '', r.text)); return; }
      if (r.kind === 'mod') { frag.appendChild(cmpLineEl('cmp-row--mod', r.oldNo, r.newNo, '±', wordDiffBoth(r.a, r.b))); return; }
      if (r.kind === 'del') { frag.appendChild(cmpLineEl('cmp-row--del', r.oldNo, null, '-', r.text)); return; }
      frag.appendChild(cmpLineEl('cmp-row--ins', null, r.newNo, '+', r.text));
    });
    return frag;
  }

  /* ---------- 좌우 보기 (원본 | 수정본 나란히) ---------- */
  function splitCellEl(cls, no, content) {
    var cell = document.createElement('div');
    cell.className = 'cmp-cell' + (cls ? ' ' + cls : '');
    var noEl = document.createElement('span'); noEl.className = 'cmp-no'; noEl.textContent = no == null ? '' : no;
    var tx = document.createElement('span'); tx.className = 'cmp-text';
    if (content == null) cell.classList.add('cmp-cell--empty');
    else if (typeof content === 'string') tx.textContent = content;
    else tx.appendChild(content);
    cell.appendChild(noEl); cell.appendChild(tx);
    return cell;
  }

  function splitRowEl(leftCell, rightCell) {
    var row = document.createElement('div');
    row.className = 'cmp-split-row';
    row.appendChild(leftCell); row.appendChild(rightCell);
    return row;
  }

  function renderSplitRows(rows) {
    var wrap = document.createElement('div');
    wrap.className = 'cmp-split';
    rows.forEach(function (r) {
      if (r.kind === 'sep') {
        wrap.appendChild(sepEl(r.rows, function (hidden) {
          var sub = document.createDocumentFragment();
          hidden.forEach(function (h) {
            sub.appendChild(splitRowEl(splitCellEl('', h.oldNo, h.text), splitCellEl('', h.newNo, h.text)));
          });
          return sub;
        }));
        return;
      }
      if (r.kind === 'same') {
        wrap.appendChild(splitRowEl(splitCellEl('', r.oldNo, r.text), splitCellEl('', r.newNo, r.text)));
      } else if (r.kind === 'mod') {
        wrap.appendChild(splitRowEl(
          splitCellEl('cmp-cell--del', r.oldNo, wordDiffSide(r.a, r.b, 'del')),
          splitCellEl('cmp-cell--ins', r.newNo, wordDiffSide(r.a, r.b, 'ins'))
        ));
      } else if (r.kind === 'del') {
        wrap.appendChild(splitRowEl(splitCellEl('cmp-cell--del', r.oldNo, r.text), splitCellEl('', null, null)));
      } else {
        wrap.appendChild(splitRowEl(splitCellEl('', null, null), splitCellEl('cmp-cell--ins', r.newNo, r.text)));
      }
    });
    return wrap;
  }

  /** 숨긴 동일 줄 구분선 — 클릭하면 expand(hidden) 결과로 치환 */
  function sepEl(hiddenRows, expand) {
    var sep = document.createElement('div');
    sep.className = 'cmp-sep';
    sep.textContent = '⋯ 동일한 ' + fmt(hiddenRows.length) + '줄 숨김 — 누르면 펼침 ⋯';
    sep.addEventListener('click', function () { sep.replaceWith(expand(hiddenRows)); });
    return sep;
  }

  var cmpTimer = null;
  function onCmpInput() {
    clearTimeout(cmpTimer);
    cmpTimer = setTimeout(renderCompare, (cmpA.value.length + cmpB.value.length) > 50000 ? 300 : 120);
  }
  cmpA.addEventListener('input', onCmpInput);
  cmpB.addEventListener('input', onCmpInput);
  $('cmpSameAll').addEventListener('change', renderCompare);

  $('cmpSwap').addEventListener('click', function () {
    var t = cmpA.value; cmpA.value = cmpB.value; cmpB.value = t;
    renderCompare();
    toast('⇄ 원본과 수정본을 서로 바꿨습니다');
  });
  $('cmpClear').addEventListener('click', function () {
    cmpA.value = ''; cmpB.value = '';
    renderCompare();
  });
  $('cmpSample').addEventListener('click', function () {
    cmpA.value = [
      'function calcTotal(items) {',
      '  let total = 0;',
      '  for (let i = 0; i < items.length; i++) {',
      '    total += items[i].price;',
      '  }',
      '  return total;',
      '}',
      '',
      '// 장바구니 합계를 표시한다',
      'render(calcTotal(cart));'
    ].join('\n');
    cmpB.value = [
      'function calcTotal(items, discount = 0) {',
      '  let total = 0;',
      '  for (let i = 0; i < items.length; i++) {',
      '    total += items[i].price * items[i].qty;',
      '  }',
      '  return total - discount;',
      '}',
      '',
      '// 장바구니 합계를 표시한다',
      'render(calcTotal(cart, coupon));',
      'logEvent("cart_total");'
    ].join('\n');
    renderCompare();
    toast('샘플을 넣었습니다 — 바뀐 줄과 단어가 강조됩니다');
  });

  /* =====================================================================
   * 단축키
   * ===================================================================== */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runOp('all'); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoBtn.click(); }
  });

  /* =====================================================================
   * 초기화 — 세션 초안 복원
   * ===================================================================== */
  try {
    var draft = sessionStorage.getItem(LS.draft);
    if (draft && !input.value) input.value = draft;
  } catch (e) {}
  refreshUndo();
  try {
    if (localStorage.getItem(LS.tab) === 'cmp') switchView('cmp');
  } catch (e) {}
  onInput(true);
})();
