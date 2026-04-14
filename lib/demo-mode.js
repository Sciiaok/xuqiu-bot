import { NextResponse } from 'next/server';
import { config } from '../src/config.js';

export function isDemoMode() {
  return config.app.demoMode;
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
