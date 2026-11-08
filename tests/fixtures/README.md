# Test Fixtures

Maintenance reference. [Development](../../docs/DEVELOPMENT.md) · [Agent rules](../../AGENTS.md)

## agent-image.jpg

Synthetic demonstration image used by tests/agent/codemode.test.ts for image reading, output persistence and size-budget behavior. It is not a current product screenshot and contains no real business input.

SHA-256: `13aabadf61b56cd84c78b5ce1bdcd4173d835d6721edd92d14ef4ee3d88f7ffe`.

Before replacement, check required format/dimensions and oversized-output behavior; run the relevant tests. Never use production attachments, user screenshots or real credentials as fixtures.

## SSH service

[ssh/Containerfile](ssh/Containerfile) is only for npm run test:ssh. Rootless Podman starts temporary OpenSSH while application/SRT code runs on the host. The test user matches the host UID/GID. Bind only loopback, mount only test-created temporary directories and generate keys at runtime. Do not mount real application state.

Coverage includes personal-key push/read, wrong-key rejection and unknown-host rejection. Stop daemons, dispose identity directories and remove temporary roots; containers use --rm. The local fixture image may be cached. Missing required transport infrastructure is not a passed integration test.

## SLS HTTPS protocol

[CLI acceptance](../integration/sls-cli.acceptance.ts) runs through npm run test:sls-cli with real aliyun CLI and OpenSSL-generated temporary certificates. HTTPS/precise-target CONNECT servers bind loopback. Credentials are synthetic and no real SLS service is contacted.

Cover response parsing, paging, failure, budgets and cancellation. Clean configuration, certificates and connections on every outcome. This suite is separate from ordinary unit tests and does not replace authorized vendor integration checks.
