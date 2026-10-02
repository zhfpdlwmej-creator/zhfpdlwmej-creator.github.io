/*!
 * PromptSlim Core — 순수 함수 엔진 (DOM/네트워크 의존 없음)
 *  - 브라우저: window.PromptSlimCore
 *  - Node(테스트): require('.../core.js')
 *
 * 이 파일은 어떤 네트워크 API도 사용하지 않는다 (fetch/XHR/beacon/WebSocket 금지 — 테스트로 강제).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PromptSlimCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * 0. 모델 / 가격 (API 입력 비용, USD per 1M tokens)
   *    factor : o200k_base(GPT-4o) 토큰 수 대비 추정 배율
   *    exact  : true 면 실제 토크나이저 결과 그대로
   * ===================================================================== */
  var PRICE_AS_OF = '2026-10';
  // base : 토큰 수 기준 모델(OpenAI o200k 토크나이저 직접 계산) — 절감량/모바일 바 표시에 사용
  var MODELS = [
    { id: 'gpt-6-astra',       vendor: 'openai',    name: 'GPT-6 Astra',       price: 10.00, factor: 1.00, exact: true,  primary: true, base: true },
    { id: 'gpt-6-sol',         vendor: 'openai',    name: 'GPT-6 Sol',         price: 2.00,  factor: 1.00, exact: true },
    { id: 'claude-fable-5-1',  vendor: 'anthropic', name: 'Claude Fable 5.1',  price: 10.00, factor: 1.30, exact: false, primary: true },
    { id: 'claude-opus-5-5',   vendor: 'anthropic', name: 'Claude Opus 5.5',   price: 4.00,  factor: 1.30, exact: false },
    { id: 'claude-sonnet-5-5', vendor: 'anthropic', name: 'Claude Sonnet 5.5', price: 2.00,  factor: 1.30, exact: false },
    { id: 'claude-haiku-4-5',  vendor: 'anthropic', name: 'Claude Haiku 4.5',  price: 1.00,  factor: 1.15, exact: false },
    { id: 'gemini-3-1-pro',    vendor: 'google',    name: 'Gemini 3.1 Pro',    price: 2.00,  factor: 1.00, exact: false, primary: true },
    { id: 'gemini-3-flash',    vendor: 'google',    name: 'Gemini 3 Flash',    price: 0.50,  factor: 1.00, exact: false }
  ];
  var BASE_MODEL = MODELS.filter(function (m) { return m.base; })[0];

  // 기본 환율 (원/달러) — 네트워크 호출이 없는 서비스라 고정값. 화면 [단가 편집]에서 수정 가능
  var DEFAULT_USD_KRW = 1435;

  /* =====================================================================
   * 1. 공통 유틸
   * ===================================================================== */
  var ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
  var NBSP_RE = /[  -   　]/g; // 각종 폭 공백 → 일반 공백

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(ZERO_WIDTH_RE, '')
      .replace(NBSP_RE, ' ');
  }

  /**
   * 마크다운 코드 펜스(``` / ~~~) 기준으로 텍스트를 분할한다.
   * 반환: [{ type:'text', content } | { type:'code', lang, open, body, close }]
   * 닫히지 않은 펜스는 끝까지 코드로 취급한다.
   */
  function splitFences(text) {
    var lines = text.split('\n');
    var out = [];
    var buf = [];
    var i = 0;
    function flushText() {
      if (buf.length) { out.push({ type: 'text', content: buf.join('\n') }); buf = []; }
    }
    while (i < lines.length) {
      var m = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/.exec(lines[i]);
      if (!m) { buf.push(lines[i]); i++; continue; }
      var fence = m[1];
      var closeRe = new RegExp('^[ \\t]*' + (fence.charAt(0) === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
      var j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      flushText();
      out.push({
        type: 'code',
        lang: (m[2] || '').toLowerCase(),
        open: lines[i],
        body: lines.slice(i + 1, j).join('\n'),
        close: j < lines.length ? lines[j] : null
      });
      i = j < lines.length ? j + 1 : j;
    }
    flushText();
    return out;
  }

  function joinFences(parts) {
    var chunks = [];
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (p.type === 'text') { chunks.push(p.content); continue; }
      var block = [p.open];
      if (p.body !== '' || p.close !== null) block.push(p.body);
      if (p.close !== null) block.push(p.close);
      chunks.push(block.join('\n'));
    }
    return chunks.join('\n');
  }

  function collapseBlankLines(s) {
    return s.replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, '\n\n');
  }

  /* =====================================================================
   * 2. 통계
   * ===================================================================== */
  var segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
  } catch (e) { segmenter = null; }

  /** 사용자가 인지하는 "글자" 단위(그래핌) 수 — 이모지·결합 문자 1자로 계산 */
  function countGraphemes(s) {
    if (!s) return 0;
    // ASCII 만 있으면 빠른 경로
    if (!/[^\x00-\x7F]/.test(s)) return s.length;
    if (segmenter) {
      var n = 0;
      var it = segmenter.segment(s)[Symbol.iterator]();
      while (!it.next().done) n++;
      return n;
    }
    return Array.from(s).length;
  }

  function utf8Bytes(s) {
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  function analyze(text) {
    var s = String(text == null ? '' : text);
    var words = s.match(/\S+/g);
    return {
      chars: countGraphemes(s),
      charsNoSpace: countGraphemes(s.replace(/\s+/g, '')),
      words: words ? words.length : 0,
      lines: s.length ? s.split(/\r\n|\r|\n/).length : 0,
      bytes: utf8Bytes(s)
    };
  }

  /**
   * 토크나이저(CDN) 로딩 실패 시 쓰는 근사 추정기 (o200k_base 경향 반영).
   *  - 라틴 단어: ~4자당 1토큰, 숫자: 3자리당 1토큰
   *  - 한글: 음절당 ~0.6토큰 / 한자·가나: 글자당 ~0.9토큰
   *  - 기호: 1토큰, 줄바꿈 묶음: 1토큰
   */
  function estimateTokensHeuristic(text) {
    var s = String(text == null ? '' : text);
    if (!s) return 0;
    var re = /[A-Za-z]+|\d+|[가-힣]+|[぀-ヿ㐀-鿿]+|\n+|[ \t]+|[^\sA-Za-z\d가-힣぀-ヿ㐀-鿿]/g;
    var m, total = 0;
    while ((m = re.exec(s)) !== null) {
      var t = m[0], c = t.charCodeAt(0);
      if (/[A-Za-z]/.test(t[0])) total += Math.max(1, Math.round(t.length / 4));
      else if (c >= 48 && c <= 57) total += Math.ceil(t.length / 3);
      else if (c >= 0xAC00 && c <= 0xD7A3) total += Math.max(1, Math.round(t.length * 0.6));
      else if (c >= 0x3040 && c <= 0x9FFF) total += Math.max(1, Math.round(t.length * 0.9));
      else if (t[0] === '\n') total += 1;
      else if (t[0] === ' ' || t[0] === '\t') total += t.length > 1 ? 1 : 0; // 단일 공백은 다음 단어에 병합
      else total += 1;
    }
    return total;
  }

  function modelTokens(baseTokens, model) {
    if (!baseTokens) return 0;
    return model.exact ? baseTokens : Math.max(1, Math.round(baseTokens * model.factor));
  }

  function costUSD(tokens, pricePerMillion) {
    return (tokens || 0) * (pricePerMillion || 0) / 1e6;
  }

  function formatUSD(v) {
    if (!v) return '$0';
    if (v >= 100) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    // 아주 작은 금액: 유효숫자 3자리
    var digits = Math.min(10, Math.max(3, 2 - Math.floor(Math.log10(v))));
    return '$' + v.toFixed(digits).replace(/0+$/, '');
  }

  function formatNumber(n) {
    return (n || 0).toLocaleString('ko-KR');
  }

  /** 원화 표기 — 1원 미만은 소수로, 큰 금액은 천 단위 구분 */
  function formatKRW(won) {
    if (!won) return '0원';
    if (won >= 100) return Math.round(won).toLocaleString('ko-KR') + '원';
    if (won >= 1) return (Math.round(won * 10) / 10).toLocaleString('ko-KR') + '원';
    if (won >= 0.01) return (Math.round(won * 100) / 100) + '원';
    var digits = Math.min(8, Math.max(3, 2 - Math.floor(Math.log10(won))));
    return won.toFixed(digits).replace(/0+$/, '') + '원';
  }

  /* =====================================================================
   * 2.5 변경 내역(diff) — 단어 단위 LCS. 압축 전/후를 비교해
   *     [{type:'same'|'del'|'ins', text}] 로 반환한다.
   * ===================================================================== */
  function tokenizeForDiff(s) {
    return String(s == null ? '' : s).split(/(\s+)/).filter(function (t) { return t !== ''; });
  }

  function diffText(before, after) {
    var a = tokenizeForDiff(before), b = tokenizeForDiff(after);
    // 대용량이면 줄 단위로 낮춰 O(n·m) 폭주 방지
    if (a.length > 1500 || b.length > 1500) {
      a = String(before).split(/(\n)/).filter(Boolean);
      b = String(after).split(/(\n)/).filter(Boolean);
      if (a.length > 1500 || b.length > 1500) {
        return [{ type: 'del', text: String(before) }, { type: 'ins', text: String(after) }];
      }
    }
    var n = a.length, m = b.length;
    // LCS 길이 테이블 (Int32, (n+1)×(m+1))
    var W = m + 1;
    var dp = new Int32Array((n + 1) * W);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[i] === b[j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    var ops = [];
    var x = 0, y = 0;
    function push(type, text) {
      var last = ops[ops.length - 1];
      if (last && last.type === type) last.text += text;
      else ops.push({ type: type, text: text });
    }
    while (x < n && y < m) {
      if (a[x] === b[y]) { push('same', a[x]); x++; y++; }
      else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) { push('del', a[x]); x++; }
      else { push('ins', b[y]); y++; }
    }
    while (x < n) { push('del', a[x]); x++; }
    while (y < m) { push('ins', b[y]); y++; }
    // 공백만 삭제/추가된 조각이 같은 쌍 사이에 끼면 그대로 두되, 의미 없는 same-공백은 병합돼 있음
    return ops;
  }

  /* =====================================================================
   * 2.6 코드·문서 비교 — 줄 단위 LCS diff
   *     반환: [{type:'same'|'del'|'ins', lines:[string]}]
   *     전략: 공통 접두/접미 줄을 먼저 떼어내고(코드 수정의 대부분을 흡수)
   *           가운데만 LCS — 그래도 너무 크면 통짜 del/ins 로 강등
   * ===================================================================== */
  function diffLines(before, after) {
    var a = String(before == null ? '' : before).replace(/\r\n?/g, '\n').split('\n');
    var b = String(after == null ? '' : after).replace(/\r\n?/g, '\n').split('\n');

    // 공통 접두/접미
    var pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    var sufA = a.length, sufB = b.length;
    while (sufA > pre && sufB > pre && a[sufA - 1] === b[sufB - 1]) { sufA--; sufB--; }

    var midA = a.slice(pre, sufA), midB = b.slice(pre, sufB);
    var ops = [];
    function push(type, lines) {
      if (!lines.length) return;
      var last = ops[ops.length - 1];
      if (last && last.type === type) last.lines = last.lines.concat(lines);
      else ops.push({ type: type, lines: lines });
    }

    push('same', a.slice(0, pre));

    var LIMIT = 1500;
    if (midA.length > LIMIT || midB.length > LIMIT) {
      push('del', midA);
      push('ins', midB);
    } else if (midA.length || midB.length) {
      var n = midA.length, m = midB.length, W = m + 1;
      var dp = new Int32Array((n + 1) * W);
      for (var i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
          dp[i * W + j] = midA[i] === midB[j]
            ? dp[(i + 1) * W + j + 1] + 1
            : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
        }
      }
      var x = 0, y = 0;
      while (x < n && y < m) {
        if (midA[x] === midB[y]) { push('same', [midA[x]]); x++; y++; }
        else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) { push('del', [midA[x]]); x++; }
        else { push('ins', [midB[y]]); y++; }
      }
      if (x < n) push('del', midA.slice(x));
      if (y < m) push('ins', midB.slice(y));
    }

    push('same', a.slice(sufA));
    return ops;
  }

  /** 줄 diff 요약 — 삭제/추가/변경 줄 수 (인접한 del+ins 쌍은 '변경'으로 집계) */
  function diffLineStats(ops) {
    var del = 0, ins = 0, mod = 0;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === 'del') {
        var next = ops[i + 1];
        if (next && next.type === 'ins') {
          var paired = Math.min(ops[i].lines.length, next.lines.length);
          mod += paired;
          del += ops[i].lines.length - paired;
          ins += next.lines.length - paired;
          i++;
        } else {
          del += ops[i].lines.length;
        }
      } else if (ops[i].type === 'ins') {
        ins += ops[i].lines.length;
      }
    }
    return { del: del, ins: ins, mod: mod };
  }

  /** diff 요약 — 삭제/추가 글자 수 */
  function diffStats(ops) {
    var del = 0, ins = 0;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === 'del') del += ops[i].text.length;
      else if (ops[i].type === 'ins') ins += ops[i].text.length;
    }
    return { del: del, ins: ins };
  }

  /* =====================================================================
   * 3. 압축 1 — 불필요한 공백/줄바꿈 정리
   * ===================================================================== */
  function cleanWhitespace(input) {
    var before = String(input == null ? '' : input);
    var parts = splitFences(normalize(before));
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (p.type === 'text') {
        p.content = collapseBlankLines(
          p.content.split('\n').map(function (line) {
            return line.replace(/[ \t\f\v]+/g, ' ').trim();
          }).join('\n')
        );
      } else {
        // 코드 내부는 들여쓰기 보존, 줄 끝 공백·연속 빈 줄만 정리
        p.body = collapseBlankLines(p.body.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n'));
      }
    }
    var after = joinFences(parts).replace(/^\s+|\s+$/g, '');
    after = collapseBlankLines(after);
    return { text: after, changed: after !== before, removedChars: Math.max(0, before.length - after.length) };
  }

  /* =====================================================================
   * 4. 압축 2 — AI 인사말 / 수식어 제거
   *    (A) 문장 전체가 군더더기면 문장 삭제
   *    (B) 문장 안의 정중 표현·완충어는 축약
   *    코드 펜스 내부는 건드리지 않는다.
   * ===================================================================== */
  var P_END = '[\\s.!?~^,·…:;)）*]*'; // 문장 꼬리(구두점/이모티콘)

  // (A) 문장 단위 — 트리밍된 문장 전체와 매칭
  var FILLER_SENTENCES = [
    // 인사
    new RegExp('^(?:여러분\\s*)?(?:안녕하세요|안녕하십니까|안녕|반갑습니다|반가워요|하이|헬로)(?:\\s*(?:여러분|GPT|챗GPT|ChatGPT|클로드|Claude|제미나이|Gemini|AI)\\s*(?:님|씨|야)?)?' + P_END + '$', 'i'),
    // 호칭만 있는 문장 ("ChatGPT님.", "클로드야!")
    new RegExp('^(?:친애하는\\s*)?(?:ChatGPT|GPT|챗GPT|챗지피티|지피티|Claude|클로드|Gemini|제미나이|제미니|AI|에이아이|인공지능|어시스턴트|비서)\\s*(?:님|씨|야|아|양)?' + P_END + '$', 'i'),
    new RegExp('^(?:좋은\\s*(?:아침|오후|저녁|하루)(?:입니다|이에요|예요)?)' + P_END + '$'),
    // 감사 / 부탁 (짧은 맺음 문장 전체)
    new RegExp('^[가-힣\\s]{0,16}(?:감사|고맙)(?:합니다|드립니다|드려요|해요|습니다|하겠습니다|겠습니다)' + P_END + '$'),
    new RegExp('^(?:늘\\s*|항상\\s*|그럼\\s*|그럼\\s*이만\\s*)?(?:잘\\s*)?부탁(?:드립니다|드려요|드릴게요|드리겠습니다|합니다|해요)' + P_END + '$'),
    // "부탁(질문) 하나 드리려고 합니다 / 부탁이 있습니다" 류 서두
    new RegExp('^(?:부탁|질문|요청|문의)(?:이|가)?\\s*(?:하나|한\\s*가지|몇\\s*가지|좀)?\\s*(?:드리려고\\s*합니다|드리려\\s*합니다|드릴게\\s*있습니다|있습니다|있어요|있는데요|드립니다)' + P_END + '$'),
    new RegExp('^(?:오늘도\\s*)?(?:수고하세요|수고하십시오|수고하셨습니다|좋은\\s*하루\\s*(?:되세요|보내세요))' + P_END + '$'),
    // 질문 예고 / 메타 서두
    new RegExp('^(?:제가\\s*)?(?:질문|궁금한\\s*(?:점|것|게))(?:이|가)?\\s*(?:하나\\s*|몇\\s*가지\\s*)?(?:있습니다|있어요|있는데요|생겼습니다|있습니다만|드릴게요|드리겠습니다)' + P_END + '$'),
    new RegExp('^(?:다음|아래|밑의?|이하의?)\\s*(?:의\\s*)?(?:질문|물음|문제|내용|요청)(?:에|에\\s*대해|에\\s*대하여)?\\s*(?:답|답변|대답|응답)(?:을|해|하여)?\\s*(?:해\\s*)?(?:주세요|주십시오|줘|줘요|주시겠어요|주시기\\s*바랍니다|부탁드립니다)' + P_END + '$'),
    new RegExp('^(?:도움(?:을|이)?\\s*(?:주시면|주신다면|되면)\\s*)?(?:정말\\s*|너무\\s*|매우\\s*)?(?:감사하겠습니다|고맙겠습니다)' + P_END + '$'),
    // English
    /^(?:hi|hello|hey|greetings|dear\s+\w+|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|everyone|all|chatgpt|gpt|claude|gemini|ai|assistant))?[\s,.!:;~]*$/i,
    /^(?:many\s+)?(?:thanks?|thank\s+you|thx|ty)(?:\s+(?:so|very)\s+much|\s+a\s+lot|\s+in\s+advance|\s+for\s+(?:your|the)\s+help)?[\s,.!:;~]*$/i,
    /^i\s+hope\s+(?:this|you)[^.!?]{0,40}(?:well|fine|good)[\s,.!]*$/i,
    /^(?:i\s+have\s+(?:a|one|some)\s+(?:quick\s+)?questions?|quick\s+question)[\s,.!:;]*$/i,
    /^(?:any\s+help\s+(?:would\s+be|is)\s+(?:greatly\s+|much\s+|really\s+)?appreciated|i\s+appreciate\s+(?:your|the|any)\s+help)[\s,.!]*$/i,
    /^(?:please\s+)?answer\s+the\s+following\s+(?:question|questions)[\s,.!:;]*$/i
  ];

  // (B) 문장 내부 치환 — [정규식, 치환값]
  var FILLER_INLINE = [
    // 문두 인사 + 쉼표 ("안녕하세요, 이 코드를…")
    [/(^|\n)[ \t]*(?:안녕하세요|안녕하십니까|반갑습니다)[!~.,\s]+(?=\S)/g, '$1'],
    [/(^|\n)[ \t]*(?:hi|hello|hey)(?:\s+(?:there|everyone|all|claude|chatgpt|gpt|gemini|ai|assistant))?[!,.]+\s*(?=\S)/gi, '$1\u0001'],
    // 완충어
    [/(^|[\s(])(?:혹시|죄송하지만|죄송한데|죄송합니다만|실례지만|실례합니다만|번거로우시겠지만|바쁘시겠지만|괜찮으시다면|가능하시다면|가능하다면|괜찮다면)[,\s]+/g, '$1'],
    // ~해 주시면 감사하겠습니다 / ~해 주실 수 있을까요? → ~해 주세요
    [/\s*(?:주시면|주신다면|주실\s*수\s*있다면)\s*(?:정말\s*|너무\s*|대단히\s*|매우\s*)?(?:감사하겠습니다|고맙겠습니다|좋겠습니다|감사하겠어요|감사드리겠습니다)/g, ' 주세요'],
    [/\s*주실\s*수\s*(?:있을까요|있나요|있으신가요|있으세요|있겠습니까|있으실까요)\s*\??/g, ' 주세요.'],
    [/\s*주시겠어요\s*\??/g, ' 주세요.'],
    [/\s*주시기\s*바랍니다/g, ' 주세요'],
    // "요약 부탁드립니다" → "요약."
    [/\s*(?:잘\s*)?부탁(?:드립니다|드려요|드릴게요|드리겠습니다|합니다|해요)/g, ''],
    // English politeness
    [/\b(?:i\s+would\s+(?:really\s+|greatly\s+)?appreciate\s+(?:it\s+)?if\s+you\s+could|i\s+was\s+wondering\s+if\s+you\s+could|would\s+you\s+be\s+(?:so\s+kind\s+as|able)\s+to|(?:could|can|would)\s+you\s+(?:please\s+|kindly\s+)?)\s*/gi, '\u0001'],
    [/\b(?:please|kindly)\s+/gi, '\u0001'],
    [/,?\s+please(?=[\s.!?]*$)/gim, ''],
    [/\s*,?\s*(?:thanks?|thank\s+you)(?:\s+(?:so|very)\s+much|\s+in\s+advance)?\s*[.!]*\s*$/gim, '']
  ];

  /** 원문 보존형 문장 분할 — 조각을 모두 이으면 원문과 동일 */
  function splitSentences(line) {
    var re = /[^.!?。？！~\n]*(?:[.!?。？！~]+[)"'”’]*|$)[ \t]*/g;
    var out = [], m;
    while ((m = re.exec(line)) !== null) {
      if (m[0] === '') { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
      out.push(m[0]);
    }
    return out;
  }

  function isFillerSentence(s) {
    var t = s.trim();
    if (!t || t.length > 60) return false;
    for (var i = 0; i < FILLER_SENTENCES.length; i++) if (FILLER_SENTENCES[i].test(t)) return true;
    return false;
  }

  function removeFillers(input) {
    var before = String(input == null ? '' : input);
    var parts = splitFences(normalize(before));
    var removed = 0;

    // (A) 군더더기 문장 삭제 패스
    function dropFillerSentences(text) {
      var lines = text.split('\n').map(function (line) {
        if (!line.trim()) return line;
        var kept = splitSentences(line).filter(function (s) {
          if (isFillerSentence(s)) { removed++; return false; }
          return true;
        });
        var res = kept.join('').replace(/[ \t]+$/, '');
        return res.trim() ? res : '\u0000'; // 비워진 줄 표시(아래에서 제거)
      });
      return lines.filter(function (l) { return l !== '\u0000'; }).join('\n');
    }

    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (p.type !== 'text') continue;

      var content = dropFillerSentences(p.content);

      // (B) 문장 내 치환
      for (var r = 0; r < FILLER_INLINE.length; r++) {
        var rule = FILLER_INLINE[r];
        content = content.replace(rule[0], function () {
          removed++;
          var rep = rule[1];
          return rep.indexOf('$1') >= 0 ? rep.replace('$1', arguments[1] || '') : rep;
        });
      }

      // 영어 정중 표현을 지운 자리(\u0001)가 문장 첫머리면 다음 글자를 대문자로
      content = content
        .replace(/(^|[.!?:]\s+|\n[ \t]*)\u0001+([a-z])/g, function (_, pre, ch) { return pre + ch.toUpperCase(); })
        .replace(/\u0001/g, '');

      // 정리: 중복 구두점, 문두 쉼표, 문장 내부 이중 공백(줄 앞 들여쓰기는 보존)
      content = content
        .replace(/ (주세요)\s*\.\s*\./g, ' $1.')
        .replace(/(^|\n)([ \t]*)[,，]\s*/g, '$1$2')
        .replace(/(\S)[ \t]{2,}/g, '$1 ')
        .replace(/(\S)[ \t]+([.,!?])(?=\s|$)/g, '$1$2')
        .replace(/([^.\d])\.{2}(?=\s|$)/g, '$1.');

      // (C) 완충어 제거로 드러난 군더더기 문장("부탁 하나 드리려고 합니다" 등) 한 번 더 제거
      p.content = dropFillerSentences(content);
    }

    var after = collapseBlankLines(joinFences(parts)).replace(/^\s+|\s+$/g, '');
    return { text: after, changed: after !== before, removedCount: removed, removedChars: Math.max(0, before.length - after.length) };
  }

  /* =====================================================================
   * 5. 압축 3 — JSON / 코드 Minify
   * ===================================================================== */
  var INDENT_SENSITIVE = /^(?:py|python|python3|yaml|yml|makefile|make|mk|haskell|hs|coffee|coffeescript|pug|jade|sass|nim|fsharp|fs|elm|md|markdown|text|txt|plaintext|diff|patch)$/;
  var SLASH_COMMENT = /^(?:js|javascript|jsx|mjs|cjs|ts|typescript|tsx|java|kotlin|kt|kts|scala|groovy|gradle|c|h|cpp|c\+\+|cc|hpp|cs|csharp|go|golang|rust|rs|swift|php|dart|css|scss|less|jsonc|json5|sol|solidity|proto)$/;
  var HASH_COMMENT = /^(?:sh|bash|zsh|shell|console|ps1|powershell|rb|ruby|r|perl|pl|toml|ini|conf|dockerfile|docker|nginx|properties|tf|hcl|elixir|ex|exs)$/;
  var SQL_LANG = /^(?:sql|mysql|pgsql|postgres|postgresql|plsql|tsql|sqlite|oracle)$/;
  var MARKUP_LANG = /^(?:html|htm|xml|svg|xhtml|vue|ftl|jsp)$/;

  function tryParseJSON(s) {
    var t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
    try { return JSON.parse(t); } catch (e) { return undefined; }
  }

  function minifyCodeBody(body, lang) {
    var json = tryParseJSON(body);
    if (json !== undefined && /^(?:|json|jsonc|json5|js|javascript)$/.test(lang)) return { body: JSON.stringify(json), kind: 'json' };

    var lines = body.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); });
    var keepIndent = !lang || INDENT_SENSITIVE.test(lang);

    if (SLASH_COMMENT.test(lang)) {
      var joined = lines.join('\n').replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '');
      lines = joined.split('\n').filter(function (l) { return !/^\s*\/\/(?!\s*(?:@ts-|eslint|prettier|#))/.test(l); });
    } else if (HASH_COMMENT.test(lang) || /^(?:py|python|python3|yaml|yml)$/.test(lang)) {
      lines = lines.filter(function (l, idx) {
        if (idx === 0 && /^#!/.test(l)) return true; // shebang 보존
        return !/^\s*#(?![!{])/.test(l) || /^\s*#\s*(?:-\*-|type:|noqa|pragma)/.test(l);
      });
    } else if (SQL_LANG.test(lang)) {
      lines = lines.join('\n').replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '').split('\n')
        .filter(function (l) { return !/^\s*--/.test(l); });
    } else if (MARKUP_LANG.test(lang)) {
      var html = lines.join('\n').replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
      if (!/<(?:pre|textarea|script|style)\b/i.test(html)) {
        html = html.replace(/>\s+</g, '><').replace(/\s*\n\s*/g, ' ');
        return { body: html.trim(), kind: 'code' };
      }
      lines = html.split('\n');
    }

    lines = lines.filter(function (l) { return l.trim() !== ''; });
    if (!keepIndent) lines = lines.map(function (l) { return l.replace(/^[ \t]+/, ''); });
    return { body: lines.join('\n'), kind: 'code' };
  }

  /**
   * 일반 텍스트 안에 펜스 없이 붙여 넣은 JSON 을 찾아 압축한다.
   * 문자열 인식형 괄호 매칭 → JSON.parse 성공한 덩어리만 치환.
   */
  function findMatchingBracket(s, start, limit) {
    var stack = [], inStr = false, esc = false;
    var end = Math.min(s.length, start + limit);
    for (var i = start; i < end; i++) {
      var c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        else if (c === '\n') return -1; // JSON 문자열은 개행 불가
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        var open = stack.pop();
        if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) return -1;
        if (!stack.length) return i;
      }
    }
    return -1;
  }

  function minifyInlineJSON(text, counter) {
    var out = '', i = 0, attempts = 0;
    while (i < text.length) {
      var c = text[i];
      if ((c === '{' || c === '[') && attempts < 2000) {
        attempts++;
        var j = findMatchingBracket(text, i, 500000);
        if (j > i) {
          var cand = text.slice(i, j + 1);
          if (/\s/.test(cand) && /[:,]/.test(cand)) {
            var parsed = tryParseJSON(cand);
            if (parsed !== undefined && typeof parsed === 'object') {
              out += JSON.stringify(parsed);
              counter.json++;
              i = j + 1;
              continue;
            }
          }
        }
      }
      out += c;
      i++;
    }
    return out;
  }

  function minifyJsonAndCode(input) {
    var before = String(input == null ? '' : input);
    var parts = splitFences(normalize(before));
    var counter = { json: 0, code: 0 };
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (p.type === 'code') {
        var r = minifyCodeBody(p.body, p.lang);
        if (r.body !== p.body) { if (r.kind === 'json') counter.json++; else counter.code++; }
        p.body = r.body;
      } else {
        // 펜스 밖에 그대로 붙여 넣은 JSON 문서 전체 / 일부
        var whole = tryParseJSON(p.content);
        if (whole !== undefined && typeof whole === 'object') {
          var min = JSON.stringify(whole);
          if (min !== p.content.trim()) counter.json++;
          var lead = /^\s*/.exec(p.content)[0], trail = /\s*$/.exec(p.content)[0];
          p.content = lead + min + trail;
        } else {
          p.content = minifyInlineJSON(p.content, counter);
        }
      }
    }
    var after = joinFences(parts);
    return { text: after, changed: after !== before, jsonCount: counter.json, codeCount: counter.code, removedChars: Math.max(0, before.length - after.length) };
  }

  /* =====================================================================
   * 6. 전체 최적화 (수식어 → Minify → 공백)
   * ===================================================================== */
  function optimizeAll(input) {
    var a = removeFillers(input);
    var b = minifyJsonAndCode(a.text);
    var c = cleanWhitespace(b.text);
    var before = String(input == null ? '' : input);
    return {
      text: c.text,
      changed: c.text !== before,
      removedCount: a.removedCount,
      jsonCount: b.jsonCount,
      codeCount: b.codeCount,
      removedChars: Math.max(0, before.length - c.text.length)
    };
  }

  /* =====================================================================
   * 7. Undo 히스토리 (DOM 비의존)
   * ===================================================================== */
  function History(limit) {
    this.limit = limit || 100;
    this.stack = [];
  }
  History.prototype.push = function (snapshot) {
    var last = this.stack[this.stack.length - 1];
    if (last && last.text === snapshot.text) return false;
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    return true;
  };
  History.prototype.pop = function () { return this.stack.pop() || null; };
  History.prototype.size = function () { return this.stack.length; };
  History.prototype.clear = function () { this.stack = []; };

  return {
    PRICE_AS_OF: PRICE_AS_OF,
    MODELS: MODELS,
    BASE_MODEL: BASE_MODEL,
    DEFAULT_USD_KRW: DEFAULT_USD_KRW,
    formatKRW: formatKRW,
    diffText: diffText,
    diffStats: diffStats,
    diffLines: diffLines,
    diffLineStats: diffLineStats,
    normalize: normalize,
    splitFences: splitFences,
    joinFences: joinFences,
    splitSentences: splitSentences,
    analyze: analyze,
    countGraphemes: countGraphemes,
    utf8Bytes: utf8Bytes,
    estimateTokensHeuristic: estimateTokensHeuristic,
    modelTokens: modelTokens,
    costUSD: costUSD,
    formatUSD: formatUSD,
    formatNumber: formatNumber,
    cleanWhitespace: cleanWhitespace,
    removeFillers: removeFillers,
    minifyJsonAndCode: minifyJsonAndCode,
    optimizeAll: optimizeAll,
    History: History
  };
});
