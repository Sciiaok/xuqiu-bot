Run integration tests against real APIs. Requires .env.local with API keys.

Meta Ads API (~15s, needs META_SYSTEM_TOKEN + META_AD_ACCOUNT_ID):

```bash
node tests/integration-meta-ads.mjs
node tests/integration-meta-ads.mjs --keep
```

Full orchestrator pipeline (~5min, needs all API keys):

```bash
node tests/integration-orchestrator.mjs
node tests/integration-orchestrator.mjs --keep
```

AIGC image generation (needs OPENROUTER_API_KEY):

```bash
node tests/integration-aigc.mjs
```

Use `--keep` to preserve created Meta campaigns and DB data for manual inspection.
