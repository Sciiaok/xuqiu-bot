import { test, expect } from '@playwright/test';
import { mockSupabase } from './fixtures/supabase-mock.js';

test.describe('Inquiries Filters', () => {
  test('agent filter shows all product lines from agents api', async ({ page }) => {
    await mockSupabase(page, {
      leads: [
        {
          id: 'lead-001',
          conversation_id: 'conv-001',
          updated_at: '2026-03-10T10:00:00.000Z',
          inquiry_quality: 'GOOD',
          business_value: 'LOW',
          car_model: 'Model A',
          approved: false,
          route: 'CONTINUE',
          agent_id: 'agent-001',
          contact: { wa_id: '8613800000001', company_name: 'Alpha Co', name: 'Alpha' },
          conversation: { id: 'conv-001', status: 'open', last_message_at: '2026-03-10T10:00:00.000Z', message_count: 1 },
          agent: { id: 'agent-001', product_line: 'auto' },
          details: {},
          color_quantity: [],
        },
        {
          id: 'lead-002',
          conversation_id: 'conv-002',
          updated_at: '2026-03-10T11:00:00.000Z',
          inquiry_quality: 'GOOD',
          business_value: 'LOW',
          car_model: 'Model B',
          approved: false,
          route: 'CONTINUE',
          agent_id: 'agent-002',
          contact: { wa_id: '8613800000002', company_name: 'Beta Co', name: 'Beta' },
          conversation: { id: 'conv-002', status: 'open', last_message_at: '2026-03-10T11:00:00.000Z', message_count: 1 },
          agent: { id: 'agent-002', product_line: 'parts' },
          details: {},
          color_quantity: [],
        },
      ],
    });

    await page.route('**/api/agents', (route) =>
      route.fulfill({
        json: {
          agents: [
            { id: 'agent-001', product_line: 'auto' },
            { id: 'agent-002', product_line: 'parts' },
            { id: 'agent-003', product_line: 'agri_machinery' },
          ],
        },
      })
    );

    await page.goto('/dashboard/inquiries');

    await expect(page.getByRole('button', { name: 'auto' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'parts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'agri_machinery' })).toBeVisible();
  });
});
