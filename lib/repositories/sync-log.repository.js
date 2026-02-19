// lib/repositories/sync-log.repository.js
import supabase from '../supabase.js';

/**
 * Create a sync log entry
 * @param {Object} logData
 * @returns {Promise<Object>}
 */
export async function createSyncLog(logData) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .insert({
      lead_id: logData.leadId,
      status: logData.status || 'pending',
      request_payload: logData.requestPayload || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update sync log
 * @param {string} logId
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateSyncLog(logId, updates) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  if (updates.status !== undefined) updateData.status = updates.status;
  // Handle array or single value for externalId
  if (updates.externalId !== undefined) {
    updateData.external_id = Array.isArray(updates.externalId)
      ? updates.externalId.join(',')
      : updates.externalId;
  }
  // Handle array or single value for externalNo
  if (updates.externalNo !== undefined) {
    updateData.external_no = Array.isArray(updates.externalNo)
      ? updates.externalNo.join(',')
      : updates.externalNo;
  }
  if (updates.responsePayload !== undefined) updateData.response_payload = updates.responsePayload;
  if (updates.errorMessage !== undefined) updateData.error_message = updates.errorMessage;
  if (updates.retryCount !== undefined) updateData.retry_count = updates.retryCount;
  if (updates.syncedAt !== undefined) updateData.synced_at = updates.syncedAt;

  const { data, error } = await supabase
    .from('lead_sync_logs')
    .update(updateData)
    .eq('id', logId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get latest sync log for a lead
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getLatestSyncLog(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Check if lead has successful sync
 * @param {string} leadId
 * @returns {Promise<boolean>}
 */
export async function hasSuccessfulSync(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('id')
    .eq('lead_id', leadId)
    .eq('status', 'success')
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

/**
 * Get failed logs that need retry (retry_count <= 3)
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getRetryableFailedLog(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('*')
    .eq('lead_id', leadId)
    .eq('status', 'failed')
    .lte('retry_count', 3)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Increment retry count
 * @param {string} logId
 * @returns {Promise<Object>}
 */
export async function incrementRetryCount(logId) {
  const { data: current } = await supabase
    .from('lead_sync_logs')
    .select('retry_count')
    .eq('id', logId)
    .single();

  return updateSyncLog(logId, {
    retryCount: (current?.retry_count || 0) + 1,
    status: 'syncing',
  });
}
