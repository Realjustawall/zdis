# ZDIS on Ubuntu

Use Ubuntu 24.04 LTS and Node.js 24 or newer.

```sh
bash ubuntu/setup.sh
bash ubuntu/start.sh
```

SQLite is the default. The installation creates `.env` only when absent and
keeps database/uploads in `server/data`. The first startup generates and prints
an administrator password; the repository contains no configured password or
runtime database. Keep the generated password and configure your public HTTPS
URL before opening the service to other machines.

For voice/video and private listener permissions, configure an actual LiveKit
server with the four `LIVEKIT_*` variables in `.env`. See
[media requirements](../docs/PERMISSIONS.md). Without LiveKit, P2P cannot enforce
publication restrictions and restricted participants are rejected safely.

Run `npm test` and `npm run build` to validate the installed source. This edition
shares application code with Windows and provides native Bash launch scripts.
