# Releasing

`0.1.0` was published through the controlled bootstrap workflow on 2026-07-28 and verified from a clean install. The bootstrap workflow is deliberately fixed to that immutable version and must not be rerun or generalized into a reusable token-based publisher.

Routine releases are intended to use token-free npm Trusted Publishing. Configuration is currently deferred until a maintainer has a device that can complete npm's WebAuthn/passkey flow. Until OIDC is verified, do not publish another version merely to test the release path, do not reuse any token exposed outside protected secret storage, and do not enable `disallow tokens` while it would remove the only tested recovery path.

## Configure routine Trusted Publishing

On a device with a working passkey or security key, open npm **Settings → Trusted Publisher** and configure:

- Provider: GitHub Actions
- Organization or user: `airouter-dev`
- Repository: `openai-compatible-errors`
- Workflow filename: `publish.yml`
- GitHub environment: `npm`
- Allowed action: `npm publish`

The protected `npm` environment already requires a reviewer. Keep `id-token: write` in `publish.yml`; do not add a token secret. After an OIDC release succeeds, revoke the bootstrap token, delete its environment secret, and only then set npm Publishing access to require 2FA and disallow traditional tokens.

For each routine release, update the version and changelog in a reviewed pull request, let the full CI matrix pass, inspect `npm pack --dry-run`, then manually dispatch **Publish npm**. Verify the npm page, provenance, tarball files, and clean-project imports before announcing the release.
