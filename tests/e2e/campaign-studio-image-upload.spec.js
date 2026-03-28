import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// ── Test data ────────────────────────────────────────────────────────────

const MOCK_SESSIONS_INTAKE = [{
  brief_id: 'brief-img',
  session_id: null,
  first_message: null,
  status: 'intake',
  current_phase: 'intake',
  phase_index: 0,
  completion_pct: 0,
  created_at: '2026-03-26T10:00:00Z',
  updated_at: '2026-03-26T10:00:00Z',
}];

const MOCK_SESSIONS_ORCH = [{
  brief_id: 'brief-img-orch',
  session_id: 'session-img-orch',
  first_message: '推广产品',
  status: 'running',
  current_phase: 'research',
  phase_index: 2,
  completion_pct: 80,
  created_at: '2026-03-26T10:00:00Z',
  updated_at: '2026-03-26T10:00:00Z',
}];

const MOCK_UPLOAD_RESPONSE = {
  url: 'https://example.supabase.co/storage/v1/object/public/chat-uploads/brief-img/test.png',
  storage_path: 'brief-img/1711500000_abc123.png',
  filename: 'test-product.png',
  content_type: 'image/png',
  size: 12345,
};

const MOCK_UPLOAD_RESPONSE_2 = {
  url: 'https://example.supabase.co/storage/v1/object/public/chat-uploads/brief-img/test2.png',
  storage_path: 'brief-img/1711500001_def456.png',
  filename: 'test-product-2.png',
  content_type: 'image/png',
  size: 23456,
};

const MOCK_INTAKE_SSE = [
  'event: delta\ndata: {"text":"收到您上传的产品图片！"}\n\n',
  'event: delta\ndata: {"text":"我已经看到了图片中的产品信息。"}\n\n',
  'event: done\ndata: {"status":"ok"}\n\n',
].join('');

// ── Helpers ──────────────────────────────────────────────────────────────

async function setupMocks(page) {
  // Set Chinese locale before navigating
  await page.context().addCookies([{
    name: 'NEXT_LOCALE',
    value: 'zh',
    domain: 'localhost',
    path: '/',
  }]);
  await page.route('**/auth/v1/**', route =>
    route.fulfill({ json: { id: 'user-1', email: 'test@test.com' } })
  );
  await page.route('**/realtime/**', route => route.abort());
}

/**
 * Create a minimal 1x1 PNG buffer for test uploads.
 */
function createTestPng() {
  // Minimal valid 1x1 red PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
}

const TEST_IMAGE_DIR = path.join(process.cwd(), 'tests', 'e2e', 'fixtures');

