# ZDIS

**Private communication platform for creators and their teams.**

Developed by **Sahsha Team — JustAWall**

> **License:** This project is distributed under its own license terms.
> Before using, modifying, redistributing, or using ZDIS commercially, please read the [LICENSE](LICENSE) file.

---

Enterprise deployment, HA, SFU/TURN, object storage, malware scanning,
observability, backup/restore, multi-region failover, CI, E2E, and load-testing
instructions are in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

For a complete one-command Ubuntu installation see
[docs/UBUNTU_INSTALL.md](docs/UBUNTU_INSTALL.md).

ZDIS is a private chat platform for creators , developers and also companies that contain
channels, direct messages, voice/video calls and file sharing, with every
account provisioned by an administrator.

There is **no public sign-up**. The only way an account comes into existence is
an administrator creating it in the admin panel.

---

## Quick start

```bash
npm install
npm run build       # builds the React client
npm start           # serves API + client on http://localhost:4000
```

Complete Ubuntu server installation:

```bash
sudo bash installer/installer.sh \
  --domain chat.example.com \
  --admin-email admin@example.com \
  --email operations@example.com \
  --server-ip 203.0.113.10
```

It provisions the complete Docker stack, TLS, firewall, systemd, generated
secrets, automatic backups and the `zdisctl` operations command. Existing
files, production secrets, configuration and Docker volumes are preserved.

Open http://localhost:4000 and sign in with the administrator account.

For development with hot reload:

```bash
npm run dev         # API on :4000, Vite dev server on :5173
```

Use http://localhost:5173 in development — it proxies `/api` and the
WebSocket to the API server, which keeps the session cookie same-origin.

### Configuration

Everything has a working default; copy `.env.example` to `.env` only to change
something.

```bash
cp .env.example .env
```

The first administrator is created at startup from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`. If you leave the password blank, a strong one is
generated and printed **once** in the server log.

Locked out? Recover from the console:

```bash
npm run reset-admin --workspace server -- office@intesho.com
```

---

## Infrastructure — nothing to install

No Docker, no database server, no cache server. The app detects what is
available and adapts:

| Component        | If available                                                           | Otherwise                                                                        |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Database         | PostgreSQL, when `DATABASE_URL` is set **and** the connection succeeds | SQLite via Node's built-in `node:sqlite` — no native compilation, no C toolchain |
| Cache            | Redis, when `REDIS_URL` is set **and** it answers a `PING`             | A bounded in-process cache                                                       |
| Realtime fan-out | The Redis Socket.IO adapter, so you can run several server processes   | Single-process, in-memory                                                        |

A refused Postgres or Redis connection is logged as a warning and the server
keeps starting — it never fails to boot because an optional dependency is
missing. The live choice is shown in the admin panel under **Overview →
Runtime**.

Redis matters only if you run more than one server process. One process is fine
for a few hundred concurrent users.

---

## ClamAV malware scanning and memory requirements

ZDIS can use **ClamAV** as an additional security layer for scanning uploaded
files for known malware before those files are made available to users.

ClamAV is strongly recommended for production installations where file uploads
are enabled and files may be uploaded by users you do not fully trust.

### RAM requirements

ClamAV loads its malware signature database into memory. This means that the
ClamAV daemon can consume a noticeable amount of RAM while running, especially
during startup and malware-database updates.

For a server running ZDIS together with ClamAV:

* **4 GB RAM or more is recommended** for a comfortable production deployment.
* **2 GB RAM may work for smaller installations**, but available memory can
  become limited when ZDIS, ClamAV, Docker services, PostgreSQL, Redis or other
  services are running on the same machine.
* Servers with limited physical memory should have **Swap** configured.
* Swap can help prevent Linux from terminating processes when RAM is exhausted.
* Swap is **not a replacement for physical RAM**. Heavy Swap usage will reduce
  performance because disk storage is significantly slower than RAM.

### Check available RAM and Swap

Check current memory usage:

```bash
free -h
```

Example:

```text
               total        used        free      shared  buff/cache   available
