# Windows / SQLite validation — 2026-10-02

Local validation is extensive, but **unconditional production approval is not established**. The Windows edition is in `zdis-windows-server`; the supplied project outside it was preserved.

## Environment and method

Windows 11 Enterprise 10.0.22631, Node 24.11.0, npm 11.6.1, approximately 16 GB RAM, installed Google Chrome, FFmpeg 8.1.1, and the actual Windows LiveKit 1.13.7 release with its published checksum verified. Tests ran in an isolated copy whose path includes spaces, with separate databases, uploads, accounts and ports. SQLite and in-memory cache were used without Redis/PostgreSQL.

Microphone and camera inputs were synthetic Chrome devices; DTLS/RTP transmission, frame decoding and getDisplayMedia screen capture were real. Mobile tests use Chromium device emulation. The Safari compatibility test simulates restricted storage and legacy media listeners; it is not a Safari browser test.

## Verified changes

- Windows setup/start/boot-task scripts, root-relative data paths, explicit SQLite selection and bounded prepared-statement reuse.
- Serialized asynchronous SQLite transactions. Regression tests cover 20 concurrent transactions and unrelated writes queued both before and during a rollback.
- Both WebRTC peers can renegotiate. Perfect negotiation handles simultaneous offers; source metadata distinguishes screen sharing from camera tracks.
- Playback chooses the screen while camera and screen coexist, observes stream mutations, and resumes the camera after sharing stops.
- SFU video elements use LiveKit Track.attach/detach so adaptive streaming receives actual visibility information. LiveKit documents this requirement at https://docs.livekit.io/guides/room/receive.
- Private-call state closes at both ends after hang-up or decline.
- SQLite-backed local media jobs generate previews/derivatives automatically without Redis and resume interrupted processing.
- Local scheduled-message, webhook and digest workers. Scheduled publication uses a reserved stable message nonce and numeric encrypted flags; existing legacy scheduled rows receive defaults.
- Active group indicator retains its centering during animation.
- Updated locked dependencies, including Nodemailer. npm audit reports **0 vulnerabilities** on this lockfile. This is not a comprehensive security certification.
- Test database paths are explicitly isolated from an installed application's .env.

## Executed verification

| Area | Result and scope |
| --- | --- |
| Locked installation | npm ci succeeded in the isolated Windows copy with updated manifests/lockfile. A previous entirely empty-cache attempt stalled on dependency retrieval; offline/blocked-network installation is not certified. |
| Build | TypeScript, Vite, service-worker generation and offline asset verification passed. |
| Backend | npm test passed: 66 API, 23 realtime, 13 network and 10 platform/E2EE cases; enterprise scenario, legacy migration, antivirus protocol, backup verification/restore, TURN credentials, E2EE migration, file encryption and new SQLite transaction regression also passed. |
| Windows runtime | Explicit SQLite despite inherited PostgreSQL variables; unrelated working directory, nested paths, cached statements, DDL invalidation and persistence after reopening passed. All three Windows PowerShell scripts parsed. |
| Browser | **26 passed, zero failed/skipped**, desktop and mobile Chromium: administration, accounts, themes, notifications, group chat, live delivery, scrolling, deletion, mixed-direction text, native text preview, actual service-worker offline reload and compatibility simulation. Media tests measure inbound RTP and decoded frames, simultaneous camera offers, selected screen track, advancing playback, camera restoration, private hang-up and decline. |
| Browser teardown | A worker-owned Chrome occasionally needed bounded forced termination after assertions finished. The fixture disconnects its remote client and terminates only its own browser process; the final suite exited successfully. |
| Files | **24 successful scenarios**: 17 formats (TXT, Markdown, CSV, JSON, CSS, JS, PNG, JPEG, WebP, GIF, WAV, MP3, OGG, MP4, WebM, PDF, ZIP), message attachments, exact bytes/hashes, unauthorized-reader rejection, automatic preview, HTTP ranges, invalid payloads, resumable upload, cancellation and concurrent upload. PDF sample validates transfer/signature, not a full PDF rendering corpus. |
| Resumable upload | 20 MiB + 137 bytes, five parts, out-of-order and duplicate parts, premature completion rejection, restart during upload, final SHA256, wrong checksum, ownership and released reservation passed. |
| No-Redis processing | Automatic image preview, WAV derivative and MP4 poster/derivative, interrupted-job restart, 20 concurrent image previews, scheduled publication with real Socket.IO delivery and restart without duplicate stored messages passed. |
| Webhooks | Actual local HTTP receiver, first response 503 then 200, signature verification, delivered status and attempt count passed. Local receiver was allowed only in a test configuration; production configuration rejected a private destination. |
| Mail/digest | Updated Nodemailer passed SMTP verification, notification delivery, real immediate notification fallback and due digest delivery/status against a local fake SMTP receiver. No email was sent to an external provider. |
| Private media | Eight additional actual-browser scenarios passed: private voice/video, screen RTP, hang-up at both ends, decline and microphone denial without fake automatic permission approval. |
| SFU controls | Real LiveKit passed camera-after-audio, first/later screen sharing and screen replacing an active camera. Displayed screen advances and camera playback resumes after Stop sharing. |
| SFU stability | Four distinct users passed a 120-second all-to-all test: each user continuously received audio and decoded video from all three peers, sampled every ten seconds, at 160x120 / 5 FPS. Twelve-user initial connection and media reception passed, but longer stability **did not pass**; see limitations. |
| Direct mesh stability | Four distinct users passed a 120-second all-to-all audio/video test at 160x120 / 5 FPS. Two users passed 60 seconds with actual 1280x720 / 10 FPS captured camera settings. This is not a 720p/30 FPS or 4K certification. |

