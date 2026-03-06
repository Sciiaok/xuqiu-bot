import { test, expect } from '@playwright/test';
import { MOCK_CONVERSATION, MOCK_MESSAGES } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

test.describe('Inbox — Media Upload', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page, {
      conversations: [MOCK_CONVERSATION],
      messages: MOCK_MESSAGES,
    });
    await page.goto('/dashboard/inbox');
    // Wait for contact to auto-select and chat to load
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  });

  test('attach button is visible', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeHidden(); // hidden file input
    await expect(page.getByTitle('Attach file')).toBeVisible();
  });

  test('selecting a valid image shows preview with filename and size', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(1024 * 100), // 100KB
    });
    // Preview shows "photo.jpg (0.1MB)"
    await expect(page.getByText('photo.jpg')).toBeVisible();
    await expect(page.getByText('Remove')).toBeVisible();
  });

  test('selecting a file changes button text to "Send File"', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'doc.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(1024),
    });
    await expect(page.getByRole('button', { name: 'Send File' })).toBeVisible();
  });

  test('selecting a file changes placeholder to "Add a caption..."', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'img.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(1024),
    });
    await expect(page.getByPlaceholder('Add a caption...')).toBeVisible();
  });

  test('clicking "Remove" clears the file preview', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(1024),
    });
    await page.getByText('Remove').click();
    await expect(page.getByText('photo.jpg')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  });

  test('sending media calls POST /api/send-message with multipart', async ({ page }) => {
    let requestContentType = '';
    await page.route('**/api/send-message', (route) => {
      requestContentType = route.request().headers()['content-type'] || '';
      return route.fulfill({
        json: { success: true, message: 'Message sent', data: { waId: '8613800000001' } },
      });
    });

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(1024),
    });
    await page.getByRole('button', { name: 'Send File' }).click();

    // Wait for send to complete — button returns to "Send"
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(requestContentType).toContain('multipart/form-data');
  });

  test('sending media with caption includes caption in form data', async ({ page }) => {
    let postData = '';
    await page.route('**/api/send-message', async (route) => {
      postData = route.request().postData() || '';
      return route.fulfill({
        json: { success: true, message: 'OK', data: { waId: '8613800000001' } },
      });
    });

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(1024),
    });
    await page.getByPlaceholder('Add a caption...').fill('test caption');
    await page.getByRole('button', { name: 'Send File' }).click();

    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(postData).toContain('test caption');
  });

  test('file preview clears after successful send', async ({ page }) => {
    await page.route('**/api/send-message', (route) =>
      route.fulfill({ json: { success: true, message: 'OK', data: {} } })
    );

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(1024),
    });
    await expect(page.getByText('photo.jpg')).toBeVisible();
    await page.getByRole('button', { name: 'Send File' }).click();

    // After send, preview should be gone
    await expect(page.getByText('photo.jpg')).not.toBeVisible();
  });

  test('send button is disabled when no text and no file', async ({ page }) => {
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeDisabled();
  });

  test('text message still works (regression)', async ({ page }) => {
    let requestBody = '';
    await page.route('**/api/send-message', async (route) => {
      requestBody = route.request().postData() || '';
      return route.fulfill({
        json: { success: true, message: 'OK', data: { waId: '8613800000001' } },
      });
    });

    await page.getByPlaceholder('Type a message...').fill('Hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByPlaceholder('Type a message...')).toHaveValue('');
    expect(requestBody).toContain('Hello world');
  });

  test('attach button is disabled when sending', async ({ page }) => {
    // Slow API to keep sending state active
    await page.route('**/api/send-message', (route) =>
      new Promise((r) => setTimeout(() => {
        route.fulfill({ json: { success: true, message: 'OK', data: {} } });
        r();
      }, 2000))
    );

    await page.getByPlaceholder('Type a message...').fill('test');
    await page.getByRole('button', { name: 'Send' }).click();

    // During send, attach button should be disabled
    await expect(page.getByTitle('Attach file')).toBeDisabled();
  });
});
