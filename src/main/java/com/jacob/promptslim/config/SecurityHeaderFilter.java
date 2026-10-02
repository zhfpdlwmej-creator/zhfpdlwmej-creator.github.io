package com.jacob.promptslim.config;

import java.io.IOException;

import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Zero Server Side Request 보증 필터.
 * <ul>
 *   <li>GET/HEAD/OPTIONS 외 메서드는 405 — 서버는 어떤 데이터도 받지 않는다</li>
 *   <li>CSP connect-src 'none' / form-action 'none' — 브라우저 단에서 데이터 송신 자체를 차단</li>
 *   <li>Referrer 미전송, 카메라/마이크/위치 등 권한 차단</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SecurityHeaderFilter extends OncePerRequestFilter {

    @Value("${promptslim.security.csp}")
    private String csp;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        response.setHeader("Content-Security-Policy", csp.replaceAll("\\s+", " ").trim());
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

        String method = request.getMethod();
        if (!"GET".equals(method) && !"HEAD".equals(method) && !"OPTIONS".equals(method)) {
            response.setHeader("Allow", "GET, HEAD, OPTIONS");
            response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
            return;
        }

        // 화면(HTML)은 항상 최신 — 정적 자원은 ?v= 버전 키로 장기 캐시
        if ("/".equals(request.getRequestURI())) {
            response.setHeader("Cache-Control", "no-cache");
        }
        chain.doFilter(request, response);
    }
}