## Final application load

The final SQLite adapter passed all ten load scenarios:

- 10, 100, 500 and **1,500 authenticated WebSockets**, spread across at most **89 distinct member accounts**. This is not 1,500 independent people.
- 200 message writes persisted once, and the observer received each once; no write was rate-limited in this run.
- 20 simultaneous 1 MiB uploads remained byte-exact while 1,500 sockets were connected.
- 100 disconnected clients reconnected with their existing sessions.
- 900 excessive health requests triggered 301 protective HTTP 429 responses and no server crash.
- Restart afterward preserved SQLite integrity and foreign-key checks.

Measured p95 connection latency was 38 / 183 / 103 / 73 ms at those connection counts; p95 message-write latency was 849 ms. The 20-upload scenario took about 100.5 seconds, and the separate ten simultaneous 2 MiB file scenario took about 205.9 seconds. These upload durations are an observed performance limitation requiring measurement on the target server. No throughput improvement or response-time SLA is claimed.

## Unresolved and untested conditions

- **Eight-user direct mesh stability failed locally**, including an independent raw RTCPeerConnection control with both ICE candidate pool sizes 2 and 0. This does not establish an application-server root cause, and this capacity is not approved.
- **Twelve-user SFU long-duration stability is not approved.** Early tests were affected by verbose log capture; quiet logging allowed twelve users to join. One longer run stopped decoding an inbound video around 180 seconds; after fixing adaptive element attachment, another run observed disconnected transports. Four-user stability passed; the remaining high-capacity issue must be checked with separate real clients and the target media server.
- Windows LiveKit logged unsupported CPU monitoring and disabled capacity management on this platform. The application installer does not provision LiveKit or TURN.
- Actual Windows Server installation/reboot, SYSTEM scheduled-task execution and administrative firewall changes were not exercised on this Windows 11 workstation.
- Physical microphones/cameras and subjective audio quality, real mobile devices, real Safari/Firefox, 720p/30 FPS and 4K, public TLS deployment, NAT/TURN relay, WAN loss/jitter, hours-long soak, thousands of unique accounts, Redis/PostgreSQL clustering/failover, real S3, OAuth, payment, push and external mail-provider integration are not certified.
- TURN credential checks do not prove a TURN relay call. API recording/consent checks do not prove an actual recording/egress provider.

## Reproducing retained regressions

Run in an isolated copy after `npm ci`:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:windows
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npx.cmd playwright test --workers=1
npm.cmd audit
```

The backend test runner uses port 18080 (TEST_PORT override); browser tests use 18081 on Windows (TEST_E2E_PORT override). Retained regression source is under tests/, and supplemental scenario results are preserved in validation-results.json beside this report.

## Final checks

All 48 supplemental-test databases passed SQLite integrity and foreign-key checks. Source hashes matched between the Windows edition and the tested copy. All owned application/browser/LiveKit processes were stopped; the final process and TCP-listener checks found no test instance remaining.

## Temporary environment cleanup

The dedicated environment is zdis-test-53ffb90116f4456a843365222d24facf. Automatic approval review previously rejected deletion of this exact environment with `blocked by policy`, without a more specific reason. Its files have not been claimed deleted. The exact-path, process-checked cleanup-test.ps1 inside that directory is available for manual cleanup. Product source, dependencies needed to run the Windows edition, and this validation report must be preserved.

