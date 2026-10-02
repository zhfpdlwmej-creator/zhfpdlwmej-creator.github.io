package com.jacob.promptslim;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * 서버 계약 테스트 — "Zero Server Side Request" 를 서버가 실제로 보증하는지 확인한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class PromptSlimApplicationTest {

    @Autowired
    TestRestTemplate rest;

    @Test
    void 메인_화면이_뜬다() {
        ResponseEntity<String> res = rest.getForEntity("/", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody())
                .contains("TokenFit")
                .contains("토큰")
                .contains("입력하신 데이터는 서버로 전송되지 않고 사용자의 브라우저 내에서 안전하게 처리됩니다");
    }

    @Test
    void CSP가_외부전송을_차단한다() {
        ResponseEntity<String> res = rest.getForEntity("/", String.class);
        String csp = res.getHeaders().getFirst("Content-Security-Policy");
        assertThat(csp).isNotNull()
                .contains("connect-src 'none'")
                .contains("form-action 'none'")
                .contains("frame-ancestors 'none'");
        assertThat(res.getHeaders().getFirst("Referrer-Policy")).isEqualTo("no-referrer");
        assertThat(res.getHeaders().getFirst("X-Content-Type-Options")).isEqualTo("nosniff");
    }

    @Test
    void 데이터를_받는_엔드포인트가_없다_POST는_405() {
        ResponseEntity<String> res = rest.postForEntity("/", new HttpEntity<>("text=secret"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.METHOD_NOT_ALLOWED);
    }

    @Test
    void 정적_자원이_서빙된다() {
        assertThat(rest.getForEntity("/assets/js/core.js", String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rest.getForEntity("/assets/js/app.js", String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rest.getForEntity("/assets/js/token-worker.js", String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rest.getForEntity("/assets/css/app.css", String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rest.getForEntity("/img/favicon.svg", String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void 클라이언트_JS에_네트워크_전송_API가_없다() {
        for (String path : new String[] {"/assets/js/core.js", "/assets/js/app.js", "/assets/js/token-worker.js"}) {
            String body = rest.getForEntity(path, String.class).getBody();
            assertThat(body).isNotNull();
            assertThat(body).as(path)
                    .doesNotContain("fetch(")
                    .doesNotContain("XMLHttpRequest")
                    .doesNotContain("sendBeacon")
                    .doesNotContain("WebSocket(");
        }
    }
}
