# Android and iOS

The mobile projects use Capacitor and share the audited React client with the PWA.

For a production release, point the native shell at the HTTPS deployment so cookie authentication,
WebSocket, uploads and WebRTC remain same-origin:

```bash
CAPACITOR_SERVER_URL=https://chat.example.com npm run native:sync --workspace client
```

Android can then be opened with `npm run android --workspace client`. iOS requires macOS and Xcode;
open it with `npm run ios --workspace client`. Package signing, App Store/Play Console identities and
privacy declarations are deployment credentials and are intentionally not committed to source control.

Without `CAPACITOR_SERVER_URL`, the projects bundle `client/dist` for local UI development. A production
native build should always use the public HTTPS URL unless a native token-auth transport is added.
