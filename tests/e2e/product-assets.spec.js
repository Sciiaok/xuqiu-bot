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
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString(),
  },
];

const MOCK_SPECS = [
  {
    id: 'spec-001',
    model: 'DF2004E',
    brand: 'SDEC',
    product_line: 'agri_machinery',
    specs: { model: 'DF2004E', brand: 'SDEC', rated_power_kw: 162 },
    created_at: new Date().toISOString(),
  },
];

const MOCK_ASSETS = [
  {
    id: 'asset-001',
    agent_id: 'agent-001',
    model: 'DF2004E',
    filename: 'front-view.jpg',
    storage_path: 'auto/DF2004E/front-view.jpg',
    content_type: 'image/jpeg',
    created_at: new Date(Date.now() - 1800000).toISOString(),
  },
  {
    id: 'asset-002',
    agent_id: 'agent-001',
    model: 'DF2004E',
    filename: 'side-view.png',
    storage_path: 'auto/DF2004E/side-view.png',
    content_type: 'image/png',
    created_at: new Date(Date.now() - 1200000).toISOString(),
  },
  {
    id: 'asset-003',
    agent_id: 'agent-001',
    model: 'DF1804E',
    filename: 'cabin.jpg',
    storage_path: 'auto/DF1804E/cabin.jpg',
    content_type: 'image/jpeg',
    created_at: new Date(Date.now() - 600000).toISOString(),
  },
];

const MOCK_MODELS = ['DF1804E', 'DF2004E'];

const MOCK_OPERATIONS = [
  {
    id: 'op-001',
    document_id: 'doc-001',
    agent_id: 'agent-001',
    operation: 'upload',
    operator: 'admin@test.com',
    details: { filename: '2004E.pdf' },
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
];

function setupRoutes(page, { assets = MOCK_ASSETS, models = MOCK_MODELS } = {}) {
  return Promise.all([
    // Agents
    page.route('**/api/agents', (route) =>
      route.fulfill({ json: { agents: MOCK_AGENTS_LIST } })
    ),
    // Product docs routes
    page.route('**/api/product-docs/**', (route) => {
      const url = route.request().url();
      if (url.includes('/operations')) return route.fulfill({ json: MOCK_OPERATIONS });
      if (url.includes('/specs')) return route.fulfill({ json: MOCK_SPECS });
      return route.continue();
    }),
    page.route('**/api/product-docs', (route) =>
      route.fulfill({ json: MOCK_DOCS })
    ),
    // Product assets — single handler to avoid route conflicts
    page.route('**/api/product-assets**', (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes('/models')) {
        return route.fulfill({ json: models });
      }
      if (url.includes('/upload') && method === 'POST') {
        return route.fulfill({
          json: {
            id: 'asset-new',
            model: 'DF2004E',
            filename: 'new-upload.jpg',
            storage_path: 'auto/DF2004E/new-upload.jpg',
            content_type: 'image/jpeg',
            created_at: new Date().toISOString(),
          },
        });
      }
      if (method === 'DELETE') {
        return route.fulfill({ json: { success: true } });
      }
      // List
      return route.fulfill({ json: assets });
    }),
  ]);
}

