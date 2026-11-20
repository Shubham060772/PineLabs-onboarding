$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$processes = @(Get-CimInstance Win32_Process)
$projectPattern = [regex]::Escape($projectRoot)
$selected = @{}
# Match this checkout's service launchers, never all Node processes on the machine.
foreach ($process in $processes) {
    if ($process.Name -eq 'node.exe' -and $process.CommandLine -match $projectPattern -and $process.CommandLine -match '(scripts[/\\](dev|start-ai|local-db)\.ts|apps[/\\](api|mock-providers)[/\\]src[/\\]index\.ts|vite[/\\]bin[/\\]vite\.js)') {
        $selected[[int]$process.ProcessId] = $true
    }
}
# Include the model even when started separately before the application.
if (Test-Path -LiteralPath '.local\ai-runtime.json') {
    $runtime = Get-Content -LiteralPath '.local\ai-runtime.json' -Raw | ConvertFrom-Json
    foreach ($process in $processes) {
        if ($process.Name -eq 'llama-server.exe' -and $process.ExecutablePath -and $process.ExecutablePath.StartsWith([string]$runtime.runtime, [StringComparison]::OrdinalIgnoreCase)) {
            $selected[[int]$process.ProcessId] = $true
        }
    }
}
do {
    $added = $false
    foreach ($process in $processes) {
        if ($selected.ContainsKey([int]$process.ParentProcessId) -and -not $selected.ContainsKey([int]$process.ProcessId) -and $process.Name -ne 'postgres.exe') {
            $selected[[int]$process.ProcessId] = $true
            $added = $true
        }
    }
} while ($added)
# PostgreSQL gets a clean fast shutdown, flushing data and ending connections.
# Do this before killing a launcher: embedded-postgres has an exit hook that
# otherwise force-terminates its database process on Windows.
$databaseDir = Join-Path $projectRoot '.local\postgres'
$pgCtl = Join-Path $projectRoot 'node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'
if ((Test-Path -LiteralPath $pgCtl) -and @($processes | Where-Object { $_.Name -eq 'postgres.exe' -and $_.CommandLine -match [regex]::Escape($databaseDir) }).Count -gt 0) {
    & $pgCtl -D $databaseDir -m fast -w -t 30 stop
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not shut down cleanly.' }
}
foreach ($process in $processes) {
    if ($selected.ContainsKey([int]$process.ProcessId)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
}
$readyPath = Join-Path $projectRoot '.local\dev-ready'
if (Test-Path -LiteralPath $readyPath) { Remove-Item -LiteralPath $readyPath }
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3001, 3002, 5173, 8081, 54329) })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}
if ($remaining.Count -gt 0) { throw 'A service port is still occupied. No unrelated processes were stopped.' }
Write-Host 'Website, API, provider simulator, local model and local PostgreSQL are stopped. Data is preserved.'
