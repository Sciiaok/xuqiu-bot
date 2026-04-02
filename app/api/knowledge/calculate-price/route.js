import { NextResponse } from 'next/server';
import { calculatePrice } from '../../../../src/kb-search.service.js';

/**
 * POST /api/knowledge/calculate-price
 * Calculate exact price for a product with quantity discounts, shipping, and insurance.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, sku, quantity, destination_port, trade_term } = body;

    if (!agent_id || !sku) {
      return NextResponse.json(
        { error: 'agent_id and sku are required' },
        { status: 400 }
      );
    }

    const result = await calculatePrice(agent_id, {
      sku,
      quantity: quantity || 1,
      destinationPort: destination_port || null,
      tradeTerm: trade_term || 'FOB',
    });

    if (result.error) {
      return NextResponse.json(result, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[knowledge/calculate-price] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