test.describe('Product Assets', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page);
    await setupRoutes(page);
  });

  // --- Section visibility ---
  test('shows Product Assets section on docs page', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(page.getByRole('heading', { name: 'Product Assets' })).toBeVisible();
  });

  // --- Asset uploader ---
  test('asset uploader shows agent and model dropdowns', async ({ page }) => {
    await page.goto('/dashboard/docs');
    // Upload Asset button
    await expect(page.getByRole('button', { name: 'Upload Asset' })).toBeVisible();
    // Asset section should have agent and model selects
    const assetSection = page.locator('text=Product Assets >> .. >> ..');
    const selects = assetSection.locator('select');
    const count = await selects.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('model dropdown populates from product_specs', async ({ page }) => {
    await page.goto('/dashboard/docs');
    // Options inside a closed <select> are hidden — check via option count
    const modelOption = page.locator('option:has-text("DF2004E")');
    await expect(modelOption).toHaveCount(1);
    await expect(page.locator('option:has-text("DF1804E")')).toHaveCount(1);
  });

  test('model dropdown shows "no models" when agent has no specs', async ({ page }) => {
    await setupRoutes(page, { models: [] });
    await page.goto('/dashboard/docs');
    const modelSelect = page.locator('select').nth(2);
    await expect(modelSelect).toBeDisabled();
  });

  // --- Asset gallery ---
  test('asset gallery displays images grouped by model', async ({ page }) => {
    await page.goto('/dashboard/docs');
    // Should show model headers
    await expect(page.getByRole('heading', { name: 'DF2004E' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'DF1804E' })).toBeVisible();
    // Should show filenames
    await expect(page.getByText('front-view.jpg')).toBeVisible();
    await expect(page.getByText('side-view.png')).toBeVisible();
    await expect(page.getByText('cabin.jpg')).toBeVisible();
  });

  test('asset gallery shows images', async ({ page }) => {
    await page.goto('/dashboard/docs');
    const images = page.locator('img[alt="front-view.jpg"], img[alt="side-view.png"], img[alt="cabin.jpg"]');
    await expect(images).toHaveCount(3);
  });

  test('asset gallery is empty when no assets', async ({ page }) => {
    await setupRoutes(page, { assets: [] });
    await page.goto('/dashboard/docs');
    // Gallery should not render model headings
    const h3 = page.locator('h3:has-text("DF2004E")');
    await expect(h3).toHaveCount(0);
  });

  // --- Upload flow ---
  test('upload button triggers file input and calls upload API', async ({ page }) => {
    let uploadCalled = false;
    // Override the product-assets handler to track upload calls
    await page.route('**/api/product-assets**', (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes('/models')) return route.fulfill({ json: MOCK_MODELS });
      if (url.includes('/upload') && method === 'POST') {
        uploadCalled = true;
        return route.fulfill({
          json: {
            id: 'asset-new',
            model: 'DF2004E',
            filename: 'test.jpg',
            storage_path: 'auto/DF2004E/test.jpg',
            content_type: 'image/jpeg',
            created_at: new Date().toISOString(),
          },
        });
      }
      return route.fulfill({ json: MOCK_ASSETS });
    });

    await page.goto('/dashboard/docs');

    // Wait for model dropdown to populate
    await expect(page.locator('option:has-text("DF2004E")')).toHaveCount(1);

    // Trigger file upload via the hidden input
    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: 'test.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    });

    // Wait for upload to complete
    await page.waitForTimeout(1000);
    expect(uploadCalled).toBe(true);
  });

  // --- Delete flow ---
  test('clicking delete on asset calls DELETE API', async ({ page }) => {
    let deleteCalled = false;
    let deleteUrl = '';
    await page.route('**/api/product-assets/*', (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        deleteUrl = route.request().url();
        return route.fulfill({ json: { success: true } });
      }
      return route.continue();
    });

    page.on('dialog', (d) => d.accept());
    await page.goto('/dashboard/docs');

    // Hover over first image to reveal delete button, then click it
    const firstImage = page.locator('img[alt="front-view.jpg"]');
    await firstImage.hover();
    const deleteBtn = firstImage.locator('..').locator('button');
    await deleteBtn.click();

    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(true);
    expect(deleteUrl).toContain('asset-001');
  });

  test('declining delete does not call API', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/product-assets/*', (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        return route.fulfill({ json: { success: true } });
      }
      return route.continue();
    });

    page.on('dialog', (d) => d.dismiss());
    await page.goto('/dashboard/docs');

    const firstImage = page.locator('img[alt="front-view.jpg"]');
    await firstImage.hover();
    const deleteBtn = firstImage.locator('..').locator('button');
    await deleteBtn.click();

    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(false);
  });

  // --- Drag and drop ---
  test('drop zone shows correct accept text', async ({ page }) => {
    await page.goto('/dashboard/docs');
    await expect(
      page.getByText(/Drop images here|拖拽图片/)
    ).toBeVisible();
  });
});
