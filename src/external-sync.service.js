// src/external-sync.service.js

const REVO_SCM_API = 'http://47.111.1.165/api/external/inquiries/batch';

/**
 * Convert qty_bucket to numeric quantity
 * - Number string "10" → 10
 * - Range "10-15" → 15 (max value)
 * - Plus format "20+" → 20
 * @param {string} bucket
 * @returns {number}
 */
function convertQtyBucket(bucket) {
  if (!bucket) return 1;

  // Handle "20+" format
  if (bucket.endsWith('+')) {
    const num = parseInt(bucket.slice(0, -1), 10);
    return isNaN(num) ? 1 : num;
  }

  // Handle range "10-15" format - take max value
  if (bucket.includes('-')) {
    const parts = bucket.split('-');
    const max = parseInt(parts[parts.length - 1], 10);
    return isNaN(max) ? 1 : max;
  }

  // Handle plain number "10"
  const num = parseInt(bucket, 10);
  return isNaN(num) ? 1 : num;
}

/**
 * Build base inquiry object without color-specific fields
 * @param {Object} lead
 * @returns {Object}
 */
function buildBaseInquiry(lead) {
  return {
    lead_key: lead.lead_key || undefined,
    customer: {
      name: lead.contact?.company_name || lead.contact?.name || 'Unknown',
      country: lead.destination_country || 'Unknown',
    },
    inquiry: {
      brand: lead.brand || 'Unknown',
      model: lead.car_model || 'Unknown',
      port_of_loading: lead.loading_port || undefined,
      port_of_discharge: lead.destination_port || undefined,
      incoterm: lead.incoterm || undefined,
      timeline: lead.timeline || undefined,
    },
  };
}

/**
 * Expand lead into multiple inquiry items by color_quantity
 * @param {Object} lead
 * @returns {Array} - Array of inquiry items for external API
 */
export function expandLeadForSync(lead) {
  const colorQuantity = lead.color_quantity || [];
  const base = buildBaseInquiry(lead);
  const qtyBucketNote = lead.qty_bucket ? `qty_bucket: ${lead.qty_bucket}` : '';

  // No color_quantity: single inquiry with warning note
  if (colorQuantity.length === 0) {
    const notes = lead.extra_data?.notes
      ? `${lead.extra_data.notes}; 颜色信息待确认; ${qtyBucketNote}`
      : `颜色信息待确认; ${qtyBucketNote}`;

    return [{
      external_id: lead.id,
      lead_key: base.lead_key,
      customer: base.customer,
      inquiry: {
        ...base.inquiry,
        quantity: convertQtyBucket(lead.qty_bucket),
        notes: notes.trim().replace(/; $/, ''),
      },
    }];
  }

  // Expand each color into separate inquiry
  return colorQuantity.map(cq => {
    const colorNote = `Color: ${cq.color}`;
    const notes = lead.extra_data?.notes
      ? `${lead.extra_data.notes}; ${colorNote}; ${qtyBucketNote}`
      : `${colorNote}; ${qtyBucketNote}`;

    return {
      external_id: `${lead.id}_${cq.color}`,
      lead_key: base.lead_key,
      customer: base.customer,
      inquiry: {
        ...base.inquiry,
        quantity: cq.qty || 1,
        colors: [cq.color],
        notes: notes.trim().replace(/; $/, ''),
      },
    };
  });
}

/**
 * Sync leads to external system
 * @param {Array} leads - Array of lead objects
 * @param {string} apiKey - API key for authentication
 * @returns {Promise<Object>} - API response
 */
export async function syncLeadsToExternal(leads, apiKey) {
  if (!apiKey) {
    throw new Error('REVO_SCM_API_KEY is not configured');
  }

  if (!leads || leads.length === 0) {
    return { success: true, summary: { total: 0 }, results: [] };
  }

  // Expand leads by color_quantity (one lead may become multiple items)
  const items = leads.flatMap(expandLeadForSync);

  const response = await fetch(REVO_SCM_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ mode: 'skip', items }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`External API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Process sync results and merge expanded inquiry results back to lead level
 * @param {Array} leads - Original leads
 * @param {Object} apiResponse - API response
 * @returns {Array} - Array of { leadId, status, externalIds, externalNos, expandedCount, error }
 */
export function processSyncResults(leads, apiResponse) {
  const results = [];

  for (const lead of leads) {
    // Find all results for this lead (exact match or prefixed with lead.id_)
    const relatedResults = (apiResponse.results || []).filter(
      r => r.external_id === lead.id || r.external_id.startsWith(`${lead.id}_`)
    );

    if (relatedResults.length === 0) {
      results.push({
        leadId: lead.id,
        status: 'failed',
        externalIds: [],
        externalNos: [],
        expandedCount: 0,
        error: 'No result returned from API',
      });
      continue;
    }

    // Check if all expanded inquiries succeeded
    const hasError = relatedResults.some(r => r.status === 'error');
    const externalIds = relatedResults
      .map(r => r.inquiry_id)
      .filter(Boolean);
    const externalNos = relatedResults
      .map(r => r.inquiry_no)
      .filter(Boolean);
    const firstError = relatedResults.find(r => r.error)?.error || null;

    results.push({
      leadId: lead.id,
      status: hasError ? 'failed' : 'success',
      externalIds,
      externalNos,
      expandedCount: relatedResults.length,
      error: firstError,
    });
  }

  return results;
}
