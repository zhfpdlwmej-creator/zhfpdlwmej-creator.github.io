/*
 * PromptSlim core.js 단위 테스트 — node --test (gradle jsTest / check 에서 실행)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const CORE_PATH = path.resolve(__dirname, '../../main/resources/static/assets/js/core.js');
const C = require(CORE_PATH);

/* =====================================================================
 * 0. 보안 — 엔진/워커/앱 어디에도 외부 전송 API가 없어야 한다
 * ===================================================================== */
test('보안: 클라이언트 JS에 네트워크 전송 API가 없다', () => {
  const dir = path.dirname(CORE_PATH);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket(', 'EventSource(']) {
      assert.ok(!src.includes(banned), `${f} 에 금지된 API 발견: ${banned}`);
    }
  }
});

/* =====================================================================
 * 1. analyze — 글자/단어/줄 수
 * ===================================================================== */
test('analyze: 빈 입력', () => {
  assert.deepEqual(C.analyze(''), { chars: 0, charsNoSpace: 0, words: 0, lines: 0, bytes: 0 });
  assert.equal(C.analyze(null).chars, 0);
});

test('analyze: 한글/영문 혼합', () => {
  const r = C.analyze('안녕 world');
  assert.equal(r.chars, 8);          // 공백 포함
  assert.equal(r.charsNoSpace, 7);   // 공백 제외
  assert.equal(r.words, 2);
  assert.equal(r.lines, 1);
  assert.equal(r.bytes, 12);         // 한글 3바이트×2 + 공백1 + ascii5
});

test('analyze: 이모지는 1글자(그래핌)', () => {
  assert.equal(C.analyze('👍🏻').chars, 1);
  assert.equal(C.analyze('a👨‍👩‍👧b').chars, 3);
});

test('analyze: 줄 수는 CRLF 도 인식', () => {
  assert.equal(C.analyze('a\r\nb\nc').lines, 3);
});

/* =====================================================================
 * 2. cleanWhitespace
 * ===================================================================== */
test('cleanWhitespace: 다중 공백 → 1칸, 연속 빈 줄 → 1줄', () => {
  const r = C.cleanWhitespace('a    b\t\tc\n\n\n\n\nd   ');
  assert.equal(r.text, 'a b c\n\nd');
  assert.ok(r.changed);
});

test('cleanWhitespace: 코드 펜스 내부 들여쓰기는 보존', () => {
  const src = '설명   입니다\n```py\ndef f():\n    return 1   \n```\n끝';
  const r = C.cleanWhitespace(src);
  assert.ok(r.text.includes('    return 1\n')); // 들여쓰기 유지, 꼬리 공백만 제거
  assert.ok(r.text.startsWith('설명 입니다'));
});

test('cleanWhitespace: 변화 없으면 changed=false', () => {
  assert.equal(C.cleanWhitespace('a b\n\nc').changed, false);
});

/* =====================================================================
 * 3. removeFillers
 * ===================================================================== */
test('removeFillers: 한국어 인사/감사/부탁 문장 제거', () => {
  const r = C.removeFillers('안녕하세요!\n이 글을 요약해줘.\n감사합니다.');
  assert.equal(r.text, '이 글을 요약해줘.');
  assert.ok(r.removedCount >= 2);
});

test('removeFillers: "다음 질문에 답해주세요" 제거', () => {
  const r = C.removeFillers('다음 질문에 답해 주세요.\n지구는 왜 도는가?');
  assert.equal(r.text, '지구는 왜 도는가?');
});

test('removeFillers: 문장 내 완충어 축약 (~주실 수 있을까요 → ~주세요)', () => {
  const r = C.removeFillers('혹시 이 코드를 검토해 주실 수 있을까요?');
  assert.equal(r.text, '이 코드를 검토해 주세요.');
});

test('removeFillers: 부탁드립니다 꼬리 제거', () => {
  assert.equal(C.removeFillers('번역 부탁드립니다.').text, '번역.');
});

test('removeFillers: 완충어 제거 후 드러난 군더더기 문장도 삭제 (2-pass)', () => {
  const r = C.removeFillers('안녕하세요 ChatGPT님! 바쁘시겠지만 부탁 하나 드리려고 합니다.\n이 글을 요약해줘.');
  assert.equal(r.text, '이 글을 요약해줘.');
});

test('removeFillers: 영어 인사/정중 표현', () => {
  const r = C.removeFillers('Hello ChatGPT! Could you please summarize this article? Thanks in advance!');
  assert.equal(r.text, 'Summarize this article?');
});

