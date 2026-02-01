param(
  [string]$ObsHost = "192.168.2.34",
  [int]$ObsPort = 4455,
  [string]$ObsPassword = $env:OBS_WS_PASSWORD,
  [switch]$ObsAuto
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$script:repoRoot = $repoRoot
$script:procs = @()
$script:obsAuto = [bool]$ObsAuto
$script:obsHost = $ObsHost
$script:obsPort = $ObsPort
$script:recorderExe = Join-Path $repoRoot "tools\timestone_recorder\target\debug\timestone_recorder.exe"
$script:obsExe = Join-Path $repoRoot "tools\timestone_obs_ws\target\debug\timestone_obs_ws.exe"
$script:fileTapperExe = Join-Path $repoRoot "tools\timestone_file_tapper\target\debug\timestone_file_tapper.exe"
$script:stopping = $false
$script:fileTapperProc = $null

function Send-ObsCommand {
  param(
    [string]$Command
  )
  try {
    & $script:obsExe --host $script:obsHost --port $script:obsPort --command $Command | Out-Null
  } catch {
    Write-Host "[launcher] Failed to send OBS command: $Command"
  }
}

function Stop-All {
  if ($script:stopping) {
    return
  }
  $script:stopping = $true
  Write-Host "`n[launcher] Stopping timestone..."
  if ($script:obsAuto) {
    try {
      Write-Host "[launcher] Stopping OBS recording and stream..."
      Send-ObsCommand "stop"
    } catch {
      Write-Host "[launcher] Failed to stop OBS via websocket."
    }
  }
  try {
    if (Test-Path $script:recorderExe) {
      & $script:recorderExe stop | Out-Null
    }
  } catch {
    Write-Host "[launcher] Failed to send recorder stop signal."
  }
  foreach ($p in $script:procs) {
    if ($p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
      if (-not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Ensure-Binary {
  param(
    [string]$Manifest,
    [string]$ExePath,
    [string]$Label
  )
  if (-not (Test-Path $ExePath)) {
    Write-Host "[launcher] Building $Label..."
    & cargo build --manifest-path $Manifest
    if ($LASTEXITCODE -ne 0) {
      throw "Build failed for $Label"
    }
  }
}

if ($ObsPassword) {
  $env:OBS_WS_PASSWORD = $ObsPassword
}

Write-Host "[launcher] Repo root: $repoRoot"

Ensure-Binary "tools\timestone_recorder\Cargo.toml" $script:recorderExe "timestone_recorder"
Ensure-Binary "tools\timestone_obs_ws\Cargo.toml" $script:obsExe "timestone_obs_ws"
Ensure-Binary "tools\timestone_file_tapper\Cargo.toml" $script:fileTapperExe "timestone_file_tapper"

Write-Host "[launcher] Starting timestone_recorder..."
$script:procs += Start-Process -FilePath $script:recorderExe -ArgumentList @("start") -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting OBS WS listener..."
$script:procs += Start-Process -FilePath $script:obsExe -ArgumentList @(
  "--host",$ObsHost,"--port",$ObsPort,"--verbose"
) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

if ($script:obsAuto) {
  try {
    Write-Host "[launcher] Starting OBS recording and stream..."
    Send-ObsCommand "start"
  } catch {
    Write-Host "[launcher] Failed to start OBS via websocket."
  }
}

Write-Host "[launcher] Starting file tapper (logs below)..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $script:fileTapperExe
$psi.Arguments = "--verbose --quiet-ffmpeg"
$psi.WorkingDirectory = $repoRoot
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$script:fileTapperProc = New-Object System.Diagnostics.Process
$script:fileTapperProc.StartInfo = $psi
$script:fileTapperProc.EnableRaisingEvents = $true
$script:fileTapperProc.add_OutputDataReceived({
  param($sender, $e)
  if ($e.Data) { Write-Host $e.Data }
})
$script:fileTapperProc.add_ErrorDataReceived({
  param($sender, $e)
  if ($e.Data) { Write-Host $e.Data }
})
$script:fileTapperProc.Start() | Out-Null
$script:fileTapperProc.BeginOutputReadLine()
$script:fileTapperProc.BeginErrorReadLine()

Write-Host "[launcher] Controls: P = pause, R = resume, S = stop/exit."
try {
  while (-not $script:stopping) {
    if ($script:fileTapperProc.HasExited) {
      $code = $script:fileTapperProc.ExitCode
      Write-Host ("[launcher] File tapper exited with code {0} at {1}" -f $code, (Get-Date))
      break
    }
    try {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        switch ($key.Key) {
          "P" { Write-Host "[launcher] Pause requested"; Send-ObsCommand "pause" }
          "R" { Write-Host "[launcher] Resume requested"; Send-ObsCommand "resume" }
          "S" { Write-Host "[launcher] Stop requested"; break }
        }
      } else {
        Start-Sleep -Milliseconds 200
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
} finally {
  Stop-All
}
