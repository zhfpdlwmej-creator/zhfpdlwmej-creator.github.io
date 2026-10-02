package com.jacob.promptslim;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * PromptSlim — AI 프롬프트 글자 수 / 토큰 계산기 & 압축기.
 * <p>
 * 서버의 역할은 정적 페이지와 보안 헤더 전달뿐이다. 사용자가 입력한 텍스트는
 * 전부 브라우저(core.js / token-worker.js)에서 처리되며 서버로 올라오는 경로가 없다.
 */
@SpringBootApplication
public class PromptSlimApplication {

    public static void main(String[] args) {
        SpringApplication.run(PromptSlimApplication.class, args);
    }
}
