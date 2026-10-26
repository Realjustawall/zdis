# Dedicated server applications

The Ubuntu enterprise installer builds an Android release APK and a Windows x64 NSIS installer after configuring HTTPS. Both load the same origin as the server, so login uses the existing username and password without entering a server URL. This requires internet access during compilation, Docker, OpenSSL, keytool, and several GB of free storage. It is not an offline build.

To rebuild locally on the installed Ubuntu host:

```bash
sudo python3 scripts/build-server-clients.py \
  --url https://chat.example.com \
  --output /opt/zdis/data/clients \
  --signing-dir /var/lib/zdis-client-signing
```

Adjust `/opt/zdis` to the installation path. For standalone Node installations, use `server/data/clients` (or `$DATA_DIR/clients`) instead. `ubuntu/setup.sh` also accepts `ZDIS_CLIENT_SERVER_URL=https://chat.example.com` to invoke the builder.

Downloads are `/downloads/ZDis.apk`, `/downloads/ZDis-Setup.exe`, `/downloads/manifest.json`, and `/downloads/ZDis-Server-Certificate.crt`. The Messages sidebar links the applications. These files are public so a new user can install before logging in. No account password or signing key is embedded in either app.

A stable hash of the HTTPS origin sets each application's identity and isolates its storage. Preserve `/var/lib/zdis-client-signing` through upgrades. Losing the Android key prevents updating an existing installation under its original identity. Changing origin also changes the application identity. Use the same canonical origin every time.

## Signing and trust

Android APK signatures are verified with `apksigner` before publication. Windows builds require code signing (`forceCodeSigning`) and produce a per-user installer without elevation. The generated Windows certificate is unique to this server and self-signed: it does **not** provide a publicly trusted publisher identity or eliminate SmartScreen. Distribute its fingerprint through a trusted channel before trusting it on a device. A publicly trusted Windows signing certificate must be supplied by the operator; this change cannot issue one.

Private key files and their randomly generated password are mode 600 beneath a mode 700 directory outside the repository. Docker receives signing passwords through environment variables, not command-line arguments. The source snapshot excludes environment files, data, uploads, backups and signing keys. Artifacts are staged until both build processes succeed; the final checksum manifest is then written. Keep signing backups private.

## Transport and desktop isolation

Dedicated apps require HTTPS with a valid device-trusted server certificate. They never disable certificate checking. Windows disables Node integration, uses context isolation and sandboxing, blocks embedded webviews, popups, and navigation to other origins. Media/notification permissions are restricted to the configured origin. The Android shell loads that same hosted application, so it needs the server to be reachable.

## Validation limits

The builder's URL validation, secret permissions and failed-build publication behavior have automated tests. Actual Android compilation/signature verification and Windows installer execution were **not** run in the editing environment: Docker, Android SDK and Wine are unavailable. Run the complete builder and installation smoke tests on a build host before calling these binaries release-ready.
