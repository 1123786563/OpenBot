# Run from an elevated PowerShell in a Windows 10/11 Pro VM.
$ErrorActionPreference = 'Stop'

$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -match 'Home') {
    throw 'Windows Home cannot host the built-in RDP server. Use Windows Pro, Enterprise, or a supported Windows Server edition.'
}

Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -Name 'RemoteDesktop-UserMode-In-TCP' -ErrorAction Stop
Write-Host 'RDP is enabled. Use a Windows account with a password and keep the VM on a trusted private network.'