test('removeFillers: 본문(비인사)은 보존', () => {
  const keep = '감사 인사를 전하는 이메일을 작성해줘. 고객이 "안녕하세요"라고 시작했다.';
  const r = C.removeFillers(keep);
  assert.ok(r.text.includes('감사 인사를 전하는 이메일'));
  assert.ok(r.text.includes('"안녕하세요"라고 시작했다'));
});

test('removeFillers: 코드 펜스 내부는 건드리지 않음', () => {
  const src = '```\nprint("안녕하세요")\n```';
  assert.equal(C.removeFillers(src).text, src);
});

test('removeFillers: 숫자 소수점/범위 표기 보존', () => {
  const r = C.removeFillers('값은 3.14 입니다. 범위는 2..5 입니다. 확인 부탁드립니다.');
  assert.ok(r.text.includes('3.14'));
  assert.ok(r.text.includes('2..5'));
});

/* =====================================================================
 * 4. minifyJsonAndCode
 * ===================================================================== */
test('minify: 전체가 JSON 인 입력', () => {
  const r = C.minifyJsonAndCode('{\n  "a": 1,\n  "b": [1, 2]\n}');
  assert.equal(r.text, '{"a":1,"b":[1,2]}');
  assert.equal(r.jsonCount, 1);
});

test('minify: 본문 속 인라인 JSON 만 압축, 일반 문장은 유지', () => {
  const r = C.minifyJsonAndCode('데이터: { "x": 1,  "y": 2 } 입니다.\n중괄호 {그냥 텍스트} 는 유지.');
  assert.ok(r.text.includes('{"x":1,"y":2}'));
  assert.ok(r.text.includes('{그냥 텍스트}'));
});

test('minify: js 코드 펜스 — 주석/빈 줄/들여쓰기 제거', () => {
  const src = '```js\n// 주석\nfunction a() {\n    /* block\n     comment */\n    return 1;\n\n}\n```';
  const r = C.minifyJsonAndCode(src);
  assert.equal(r.text, '```js\nfunction a() {\nreturn 1;\n}\n```');
  assert.equal(r.codeCount, 1);
});

test('minify: python 펜스 — 주석은 지우되 들여쓰기 보존', () => {
  const src = '```python\n# comment\ndef f():\n    return 1\n```';
  const r = C.minifyJsonAndCode(src);
  assert.equal(r.text, '```python\ndef f():\n    return 1\n```');
});

test('minify: JSON 문자열 값 내부 공백은 보존', () => {
  const r = C.minifyJsonAndCode('{ "msg": "hello   world" }');
  assert.equal(r.text, '{"msg":"hello   world"}');
});

test('minify: 깨진 JSON 은 건드리지 않음', () => {
  const src = '{ "a": 1, }';
  assert.equal(C.minifyJsonAndCode(src).text, src);
});

test('minify: html 펜스 — 태그 사이 공백 압축', () => {
  const r = C.minifyJsonAndCode('```html\n<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n```');
  assert.equal(r.text, '```html\n<ul><li>a</li><li>b</li></ul>\n```');
});

/* =====================================================================
 * 5. optimizeAll — 통합
 * ===================================================================== */
test('optimizeAll: 인사+공백+JSON 종합', () => {
  const src = '안녕하세요!   다음 데이터를   분석해 주세요.\n\n\n{\n  "a": 1\n}\n\n감사합니다!';
  const r = C.optimizeAll(src);
  assert.equal(r.text, '다음 데이터를 분석해 주세요.\n\n{"a":1}');
  assert.ok(r.changed);
  assert.ok(r.removedChars > 0);
});

test('optimizeAll: 이미 최적인 입력은 changed=false', () => {
  const src = '요약: AI 뉴스 3줄.';
  const r = C.optimizeAll(src);
  assert.equal(r.text, src);
  assert.equal(r.changed, false);
});

/* =====================================================================
 * 6. 토큰 근사/비용/포맷
 * ===================================================================== */
test('estimateTokensHeuristic: 규모 감각 (영문 ~4자/토큰)', () => {
  const t = C.estimateTokensHeuristic('The quick brown fox jumps over the lazy dog');
  assert.ok(t >= 8 && t <= 14, `got ${t}`);
  assert.equal(C.estimateTokensHeuristic(''), 0);
});

