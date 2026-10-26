## ZDis 1.0.2 — Mobile navigation, realtime recovery and dedicated clients

- Rebuild the mobile workspace with horizontal side pages, mirrored Persian/English direction, reviewed translations and narrow-screen overflow fixes.
- Add receive-only voice entry without microphone or camera capture; preserve mute state, allow microphone activation later and recover room signalling after reconnect.
- Recover missed message changes, presence and activity state without refreshing the page; update voice control and lobby state through realtime events.
- Harden session/origin validation and administrative access, fix administrator user creation and update vulnerable production dependencies.
- Add per-server Android and Windows client builds with embedded HTTPS origin and server-specific signing keys. The server builder retains keys for upgrades; a server's Windows certificate is self-signed and does not provide public publisher trust.
- Restore the Android activity/resources and make microphone/camera hardware optional.
- Add signed native artifact verification, Android emulator installation, Windows installer startup checks, real-media browser tests and isolated browser backends in CI.

The release archives are the Ubuntu and Windows **server/application distributions**. They include the dedicated client builder; they are not APK or NSIS client installers. Build those for your own HTTPS server using `scripts/build-server-clients.py`. CI client candidates target a reserved test origin and are not production downloads.

Automated native installation checks cover installation and process startup, while browser tests exercise application/media behavior against disposable backends. They do not establish physical-device audio quality or pixel-perfect equivalence with Discord.

### Previous server deployment fixes

- Fix PostgreSQL selection in Scale, Enterprise and Kubernetes deployments.
- Fix container worker startup and the Scale worker health probe.
- Serialize initial administrator and built-in bot provisioning across PostgreSQL nodes to prevent duplicate-account startup failures.
- Update vulnerable production and development dependencies without removing application features.
- Add deployment, concurrent bootstrap and distribution packaging regressions.
- Verify native Ubuntu and Windows builds, PostgreSQL/Redis integration, browser and LiveKit media behavior, security scanning and cluster capacity/failover before publication.

The Ubuntu archive includes `ubuntu/setup.sh` and `ubuntu/start.sh`; the Windows archive includes the existing `.cmd` launchers and `windows/setup.ps1`/`windows/start.ps1`. Both include the full application sources and production web build. Install Node.js 24 or newer and follow the existing platform setup instructions. SHA256SUMS.txt verifies the downloaded archives.
