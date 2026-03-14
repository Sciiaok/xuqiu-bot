import { test, expect } from '@playwright/test';
import { MOCK_CONVERSATION, MOCK_MESSAGES } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('Inbox navigation', () => {
  test('keeps the inbox shell visible while a deep link is resolving', async ({ page }) => {
    await mockSupabase(page, {
      conversations: [MOCK_CONVERSATION],
      messages: MOCK_MESSAGES,
    });

    await page.route('**/rest/v1/conversations*', async (route) => {
      const url = route.request().url();

      if (url.includes('select=is_human_takeover')) {
        return route.fulfill({
          json: { is_human_takeover: false },
          headers: {
            'content-type': 'application/vnd.pgrst.object+json',
            'content-profile': 'public',
          },
        });
      }

      if (url.includes('contact_id=eq.')) {
        return route.fulfill({ json: [{ id: MOCK_CONVERSATION.id }] });
      }

      await wait(400);
      return route.fulfill({ json: [MOCK_CONVERSATION] });
    });

    await page.route('**/rest/v1/messages*', async (route) => {
      await wait(400);
      return route.fulfill({ json: MOCK_MESSAGES });
    });

    await page.goto(`/dashboard/inbox?conversation_id=${MOCK_CONVERSATION.id}`);

    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByText('Select a contact to start chatting')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /Test User/ })).toBeVisible();
    await expect(page.locator('div').filter({ hasText: /^Test User$/ })).toBeVisible();
  });
});
