# Contributing

Contributions should make the error boundary safer or add evidence for a real OpenAI-compatible failure shape. New aliases, provider lists, or keyword-only documentation are not useful contributions.

## Development

Use Node.js 20 or newer for the source toolchain. The packed library still targets Node.js 18.18 and newer.

```bash
npm ci --ignore-scripts
npm run validate
npm run smoke
```

Before opening a pull request:

- Add a focused test for every behavior change.
- Use synthetic credential canaries and invented prompt text. Never copy production keys, headers, prompts, model output, customer data, or provider response bodies into an issue or fixture.
- Keep unknown retry evidence fail-closed. A change must not turn `manual_decision` into `retry` without explicit replay-safety evidence.
- Preserve zero runtime dependencies unless a dependency removes more risk than it introduces and the change is discussed first.
- Run `npm pack --dry-run` and confirm the artifact contains only the intended README, changelog, license, package metadata, and `dist` files.

The pull request should state which concrete error shape or replay boundary it covers and how it was verified. Compatibility claims must name the exact tested runtime or SDK version.
