# Windows GUI + CUA Driver + Guacamole demo

This demo displays a real Windows GUI in a browser using Guacamole's RDP client. CUA Driver runs inside the signed-in Windows desktop session and types into Notepad. Both paths connect to the same Windows VM; the browser does not run Windows or CUA itself.

## Requirements

- A Windows 10/11 Pro, Enterprise, or supported Windows Server VM. Windows Home cannot accept built-in RDP connections.
- A logged-in Windows user with a password, and CUA Driver installed for that same user.
- Docker Compose and Python 3.9+ on the machine running Guacamole. The Windows VM must be reachable from the `guacd` container on TCP 3389. For a Parallels VM, use bridged networking and set its LAN address in `.env`.
- The Windows VM's RDP firewall rule enabled. Keep RDP on a trusted private network; do not expose port 3389 to the public internet.

On this Apple Silicon Mac, Parallels is installed but no Windows VM is present, so create a Windows 11 ARM VM in Parallels or supply another Windows host before the RDP part can run. For Parallels, set the VM network adapter to **Bridged Network** so `guacd` can reach the guest's LAN IP.

## Prepare the Windows VM

In an elevated PowerShell inside the Windows VM, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./windows/enable-rdp.ps1
```

Copy or download this example folder into Windows first if you want to run the script there. The script enables Remote Desktop and its built-in firewall rule. Use Windows Pro or later.

Sign in to the Windows VM as the user that Guacamole will use. In that user's PowerShell, install CUA Driver and register its daemon to start in the interactive logon session:

```powershell
irm https://cua.ai/driver/install.ps1 | iex
cua-driver autostart enable
cua-driver autostart kick
cua-driver status
cua-driver doctor
```

The `doctor` report should identify an interactive desktop session. Do not run the CUA daemon as an SSH/service account in Session 0; it cannot see the GUI. First connect through Guacamole and confirm the same Windows account can log on over RDP.

## Start Guacamole

On the machine running Docker Compose:

```sh
cd examples/cua-guacamole-windows-demo
cp .env.example .env
```

Edit `.env` with the Windows VM's bridged IP, Windows account credentials, and a local Guacamole login. Then run:

```sh
./start.sh
```

Open <http://127.0.0.1:18082/> and sign in using `GUACAMOLE_USERNAME` and `GUACAMOLE_PASSWORD`. Select **Windows CUA desktop**. In that RDP desktop, open PowerShell and run the demo script from the copied example folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd C:\OpenBot\examples\cua-guacamole-windows-demo
.\windows\run-cua-demo.ps1
```

CUA Driver opens Notepad and types a short message. The same Notepad window is visible in Guacamole.

To stop the web gateway, run `docker compose down`. The Windows VM and its CUA Driver daemon remain under the VM user's control.

The generated `runtime/user-mapping.xml` contains demo credentials and is ignored by git. This example is a local proof of concept: it does not implement OpenBot user-to-VM provisioning, per-user authorization, session leases, or audit storage. CUA Driver is MIT licensed; Guacamole is Apache 2.0.
