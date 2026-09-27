@echo off
rem Pop-3D 개발 서버. node가 PATH에 없으면 이 PC의 포터블 Node(%USERPROFILE%\.local\node)를 쓴다.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || set "PATH=%USERPROFILE%\.local\node;%PATH%"
if not exist node_modules call npm install
call npm run dev -- --host 127.0.0.1 --port 5174 --strictPort --open
