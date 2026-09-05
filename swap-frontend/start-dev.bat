@echo off
cd /d "%~dp0"
echo Starting CFOswap development server...
node node_modules\vite\bin\vite.js --port 3000 --host
pause
