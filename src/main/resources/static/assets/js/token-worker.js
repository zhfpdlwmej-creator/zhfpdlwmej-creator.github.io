/*!
 * PromptSlim Token Worker (module worker)
 *  - OpenAI o200k_base(GPT-4o/GPT-5) 토크나이저를 CDN 에서 "다운로드"만 하고 이 스레드 안에서 실행한다.
 *  - 입력 텍스트는 postMessage 로 메인 스레드와만 주고받는다 — 외부로 나가는 경로 없음 (CSP connect-src 'none').
 *  - 대용량 입력에도 UI(타이핑)가 멈추지 않도록 메인 스레드와 분리.
 */
const CDN = 'https://cdn.jsdelivr.net/npm/js-tiktoken@1.0.21';

let enc = null;

async function init() {
  try {
    const [lite, ranks] = await Promise.all([
      import(`${CDN}/lite/+esm`),
      import(`${CDN}/ranks/o200k_base/+esm`)
    ]);
    enc = new lite.Tiktoken(ranks.default);
    self.postMessage({ type: 'ready', encoding: 'o200k_base' });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
}

/**
 * 토큰 → 화면 표시용 조각.
 * 한글/이모지처럼 UTF-8 바이트가 토큰 경계에서 잘리는 경우(디코딩 결과에 U+FFFD)는
 * 다음 토큰과 묶어 하나의 조각으로 만든다 (조각당 토큰 수 n 을 함께 전달).
 */
function toSegments(tokens, limit) {
  const segs = [];
  let group = [];
  const max = Math.min(tokens.length, limit);
  for (let i = 0; i < max; i++) {
    group.push(tokens[i]);
    const text = enc.decode(group);
    if (!text.includes('�') || group.length >= 4 || i === max - 1) {
      segs.push({ t: text, ids: group });
      group = [];
    }
  }
  return segs;
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'count') return;
  if (!enc) {
    self.postMessage({ type: 'result', id: msg.id, ok: false });
    return;
  }
  const t0 = performance.now();
  // 특수 토큰(<|endoftext|> 등)도 일반 텍스트로 취급해 예외 없이 계산
  const tokens = enc.encode(msg.text || '', [], []);
  const res = { type: 'result', id: msg.id, ok: true, count: tokens.length };
  if (msg.segments) {
    res.segments = toSegments(tokens, msg.limit || 3000);
    res.truncated = tokens.length > (msg.limit || 3000);
  }
  if (msg.before != null) {
    res.beforeCount = enc.encode(msg.before, [], []).length;
  }
  res.ms = Math.round(performance.now() - t0);
  self.postMessage(res);
};

init();