Mem:            3.8Gi       1.2Gi       1.5Gi       100Mi       1.1Gi       2.3Gi
Swap:           2.0Gi          0B       2.0Gi
```

You can also check active Swap devices directly:

```bash
swapon --show
```

If this command returns nothing, your server currently has no active Swap.

You can inspect memory continuously with:

```bash
top
```

or, if installed:

```bash
htop
```

### Add Swap on Ubuntu

If the server has limited RAM, a **2 GB Swap file** is a reasonable starting
point for smaller ZDIS deployments.

Create a 2 GB Swap file:

```bash
sudo fallocate -l 2G /swapfile
```

Restrict access to the file:

```bash
sudo chmod 600 /swapfile
```

Format the file as Swap:

```bash
sudo mkswap /swapfile
```

Enable it:

```bash
sudo swapon /swapfile
```

Verify that it is active:

```bash
free -h
```

You should now see a Swap entry similar to:

```text
Swap:           2.0Gi          0B       2.0Gi
```

You can also verify it with:

```bash
swapon --show
```

### Keep Swap enabled after reboot

The commands above enable Swap immediately, but without an `/etc/fstab` entry
it may not automatically return after the server reboots.

Add the Swap file to `/etc/fstab`:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Verify:

```bash
tail /etc/fstab
```

You should see:

```text
/swapfile none swap sw 0 0
```

### Configure Swap usage

Linux controls how aggressively it moves memory pages into Swap using the
`vm.swappiness` setting.

Check the current value:

```bash
cat /proc/sys/vm/swappiness
```

For a server, you may choose a lower value such as `10` so physical RAM is
preferred and Swap is mainly used when memory pressure increases.

Apply it immediately:

```bash
sudo sysctl vm.swappiness=10
```

To keep the setting after reboot:

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-zdis.conf
```

Apply the saved configuration:

```bash
sudo sysctl --system
```

Verify:

```bash
cat /proc/sys/vm/swappiness
```

Expected output:

```text
10
```

### Install ClamAV on Ubuntu

Install ClamAV and its daemon:

```bash
sudo apt update
sudo apt install -y clamav clamav-daemon
```

Check the installed version:

```bash
clamscan --version
```

Update the malware signature database:

```bash
sudo freshclam
```

If `freshclam` reports that another updater process is already running, the
automatic ClamAV update service may already be managing database updates.

Check the ClamAV daemon:

```bash
sudo systemctl status clamav-daemon
```

Enable it automatically at boot:

```bash
sudo systemctl enable clamav-daemon
```

Start or restart it:

```bash
sudo systemctl restart clamav-daemon
```

Verify again:

```bash
sudo systemctl status clamav-daemon
```

### Test ClamAV manually

You can scan an individual file with:

```bash
clamscan /path/to/file
```

Scan a directory recursively:

```bash
clamscan -r /path/to/directory
```

The output will include a scan summary showing the number of scanned files and
whether infected files were detected.

### Low-memory servers

If ClamAV is repeatedly terminated on a low-memory VPS, check for
out-of-memory events:

```bash
dmesg | grep -i -E 'out of memory|oom|killed process'
```

Also check available memory:

```bash
free -h
```

If the machine has no Swap, configure it using the instructions above.

If Swap is already heavily used during normal operation, the preferred
production solution is to increase the server's physical RAM rather than
continuously increasing Swap.

For example, if:

```bash
free -h
```

shows that physical RAM is almost completely occupied and a significant amount
of Swap is constantly being used, the machine is under memory pressure.

### Important security note

If file uploads are enabled for untrusted users, disabling malware scanning
solely to save memory reduces the security of the deployment.

ClamAV should be treated as an additional security layer. It does not replace
ZDIS file-type validation, upload restrictions, permission checks or other
application-level security controls.

---

## Roles

Three platform roles, set by an administrator:

| Role         | Can do                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **admin**    | Everything below, plus the admin panel: create/edit/disable/delete accounts, reset passwords and 2FA, force sign-outs, delete any group, change server settings, read the audit log. Moderates every group. |
| **youtuber** | Creates their own groups and becomes owner. Adds people from the member directory straight into their group, issues invite codes, promotes moderators, manages channels. This is the intended primary role. |
| **member**   | Joins groups they are added to or invited to, DMs anyone, takes part in voice. Cannot create groups by default (an admin can switch this on).                                                               |

