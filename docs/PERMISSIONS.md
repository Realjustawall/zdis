# Account policies and channel permissions

Admin → Settings contains the account access, quota and custom badge editor.
Global defaults apply to existing and new users. An account override replaces
only selected defaults; clearing it restores inheritance. Changes persist in
SQLite. A denial applies even to the server owner and a role with Administrator.
Server owners still bypass channel overwrites, except platform account denials.

The defaults are 10 owned groups/servers, membership in 50 groups/servers,
10 manually created internal channels and 100 channels per group. Owned groups
count toward membership. Automatic starter channels do not consume the manual
creation quota; support tickets consume the group channel limit. Lowering a quota
prevents new creation/joining; it does not delete existing resources. Zero denies
new operations. Built-in and integration bot installation memberships are system
operations and do not consume a human's membership quota.

Ordinary members can create their own server. Inside somebody else's server,
creation requires Manage Channels. Custom roles, @everyone and individual members
have channel allow/deny/inherit settings. Categories can supply synchronized
overwrites. Role allows combine after role denies, and member overwrites apply
last. Private role access also works in channel lists, voice access and search.
Hidden channels are excluded from search and their metadata is not broadcast to
unprivileged members when created or renamed.

See the [official Discord permission algorithm](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)
for the reference order. This app retains legacy owner/admin/moderator membership
roles and platform administrator access. It is not a byte-for-byte Discord API
implementation and does not provide every Discord product feature.

Files, images, video files, audio files, joining voice, speaking, camera and screen
sharing have separate account switches. Channel roles also have image/video/audio
and screen sharing switches. Camera and screen sharing additionally require Video;
media attachments require Attach Files. Standard GIFs and stickers require image
permission. Actual detected file bytes, resumable upload completion and attachment
message delivery are checked. Encrypted attachments conceal their media type, so
all media account grants are required for encrypted containers.

## Voice enforcement limits

LiveKit SFU tokens restrict microphone, camera and screen publication sources
separately. Account and role/channel changes refresh grants of tracked active
participants. Channel SFU sessions cannot use the mesh signalling endpoints.
The client avoids requesting prohibited microphone/camera/screen tracks.

Pure P2P sends media directly between browsers. The server cannot reliably filter
already established media from modified clients. Restricted accounts cannot join
P2P calls; fine-grained listen-only/media restrictions need configured LiveKit.
With LiveKit configured, private calls also use SFU rooms and enforce microphone,
camera and screen publication grants server-side. A member denied all publication
can still listen without capturing a microphone or camera. Blocking either member
revokes access to a running one-to-one call. Without LiveKit, private calls retain
the restricted-account P2P rejection rule.
The initial LiveKit tests connected signaling but failed ICE. On 2026-10-04,
explicit CLI ports, a single IPv4 media-interface filter and local TURN fallback
passed actual media delivery on
LiveKit 1.13.7 Windows. Generated microphone audio and canvas camera/screen streams
were received separately, with decoded video frames, in desktop Chrome and mobile
Chrome emulation. Live microphone denial, camera revocation and participant removal
also passed. Production UI controls passed a two-user desktop test of audio,
camera, screen display, live camera denial and a listen-only rejoin that forbids
all getUserMedia capture. Capture inputs are generated/fake;
physical hardware, the OS screen chooser and internet/NAT paths are not certified.
Do not claim complete voice security validation or 100% Discord parity. Server-side refresh failures are logged; distributed
multi-worker SFU refresh is not certified by the SQLite single-process tests.

## Badges

Built-in badges remain available. Admins create custom badges with a name, color
and supported icon. The user editor grants/removes these alongside built-in
badges. Deleting a custom badge removes assignments. Custom badges are cosmetic;
they do not grant staff or administrator access. Built-in badges cannot be deleted.

## Validation

Seven isolated SQLite tests cover inherited policies, zero limits, concurrent group
creation and membership, administrator-denial precedence and custom badge lifecycle.
Seven real HTTP/WebSocket scenarios cover policy authorization/validation, group
and concurrent channel quotas, upload denial, voice/P2P join restrictions, private
role access and search privacy, and custom badge authorization. The browser test
exercises the actual admin editor in desktop Chrome and mobile Chrome emulation.

The additional SQLite regressions verify that GIF message edits cannot bypass an
image restriction, and runtime configuration rejects invalid patches atomically
while preserving blank secrets. Four desktop/mobile browser tests passed.

Admins can configure LiveKit signaling/API URLs, API credentials and participant
capacity in the platform panel. Secrets are encrypted and write-only. Refresh
clients after transport changes. The Windows LiveKit binary reported unsupported
CPU monitoring; production capacity management needs separate validation.

The latest backend now runs on port 18181 with migration 030 applied.
Use `powershell -ExecutionPolicy Bypass -File windows/preview.ps1` for a local
preview with isolated .tmp data and the test account admin/admin. This command
binds only to localhost; the production start command uses separate data and
generates its initial password. The media server currently stays running for
the requested preview. Test accounts/groups are removed by the SFU tests.
Temporary binaries, keys, databases and test reports are excluded from packages. This release does not certify all Discord features or
high-load voice/video operation.

## Windows SFU preview

The Windows app and LiveKit are separate processes. Download the Windows LiveKit
binary from the official release page, then run from the Windows edition root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File windows/preview-livekit.ps1 -NodeIp YOUR_LOCAL_IPV4 -LiveKitExecutable "C:\Tools\LiveKit\livekit-server.exe"
```

Use the IPv4 assigned to this computer's active LAN adapter. The helper rejects an
unassigned/loopback address or occupied ports, creates random persistent local API
credentials in `.tmp/preview-latest`, and starts the app on localhost:18181.
LiveKit uses signal TCP 18880, media TCP 18881 and media UDP 18882, supplied
explicitly on its command line. Local TURN uses UDP 18883 and relay UDP
18884?18893. Its RTC IP filter binds media only to the selected NodeIp, rather
than also binding VMware and other virtual adapters. Stopping the helper also stops its owned media
child. It does not change firewall rules. Earlier unfiltered configurations had intermittent ICE failures. Restricting
media to the selected IPv4 adapter, together with the local TURN fallback,
passed repeated tests and a fresh restart. This points to the multi-interface
configuration, but does not isolate an upstream LiveKit defect. The helper runs
without dev mode or fixed public credentials.

This is a local preview. For a public installation, configure routable candidates,
TLS and firewall/NAT rules and validate clients from another network. See
[LiveKit local setup](https://docs.livekit.io/transport/self-hosting/local/) and
[deployment guidance](https://docs.livekit.io/transport/self-hosting/deployment/).
The LiveKit binary is not bundled in the installation ZIP.

The latest SFU run passed three scenarios (desktop SDK, desktop production UI,
mobile-emulated SDK). The desktop UI scenario is explicitly skipped for mobile
emulation; it does not certify a phone OS capture chooser. The SDK tests verify
microphone/camera browser permission has not already been granted, so connection
success is not dependent on enabling fake capture devices.
