# Enterprise operations

This repository contains two deployment paths:

- `infra/docker-compose.enterprise.yml`: a reproducible two-API-node stack for
  staging, integration testing, and a single-host production installation.
- `infra/kubernetes`: a multi-node production baseline with autoscaling,
  disruption budgets, Redis Cluster, distributed LiveKit, dedicated TURN, and
  an example three-instance CloudNativePG cluster.

The application remains usable with SQLite, local files, in-process cache, and
mesh WebRTC for development. Production should set every `REQUIRE_*` flag so a
missing dependency causes a failed readiness check instead of a silent
downgrade.

## Architecture

```text
Browser / mobile web
        |
  CDN / global DNS
        |
Ingress / nginx  ─────────────── TURN edge nodes
        |
  API pods (3..30) ───────────── LiveKit SFU nodes
     |       |                         |
     |       +──── Redis Cluster ──────+
     |                 |
     +──── PostgreSQL primary + replicas
     |
     +──── private S3 bucket ─── CDN signed delivery
     |
     +──── ClamAV pool
     |
 BullMQ workers ─── SMTP / Web Push / backup jobs
        |
 OpenTelemetry Collector ─── Tempo
 Prometheus ─── Alertmanager ─── Grafana
```

Socket.IO fan-out, presence, and BullMQ use Redis. BullMQ keys use a Redis hash
tag so all queue keys stay in one cluster slot. PostgreSQL is the source of
truth. File bytes live in S3-compatible object storage; only metadata and
authorization live in PostgreSQL. Downloads are authorized by the API and then
redirected to a short-lived S3 or CDN signed URL.

## Start the complete Compose stack

1. Copy `infra/enterprise.env.example` to `infra/.env` and replace every value.
2. Create `infra/secrets/metrics-token.txt` with a long random token.
3. Point `PUBLIC_ORIGIN`, `PUBLIC_LIVEKIT_URL`, `PUBLIC_TURN_URL`,
   `S3_PUBLIC_ENDPOINT`, and `TURN_EXTERNAL_IP` to externally reachable names.
4. Start the stack:

```sh
docker compose \
  --env-file infra/.env \
  -f infra/docker-compose.enterprise.yml \
  up -d --build
```

The gateway is on port 8080, MinIO on 9000/9001, LiveKit signaling on 7880,
TURN on 3478/5349, and Grafana on 3000. Put a TLS-terminating load balancer in
front of the HTTP gateway and LiveKit signaling. TURN/TLS terminates in coturn
and therefore needs its certificate in a production deployment; the Compose
file is intended to prove the network path locally and uses TURN on 3478 by
default.

Compose deliberately uses one PostgreSQL and one Redis container because a
single Docker host cannot provide real failure-domain isolation. Use the
Kubernetes resources or managed multi-AZ services for HA.

## Kubernetes production checklist

Before `kubectl apply -k infra/kubernetes`:

1. Build and push the image, then replace
   `ghcr.io/your-org/youtbelimo:1.0.0`.
2. Use `infra/kubernetes/secret.example.yaml` only as a key inventory. Create
   `youtbelimo-secrets` with External Secrets, Sealed Secrets, or your cloud
   secret manager before applying the Kustomization; the placeholder file is
   intentionally excluded.
3. Install Metrics Server for HPA and an ingress controller.
4. Install CloudNativePG, review `postgres-ha.example.yaml`, and apply it
   separately. Its `postgres-rw` service is the application endpoint.
5. Provision private S3-compatible storage with versioning, object lock where
   required, server-side encryption, cross-region replication, and a lifecycle
   rule for `backups/`.
6. Label public media nodes with `youtbelimo.io/media-edge=true`. Open TCP 7881,
   UDP 50000-50100 for LiveKit, and TCP/UDP 3478/5349 plus UDP 49160-49200 for
   coturn. Create `turn-tls`.
7. Put `media.example.com` behind TLS and direct it to the LiveKit signaling
   service. Publish multiple A/AAAA records for `turn.example.com` or use a
   network load balancer that preserves UDP.
8. Install the OTel/Prometheus/Grafana stack in an `observability` namespace or
   adapt the endpoints in the ConfigMap.

The API Deployment starts at three replicas, spreads pods across zones and
nodes, has zero-unavailable rolling updates, a PDB, readiness/liveness/startup
probes, graceful termination, and an HPA from 3 to 30 pods. Migrations are
serialized with a PostgreSQL transaction-scoped advisory lock, so simultaneous
pod startup cannot race the schema.

