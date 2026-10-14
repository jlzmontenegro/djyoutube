@echo off
title DJ YouTube
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js. Instalalo desde https://nodejs.org y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)
node server.js
pause
