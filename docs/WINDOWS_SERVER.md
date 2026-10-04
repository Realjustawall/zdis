# Windows Server

This edition runs directly on Windows with Node.js; Docker, WSL, PostgreSQL and Redis are not required. Node's built-in SQLite uses SQLite 3 (no separate sqlite3 package is needed). Install Node.js 24 or newer, with node.exe and npm.cmd available on PATH. Validation was performed on Windows with Node 24.11.0, not on a separate Windows Server machine.

## Install and run

Extract `zdis-windows-server.zip`, install Node.js 24 or newer, then double-click
`install-windows.cmd`. When installation finishes, run `start-windows.cmd`.
The ZIP has no archive password. It contains the built client and source, but no
installed dependencies, live `.env`, application databases, uploads, logs, or
browser/testing output. The demo `admin/admin` account is not included. First
startup creates a new administrator and generates its password as described below.

To rebuild the clean ZIP after changing the source, run `npm.cmd run build`, then
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\package.ps1`.

Open PowerShell in the project directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\start.ps1
```

Setup preserves an existing .env, installs locked dependencies and builds the client. Browse http://localhost:8080. The generated admin password appears once on first startup. Admin email defaults to admin@example.com. Edit .env before first startup to set your own account.

Data defaults to server/data/zdis.sqlite3; uploads and the persistent application secret are inside server/data. Environment paths DATA_DIR, SQLITE_FILE and UPLOAD_DIR are resolved relative to the project root, even when launched from another directory. Use an absolute path to keep data outside the source directory. Preserve the data directory on updates.

DATABASE_DRIVER=sqlite explicitly selects SQLite even when the machine has PGHOST/PGUSER or DATABASE_URL configured. To deliberately enable PostgreSQL set DATABASE_DRIVER=postgres; auto restores the original automatic selection. REQUIRE_POSTGRES=true conflicts with explicit SQLite and fails clearly.

SQLite already uses WAL, foreign keys, a 5-second busy timeout and synchronous=NORMAL. A bounded cache reuses up to 128 prepared queries; SQLITE_STATEMENT_CACHE=0 disables it. DDL clears the cache. Keep the SQLite file on a local disk, and run one application instance against it. This edition does not claim improved benchmark throughput.

## Automatic startup

After a successful manual run, open PowerShell as Administrator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\register-startup.ps1
```

This registers and starts a Windows Scheduled Task, not an SCM Windows service. It runs at boot without an interactive login, restarts after failure and prevents overlapping instances. Do not leave the manual instance running when starting the task. The SYSTEM account must be able to execute Node and access this directory. Install Node for all users. Registration refuses to overwrite an existing task.

Console output is captured in logs/server.log, including the initial generated admin password: restrict access to this directory and rotate the log periodically. To inspect, stop or remove the task:

```powershell
Get-ScheduledTaskInfo -TaskName ZDIS-Windows-Server
Stop-ScheduledTask -TaskName ZDIS-Windows-Server
Unregister-ScheduledTask -TaskName ZDIS-Windows-Server -Confirm:$false
```

## Network and HTTPS

For LAN use set PUBLIC_URL and CLIENT_ORIGIN to the actual server URL. Setup with -OpenFirewall (and -FirewallPort when PORT differs from 8080) optionally permits TCP 8080 on Domain/Private profiles and requires Administrator; no firewall rules are changed by default.

For public deployment put an HTTPS reverse proxy in front of the application with WebSocket support. Set PUBLIC_URL and CLIENT_ORIGIN to the HTTPS origin, SECURE_COOKIES=true, TRUST_PROXY=true and HOST=127.0.0.1 when the proxy is on this machine. The default HTTP configuration has SECURE_COOKIES=false so local login works; it does not install TLS automatically.

FFmpeg on PATH is needed for optional video/audio processing. LiveKit/TURN and ClamAV remain separately configured optional services; the Windows installer does not provision them. Redis-backed workers and enterprise clustering are not part of the default single-process installation.

Without Redis the server processes media using a bounded local worker and the SQLite attachment backlog. Interrupted media jobs resume on restart. Scheduled messages, webhook deliveries (up to five attempts with backoff), and notification digests also run locally. FFmpeg must be installed for audio/video derivatives; image previews use sharp. Backups remain an explicit command or an operator-managed scheduled task. Local workers are intended for one application process; use Redis workers when deploying multiple processes.

## Backup and checks

```powershell
npm.cmd run backup --workspace server
npm.cmd run verify-backup --workspace server -- <backup-path>
npm.cmd test
npm.cmd run test:windows
npm.cmd run build
```

Use the application's backup command rather than copying only a live .sqlite3 file (WAL may contain current writes). See the existing backup documentation for restore procedures. Take a backup before updates. Windows access control uses NTFS ACLs; POSIX mode 0600 on the application secret is not an NTFS access policy. Limit access to the project/data/logs to administrators and the task account.

Tests use port 18080; override with TEST_PORT if reserved on your machine. Windows can reserve port ranges (including 4000); inspect with `netsh interface ipv4 show excludedportrange protocol=tcp` and select a free PORT in .env.

The supplied 001_enterprise.sql was empty. Migrations 025/026 restore runtime configuration and 65 missing application tables, with keys, ownership foreign keys and indexes. Existing API/realtime/enterprise tests validate these repairs; optional external-service deployments need their own environment validation.

Validation results and limitations: [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md). SQLite API reference: https://nodejs.org/api/sqlite.html
