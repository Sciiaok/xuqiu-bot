import { test, expect } from '@playwright/test';
import { mockSupabase } from './fixtures/supabase-mock.js';

const NOW = new Date();
const FIVE_MIN_AGO = new Date(NOW.getTime() - 5 * 60 * 1000);
const TEN_MIN_AGO = new Date(NOW.getTime() - 10 * 60 * 1000);

const CONTACT_A = {
  id: 'contact-a',
  wa_id: '8613800000001',
  company_name: 'Alpha Corp',
  name: 'Alice',
};

const CONTACT_B = {
  id: 'contact-b',
  wa_id: '8613800000002',
  company_name: 'Beta Corp',
  name: 'Bob',
};

const CONV_A = {
  id: 'conv-a',
  contact_id: 'contact-a',
  last_message_at: FIVE_MIN_AGO.toISOString(),
  is_human_takeover: true,
  contact: CONTACT_A,
};

const CONV_B = {
  id: 'conv-b',
  contact_id: 'contact-b',
  last_message_at: TEN_MIN_AGO.toISOString(),
  is_human_takeover: false,
  contact: CONTACT_B,
};

const MESSAGES_A = [
  {
    id: 'msg-a1',
    role: 'user',
    content: 'I need a quote for 5 trucks',
    sent_at: FIVE_MIN_AGO.toISOString(),
    sent_by: 'customer',
    conversation_id: 'conv-a',
  },
];

const MESSAGES_B = [
  {
    id: 'msg-b1',
    role: 'assistant',
    content: 'Thank you for your inquiry',
    sent_at: TEN_MIN_AGO.toISOString(),
    sent_by: 'bot',
    conversation_id: 'conv-b',
  },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set up mock Supabase with two contacts, customizable per test.
 * Overrides the default mockSupabase to handle conversation-specific queries
 * and preview message fetches.
 */
async function setupTwoContactMock(page, {
  conversations = [CONV_A, CONV_B],
  allMessages = [...MESSAGES_A, ...MESSAGES_B],
  takeoverStatus = false,
} = {}) {
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: { id: 'user-1', email: 'test@test.com' } })
  );

  await page.route('**/rest/v1/agents*', (route) =>
    route.fulfill({ json: [] })
  );

  await page.route('**/rest/v1/conversations*', (route) => {
    const url = route.request().url();

    if (url.includes('select=is_human_takeover')) {
      const convId = url.match(/id=eq\.([^&]+)/)?.[1];
      const conv = conversations.find((c) => c.id === convId);
      return route.fulfill({
        json: { is_human_takeover: conv?.is_human_takeover ?? takeoverStatus },
        headers: {
          'content-type': 'application/vnd.pgrst.object+json',
          'content-profile': 'public',
        },
      });
    }

    if (url.includes('contact_id=eq.')) {
      const contactId = url.match(/contact_id=eq\.([^&]+)/)?.[1];
      const ids = conversations
        .filter((c) => c.contact_id === contactId)
        .map((c) => ({ id: c.id }));
      return route.fulfill({ json: ids });
    }

    return route.fulfill({ json: conversations });
  });

  await page.route('**/rest/v1/messages*', (route) => {
    const url = route.request().url();
    const convIdMatch = url.match(/conversation_id=eq\.([^&]+)/);
    if (convIdMatch) {
      const convId = convIdMatch[1];
      const msgs = allMessages.filter((m) => m.conversation_id === convId);
      return route.fulfill({ json: msgs });
    }
    // For IN queries (conversation_id=in.), return all matching
    return route.fulfill({ json: allMessages });
  });

  await page.route('**/rest/v1/leads*', (route) =>
    route.fulfill({ json: [] })
  );

  await page.route('**/rest/v1/lead_sync_logs*', (route) =>
    route.fulfill({ json: [] })
  );

  // Abort realtime WebSocket
  await page.route('**/realtime/**', (route) => route.abort());
}