The included Redis StatefulSet creates six Redis Cluster nodes: three masters
and three replicas. The bootstrap Job is idempotent. For stricter operational
support, replace it with a managed Redis Cluster endpoint; set
`REDIS_CLUSTER_NODES` to its seed nodes.

## Voice and video

When LiveKit variables are set, the API issues short-lived, room-scoped access
tokens only after checking channel or conversation access. The browser uses
LiveKit for microphone, camera, screen share, active speakers, adaptive stream,
and dynacast. Without LiveKit, the existing peer-to-peer mesh remains available
and is capped at eight participants.

LiveKit uses Redis for multi-node room placement. Do not aggressively terminate
SFU pods with active rooms; drain media nodes before upgrades. TURN must be
reachable from restrictive networks over TLS, normally on 443 or 5349.
TURN credentials returned by `/api/auth/me` are user-bound HMAC credentials
that expire after one hour; the shared coturn secret is never sent to clients.

## Backups and disaster recovery

The BullMQ worker schedules a backup daily at 03:00 UTC. A backup contains:

- a consistent SQLite snapshot or PostgreSQL custom-format `pg_dump`;
- local uploads when local storage is selected;
- a versioned manifest and SHA-256 checksum.

With S3 storage, archives are written under `backups/`. Object lifecycle policy
enforces retention. CloudNativePG volume snapshots provide an independent
database-level recovery layer. Production S3 should enable versioning and
cross-region replication.

Manual commands:

```sh
npm run backup --workspace server
npm run verify-backup --workspace server -- /path/to/archive.tar.gz
npm run restore-backup --workspace server -- /path/to/archive.tar.gz \
  --confirm-destructive-restore
```

Stop API and worker processes before a restore. The restore command verifies
the archive first, preserves the previous SQLite database/upload directory, and
uses `pg_restore --clean --if-exists --exit-on-error` for PostgreSQL.

Every CI integration run performs a real backup, verifies it, changes the
database and file payload, restores the archive, and confirms the old values.
When CI uses PostgreSQL, this drill uses real `pg_dump` and `pg_restore`.

Suggested policy:

- database point-in-time recovery window: 30 days;
- daily logical/application archive: 30 days;
- weekly archive: 12 weeks;
- monthly immutable archive: 12 months;
- quarterly restore drill in an isolated account/cluster;
- alert when the last successful backup is older than 26 hours.

## Multi-region failover

The safe portable design is active/passive for writes:

1. Region A serves traffic and owns the PostgreSQL primary.
2. Region B runs warm API/worker capacity, a regional Redis Cluster, replicated
   object storage, and a PostgreSQL physical replica.
3. Global traffic management probes `/api/ready` and LiveKit endpoints.
4. On declared regional failure, fence Region A, promote Region B PostgreSQL,
   update `DATABASE_URL`, scale Region B API/workers, verify migrations and S3,
   then move global traffic.
5. Redis is disposable coordination state; do not replicate it as a source of
   truth. Sessions are persisted in PostgreSQL, so users do not need to sign in
   again after regional failover.

Run the load test and a restore drill after failover. Re-establish replication
before failing back. Exact DNS, database promotion, KMS, and object replication
commands are provider-specific and must be automated in the platform account;
they cannot be safely hard-coded without the chosen cloud and domains.

Active/active writes require a globally consistent database or application
conflict-resolution model and are intentionally not claimed by these manifests.

## Quality gates

```sh
npm test
npm run test:e2e

# Against a running environment; use a dedicated account.
LOAD_BASE_URL=https://chat.example.com \
LOAD_EMAIL=load-test@example.com \
LOAD_PASSWORD='...' \
LOAD_CONNECTIONS=3000 \
LOAD_RAMP_PER_SECOND=200 \
LOAD_HOLD_SECONDS=300 \
npm run test:load
```

The load test uses WebSocket-only Socket.IO clients, ramps to the requested
concurrency, holds connections, emits sampled presence traffic, and fails when
the success rate is below 99%, p95 connect time exceeds five seconds, or too
many sockets drop during the hold. Run it from multiple load-generator hosts
for 10,000+ connections so client-side ephemeral ports are not the bottleneck.

The Quality workflow runs integration tests against real PostgreSQL and Redis
containers with fallback disabled, and Playwright tests on desktop and mobile
Chromium. Failed Playwright traces/screenshots/videos are retained as artifacts.

## Enterprise identity and security keys

