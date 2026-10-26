# Verification of the unpushed mobile/realtime changes

The Quality workflow runs on every branch push. Push only the review branch
`fix/android-native-realtime-security` after the owner's approval; no merge,
tag, deployment or release is needed. The release workflow accepts successful
Quality runs from push events on main only.

## Required checks

| Job | Evidence required |
| --- | --- |
| Native SQLite runtime: Ubuntu and Windows | Build, full server tests, SQLite compatibility and both server archives |
| Browser E2E | All browser suites, actual mesh RTP assertions, reconnect recovery, language/direction and the 59-page geometry audit |
| LiveKit media E2E | Real incoming audio bytes, decoded video frames, generated screen-stream playback, publication permissions, receive-only entry and microphone promotion |
| Dedicated clients | Run the actual server builder with disposable per-origin keys; produce signed APK and NSIS EXE; verify APK signature, hashes, embedded Android HTTPS origin and Windows Authenticode signature |
| Android emulator | Install the APK on API 35, launch the fully qualified activity, retain a running process and save launch/logcat diagnostics |
| Windows client | Verify signatures, silently install, inspect embedded server.json inside the installed app.asar and confirm the process stays running |
| Security/infrastructure | Production dependency audit, SBOM, repository/image/secret scans, Compose/Kubernetes/Terraform checks and PostgreSQL/Redis/S3/AV integration |

The native candidates point to the reserved `https://ci.zdis.invalid` origin.
Android/Windows installation checks are startup smoke tests, not successful
login or media tests inside those installed apps. Browser tests use a disposable
real backend and SFU; browser media sources are generated test devices. Physical
microphone/speaker quality, Android hardware variations, public Windows signing
trust and exact visual parity with Discord remain outside these automated checks.
CI signing keys are discarded; these candidates are not server production builds.

SFU suites get separate backend instances so production login throttles remain
intact. CI rejects `VOICE_QA_SIGNALLING_ONLY=1`; successful control signalling is
insufficient to pass the media assertions. A reconnect must show increasing
incoming audio bytes, rather than merely retaining an old nonzero counter.

## Execution status

Prepared locally, not executed on GitHub yet. The latest remote Quality run
`40170377611` tested the old `a51a73557b28659b8793606a9975fa4f42dbd733`
commit; its dependency audit failed. Re-running that run cannot test local fixes.
Four native source/builder/artifact checks, Python syntax checks, workflow YAML
parsing and browser suite discovery passed locally. Docker builds, Authenticode
verification, emulator and Windows installation require the Actions runners.

After approval, record the new exact commit SHA and run URL, inspect every job,
fix failures on the same review branch and rerun the affected checks. Do not
describe this plan or the old run's successes as results for the new version.
