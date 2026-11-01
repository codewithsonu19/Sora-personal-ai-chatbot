@echo off
title Sora AI Assistant
echo ========================================================
echo               Starting Sora AI Assistant                
echo ========================================================

rem Check if Ollama is running
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe">NUL
if "%ERRORLEVEL%"=="1" (
    echo [1/2] Starting Ollama inference engine in background...
    start /B ollama serve
    timeout /t 3 /nobreak >nul
) else (
    echo [1/2] Ollama inference engine is already running.
)

echo [2/2] Launching Sora Backend + Web UI...
uv run jarvis gui