// Ensure test image exists before tests run
test.beforeAll(() => {
  const imgPath = path.join(TEST_IMAGE_DIR, 'test-product.png');
  if (!fs.existsSync(imgPath)) {
    fs.writeFileSync(imgPath, createTestPng());
  }
  const imgPath2 = path.join(TEST_IMAGE_DIR, 'test-product-2.png');
  if (!fs.existsSync(imgPath2)) {
    fs.writeFileSync(imgPath2, createTestPng());
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Campaign Studio - Image Upload', () => {

  test('image upload button is visible in chat input', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Image upload button should be visible
    await expect(page.locator('[data-testid="image-upload-btn"]')).toBeVisible({ timeout: 5000 });
  });

  test('select image shows preview thumbnail', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );
    // Mock upload API
    await page.route('**/api/campaign/upload', route =>
      route.fulfill({ json: MOCK_UPLOAD_RESPONSE })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Select an image via the hidden file input
    const fileInput = page.locator('[data-testid="image-file-input"]');
    await fileInput.setInputFiles(path.join(TEST_IMAGE_DIR, 'test-product.png'));

    // Preview bar should appear with the image thumbnail
    const previewBar = page.locator('[data-testid="image-preview-bar"]');
    await expect(previewBar).toBeVisible({ timeout: 5000 });

    // Should have an image element in the preview
    const previewImg = previewBar.locator('img');
    await expect(previewImg).toBeVisible();
  });

  test('remove image from preview', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );
    await page.route('**/api/campaign/upload', route =>
      route.fulfill({ json: MOCK_UPLOAD_RESPONSE })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Add image
    await page.locator('[data-testid="image-file-input"]').setInputFiles(
      path.join(TEST_IMAGE_DIR, 'test-product.png')
    );
    await expect(page.locator('[data-testid="image-preview-bar"]')).toBeVisible({ timeout: 5000 });

    // Hover over preview to reveal remove button, then click it
    const previewItem = page.locator('[data-testid="image-preview-bar"] > div').first();
    await previewItem.hover();
    await page.locator('[data-testid="remove-image"]').first().click();

    // Preview bar should disappear
    await expect(page.locator('[data-testid="image-preview-bar"]')).not.toBeVisible();
  });

  test('send message with image in intake phase', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );
    await page.route('**/api/campaign/upload', route =>
      route.fulfill({ json: MOCK_UPLOAD_RESPONSE })
    );

    let capturedBody = null;
    await page.route('**/api/campaign/orchestrate/brief-img', route => {
      capturedBody = route.request().postDataJSON();
      return route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_INTAKE_SSE,
      });
    });

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Add image
    await page.locator('[data-testid="image-file-input"]').setInputFiles(
      path.join(TEST_IMAGE_DIR, 'test-product.png')
    );
    await expect(page.locator('[data-testid="image-preview-bar"]')).toBeVisible({ timeout: 5000 });

    // Wait for upload to complete (spinner disappears)
    await expect(page.locator('[data-testid="image-preview-bar"] .animate-spin')).not.toBeVisible({ timeout: 5000 });

    // Type text and send
    await page.getByPlaceholder('输入消息...').fill('这是我们的产品图片');
    await page.locator('[data-testid="send-btn"]').click();

    // User message should render with image
    await expect(page.locator('[data-testid="user-message-image"]')).toBeVisible({ timeout: 5000 });

    // User message text should also render
    await expect(page.locator('text=这是我们的产品图片')).toBeVisible();

    // AI should respond
    await expect(page.locator('text=收到您上传的产品图片！我已经看到了图片中的产品信息。')).toBeVisible({ timeout: 5000 });

    // Preview bar should be cleared after sending
    await expect(page.locator('[data-testid="image-preview-bar"]')).not.toBeVisible();

    // Verify the API received attachments in the request body
    expect(capturedBody).toBeTruthy();
    expect(capturedBody.message).toBe('这是我们的产品图片');
    expect(capturedBody.attachments).toHaveLength(1);
    expect(capturedBody.attachments[0].url).toContain('chat-uploads');
  });

  test('send image-only message without text', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );
    await page.route('**/api/campaign/upload', route =>
      route.fulfill({ json: MOCK_UPLOAD_RESPONSE })
    );
    await page.route('**/api/campaign/orchestrate/brief-img', route =>
      route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_INTAKE_SSE,
      })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Add image without typing text
    await page.locator('[data-testid="image-file-input"]').setInputFiles(
      path.join(TEST_IMAGE_DIR, 'test-product.png')
    );
    await expect(page.locator('[data-testid="image-preview-bar"] .animate-spin')).not.toBeVisible({ timeout: 5000 });

    // Send button should be enabled (has image even without text)
    const sendBtn = page.locator('[data-testid="send-btn"]');
    await expect(sendBtn).toBeEnabled();

    await sendBtn.click();

    // Should see the image in the user message
    await expect(page.locator('[data-testid="user-message-image"]')).toBeVisible({ timeout: 5000 });

    // AI response should still come
    await expect(page.locator('text=收到您上传的产品图片！')).toBeVisible({ timeout: 5000 });
  });

  test('send multiple images', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );
    await page.route('**/api/campaign/intake/brief-img', route =>
      route.fulfill({ json: { id: 'brief-img', brief: {}, completion: {}, status: 'active' } })
    );

    let uploadCount = 0;
    await page.route('**/api/campaign/upload', route => {
      uploadCount++;
      return route.fulfill({
        json: uploadCount === 1 ? MOCK_UPLOAD_RESPONSE : MOCK_UPLOAD_RESPONSE_2,
      });
    });

    let capturedBody = null;
    await page.route('**/api/campaign/orchestrate/brief-img', route => {
      capturedBody = route.request().postDataJSON();
      return route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_INTAKE_SSE,
      });
    });

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=新会话');

    // Select multiple images at once
    await page.locator('[data-testid="image-file-input"]').setInputFiles([
      path.join(TEST_IMAGE_DIR, 'test-product.png'),
      path.join(TEST_IMAGE_DIR, 'test-product-2.png'),
    ]);

    // Should see 2 preview thumbnails
    const previewBar = page.locator('[data-testid="image-preview-bar"]');
    await expect(previewBar).toBeVisible({ timeout: 5000 });
    await expect(previewBar.locator('img')).toHaveCount(2, { timeout: 5000 });

    // Wait for both uploads to complete
    await expect(page.locator('[data-testid="image-preview-bar"] .animate-spin')).not.toBeVisible({ timeout: 5000 });

    // Send
    await page.getByPlaceholder('输入消息...').fill('两张产品图');
    await page.locator('[data-testid="send-btn"]').click();

    // Both images should render in user message
    await expect(page.locator('[data-testid="user-message-image"]')).toHaveCount(2, { timeout: 5000 });

    // API should have received 2 attachments
    expect(capturedBody.attachments).toHaveLength(2);
  });

  test('image upload works in orchestration chat phase', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_ORCH } })
    );
    await page.route('**/api/campaign/intake/brief-img-orch', route =>
      route.fulfill({
        json: { id: 'brief-img-orch', brief: { industry: '测试' }, completion: { completion_pct: 80 }, status: 'completed' },
      })
    );
    await page.route('**/api/campaign/orchestrate/session-img-orch', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: 'session-img-orch',
            brief_id: 'brief-img-orch',
            status: 'running',
            current_phase: 'research',
            phase_results_keys: [],
            phase_results: {},
            messages: [],
          },
        });
      }
      if (route.request().method() === 'POST') {
        return route.fulfill({
          headers: { 'Content-Type': 'text/event-stream' },
          body: 'event: delta\ndata: {"text":"我看到了您上传的图片。"}\n\nevent: done\ndata: {"session_id":"session-img-orch"}\n\n',
        });
      }
      return route.continue();
    });
    await page.route('**/api/campaign/upload', route =>
      route.fulfill({ json: MOCK_UPLOAD_RESPONSE })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=推广产品');

    // Wait for chat to load
    await expect(page.locator('[data-testid="image-upload-btn"]')).toBeVisible({ timeout: 5000 });

    // Upload image
    await page.locator('[data-testid="image-file-input"]').setInputFiles(
      path.join(TEST_IMAGE_DIR, 'test-product.png')
    );
    await expect(page.locator('[data-testid="image-preview-bar"] .animate-spin')).not.toBeVisible({ timeout: 5000 });

    // Send with text
    await page.getByPlaceholder('输入消息...').fill('参考这张图片');
    await page.locator('[data-testid="send-btn"]').click();

    // User message with image should render
    await expect(page.locator('[data-testid="user-message-image"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=参考这张图片')).toBeVisible();

    // AI response
    await expect(page.locator('text=我看到了您上传的图片。')).toBeVisible({ timeout: 5000 });
  });

  test('images from history are rendered on page reload', async ({ page }) => {
    await setupMocks(page);
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_ORCH } })
    );
    await page.route('**/api/campaign/intake/brief-img-orch', route =>
      route.fulfill({
        json: { id: 'brief-img-orch', brief: { industry: '测试' }, completion: { completion_pct: 80 }, status: 'completed' },
      })
    );
    // Return history with attachments
    await page.route('**/api/campaign/orchestrate/session-img-orch', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: 'session-img-orch',
            brief_id: 'brief-img-orch',
            status: 'running',
            current_phase: 'research',
            phase_results_keys: [],
            phase_results: {},
            messages: [
              {
                id: 'm1',
                phase: null,
                role: 'user',
                content: '看看这张图',
                tool_name: null,
                tool_result: null,
                attachments: [MOCK_UPLOAD_RESPONSE],
                created_at: '2026-03-26T10:00:00Z',
              },
              {
                id: 'm2',
                phase: null,
                role: 'assistant',
                content: '我看到了图片中的产品。',
                tool_name: null,
                tool_result: null,
                attachments: null,
                created_at: '2026-03-26T10:00:01Z',
              },
            ],
          },
        });
      }
      return route.continue();
    });

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=推广产品');

    // Should see the image from history
    await expect(page.locator('[data-testid="user-message-image"]')).toBeVisible({ timeout: 5000 });

    // Should see text messages
    await expect(page.locator('text=看看这张图')).toBeVisible();
    await expect(page.locator('text=我看到了图片中的产品。')).toBeVisible();
  });
});
