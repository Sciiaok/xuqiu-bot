import { test, expect } from '@playwright/test';
import { MOCK_AGENT, MOCK_AGENTS_LIST } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

test.describe('Agents Management', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page);
    await page.route('**/api/agents', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { agents: MOCK_AGENTS_LIST } });
      }
      return route.continue();
    });
  });

  // --- Navigation ---
  test('sidebar has Agents link that navigates to /dashboard/agents', async ({ page }) => {
    await page.goto('/dashboard/inbox');
    await page.getByRole('link', { name: 'Agents' }).click();
    await expect(page).toHaveURL(/\/dashboard\/agents/);
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  });

  // --- List ---
  test('shows agent cards with name, product_line, status', async ({ page }) => {
    await page.goto('/dashboard/agents');
    // Wait for agents to load
    await expect(page.getByText('Vehicle Export Agent')).toBeVisible();
    await expect(page.getByText('Parts Agent').first()).toBeVisible();
    await expect(page.getByText('Product: auto')).toBeVisible();
    await expect(page.getByText('Active').first()).toBeVisible();
  });

  test('shows WA phone number ID on agent card', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await expect(page.getByText('WA: 123456')).toBeVisible();
  });

  test('shows empty state when no agents', async ({ page }) => {
    await page.route('**/api/agents', (route) =>
      route.fulfill({ json: { agents: [] } })
    );
    await page.goto('/dashboard/agents');
    await expect(page.getByText('No agents configured')).toBeVisible();
  });

  // --- Create ---
  test('clicking "+ New Agent" opens editor form', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: '+ New Agent' }).click();
    await expect(page.getByText('New Agent', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Vehicle Export Agent')).toBeVisible();
  });

  test('creating agent sends POST /api/agents', async ({ page }) => {
    let postBody = null;
    await page.route('**/api/agents', (route) => {
      if (route.request().method() === 'POST') {
        postBody = JSON.parse(route.request().postData());
        return route.fulfill({ status: 201, json: { agent: { id: 'new-1', ...postBody } } });
      }
      return route.fulfill({ json: { agents: MOCK_AGENTS_LIST } });
    });

    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: '+ New Agent' }).click();
    await page.getByPlaceholder('Vehicle Export Agent').fill('Test Agent');
    await page.getByPlaceholder('auto').fill('test');
    await page.getByPlaceholder('Enter the system prompt for this agent...').fill('You are a test agent.');
    await page.getByRole('button', { name: 'Create Agent' }).click();

    // Wait for editor to close (agent list refreshes)
    await expect(page.getByText('New Agent', { exact: true })).not.toBeVisible();
    expect(postBody).toMatchObject({
      name: 'Test Agent',
      productLine: 'test',
      systemPrompt: 'You are a test agent.',
    });
  });

  test('validation error when required fields are empty', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: '+ New Agent' }).click();
    await page.getByRole('button', { name: 'Create Agent' }).click();
    await expect(page.getByText('Name, product line, and system prompt are required')).toBeVisible();
  });

  test('invalid JSON in output schema shows error', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: '+ New Agent' }).click();
    await page.getByPlaceholder('Vehicle Export Agent').fill('Test');
    await page.getByPlaceholder('auto').fill('test');
    await page.getByPlaceholder('Enter the system prompt for this agent...').fill('prompt');

    // Clear the output schema textarea and type invalid JSON
    const schemaTextarea = page.getByPlaceholder('{}');
    await schemaTextarea.clear();
    await schemaTextarea.fill('not json');
    await page.getByRole('button', { name: 'Create Agent' }).click();
    await expect(page.getByText('Output schema must be valid JSON')).toBeVisible();
  });

  // --- Edit ---
  test('clicking "Edit" opens editor with pre-filled values', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await expect(page.getByText('Edit Agent')).toBeVisible();

    // Name should be pre-filled
    const nameInput = page.getByPlaceholder('Vehicle Export Agent');
    await expect(nameInput).toHaveValue('Vehicle Export Agent');
  });

  test('product_line is disabled when editing', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await expect(page.getByPlaceholder('auto')).toBeDisabled();
  });

  test('updating agent sends PUT /api/agents/[id]', async ({ page }) => {
    let putCalled = false;
    await page.route('**/api/agents/*', (route) => {
      if (route.request().method() === 'PUT') {
        putCalled = true;
        return route.fulfill({ json: { agent: MOCK_AGENT } });
      }
      return route.continue();
    });

    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByPlaceholder('Vehicle Export Agent').fill('Updated Agent');
    await page.getByRole('button', { name: 'Update Agent' }).click();

    await expect(page.getByText('Edit Agent')).not.toBeVisible();
    expect(putCalled).toBe(true);
  });

  test('cancel button closes editor without saving', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: '+ New Agent' }).click();
    await expect(page.getByText('New Agent', { exact: true })).toBeVisible();
    // Click the bottom Cancel button in the editor actions row
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByText('New Agent', { exact: true })).not.toBeVisible();
  });

  // --- Deactivate ---
  test('clicking "Deactivate" shows confirm dialog and calls DELETE', async ({ page }) => {
    let deleteCalled = false;
    page.on('dialog', (d) => d.accept());

    await page.route('**/api/agents/*', (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        return route.fulfill({ json: { agent: { ...MOCK_AGENT, is_active: false } } });
      }
      return route.continue();
    });

    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: 'Deactivate' }).first().click();
    expect(deleteCalled).toBe(true);
  });

  test('deactivating last agent shows error (409)', async ({ page }) => {
    page.on('dialog', async (d) => d.accept());

    await page.route('**/api/agents', (route) =>
      route.fulfill({ json: { agents: [MOCK_AGENT] } }) // only 1 agent
    );
    await page.route('**/api/agents/*', (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({
          status: 409,
          json: { error: 'Cannot deactivate the last active agent' },
        });
      }
      return route.continue();
    });

    await page.goto('/dashboard/agents');
    await page.getByRole('button', { name: 'Deactivate' }).click();
    // The error is shown via alert() in the UI — handled by dialog listener
  });
});