Every account can see every other account in the **member directory** and start
a DM with any of them.

Inside a group there is a second, independent set of roles — **owner → admin →
moderator → member** — controlling channel management, member management,
invites, pinning and deleting other people's messages. Nobody can grant a role
at or above their own, and nobody can act on someone who outranks them.

Accounts can also carry multiple badges. Administrator, Staff, Developer and
Streamer badges grant platform capabilities; creator-platform badges are
identity labels, while Editor, PicoArt and Team labels can be managed by a
streamer for people on their roster. The legacy three-value role remains in the
API for compatibility and is kept in sync with capability badges.

---

## Features

**Messaging** — text channels, private channels with an explicit member list,
1:1 DMs, group DMs up to 25 people, replies with threading context, editing,
soft deletes, emoji reactions, pinned messages, `@mentions` with autocomplete,
unread and mention badges, read state, cursor-paginated history, and search
scoped to exactly what you are allowed to read.

**Formatting** — `**bold**`, `*italic*`, `__underline__`, `~~strike~~`,
`` `code` ``, ` ```code blocks``` `, `> quotes`, `||spoilers||`, links,
mentions. Rendered directly to React elements rather than to HTML, so message
content cannot inject markup regardless of what someone types.

**Voice and video** — WebRTC voice channels with camera and screen sharing,
per-participant mute/deafen, speaking indicators, and a live participant list
in the sidebar. Full mesh up to 8 people per channel: media flows peer to peer
and never touches the server, which only relays SDP and ICE. STUN is
configured by default; set `TURN_URL` for participants behind restrictive NAT.

**Files** — up to 10 MB, with the type allow-list and per-category switches
under the administrator's control. Uploads can be switched off entirely, which
removes the attach button and closes the endpoint.

**Realtime** — presence, typing indicators, and live delivery of every message,
edit, reaction, membership and settings change over Socket.IO.

**Network** — friend requests, public linked creator profiles, streamer-owned
rosters, cross-roster access approval, and streamer collaboration requests.
Accepting a collaboration creates a shared group automatically. Roster
accounts cannot enter another streamer's group until they approve that
streamer's access request.

**Channel organisation** — group owners can create ordered channel categories,
assign text or voice channels to them, move channels between categories, and
remove a category without deleting its channels.

**Admin panel** — account lifecycle, per-account security actions, group
oversight, multi-badge assignment, linked-profile verification, server
settings, an audit log, and a maintenance sweep for expired sessions and
orphaned uploads.

---

## Security

The trade-offs here were made toward safety over convenience.

**Authentication.** Passwords are hashed with scrypt (N=65536, r=8 — about
64 MB per hash), from Node's own crypto module, so there is no native addon to
build and an offline attacker faces a memory-hard wall. Sessions are opaque
random tokens; only a SHA-256 of each token is stored, so a database leak hands
out no live sessions. Failed sign-ins are throttled per IP *and* per account,
with a lockout after 8 attempts. A wrong password and a non-existent account
take the same amount of time and return the same message, so the endpoint does
not disclose which addresses are real. Optional TOTP two-factor authentication
can be made mandatory for administrators.

**Sessions.** Cookies are `httpOnly`, `SameSite=Strict`, and `Secure` in
production. CSRF is a second layer on top: a double-submit token derived by
HMAC from a per-session secret, required on every state-changing request.
Sessions are individually revocable — changing a password signs out every other
device, and an administrator can disable an account and see its live sockets
close within the same second.

**Authorisation.** Every read and write resolves through a single permission
context. Non-members get `404`, not `403`, when they probe a group or
conversation, so identifiers cannot be enumerated. Private channels are
filtered out of listings, message reads, and search results. Attachments are
never served statically — each download re-checks that the caller can read the
message the file belongs to.