test.describe('Inbox preview sync', () => {
  // ---------------------------------------------------------------------------
  // 1. Contact list renders preview text from last message
  // ---------------------------------------------------------------------------
  test.describe('Preview text rendering', () => {
    test('shows last message content as preview for each contact', async ({ page }) => {
      await setupTwoContactMock(page);
      await page.goto('/dashboard/inbox');

      // Wait for contact list to load
      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Bob/ })).toBeVisible();

      // Alice's preview should show her last message
      const aliceButton = page.getByRole('button', { name: /Alice/ });
      await expect(aliceButton).toContainText('I need a quote for 5 trucks');

      // Bob's preview should show bot reply with ↩ prefix
      const bobButton = page.getByRole('button', { name: /Bob/ });
      await expect(bobButton).toContainText('Thank you for your inquiry');
    });

    test('contacts are sorted by lastMessageAt descending (newest first)', async ({ page }) => {
      await setupTwoContactMock(page);
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();

      // Alice (5min ago) should be above Bob (10min ago)
      const contactButtons = page.locator('button.w-full.text-left');
      const firstName = await contactButtons.first().locator('span.text-sm.truncate').textContent();
      expect(firstName).toBe('Alice');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Unread dot only for human-takeover contacts
  // ---------------------------------------------------------------------------
  test.describe('Unread dot visibility', () => {
    test('blue dot appears for human-takeover contact with user message', async ({ page }) => {
      await setupTwoContactMock(page);
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();

      // Alice: is_human_takeover=true, last message role=user → should show dot
      const aliceButton = page.getByRole('button', { name: /Alice/ });
      const aliceDot = aliceButton.locator('span.rounded-full.bg-accent-blue');
      await expect(aliceDot).toBeVisible();
    });

    test('no blue dot for non-takeover contact even with user message', async ({ page }) => {
      // Bob has is_human_takeover=false but give him a user message
      const convBWithUserMsg = { ...CONV_B, is_human_takeover: false };
      const msgBUser = {
        id: 'msg-b2',
        role: 'user',
        content: 'Hello from Bob',
        sent_at: TEN_MIN_AGO.toISOString(),
        sent_by: 'customer',
        conversation_id: 'conv-b',
      };

      await setupTwoContactMock(page, {
        conversations: [CONV_A, convBWithUserMsg],
        allMessages: [...MESSAGES_A, msgBUser],
      });
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Bob/ })).toBeVisible();

      // Bob: is_human_takeover=false, last message role=user → should NOT show dot
      const bobButton = page.getByRole('button', { name: /Bob/ });
      const bobDot = bobButton.locator('span.rounded-full.bg-accent-blue');
      await expect(bobDot).toHaveCount(0);
    });

    test('no blue dot when last message is from assistant (even with takeover)', async ({ page }) => {
      // Alice with takeover but last message is assistant
      const convAAssistant = { ...CONV_A, is_human_takeover: true };
      const msgAAssistant = {
        id: 'msg-a2',
        role: 'assistant',
        content: 'Here is the quote',
        sent_at: FIVE_MIN_AGO.toISOString(),
        sent_by: 'operator',
        conversation_id: 'conv-a',
      };

      await setupTwoContactMock(page, {
        conversations: [convAAssistant, CONV_B],
        allMessages: [msgAAssistant, ...MESSAGES_B],
      });
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();

      // Alice: is_human_takeover=true but last message role=assistant → no dot
      const aliceButton = page.getByRole('button', { name: /Alice/ });
      const aliceDot = aliceButton.locator('span.rounded-full.bg-accent-blue');
      await expect(aliceDot).toHaveCount(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Preview update after sending a message
  // ---------------------------------------------------------------------------
  test.describe('Send message flow', () => {
    test('send API is called with correct payload', async ({ page }) => {
      await setupTwoContactMock(page);

      let capturedBody = null;
      await page.route('**/api/send-message', async (route) => {
        capturedBody = JSON.parse(route.request().postData());
        return route.fulfill({
          json: { ok: true, messageId: 'msg-sent-1' },
        });
      });

      await page.goto('/dashboard/inbox');
      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();

      // Click Alice to select her (she should be auto-selected as first)
      await wait(500);

      // Type and send a message
      const chatInput = page.locator('textarea, input[type="text"]').last();
      await chatInput.fill('New quote ready');

      const sendButton = page.locator('button[type="submit"]');
      await sendButton.click();

      // Wait for the API call
      await wait(1000);

      // Verify API was called with correct conversation ID
      expect(capturedBody).toBeTruthy();
      expect(capturedBody.conversationId).toBe('conv-a');
      expect(capturedBody.message).toBe('New quote ready');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Contact sort order reflects message timestamps
  // ---------------------------------------------------------------------------
  test.describe('Sort order', () => {
    test('newer conversation appears first after timestamp change', async ({ page }) => {
      // Bob gets a newer message than Alice
      const convBNewer = {
        ...CONV_B,
        last_message_at: NOW.toISOString(), // NOW is newer than FIVE_MIN_AGO
      };
      const msgBNew = {
        id: 'msg-b-new',
        role: 'user',
        content: 'Urgent order from Bob',
        sent_at: NOW.toISOString(),
        sent_by: 'customer',
        conversation_id: 'conv-b',
      };

      await setupTwoContactMock(page, {
        conversations: [convBNewer, CONV_A],
        allMessages: [msgBNew, ...MESSAGES_A],
      });
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Bob/ })).toBeVisible();

      // Bob (NOW) should be above Alice (5min ago)
      const contactButtons = page.locator('button.w-full.text-left');
      const firstName = await contactButtons.first().locator('span.text-sm.truncate').textContent();
      expect(firstName).toBe('Bob');

      // Bob's preview should show his latest message
      const bobButton = page.getByRole('button', { name: /Bob/ });
      await expect(bobButton).toContainText('Urgent order from Bob');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Structural sanity checks
  // ---------------------------------------------------------------------------
  test.describe('Structural checks', () => {
    test('contact items have avatar, name, and preview', async ({ page }) => {
      await setupTwoContactMock(page);
      await page.goto('/dashboard/inbox');

      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();

      const firstContact = page.locator('button.w-full.text-left').first();

      // Avatar
      await expect(firstContact.locator('div.rounded-full').first()).toBeVisible();
      // Name
      await expect(firstContact.locator('span.text-sm.truncate')).toBeVisible();
      // Preview text
      await expect(firstContact.locator('div.text-xs.truncate').last()).toBeVisible();
    });

    test('takeover button is visible in chat header', async ({ page }) => {
      await setupTwoContactMock(page);
      await page.goto('/dashboard/inbox');

      // Wait for a contact to be selected and chat header to render
      await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();
      await wait(1000);

      // The Take Over or Exit Takeover button should be present
      const headerButtons = page.locator('button').filter({
        hasText: /Take Over|Exit Takeover|接管|退出接管/,
      });
      await expect(headerButtons.first()).toBeVisible({ timeout: 5000 });
    });
  });
});