test('scriptShares: 언어 구성 비율 (공백 제외)', () => {
  const sh = C.scriptShares('안녕 ab');
  assert.equal(sh.hangul, 0.5);
  assert.equal(sh.latin, 0.5);
  assert.deepEqual(C.scriptShares(''), { hangul: 0, cjk: 0, latin: 1, other: 0 });
  assert.equal(C.scriptShares('漢字かな').cjk, 1);
});

test('modelTokens: exact 모델은 그대로, 추정 모델은 언어 가중 배율 반영', () => {
  const exact = C.MODELS.find(m => m.exact);
  const claude = C.MODELS.find(m => m.fk === 'claude47');
  assert.equal(C.modelTokens(100, exact, C.scriptShares('hello 안녕')), 100);
  // 순수 영문: latin 배율 그대로
  assert.equal(C.modelTokens(100, claude, C.scriptShares('hello world')), Math.round(100 * C.FACTORS.claude47.latin));
  // 순수 한글: hangul 배율
  assert.equal(C.modelTokens(100, claude, C.scriptShares('안녕하세요')), Math.round(100 * C.FACTORS.claude47.hangul));
  // 반반: 중간값
  const half = C.modelTokens(1000, claude, { hangul: 0.5, cjk: 0, latin: 0.5, other: 0 });
  assert.equal(half, Math.round(1000 * (C.FACTORS.claude47.latin + C.FACTORS.claude47.hangul) / 2));
  assert.equal(C.modelTokens(0, claude, null), 0);
});

test('costUSD/formatUSD + 장문 컨텍스트 단가', () => {
  assert.equal(C.costUSD(1000000, 2.5), 2.5);
  // 20만 초과분은 over200k 단가: 30만 토큰 = 20만×$2 + 10만×$4 = $0.8
  assert.equal(C.costUSD(300000, 2, 4), 0.8);
  assert.equal(C.costUSD(100000, 2, 4), 0.2); // 미만이면 기본 단가
  const gem = C.MODELS.find(m => m.id === 'gemini-3-1-pro');
  assert.equal(C.modelCostUSD(300000, gem), 0.8);
  assert.equal(C.formatUSD(0), '$0');
  assert.equal(C.formatUSD(2.5), '$2.50');
  assert.equal(C.formatUSD(0.000005), '$0.000005');
});

/* =====================================================================
 * 7. History (Undo)
 * ===================================================================== */
test('History: push/pop, 중복 스냅숏 무시, limit 유지', () => {
  const h = new C.History(3);
  assert.equal(h.push({ text: 'a' }), true);
  assert.equal(h.push({ text: 'a' }), false); // 중복
  h.push({ text: 'b' });
  h.push({ text: 'c' });
  h.push({ text: 'd' }); // limit 3 → 'a' 밀려남
  assert.equal(h.size(), 3);
  assert.equal(h.pop().text, 'd');
  assert.equal(h.pop().text, 'c');
  assert.equal(h.pop().text, 'b');
  assert.equal(h.pop(), null);
});

/* =====================================================================
 * 8. splitFences 왕복 보존
 * ===================================================================== */
test('splitFences/joinFences: 분할 후 재조합하면 원문과 동일', () => {
  const samples = [
    'plain text only',
    'a\n```js\ncode\n```\nb',
    '```\nunclosed fence...',
    '```py\nx=1\n```\n```sql\nSELECT 1;\n```'
  ];
  for (const s of samples) {
    assert.equal(C.joinFences(C.splitFences(s)), s, JSON.stringify(s));
  }
});

/* =====================================================================
 * 9. diff / 원화 포맷
 * ===================================================================== */
test('diffText: 삭제·추가 구간 식별, same+del+ins 재조합 일관성', () => {
  const before = '안녕하세요! 이 글을 요약해 주세요.';
  const after = '이 글을 요약해 주세요.';
  const ops = C.diffText(before, after);
  const del = ops.filter(o => o.type === 'del').map(o => o.text).join('');
  assert.ok(del.includes('안녕하세요'));
  // del+same == before, ins+same == after
  assert.equal(ops.filter(o => o.type !== 'ins').map(o => o.text).join(''), before);
  assert.equal(ops.filter(o => o.type !== 'del').map(o => o.text).join(''), after);
});

test('diffText: 변화 없으면 same 하나', () => {
  const ops = C.diffText('abc def', 'abc def');
  assert.deepEqual(ops, [{ type: 'same', text: 'abc def' }]);
});

test('diffStats: 삭제/추가 글자 수', () => {
  const st = C.diffStats([{ type: 'del', text: 'abcd' }, { type: 'same', text: 'x' }, { type: 'ins', text: 'yz' }]);
  assert.deepEqual(st, { del: 4, ins: 2 });
});