OIDC uses Authorization Code flow with PKCE, state and nonce validation. SAML
requires signed responses and assertions, validates `InResponseTo`, audience,
issuer and assertion age. LDAP performs a service-account search followed by a
bind as the discovered user and requires LDAPS unless the operator explicitly
enables the development-only insecure mode. Automatic provisioning is disabled
by default for all providers; existing users are linked by verified email.

Audit rows form an HMAC hash chain under a transaction-level head lock. Use a
dedicated `AUDIT_SIGNING_KEY_FILE`, retain it in the organization secret
manager, and verify the chain from the admin panel before and after deployments.
Audit exports can be shipped to immutable/WORM storage.

Secret rotation procedure:

1. generate a new `APP_SECRET` and put the current value temporarily in
   `APP_SECRET_PREVIOUS`;
2. deploy all API replicas, wait at least the maximum session TTL, then remove
   the previous value;
3. rotate `RECOVERY_CODE_SIGNING_KEY` the same way with
   `RECOVERY_CODE_PREVIOUS_KEYS`;
4. rotate S3 KMS keys by changing `S3_KMS_KEY_ID`; old objects remain readable
   through KMS grants while new objects use the new key;
5. rotate the audit signing key only at a documented chain checkpoint, archive
   the previous key, and retain both for verification.

Production enables DLP in `block` or `audit` mode. It detects private keys,
well-known provider tokens, JWTs and Luhn-valid payment-card numbers without
logging the matching secret. CI produces a CycloneDX SBOM and runs dependency,
secret, IaC, container and CodeQL scans. The Kubernetes workload runs as a
non-root user with a read-only root filesystem, dropped capabilities,
RuntimeDefault seccomp and restricted ingress. The ingress OWASP CRS setting
must be tuned in staging before enforcing it on production traffic.

## Alerts and SLOs

Prometheus records request latency/status, sockets, voice participants,
messages, uploads, PostgreSQL, Redis, and synthetic readiness. Grafana is
auto-provisioned with an operations dashboard; Tempo receives distributed
traces through the OTel Collector.

Default alert rules cover service probes, API instance loss, more than 1% 5xx,
p95 above 750 ms, PostgreSQL/Redis loss, and Redis memory pressure. The shipped
Alertmanager receiver retains and groups alerts but intentionally has no
external destination. Configure the organization’s email/PagerDuty/Opsgenie or
webhook receiver before production; committing a destination credential would
be unsafe.

Recommended initial objectives:

- availability: 99.9% per rolling 30 days;
- API latency: 95% below 750 ms;
- message delivery: 99% below two seconds;
- backup recovery point: below 24 hours (plus database PITR);
- critical alert acknowledgement: below 15 minutes.

## Advanced collaboration and integrations

Versioned migrations now cover durable drafts, scheduled and expiring messages,
thread traversal, polls, saved messages, API keys with read/write/admin scopes,
bot identities, signed outbound webhooks with SSRF protection and circuit
breaking, cursor-based offline sync, JSON import/export, and optional
OpenSearch-backed search with database fallback.

The file pipeline supports checksum-verified resumable chunks, atomic per-user
quota reservations, content sniffing, DLP, ClamAV, S3/CDN, image previews,
FFmpeg video/audio derivatives, retention deletion and periodic malware
rescans. LiveKit call governance adds a host/lobby, participant controls,
explicit recording/transcript consent, Egress-to-S3, transcript ingestion,
connection-quality aggregation and region selection.

Notification delivery includes Web Push, SMTP, per-target levels, quiet hours,
timezone-aware hourly/daily digests, BullMQ retry and an administrator-visible
dead-letter queue. Operational deployment and activation procedures are in
`docs/OPERATIONS.md`.

The browser client exposes durable drafts, scheduled and expiring messages,
poll creation/voting, saved messages and thread traversal. SFU call controls
include waiting-room approval, recording/transcript consent, host recording
controls, camera, screen sharing and peer-to-peer fallback for small rooms.

## Persian administration command center

The RTL/Persian administration client provides dark, light and
system-following themes. Its modules cover live runtime/memory/socket metrics,
accounts and sessions, groups, moderation, custom RBAC assignment, scoped API
keys, bots, signed webhooks, service health, feature readiness, notification
dead letters, maintenance, settings and tamper-evident audit.

Admin and LiveKit code are separate lazy-loaded chunks, so normal chat
sessions do not download either module until needed. PostgreSQL pools,
BullMQ/media concurrency, Sharp caches and Node/OpenSearch heap limits are
bounded through environment variables for predictable resource usage.

The complete Ubuntu installer is documented in `docs/UBUNTU_INSTALL.md`.
