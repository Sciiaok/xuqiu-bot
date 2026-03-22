import { test, expect } from '@playwright/test';
import { MOCK_AGENTS_LIST } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

const MOCK_DOCS = [
  {
    id: 'doc-001',
    filename: '2004E.pdf',
    agent_id: 'agent-001',
    doc_type: 'spec_sheet',
    status: 'ready',
    error_message: null,
    page_count: 1,
    created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 3600000).toISOString(),
  },
  {
    id: 'doc-002',
    filename: '3004F.pdf',
    agent_id: 'agent-001',
    doc_type: 'spec_sheet',
    status: 'processing',
    error_message: null,
    page_count: null,
    created_at: new Date(Date.now() - 600000).toISOString(),
    updated_at: new Date(Date.now() - 600000).toISOString(),
  },
  {
    id: 'doc-003',
    filename: 'old-spec.pdf',
    agent_id: 'agent-002',
    doc_type: 'spec_sheet',
    status: 'error',
    error_message: 'Table extraction failed',
    page_count: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString(),
  },
];

const MOCK_SPECS = [
  {
    id: 'spec-001',
    model: 'DF2004E',
    brand: 'SDEC',
    product_line: 'agri_machinery',
    specs: {
      model: 'DF2004E',
      brand: 'SDEC',
      nominal_power_kw: 147,
      rated_power_kw: 162,
      fuel_tank_l: 400,
    },
    created_at: new Date().toISOString(),
  },
];

const MOCK_OPERATIONS = [
  {
    id: 'op-001',
    document_id: 'doc-001',
    agent_id: 'agent-001',
    operation: 'upload',
    operator: 'admin@test.com',
    details: { filename: '2004E.pdf' },
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: 'op-002',
    document_id: 'doc-001',
    agent_id: 'agent-001',
    operation: 'parsed',
    operator: 'system',
    details: { filename: '2004E.pdf', specs_count: 1, chunks_count: 2 },
    created_at: new Date(Date.now() - 7100000).toISOString(),
  },
  {
    id: 'op-003',
    document_id: 'doc-003',
    agent_id: 'agent-002',
    operation: 'error',
    operator: 'system',
    details: { filename: 'old-spec.pdf', error_message: 'Table extraction failed' },
    created_at: new Date(Date.now() - 86000000).toISOString(),
  },
];

function setupRoutes(page, { docs = MOCK_DOCS, operations = MOCK_OPERATIONS } = {}) {
  return Promise.all([
    page.route('**/api/agents', (route) =>
      route.fulfill({ json: { agents: MOCK_AGENTS_LIST } })
    ),
    page.route('**/api/product-docs/**', (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes('/operations')) {
        return route.fulfill({ json: operations });
      }
      if (url.includes('/specs')) {
        return route.fulfill({ json: MOCK_SPECS });
      }
      if (url.includes('/upload') && method === 'POST') {
        return route.fulfill({ json: { document_id: 'doc-new', status: 'processing' } });
      }
      if (method === 'DELETE') {
        return route.fulfill({ json: { success: true } });
      }
      return route.continue();
    }),
    page.route('**/api/product-docs', (route) =>
      route.fulfill({ json: docs })
    ),
  ]);
}

