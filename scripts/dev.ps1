# Launch the dev build of DeskNotes from this checkout, on whatever is checked
# out now (normally `integration`). A dev copy that is already running from this
# checkout is closed first, so every launch runs the latest code.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1           # launch
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 -CloseExe # also quit a running packaged copy
#
# The app reads the provider keys from the user environment itself
# (user-env.js), and dev and the exe share %APPDATA%\DeskNotes, so nothing else
# needs setting. Dev and the exe also share one single-instance lock: while the
# exe runs, a dev launch would just bring the exe's window forward.
param(
  [switch]$CloseExe,
  [switch]$A11y,       # --force-renderer-accessibility, for UI automation
  [switch]$FromShortcut # show problems in a message box (the console closes)
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'

function Fail([string]$message) {
  if ($FromShortcut) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($message, 'DeskNotes dev', 'OK', 'Warning')
  }
  Write-Host $message -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $electron)) { Fail "Electron is missing at $electron. Run npm install in $repo." }

# Only main processes: helpers carry --type=.
$mains = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='DeskNotes.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' }
$dev = $mains | Where-Object { $_.ExecutablePath -eq $electron -and $_.CommandLine -match 'main\.mjs' }
$exe = $mains | Where-Object { $_.Name -eq 'DeskNotes.exe' }

if ($exe) {
  if (-not $CloseExe) {
    Fail "DeskNotes (the exe) is running. Quit it with Ctrl+Q, or run again with -CloseExe."
  }
  $exe | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($dev) {
  $dev | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($exe -or $dev) { Start-Sleep -Seconds 2 } # let the single-instance lock go

$branch = git -C $repo rev-parse --abbrev-ref HEAD 2>$null
$commit = git -C $repo rev-parse --short HEAD 2>$null
$dirty = if (git -C $repo status --porcelain --untracked-files=no 2>$null) { ' + uncommitted changes' } else { '' }

$arguments = @('src\desktop\main.mjs')
if ($A11y) { $arguments += '--force-renderer-accessibility' }
Remove-Item env:COPILOT_AUTOSTART, env:COPILOT_TEST_A11Y -ErrorAction SilentlyContinue
if ($A11y) { $env:COPILOT_TEST_A11Y = '1' }
$process = Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $repo -PassThru

# Wait for a window, so a launch that exits at once is reported, not hidden.
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $process.Refresh()
  if ($process.HasExited) { Fail "DeskNotes dev exited at launch (code $($process.ExitCode)). Run scripts\dev.ps1 from a terminal to see why." }
} until ($process.MainWindowHandle -ne 0 -or (Get-Date) -gt $deadline)

$closed = @()
if ($dev) { $closed += 'the previous dev copy' }
if ($exe) { $closed += 'the exe' }
Write-Host "DeskNotes dev running: pid $($process.Id), $branch@$commit$dirty"
if ($closed) { Write-Host "Closed $($closed -join ' and ')." }
Write-Host 'Ctrl+Shift+H shows or hides the overlay.'