**Uploads.** The declared content type is treated as a hint and nothing more:
files are identified by their magic bytes and rejected if the bytes disagree
with the allow-list. SVG is refused outright because it is scriptable. Stored
filenames are random, the original name is sanitised and only used for the
download prompt, and files are written `0600` outside any statically served
path. Every response carries `nosniff`, a sandboxed CSP and
`Content-Disposition`. Uploads never attached to a message are swept hourly.

**Everything else.** All SQL is parameterised. Request bodies are validated
with zod schemas before reaching any handler. Message content is stripped of
control characters and bidi overrides, which are the usual way to fake a line
as coming from someone else. A strict CSP, `frame-ancestors 'none'`,
`no-referrer` and HSTS are set. Security-relevant actions land in an
append-only audit log with actor, target and IP.

Two guard rails exist so the platform cannot be locked out of itself: the last
administrator cannot be demoted, disabled or deleted, and no administrator can
demote or disable their own account.

### Before you put this on the internet

1. Serve it over HTTPS and set `SECURE_COOKIES=true`.
2. Set `TRUST_PROXY=true` if you run behind nginx or Caddy, so rate limiting
   and the audit log see the real client IP.
3. Change the seeded administrator password, and set `SEED_ADMIN_PASSWORD` to
   empty afterwards so it is not sitting in `.env`.
4. Set `CLIENT_ORIGIN` to your real origin.
5. Turn on **Require two-factor authentication for administrators** in the
   admin panel — after you have enrolled.
6. Configure a TURN server if participants will be on restrictive networks.
7. Back up `server/data/` — it holds the SQLite database, the uploaded files
   and `.app_secret`. Losing `.app_secret` invalidates every session.

---

## Tests

The server must be running; both suites drive the real HTTP and WebSocket API.

```bash
npm start            # in one terminal
npm test             # in another
```

* `tests/migration.test.mjs` — boots a legacy SQLite schema and verifies that
  new columns are applied before indexes and all network tables are created.
* `tests/api.test.mjs` — 56 checks over auth, roles, permissions, groups,
  channels, messages, DMs, uploads and the admin panel, including the negative
  cases: CSRF rejection, private-channel isolation, search scoping, disguised
  executables, oversized files, last-admin protection.
* `tests/realtime.test.mjs` — 19 checks over Socket.IO and the WebRTC
  signalling path: authenticated handshakes, live delivery, membership
  boundaries, presence transitions, offer/answer/ICE relay, and the rule that
  signalling never escapes a voice room.
* `tests/network.test.mjs` — 10 end-to-end checks over badge migration,
  streamer provisioning, roster fences and approvals, friends, collaboration
  group creation, linked-profile verification, staff moderation and channel
  categories.

---

## Layout

```text
server/src/
  config.js            environment, paths, generated app secret
  app.js               express app, security headers, route mounting
  index.js             startup: db → cache → seed → http → realtime
  db/                  driver selection, portable schema, migrations
  cache/               redis-or-memory facade
  lib/                 password (scrypt), totp, ids, validation, errors
  middleware/          session loading, CSRF, rate limits, error handling
  services/            users, sessions, groups, conversations, messages,
                       uploads, permissions, settings, audit, badges,
                       capabilities, network
  realtime/            socket.io wiring, typing, WebRTC signalling
  routes/              auth, users, groups, conversations, messages, files, admin
  scripts/             seed, reset-admin

client/src/
  store/               session, chat, realtime, voice (WebRTC mesh), toasts
  components/          chat view, composer, message, sidebars, voice stage
  pages/               login, admin panel, member directory, network
  lib/                 api client, safe rich-text renderer, formatting
```

Ids are time-sortable, so message pagination is a plain `id < cursor`
comparison rather than an `OFFSET` scan. Timestamps are epoch milliseconds and
booleans are integers throughout, which is what lets one schema file work
unchanged on both SQLite and PostgreSQL.

---

## License

ZDIS is distributed under the terms described in the repository's
[LICENSE](LICENSE) file.

**Commercial use may require separate permission or licensing. Read the
[LICENSE](LICENSE) file before using ZDIS commercially.**

---

## Credits

**ZDIS**
Developed by **Sahsha Team**
**JustAWall**

© ZDIS / Sahsha Team. All rights reserved where applicable.
