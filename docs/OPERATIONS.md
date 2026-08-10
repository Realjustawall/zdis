# Enterprise operations runbook

## Supported topology

The production topology is three or more stateless API pods, two or more
workers, PostgreSQL behind PgBouncer, Redis Cluster, S3-compatible object
storage and CDN, ClamAV, OpenSearch, LiveKit SFU/Egress, coturn, Prometheus,
Alertmanager, Grafana, Tempo and an OpenTelemetry Collector.

The multi-region manifests use active/passive traffic with warm compute in both
regions. Route53 health checks move the global API hostname automatically.
This requires a database service whose global writer endpoint follows an
automatic regional promotion, replicated object storage/KMS grants, and
regional Redis. Do not point both regions at independent writable PostgreSQL
databases.

## First deployment

1. Create separate production, restore-test and chaos-test accounts/clusters.
2. Install the ingress controller, cert-manager, metrics-server,
   CloudNativePG/Barman plugin (or the chosen managed database), external
   secrets operator and monitoring stack.
3. Create `youtbelimo-secrets` from a secret manager. Never apply
   `secret.example.yaml` unchanged.
4. Provision S3 versioning, object lock where required, lifecycle rules,
   cross-region replication, a CDN origin access policy and KMS grants for both
   regions.
5. Apply the primary overlay:

   ```sh
   kubectl apply -k infra/kubernetes/overlays/primary
   ```

6. Apply the secondary overlay with regional secret values:

   ```sh
   kubectl --context secondary apply -k infra/kubernetes/overlays/secondary
   ```

7. Apply the Route53 module after replacing every value in
   `terraform.tfvars.example`.
8. Run `npm run enterprise:check` inside a production-configured admin Job.
9. Run Playwright against the public hostname, a backup/restore drill, the
   5,000-connection scale workflow, and one API/Redis/PostgreSQL failover drill.
10. Enable external Alertmanager receivers only after a test alert is
    acknowledged by the on-call system.

## External service activation

- OIDC: register the exact callback
  `https://<host>/api/auth/sso/oidc/callback`; enable provisioning only after
  allowed domains are configured.
- SAML: import `/api/auth/sso/saml/metadata`, install the IdP signing
  certificate and verify signed assertion, audience, issuer and replay tests.
- LDAP: use LDAPS with a dedicated read-only bind account and CA bundle.
- Email: use a restricted SMTP credential, then verify SPF, DKIM and DMARC.
- Push: generate a dedicated VAPID pair and subscribe from the production
  service worker.
- S3/CDN: block public bucket access; only signed S3/CDN URLs may expose media.
- ClamAV: require it in production and alert when readiness reports it down.
- OpenSearch: use TLS, authentication, three data nodes across zones and at
  least one replica. The Compose node is only a local integration topology.
- LiveKit: expose UDP ranges and TCP fallback, deploy coturn on public IPs,
  deploy one Egress replica per simultaneous room recording target, and test an
  actual MP4 in the object bucket.
- Transcript: give the speech-to-text worker only
  `CALL_TRANSCRIPT_WEBHOOK_SECRET`; rotate it independently.

## Capacity and soak tests

The `Scale and failover` workflow builds a three-node cluster and supports
5,000, 10,000 or 20,000 WebSocket connections. It stops one API node during
the hold, verifies reconnect recovery, and archives raw and Markdown capacity
reports. The 5,000-connection dispatch also runs a one-hour soak.

For a dedicated generator:

```sh
LOAD_BASE_URL=https://chat.example.com \
LOAD_EMAIL=load-test@example.com \
LOAD_PASSWORD='...' \
LOAD_CONNECTIONS=20000 \
LOAD_RAMP_PER_SECOND=1000 \
LOAD_HOLD_SECONDS=900 \
LOAD_RECONNECT=true \
LOAD_REPORT_FILE=scale-report.json \
npm run test:load

node tests/load/capacity-report.mjs
```

Use multiple generators for 20,000 connections when ephemeral ports, CPU or
bandwidth on one generator become the bottleneck. Capacity is accepted only
when success is at least 99%, p95 connection latency is within the configured
limit, final connected sockets meet the threshold, PostgreSQL/Redis have no
errors, and API memory returns to baseline after disconnect.

## Failover drills

The `Kubernetes failover drill` workflow is manual, approval-gated by the
`chaos-test` GitHub environment, and refuses to run without
`CHAOS_CONFIRM=yes`. It can delete one API pod, one Redis Cluster pod or the
CloudNativePG primary and records recovery time.

Never point `CHAOS_TEST_KUBECONFIG` at production. A quarterly production
game-day requires a change ticket, incident commander, verified backup,
rollback owner and customer communication plan.

### Regional failover

1. Confirm the primary is unavailable from at least two independent probes.
2. Confirm the global database writer endpoint has promoted the secondary and
   accepts a transaction. If promotion is manual, fence the old writer first.
3. Confirm S3 replication lag is inside the accepted RPO and the secondary KMS
   key is usable.
4. Confirm `https://secondary.../api/ready` and `/api/traffic-ready` return
   200, then watch Route53 move `chat.example.com`.
5. Confirm login, message send, file read/write, Redis fan-out, notification
   worker and LiveKit token/room creation.
6. Run a 500-connection smoke load and watch the SLO dashboard.
7. Declare recovery. Do not fail back until replication is rebuilt and a new
   backup/restore drill succeeds.

Target objectives: no committed-message loss with synchronous in-region
replication, cross-region RPO defined by the database/object replication
service, in-region failover under 180 seconds, and regional RTO under 15
minutes. Measure these targets; configuration alone is not evidence.

## Backup and disaster recovery

- PostgreSQL WAL/PITR: 30 days.
- Daily application archive: 30 days.
- Weekly immutable archive: 12 weeks.
- Monthly archive: 12 months.
- Restore the latest backup weekly in an isolated namespace.
- Perform a point-in-time restore and application verification quarterly.
- Alert if WAL archiving fails, the last backup is older than 26 hours, or a
  restore drill does not complete.

## Incident quick actions

- Compromised API key: revoke it in `/api/integrations/api-keys`, inspect audit
  history and rotate downstream secrets.
- Malware found on rescan: the file is quarantined automatically; review
  `scan_status`, notify affected users and retain forensic metadata.
- Webhook storm: disable the webhook; after ten failures the circuit breaker
  opens automatically.
- Notification failures: inspect `/api/admin/notification-dlq`, fix the
  provider, then retry selected dead letters.
- Audit mismatch: freeze administrative changes, export the chain, preserve
  database/WORM copies and start the security incident process.
- Redis loss: API reads and PostgreSQL remain authoritative; restore regional
  Redis and let Socket.IO/BullMQ coordination rebuild.

## Release gate

A release is eligible only when production build, unit/API/realtime/network
tests, PostgreSQL+Redis+S3+ClamAV integration, Playwright E2E, migration tests,
dependency audit, CodeQL, Trivy, SBOM generation and YAML validation pass.
Changes to database, storage, auth, networking or backup code additionally
require the relevant restore/failover drill.
