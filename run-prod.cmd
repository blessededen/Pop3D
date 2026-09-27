@echo off
rem 빌드 후 배포용 서버 실행(정적 파일 + AI API). 기본 포트 8787, .env의 PORT로 변경.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || set "PATH=%USERPROFILE%\.local\node;%PATH%"
if not exist node_modules call npm install
call npm run build || exit /b 1
call npm start
