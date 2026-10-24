$ErrorActionPreference = 'Stop'

$driverCommand = Get-Command cua-driver -ErrorAction SilentlyContinue
if (-not $driverCommand) {
    throw 'Install CUA Driver in this interactive Windows user session first: irm https://cua.ai/driver/install.ps1 | iex'
}
$driver = $driverCommand.Source

cua-driver autostart kick | Out-Null
Start-Sleep -Seconds 2
cua-driver status | Out-Null

function Invoke-CuaTool([string]$Tool, [hashtable]$Arguments) {
    $json = $Arguments | ConvertTo-Json -Depth 8 -Compress
    $output = $json | & $driver call $Tool
    if ($LASTEXITCODE -ne 0) {
        throw "cua-driver call $Tool failed with exit code $LASTEXITCODE"
    }
    return (($output -join "`n") | ConvertFrom-Json)
}

Start-Process notepad.exe
Start-Sleep -Seconds 2

$windows = @((Invoke-CuaTool 'list_windows' @{ app = 'Notepad' }).windows)
if (-not $windows -or $windows.Count -lt 1) {
    throw 'CUA Driver could not find a Notepad window in this Windows desktop session.'
}
$window = $windows[-1]
$session = 'openbot-windows-demo'

$snapshotArgs = @{ pid = $window.pid; window_id = $window.window_id; session = $session }
Invoke-CuaTool 'get_window_state' $snapshotArgs | Out-Null

$textArgs = @{
    target = @{ kind = 'window'; pid = $window.pid; window_id = $window.window_id }
    text = "CUA Driver is controlling this Windows desktop.`r`nThe same desktop is visible through Apache Guacamole over RDP.`r`n"
    delivery_mode = 'foreground'
    session = $session
}
Invoke-CuaTool 'type_text' $textArgs | Out-Null
Write-Host 'CUA typed into Notepad. The result should be visible in the Guacamole session.'
