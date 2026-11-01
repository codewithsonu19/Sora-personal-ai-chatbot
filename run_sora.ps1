# PowerShell runner for Sora AI Assistant
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "              Starting Sora AI Assistant                " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# Check if Ollama is running
$ollamaProc = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $ollamaProc) {
    Write-Host "[1/2] Starting Ollama engine in background..." -ForegroundColor Yellow
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
} else {
    Write-Host "[1/2] Ollama inference engine is already active." -ForegroundColor Green
}

Write-Host "[2/2] Launching Sora Backend + Web UI..." -ForegroundColor Green
uv run jarvis gui
