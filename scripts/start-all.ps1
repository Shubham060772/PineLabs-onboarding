$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeExe = Join-Path $projectRoot 'node_modules\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Dependencies are missing. Run npm install first.' }
if (-not (Test-Path -LiteralPath '.local\ai-runtime.json')) { throw 'Local model setup is missing. Run npm run ai:setup first.' }
$active = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3001, 3002, 5173, 8081) })
if ($active.Count -gt 0) { throw 'An application/model port is already in use. Run stop.cmd before starting the full stack.' }
New-Item -ItemType Directory -Path '.local' -Force | Out-Null
$readyPath = Join-Path $projectRoot '.local\dev-ready'
if (Test-Path -LiteralPath $readyPath) { Remove-Item -LiteralPath $readyPath }
$service = Start-Process -FilePath $nodeExe -ArgumentList '--import tsx scripts/dev.ts' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot '.local\hosting.log') -RedirectStandardError (Join-Path $projectRoot '.local\hosting-error.log') -PassThru
Write-Host 'Starting PostgreSQL, local Qwen model, API, provider simulator and website...'
try {
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline) {
        $service.Refresh()
        if ($service.HasExited) { throw 'Startup exited. See .local\hosting-error.log.' }
        if ((Test-Path -LiteralPath $readyPath) -and ((Get-Content -LiteralPath $readyPath -Raw).Trim() -eq [string]$service.Id)) {
            foreach ($url in @('http://localhost:3001/health', 'http://localhost:3002/health', 'http://localhost:5173', 'http://127.0.0.1:8081/health')) {
                $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
                if ($response.StatusCode -ne 200) { throw "Service is not ready: $url" }
            }
            Write-Host 'Ready: http://localhost:5173'
            Write-Host 'Services run in the background. Run stop.cmd to stop everything.'
            Write-Host 'Logs: .local\hosting.log and .local\hosting-error.log'
            exit 0
        }
        Start-Sleep -Seconds 1
    }
    throw 'Startup timed out. See .local\hosting-error.log.'
} catch {
    $startupError = $_
    & (Join-Path $PSScriptRoot 'stop-all.ps1')
    throw $startupError
}
