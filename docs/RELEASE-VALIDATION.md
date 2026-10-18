# Release validation

The Quality workflow validates native Ubuntu and Windows installation/build/backend/runtime behavior, deployment configurations, security and the existing browser suites. Its additional LiveKit job executes the SFU media and permission tests against an isolated media server. The PostgreSQL integration run includes a four-process first-boot regression for initial administrator and official bot provisioning.

Native jobs also test the distribution packager and build separate Ubuntu and Windows archives. Every included file is read back from the archive and compared byte-for-byte with its source. Local secrets, runtime data, dependencies and test outputs are excluded. Platform metadata and required launch files are checked during packaging.

Publication runs only after a successful Quality push run on main, and also requires the Scale/failover workflow to have succeeded on that exact commit. The published archives are downloaded from that successful native build run; they are not rebuilt after validation. SHA256 checksums accompany both archives.

Review the Actions runs and pull request checks for the results of a particular commit. These gates do not certify physical media hardware, all optional external providers or an operator's separate Kubernetes cluster.
