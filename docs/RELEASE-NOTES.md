## ZDis 1.0.1 — Fix problems

- Fix PostgreSQL selection in Scale, Enterprise and Kubernetes deployments.
- Fix container worker startup and the Scale worker health probe.
- Serialize initial administrator and built-in bot provisioning across PostgreSQL nodes to prevent duplicate-account startup failures.
- Update vulnerable production and development dependencies without removing application features.
- Add deployment, concurrent bootstrap and distribution packaging regressions.
- Verify native Ubuntu and Windows builds, PostgreSQL/Redis integration, browser and LiveKit media behavior, security scanning and cluster capacity/failover before publication.

The Ubuntu archive includes `ubuntu/setup.sh` and `ubuntu/start.sh`; the Windows archive includes the existing `.cmd` launchers and `windows/setup.ps1`/`windows/start.ps1`. Both include the full application sources and production web build. Install Node.js 24 or newer and follow the existing platform setup instructions. SHA256SUMS.txt verifies the downloaded archives.