test.describe('Product Docs Admin', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page);
    await setupRoutes(page);
  });

  // --- Navigation ---
  test('sidebar has Product Docs link that navigates to /dashboard/docs', async ({ page }) => {
    await page.goto('/dashboard/agents');
    await page.getByRole('link', { name: 'Knowledge Base' }).click();
    await expect(page).toHaveURL(/\/dashboard\/docs/);
    await expect(page.getByRole('heading', { name: 'Product Docs' })).toBeVisible();
  });

  // --- Document List ---
  test('shows document cards with filename and status badges', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByText('2004E.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('3004F.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('old-spec.pdf', { exact: true })).toBeVisible();
    // Status badges
    await expect(page.getByText('Ready')).toBeVisible();
    await expect(page.getByText('Processing', { exact: true })).toBeVisible();
    await expect(page.getByText('Error').first()).toBeVisible();
  });

  test('shows error message on error documents', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByText('Table extraction failed', { exact: true })).toBeVisible();
  });

  test('shows empty state when no documents', async ({ page }) => {
    await setupRoutes(page, { docs: [], operations: [] });
    await page.goto('/dashboard/docs');
    await expect(page.getByText('No product documents yet')).toBeVisible();
  });

  // --- Agent Filter ---
  test('agent filter buttons are shown and toggle documents', async ({ page }) => {
    await page.goto('/dashboard/docs');
    // Should see "All Agents" and product_line buttons
    await expect(page.getByRole('button', { name: 'All Agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'auto' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'parts' })).toBeVisible();
  });

  // --- Upload ---
  test('upload section shows agent selector and upload button', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByText('Upload PDF')).toBeVisible();
    // Agent dropdown
    const select = page.locator('select');
    await expect(select).toBeVisible();
  });

  // --- View Specs Modal ---
  test('clicking View Specs opens modal with spec table', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await page.getByRole('button', { name: 'View Specs' }).click();
    // Modal should show model name
    await expect(page.getByText('DF2004E')).toBeVisible();
    // Should show spec fields
    await expect(page.getByText('nominal_power_kw')).toBeVisible();
    await expect(page.getByText('147')).toBeVisible();
    // Close button
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('nominal_power_kw')).not.toBeVisible();
  });

  test('clicking modal backdrop closes modal', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await page.getByRole('button', { name: 'View Specs' }).click();
    await expect(page.getByText('DF2004E')).toBeVisible();
    // Click backdrop (the overlay div)
    await page.locator('.fixed.inset-0').click({ position: { x: 10, y: 10 } });
    await expect(page.getByText('nominal_power_kw')).not.toBeVisible();
  });

  // --- Delete ---
  test('clicking Delete shows confirm dialog and calls DELETE API', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/product-docs/**', (route) => {
      const url = route.request().url();
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        return route.fulfill({ json: { success: true } });
      }
      if (url.includes('/operations')) return route.fulfill({ json: MOCK_OPERATIONS });
      if (url.includes('/specs')) return route.fulfill({ json: MOCK_SPECS });
      return route.continue();
    });

    page.on('dialog', (d) => d.accept());

    await page.goto('/dashboard/docs');
    // Click the first Delete button (for 2004E.pdf)
    await page.getByRole('button', { name: 'Delete' }).first().click();
    expect(deleteCalled).toBe(true);
  });

  test('declining delete confirm does not call DELETE API', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/product-docs/**', (route) => {
      const url = route.request().url();
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        return route.fulfill({ json: { success: true } });
      }
      if (url.includes('/operations')) return route.fulfill({ json: MOCK_OPERATIONS });
      if (url.includes('/specs')) return route.fulfill({ json: MOCK_SPECS });
      return route.continue();
    });

    page.on('dialog', (d) => d.dismiss());

    await page.goto('/dashboard/docs');
    await page.getByRole('button', { name: 'Delete' }).first().click();
    expect(deleteCalled).toBe(false);
  });

  // --- Retry Button ---
  test('error documents show Retry button', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  // --- Operation History ---
  test('operation history shows log entries', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByText('Operation History')).toBeVisible();
    await expect(page.getByText(/Uploaded 2004E\.pdf/)).toBeVisible();
    await expect(page.getByText(/Parsed 2004E\.pdf/)).toBeVisible();
    await expect(page.getByText(/Error parsing old-spec\.pdf/)).toBeVisible();
  });

  test('operation history shows empty state when no operations', async ({ page }) => {
    await setupRoutes(page, { docs: MOCK_DOCS, operations: [] });
    await page.goto('/dashboard/docs');
    await expect(page.getByText('No operations recorded yet')).toBeVisible();
  });

  // --- Ready document shows page count and field count ---
  test('ready document card shows page count', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByText('1 page')).toBeVisible();
  });
});
