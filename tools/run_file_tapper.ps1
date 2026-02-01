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
$script:dbPath = Join-Path $repoRoot "data\timestone\timestone_events.sqlite3"
$script:stopping = $false
$script:fileTapperProc = $null
$script:fileTapperExited = $false

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

function Get-ObsRecordStatus {
  try {
    $output = & $script:obsExe --host $script:obsHost --port $script:obsPort --command status 2>$null
    $json = ($output | Out-String).Trim()
    if (-not $json) {
      return $null
    }
    return ($json | ConvertFrom-Json)
  } catch {
    return $null
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
  if ($script:fileTapperProc -and -not $script:fileTapperProc.HasExited) {
    try {
      $script:fileTapperProc.Kill()
    } catch {
      Write-Host "[launcher] Failed to stop file tapper process."
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

Write-Host "[launcher] Checking OBS record status..."
$obsStatus = Get-ObsRecordStatus
if (-not $obsStatus) {
  Write-Host "[launcher] Unable to query OBS record status. Is OBS running?"
  exit 1
}
if ($obsStatus.outputActive -eq $true) {
  Write-Host "[launcher] OBS recording already active. Stop recording and re-run this script."
  exit 1
}

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

Write-Host "[launcher] Using DB: $script:dbPath"
Write-Host "[launcher] Starting file tapper..."

# Start file tapper synchronously with output passthrough
# Using Start-Process with -Wait would block, so we use a job instead
$fileTapperJob = Start-Job -ScriptBlock {
  param($exe, $workDir, $dbPath)
  Set-Location $workDir
  & $exe --db $dbPath --verbose --quiet-ffmpeg 2>&1
} -ArgumentList $script:fileTapperExe, $repoRoot, $script:dbPath

Write-Host "[launcher] File tapper started (Job ID: $($fileTapperJob.Id))"
Write-Host "[launcher] Controls: P = pause, R = resume, S = stop/exit."

try {
  while (-not $script:stopping) {
    # Check if file tapper job completed
    if ($fileTapperJob.State -eq 'Completed' -or $fileTapperJob.State -eq 'Failed') {
      Write-Host "[launcher] File tapper job ended (State: $($fileTapperJob.State))"
      # Get any remaining output
      $output = Receive-Job -Job $fileTapperJob
      if ($output) { $output | ForEach-Object { Write-Host $_ } }
      break
    }
    
    # Get and display any new output from file tapper
    $output = Receive-Job -Job $fileTapperJob -ErrorAction SilentlyContinue
    if ($output) {
      $output | ForEach-Object { Write-Host $_ }
    }
    
    # Small sleep to prevent tight loop
    Start-Sleep -Milliseconds 100
    
    # Check for key input
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        "P" { Write-Host "[launcher] Pause requested"; Send-ObsCommand "pause" }
        "R" { Write-Host "[launcher] Resume requested"; Send-ObsCommand "resume" }
        "S" { 
          Write-Host "[launcher] Stop requested"
          $script:stopping = $true
        }
        default { }
      }
    }
  }
} finally {
  # Clean up job
  if ($fileTapperJob) {
    Stop-Job -Job $fileTapperJob -ErrorAction SilentlyContinue
    Remove-Job -Job $fileTapperJob -Force -ErrorAction SilentlyContinue
  }
  Stop-All
}
