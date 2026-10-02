# 토큰핏 TokenFit — AI 토큰 계산기 · 프롬프트 압축 · 코드 비교

로그인 없이, **100% 브라우저(클라이언트) 단에서 동작**하는 AI 토큰 계산 · 프롬프트 압축 · 코드 비교 도구. 문의: rladyddnr0225@naver.com
`stocko` 프로젝트의 프레임워크 스택(Spring Boot 2.6.2 / Java 8 / Gradle 7.6.4 / FreeMarker)과 구성을 계승.

> **입력하신 데이터는 서버로 전송되지 않고 사용자의 브라우저 내에서 안전하게 처리됩니다.**

## Zero Server Side Request — 어떻게 보증하나

구호가 아니라 3중 장치로 강제한다.

| 계층 | 장치 | 구현 위치 |
|---|---|---|
| 서버 | 텍스트를 받는 엔드포인트 자체가 없음. `GET/HEAD/OPTIONS` 외 전부 405 | `SecurityHeaderFilter` |
| 브라우저 | CSP `connect-src 'none'` + `form-action 'none'` — 페이지 JS가 fetch/XHR/WebSocket/sendBeacon 을 어디로도 못 보냄 (CDN은 스크립트 *다운로드*만 허용) | `application.yml` → `promptslim.security.csp` |
| 테스트 | ① 클라이언트 JS 소스에 네트워크 API 문자열이 없는지 ② CSP 헤더가 실제로 내려가는지 ③ POST 가 405인지 자동 검증 | `PromptSlimApplicationTest`, `core.test.js` |

## 주요 기능

- **실시간 분석**: 공백 포함/제외 글자 수(그래핌 단위 — 이모지 1자), 단어 수, 줄 수, UTF-8 바이트
- **토큰 계산**: OpenAI 공개 토크나이저 **o200k_base**(`js-tiktoken`)를 **Web Worker** 에서 실행 → 대용량 입력에도 타이핑이 안 끊김. CDN 로딩 실패 시 휴리스틱 근사 모드로 자동 전환
  - GPT-6 Astra/Sol 은 o200k 직접 계산값, Claude(Fable 5.1 · Opus/Sonnet 5.5 · Haiku 4.5) · Gemini(3.1 Pro · 3 Flash) 는 공개 클라이언트 토크나이저가 없어 배율 기반 **추정치(≈)** 표기
- **비용 계산**: 모델별 API 입력 단가(USD/1M tokens) 기준 1회·1,000회 비용. 단가는 화면에서 편집 가능(localStorage)
- **원클릭 압축** (코드 펜스 내부는 보존):
  - `공백·줄바꿈 정리` — 다중 공백→1칸, 연속 빈 줄→1줄
  - `인사말·수식어 제거` — "안녕하세요/감사합니다/부탁드립니다/다음 질문에 답해주세요/Could you please…" 등 한·영 패턴
  - `JSON/코드 Minify` — JSON 한 줄화(펜스 밖 인라인 JSON 포함), 코드 주석·빈 줄·들여쓰기 정리(Python/YAML 들여쓰기는 보존)
  - `한 번에 압축` (Ctrl+Enter) / `원복` 100단계 (Ctrl+Shift+Z)
- **토큰 시각화**: 토큰 단위 색상 박스, 공백(·)/줄바꿈(⏎) 표시, 토큰 ID 보기 (성능 위해 2,000 토큰까지)
- **편의**: 결과 복사(토스트), 전체 비우기(원복 가능), 샘플, 텍스트 파일 열기/드래그&드롭(FileReader — 업로드 아님), 압축 효과(절감 토큰·비용) 패널
- **UI**: Tailwind CSS, 라이트/다크/시스템 테마, 모바일 하단 고정 바

## 기술 스택 (stocko 계승)

- Spring Boot 2.6.2 / Java 8 / Gradle 7.6.4
- FreeMarker (`templates/index.html`) — 서버 역할은 페이지 1장 + 보안 헤더 서빙뿐
- 프런트: Vanilla JS + Tailwind(Play CDN) + js-tiktoken(jsDelivr CDN, Web Worker)
- 테스트: JUnit5(서버 계약) + `node --test`(엔진 단위 30케이스, `gradlew jsTest` — Node 없으면 자동 skip)

## 구조

```
com.jacob.promptslim
 ├─ web/     MainController (화면 1개)
 └─ config/  SecurityHeaderFilter (CSP·405·캐시 헤더)

resources
 ├─ templates/index.html          화면 (FreeMarker — ${v} 캐시버스터만 치환)
 └─ static/assets
     ├─ js/core.js                순수 엔진 (분석·압축·Undo — Node 테스트 공유)
     ├─ js/token-worker.js        o200k 토크나이저 워커
     ├─ js/app.js                 UI 바인딩
     ├─ js/theme-init.js          FOUC 방지 테마 적용
     ├─ js/tw-config.js           Tailwind 설정
     └─ css/app.css               컴포넌트 스타일 (라이트/다크)
```

## 실행

```bash
./gradlew bootRun        # http://localhost:8180
./gradlew build          # Java 테스트 + JS 엔진 테스트(jsTest)
docker build -t promptslim . && docker run -p 8180:8180 promptslim
```

## 단가 기준

기본 단가는 2026-10 기준 각사 공식 API 입력 단가(USD/1M tokens) — GPT-6 Astra $10 · Sol $2, Claude Fable 5.1 $10 · Opus 5.5 $4 · Sonnet 5.5 $2 · Haiku 4.5 $1, Gemini 3.1 Pro $2 · 3 Flash $0.5. 모델·단가는 `core.js` 의 `MODELS`, 화면의 [단가 편집]에서 변경 가능. 토큰·비용은 참고용 추정치다.

## 배포 (GitHub Pages — 서버·DB 불필요)

`gradlew staticSite` 가 `build/site/` 에 완성된 정적 사이트를 만든다 (index.html 은 ${v} 캐시버스터만 치환, CSP 는 meta 태그로 포함).
`master` 에 push 하면 `.github/workflows/deploy-pages.yml` 이 테스트 → 정적 빌드 → GitHub Pages 배포까지 자동 수행한다.
최초 1회만 저장소 Settings → Pages → Source 를 **GitHub Actions** 로 지정하면 된다.
