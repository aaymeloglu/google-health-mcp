# Anonymous Setup Feedback

Use this when testing Google Health MCP in Claude Desktop, Cursor, Codex,
Hermes, OpenClaw, Windsurf or another MCP client.

```bash
npx -y google-health-mcp-unofficial support --feedback --json
```

For Hermes-specific feedback:

```bash
npx -y google-health-mcp-unofficial support --feedback --json --client hermes
```

The output is an anonymous, redacted setup-feedback bundle for
[issue #4](https://github.com/davidmosiah/google-health-mcp/issues/4). It
includes package/runtime posture, public OAuth setup metadata, token file
presence/readability, friction markers and reviewer questions.

For safety, this public report does not read local config JSON or token JSON.
When a token exists, scope status is reported as `unknown`; run
`doctor --live` locally for private scope/API details.

It intentionally does not include:

- OAuth access tokens or refresh tokens.
- Google Cloud client-secret values.
- Local config or token file paths.
- Raw token files.
- Raw Google Health API responses.
- Personal health measurements.

Useful human notes to add below the generated bundle:

- MCP client tested.
- Device/source family, for example Fitbit, Pixel Watch, Android or Google
  sources.
- Step that was confusing.
- What worked well.
- What should be clearer.

Run `doctor --live` first when you have already authorized Google Health. That
proves identity/profile/settings reachability without printing personal health
measurements.
