import { test, expect } from '@playwright/test';
import { MOCK_CONVERSATION, MOCK_MESSAGES } from './fixtures/mock-data.js';
import { mockSupabase } from './fixtures/supabase-mock.js';

test.describe('Inbox — Human Takeover', () => {

  test.beforeEach(async ({ page }) => {
    await mockSupabase(page, {
      conversations: [MOCK_CONVERSATION],
      messages: MOCK_MESSAGES,
    });
  });

  test('shows "Take Over" button when not in takeover', async ({ page }) => {
    await page.goto('/dashboard/inbox');
    await expect(page.getByRole('button', { name: 'Take Over' })).toBeVisible();
    await expect(page.getByText('Human Mode')).not.toBeVisible();
  });

  test('clicking "Take Over" calls POST /api/conversations/[id]/takeover', async ({ page }) => {
    let apiCalled = false;
    await page.route('**/api/conversations/*/takeover', (route) => {
      if (route.request().method() === 'POST') {
        apiCalled = true;
        return route.fulfill({ json: { success: true, conversation: { ...MOCK_CONVERSATION, is_human_takeover: true } } });
      }
      return route.continue();
    });

    await page.goto('/dashboard/inbox');
    await page.getByRole('button', { name: 'Take Over' }).click();

    await expect(page.getByRole('button', { name: 'Exit Takeover' })).toBeVisible();
    await expect(page.getByText('Human Mode')).toBeVisible();
    expect(apiCalled).toBe(true);
  });

  test('shows "Exit Takeover" and badge when takeover is active', async ({ page }) => {
    await mockSupabase(page, {
      conversations: [{ ...MOCK_CONVERSATION, is_human_takeover: true }],
      messages: MOCK_MESSAGES,
      takeoverStatus: true,
    });

    await page.goto('/dashboard/inbox');
    await expect(page.getByRole('button', { name: 'Exit Takeover' })).toBeVisible();
    await expect(page.getByText('Human Mode')).toBeVisible();
  });

  test('clicking "Exit Takeover" calls DELETE and restores button', async ({ page }) => {
    await mockSupabase(page, {
      conversations: [{ ...MOCK_CONVERSATION, is_human_takeover: true }],
      messages: MOCK_MESSAGES,
      takeoverStatus: true,
    });

    await page.route('**/api/conversations/*/takeover', (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ json: { success: true, conversation: { ...MOCK_CONVERSATION, is_human_takeover: false } } });
      }
      return route.continue();
    });

    await page.goto('/dashboard/inbox');
    await page.getByRole('button', { name: 'Exit Takeover' }).click();
    await expect(page.getByRole('button', { name: 'Take Over' })).toBeVisible();
    await expect(page.getByText('Human Mode')).not.toBeVisible();
  });

  test('button shows loading state during takeover API call', async ({ page }) => {
    await page.route('**/api/conversations/*/takeover', (route) =>
      new Promise((r) => setTimeout(() => {
        route.fulfill({ json: { success: true, conversation: {} } });
        r();
      }, 500))
    );

    await page.goto('/dashboard/inbox');
    await page.getByRole('button', { name: 'Take Over' }).click();
    await expect(page.getByText('Taking over...')).toBeVisible();
  });

  test('shows error alert when takeover API fails', async ({ page }) => {
    page.on('dialog', (d) => d.accept());

    await page.route('**/api/conversations/*/takeover', (route) =>
      route.fulfill({ status: 500, json: { error: 'Server error' } })
    );

    await page.goto('/dashboard/inbox');
    await page.getByRole('button', { name: 'Take Over' }).click();
    // Button should remain as "Take Over" after failure
    await expect(page.getByRole('button', { name: 'Take Over' })).toBeVisible();
  });

  test('takeover state resets when switching contacts', async ({ page }) => {
    const secondConv = {
      ...MOCK_CONVERSATION,
      id: 'conv-002',
      contact_id: 'contact-002',
      is_human_takeover: false,
      contact: { id: 'contact-002', wa_id: '8613800000002', company_name: 'Other Corp', name: 'Other User' },
    };

    await mockSupabase(page, {
      conversations: [
        { ...MOCK_CONVERSATION, is_human_takeover: true },
        secondConv,
      ],
      messages: MOCK_MESSAGES,
      takeoverStatus: true,
    });

    await page.goto('/dashboard/inbox');
    // First contact auto-selected — takeover active
    await expect(page.getByText('Human Mode')).toBeVisible();

    // Click second contact in list
    await page.getByText('8613800000002').click();

    // Takeover should reset for the new contact
    await expect(page.getByText('Human Mode')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Take Over' })).toBeVisible();
  });

  test('takeover button is not visible when no contact is selected', async ({ page }) => {
    await mockSupabase(page, { conversations: [], messages: [] });
    await page.goto('/dashboard/inbox');
    await expect(page.getByText('Select a contact to start chatting')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take Over' })).not.toBeVisible();
  });
});
