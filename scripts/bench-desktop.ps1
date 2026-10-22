<#
  Measures the installed (or built) NexusTalk desktop app on this PC:
  start-up time, idle memory and idle CPU of the whole process tree
  (nexustalk.exe + its WebView2 processes) and the installation size.

  Usage:  powershell -ExecutionPolicy Bypass -File scripts\bench-desktop.ps1 [-Exe <path>] [-IdleSeconds 30]
  Close NexusTalk before running. Results are written to tests\bench\desktop-last-run.json.
#>
param(
  [string]$Exe = "$env:LOCALAPPDATA\NexusTalk\nexustalk.exe",
  [int]$IdleSeconds = 30,
  [int]$Runs = 3
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Exe)) { $Exe = Join-Path $PSScriptRoot "..\target\release\nexustalk.exe" }
if (-not (Test-Path $Exe)) { throw "nexustalk.exe nicht gefunden" }
if (Get-Process nexustalk -ErrorAction SilentlyContinue) { throw "Bitte NexusTalk zuerst beenden." }

function Get-Tree([int]$Root) {
  # Only NexusTalk and its WebView2 helpers (guards against reused parent PIDs).
  $all = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("nexustalk.exe", "msedgewebview2.exe") } | Select-Object ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($Root)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i]) { $ids.Add([int]$p.ProcessId) } }
  }
  return $ids
}
function Get-TreeStats([int]$Root) {
  $procs = Get-Process -Id (Get-Tree $Root) -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Count      = $procs.Count
    WorkingMB  = [math]::Round(($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1)
    PrivateMB  = [math]::Round(($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
    CpuSeconds = ($procs | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
  }
}

$logDir = Join-Path $env:APPDATA "NexusTalk\logs"
$results = @()
for ($r = 1; $r -le $Runs; $r++) {
  function Count-Ready { (Get-ChildItem $logDir -Filter "nexustalk*" -ErrorAction SilentlyContinue | ForEach-Object { (Select-String -Path $_.FullName -Pattern "ui ready" -SimpleMatch).Count } | Measure-Object -Sum).Sum }
  $before = Count-Ready
  $start = Get-Date
  $p = Start-Process -FilePath $Exe -PassThru
  # UI ready = the frontend logged "ui ready" after its first render.
  $ready = $null
  for ($i = 0; $i -lt 300 -and -not $ready; $i++) {
    Start-Sleep -Milliseconds 50
    if ((Count-Ready) -gt $before) { $ready = Get-Date }
  }
  $startupMs = if ($ready) { [int]($ready - $start).TotalMilliseconds } else { $null }
  Start-Sleep -Seconds 10
  $a = Get-TreeStats $p.Id
  Start-Sleep -Seconds $IdleSeconds
  $b = Get-TreeStats $p.Id
  $cpuPct = [math]::Round(($b.CpuSeconds - $a.CpuSeconds) / $IdleSeconds * 100 / [Environment]::ProcessorCount, 2)
  $results += [pscustomobject]@{ Run = $r; StartupMs = $startupMs; Processes = $b.Count; WorkingSetMB = $b.WorkingMB; PrivateMB = $b.PrivateMB; IdleCpuPercent = $cpuPct }
  Get-Process -Id (Get-Tree $p.Id) -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}

$installDir = Split-Path $Exe
$installMB = [math]::Round((Get-ChildItem $installDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 2)
$bundle = Join-Path $PSScriptRoot "..\target\release\bundle"
$installers = Get-ChildItem $bundle -Recurse -Include *.exe, *.msi -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ File = $_.Name; MB = [math]::Round($_.Length / 1MB, 2) } }
$out = [pscustomobject]@{
  Date = (Get-Date).ToString("s"); Exe = $Exe; Cores = [Environment]::ProcessorCount
  Runs = $results; InstallDirMB = $installMB; Installers = $installers
}
$out | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot "..\tests\bench\desktop-last-run.json")
$results | Format-Table -AutoSize
"Installationsordner: $installMB MB"
$installers | Format-Table -AutoSize
