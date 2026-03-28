Run Campaign Studio E2E tests (Playwright, headed Chrome):

```bash
npx playwright test tests/e2e/campaign-studio.spec.js --headed --browser=chromium --reporter=list
```

Run headless (CI mode):

```bash
npx playwright test tests/e2e/campaign-studio.spec.js --reporter=list
```

Run Campaign Studio component tests (vitest):

```bash
npx vitest run app/dashboard/campaign-studio
```

Run all frontend tests together:

```bash
npx vitest run app/dashboard/campaign-studio && npx playwright test tests/e2e/campaign-studio.spec.js --reporter=list
```

Run user journey simulation (张总体验流程, requires dev server on port 3000):

```bash
node tests/e2e/user-journey-zhang.mjs
```
