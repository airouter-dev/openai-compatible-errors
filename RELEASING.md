# Releasing

The package uses token-free npm Trusted Publishing for routine releases. npm can only configure a trusted publisher from the settings of an existing package, and staged publishing does not accept a brand-new package, so `0.1.0` needs one controlled bootstrap.

## Bootstrap `0.1.0`

1. Verify the public repository, CI, package metadata, tarball contents, and `npm publish --dry-run` output.
2. In npm account settings, create a new granular token with the shortest available expiration, package/scope read-write access limited to `@airouter-dev`, and bypass 2FA enabled. Do not send or paste the token into an issue, commit, chat, shell history, or local `.npmrc`.
3. In GitHub, create the `npm-bootstrap` environment, require a reviewer, and add the token as the environment secret `NPM_BOOTSTRAP_TOKEN`.
4. Manually run **Bootstrap first npm release** and type `@airouter-dev/openai-compatible-errors@0.1.0` into its confirmation field. The workflow refuses to run if that version already exists, runs validation and audit, and publishes with provenance.
5. Install the public package into a new empty project and exercise both ESM and CommonJS entry points.
6. Delete the GitHub environment secret and revoke the npm bootstrap token immediately.

The bootstrap workflow is deliberately fixed to `0.1.0`. It must never be generalized into a reusable token-based publisher.

## Configure routine Trusted Publishing

After the package exists, open its npm **Settings → Trusted Publisher** and configure:

- Provider: GitHub Actions
- Organization or user: `airouter-dev`
- Repository: `openai-compatible-errors`
- Workflow filename: `publish.yml`
- GitHub environment: `npm`
- Allowed action: `npm publish`

Create a protected `npm` environment in GitHub with a required reviewer. Keep `id-token: write` in `publish.yml`; do not add a token secret. After an OIDC release succeeds, set npm Publishing access to require 2FA and disallow traditional tokens.

For each routine release, update the version and changelog in a reviewed pull request, let the full CI matrix pass, inspect `npm pack --dry-run`, then manually dispatch **Publish npm**. Verify the npm page, provenance, tarball files, and clean-project imports before announcing the release.
