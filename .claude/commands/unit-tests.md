Run all unit tests (no external APIs needed):

```bash
node --experimental-test-module-mocks --test tests/unit/*.test.js
```

Run digital ads agent tests only:

```bash
node --experimental-test-module-mocks --test tests/unit/{research,strategy,execution}-agent.test.js tests/unit/campaign-orchestrator.test.js tests/unit/aigc-service.test.js
```
