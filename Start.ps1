$ErrorActionPreference = 'Stop'
$qrAppRoot = $PSScriptRoot
$qrPythonPath = Join-Path $qrAppRoot '.venv\Scripts\python.exe'
$qrLog = Join-Path $qrAppRoot 'startup.log'
$qrRequirements = Join-Path $qrAppRoot 'requirements.txt'
$qrReadyFile = Join-Path $qrAppRoot '.venv\requirements.sha256'
try {
    $qrExisting = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/config' -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($qrExisting.profile.application -like 'BambuStudio-*' -and $qrExisting.session) {
        Start-Process 'http://127.0.0.1:8765'
        exit 0
    }
} catch { }
try {
    if (-not (Test-Path -LiteralPath $qrPythonPath)) {
        $qrPythonCommand = Get-Command python -ErrorAction Stop
        & $qrPythonCommand.Source -m venv (Join-Path $qrAppRoot '.venv') *> $qrLog
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
    }
    $qrExpectedHash = (Get-FileHash -LiteralPath $qrRequirements -Algorithm SHA256).Hash
    $qrActualHash = if (Test-Path -LiteralPath $qrReadyFile) { (Get-Content -LiteralPath $qrReadyFile -Raw).Trim() } else { '' }
    if ($qrExpectedHash -ne $qrActualHash) {
        & $qrPythonPath -m pip install -r $qrRequirements *>> $qrLog
        if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies. See startup.log.' }
        Set-Content -LiteralPath $qrReadyFile -Value $qrExpectedHash
    }
    & $qrPythonPath (Join-Path $qrAppRoot 'server.py') *>> $qrLog
    if ($LASTEXITCODE -ne 0) { throw 'The local server stopped. See startup.log.' }
} catch {
    $_ | Out-String | Add-Content -LiteralPath $qrLog
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("QR Token Studio could not start. Install Python 3.12 or newer, then try again. Details: $qrLog", 'QR Token Studio') | Out-Null
    exit 1
}
