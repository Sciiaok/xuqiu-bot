import { NextResponse } from 'next/server';
import { utils, write } from 'xlsx';

/**
 * GET /api/knowledge/template/[kind]
 *
 * Generates an empty xlsx template with header row + one example row, matching
 * the schema enforced by src/kb-excel-template.service.js. Used by the KB
 * "文档上传" card when the user picks the 产品 / 物流 layer to give them a
 * starting point that will pass strict validation.
 */

const TEMPLATES = {
  products: {
    filename: 'products-template.xlsx',
    headers: [
      'sku', 'model', 'product_name', 'product_name_en', 'category',
      'fob_price_usd', 'moq', 'lead_time_days',
      'effective_date', 'expiry_date',
      'specs.color', 'specs.material',
    ],
    example: [
      'A100', 'A100-Pro', '示例拖拉机', 'Sample Tractor', 'tractor',
      12500, 5, '45 days',
      '2026-01-01', '',
      'red', 'steel',
    ],
  },
  shipping_routes: {
    filename: 'shipping-routes-template.xlsx',
    headers: [
      'origin_port', 'destination_port', 'destination_country', 'shipping_method',
      'cost_per_unit_usd', 'transit_days',
      'effective_date', 'expiry_date', 'notes',
    ],
    example: [
      'Shanghai', 'Mombasa', 'Kenya', 'sea',
      450, '28 days',
      '2026-01-01', '', '示例：每月一班',
    ],
  },
};

export async function GET(_request, { params }) {
  const { kind } = await params;
  const tpl = TEMPLATES[kind];
  if (!tpl) {
    return NextResponse.json({ error: `Unknown template kind: ${kind}` }, { status: 404 });
  }

  const wb = utils.book_new();
  const ws = utils.aoa_to_sheet([tpl.headers, tpl.example]);
  utils.book_append_sheet(wb, ws, 'template');
  const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${tpl.filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
