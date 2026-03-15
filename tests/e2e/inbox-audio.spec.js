import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MOCK_CONVERSATION, MOCK_MESSAGES } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleAudio = readFileSync(resolve(__dirname, 'fixtures/sample.wav'));

const AUDIO_MESSAGE = {
  id: 'msg-audio-1',
  role: 'user',
  content: 'This is the transcription of the voice note',
  sent_at: '2026-03-15T02:16:00Z',
  sent_by: 'customer',
  conversation_id: 'conv-001',
  metadata: {
    media_type: 'audio',
    wa_media_id: 'wamid_test_123',
    mime_type: 'audio/ogg',
  },
};

const TEXT_MESSAGE = {
  id: 'msg-text-1',
  role: 'user',
  content: 'Just a normal text message',
  sent_at: '2026-03-15T02:15:00Z',
  sent_by: 'customer',
  conversation_id: 'conv-001',
};

const IMAGE_MESSAGE = {
  id: 'msg-image-1',
  role: 'user',
  content: '',
  sent_at: '2026-03-15T02:14:00Z',
  sent_by: 'customer',
  conversation_id: 'conv-001',
  metadata: {
    media_type: 'image',
    wa_media_id: 'wamid_img_456',
    mime_type: 'image/jpeg',
  },
};

const ALL_MESSAGES = [TEXT_MESSAGE, IMAGE_MESSAGE, AUDIO_MESSAGE];

test.describe('Inbox — Audio Playback', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page, {
      conversations: [MOCK_CONVERSATION],
      messages: ALL_MESSAGES,
    });

    // Mock the media proxy for audio files
    await page.route('**/api/media/whatsapp/wamid_test_123', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        body: sampleAudio,
      })
    );

    // Mock the media proxy for image (return a tiny transparent PNG)
    await page.route('**/api/media/whatsapp/wamid_img_456', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        ),
      })
    );

    // Mock agents endpoint (inbox fetches it)
    await page.route('**/rest/v1/agents*', (route) =>
      route.fulfill({ json: [] })
    );
  });

  test('audio message renders player with controls', async ({ page }) => {
    await page.goto('/dashboard/inbox');

    const audio = page.locator('audio');
    await expect(audio).toBeVisible();
    await expect(audio).toHaveAttribute('controls', '');
    await expect(audio).toHaveAttribute('src', /\/api\/media\/whatsapp\/wamid_test_123/);
  });

  test('audio message shows transcription below player', async ({ page }) => {
    await page.goto('/dashboard/inbox');

    // The audio player should exist
    await expect(page.locator('audio')).toBeVisible();

    // The transcription text should also be visible
    await expect(page.getByText('This is the transcription of the voice note')).toBeVisible();
  });

  test('click play starts audio playback', async ({ page }) => {
    await page.goto('/dashboard/inbox');

    const audio = page.locator('audio');
    await expect(audio).toBeVisible();

    // Attempt to play via JS (browsers may block autoplay but we can check the promise resolves or rejects)
    const playResult = await page.evaluate(async () => {
      const el = document.querySelector('audio');
      if (!el) return { error: 'no audio element' };
      try {
        await el.play();
        return { paused: el.paused };
      } catch (e) {
        // NotAllowedError is expected in headless — the play action was triggered
        return { error: e.name, paused: el.paused };
      }
    });

    // Either play succeeded or was blocked by autoplay policy (both mean the element works)
    expect(
      playResult.paused === false || playResult.error === 'NotAllowedError'
    ).toBeTruthy();
  });

  test('text message does not show audio player', async ({ page }) => {
    await page.goto('/dashboard/inbox');

    // Wait for audio message to render so we know the page is loaded
    await expect(page.locator('audio')).toBeVisible();

    // Find the text message bubble containing 'Just a normal text message'
    const textBubble = page.getByText('Just a normal text message').locator('..');
    await expect(textBubble.locator('audio')).toHaveCount(0);
  });

  test('audio player fallback on media proxy error', async ({ page }) => {
    // Override the media route to return 500
    await page.route('**/api/media/whatsapp/wamid_test_123', (route) =>
      route.fulfill({ status: 500, body: 'Internal Server Error' })
    );

    await page.goto('/dashboard/inbox');

    // After the audio element errors, the component shows the badge fallback
    // The fallback contains the emoji badge '🎵'
    await expect(page.getByText('🎵')).toBeVisible({ timeout: 10_000 });

    // The audio element should no longer be visible (replaced by fallback)
    await expect(page.locator('audio')).toHaveCount(0);
  });
});
