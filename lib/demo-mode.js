import { NextResponse } from 'next/server';

export function isDemoMode() {
  return process.env.DEMO_MODE === 'true';
}

/**
 * Returns a mock success response for write operations in demo mode.
 * Returns null if not in demo mode (caller should proceed normally).
 */
export function demoGuard(mockData = { success: true }, status = 200) {
  if (!isDemoMode()) return null;
  return NextResponse.json(mockData, { status });
}

/**
 * Fake user object returned by auth in demo mode.
 */
export const DEMO_USER = {
  id: 'demo-user-id',
  email: 'demo@example.com',
  role: 'authenticated',
};