test('formatKRW: 구간별 표기', () => {
  assert.equal(C.formatKRW(0), '0원');
  assert.equal(C.formatKRW(1234567), '1,234,567원');
  assert.equal(C.formatKRW(1.333), '1.3원');
  assert.equal(C.formatKRW(0.27), '0.27원');
  assert.ok(C.formatKRW(0.00057).endsWith('원'));
});

/* =====================================================================
 * 10. 코드·문서 비교 (diffLines)
 * ===================================================================== */
test('diffLines: 변경/추가/동일 블록 분리', () => {
  const a = 'line1\nline2\nline3';
  const b = 'line1\nlineX\nline3\nline4';
  const ops = C.diffLines(a, b);
  assert.deepEqual(ops, [
    { type: 'same', lines: ['line1'] },
    { type: 'del', lines: ['line2'] },
    { type: 'ins', lines: ['lineX'] },
    { type: 'same', lines: ['line3'] },
    { type: 'ins', lines: ['line4'] }
  ]);
});

test('diffLines: del+same+ins 재조합하면 원본/수정본 복원', () => {
  const a = 'a\nb\nc\nd';
  const b = 'a\nc\nd\ne\nf';
  const ops = C.diffLines(a, b);
  const left = ops.filter(o => o.type !== 'ins').flatMap(o => o.lines).join('\n');
  const right = ops.filter(o => o.type !== 'del').flatMap(o => o.lines).join('\n');
  assert.equal(left, a);
  assert.equal(right, b);
});

test('diffLines: CRLF 원본도 비교 가능', () => {
  const ops = C.diffLines('a\r\nb', 'a\nb');
  assert.deepEqual(ops, [{ type: 'same', lines: ['a', 'b'] }]);
});

test('diffLineStats: 인접 del+ins 는 변경으로 집계', () => {
  const ops = [
    { type: 'del', lines: ['x', 'y'] },
    { type: 'ins', lines: ['x2', 'y2', 'z'] },
    { type: 'same', lines: ['s'] },
    { type: 'del', lines: ['only-del'] }
  ];
  assert.deepEqual(C.diffLineStats(ops), { del: 1, ins: 1, mod: 2 });
});

/* =====================================================================
 * 11. 오타·맞춤법 교정 (fixTypos)
 * ===================================================================== */
test('fixTypos: 흔한 오타 교정', () => {
  const r = C.fixTypos('안녕하세오 고갠님! 주문이 완료됬습니다. 몇일 뒤에 연락할께요.');
  assert.equal(r.text, '안녕하세요 고객님! 주문이 완료됐습니다. 며칠 뒤에 연락할게요.');
  assert.equal(r.fixedCount, 5); // 안녕하세오·고갠님·됬·몇일·할께
});

test('fixTypos: 뒤에 글자가 붙은 오타도 교정 (몇일만/몇일째)', () => {
  assert.equal(C.fixTypos('몇일만이에요, 몇일째 기다려요').text, '며칠만이에요, 며칠째 기다려요');
});

test('fixTypos: 자주 틀리는 맞춤법 (왠만/어떻해/이예요/않되)', () => {
  assert.equal(C.fixTypos('왠만하면 참아').text, '웬만하면 참아');
  assert.equal(C.fixTypos('나 어떻해').text, '나 어떡해');
  assert.equal(C.fixTypos('선물이예요').text, '선물이에요');
  assert.equal(C.fixTypos('그러면 않되는 거야').text, '그러면 안 되는 거야');
});

test('fixTypos: 멀쩡한 단어는 건드리지 않음 (오교정 방지)', () => {
  const keep = '아버지께요. 햇살이 좋다. 색이 바램 현상이 있다. 물건을 올려 두었다. 웬만하다.';
  assert.equal(C.fixTypos(keep).text, keep);
  assert.equal(C.fixTypos(keep).changed, false);
});

test('fixTypos: 코드 펜스 내부는 보존', () => {
  const src = '됬다\n```\n됬다 몇일 고갠님\n```';
  const r = C.fixTypos(src);
  assert.ok(r.text.startsWith('됐다'));
  assert.ok(r.text.includes('됬다 몇일 고갠님'));
});

test('optimizeAll: 오타 교정 포함 + fixedCount 보고', () => {
  const r = C.optimizeAll('안녕하세요! 보고서 작성 부탁드립니다. 초안이 완료됬어요.');
  assert.ok(r.text.includes('완료됐어요'));
  assert.ok(r.fixedCount >= 1);
});
