# =====================================================================
# PROMPTSLIM 컨테이너 이미지 (stocko 구성 계승)
#  - 빌드 : gradle 공식 이미지 (gradlew 미사용 — Windows 체크아웃의 CRLF 이슈 회피)
#  - 실행 : JRE8. 정적 페이지 서버라 폰트/DB 등 부가 패키지 불필요
# =====================================================================

FROM gradle:7.6.4-jdk8 AS build
WORKDIR /workspace
COPY build.gradle settings.gradle ./
COPY src ./src
RUN gradle --no-daemon clean bootJar -x test -x jsTest

FROM eclipse-temurin:8-jre
ENV LANG=C.UTF-8

COPY --from=build /workspace/build/libs/*.jar /app/app.jar

EXPOSE 8180
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
