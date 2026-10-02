package com.jacob.promptslim.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class MainController {

    @Value("${promptslim.version}")
    private String version;

    /**
     * 메인 — 계산기/압축기 단일 화면 (로그인 없음)
     */
    @GetMapping("/")
    public String index(Model model) {
        // 정적 자원 캐시 무효화 키 (?v=)
        model.addAttribute("v", version);
        return "index";
    }
}
