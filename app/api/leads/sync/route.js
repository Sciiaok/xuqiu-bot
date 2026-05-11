// app/api/leads/sync/route.js
import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import { getLeadsNeedingSync, getLeadById } from '@/lib/repositories/lead.repository';
import { createSyncLog, updateSyncLog, hasSuccessfulSync } from '@/lib/repositories/sync-log.repository';
import { syncLeadsToExternal, processSyncResults, expandLeadForSync } from '@/src/external-sync.service';
import { config } from '@/src/config';

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { leadIds, syncAll, syncFiltered, filters } = body;

    let leadsToSync = [];

    if (syncAll) {
      const allLeads = await getLeadsNeedingSync({ tenantId: ctx.tenantId });
      for (const lead of allLeads) {
        const synced = await hasSuccessfulSync(lead.id);
        if (!synced) {
          leadsToSync.push(lead);
        }
      }
    } else if (syncFiltered && filters) {
      let query = supabase
        .from('leads')
        .select(`*, contact:contacts(wa_id, company_name, name)`)
        .eq('tenant_id', ctx.tenantId);

      if (filters.stage && filters.stage !== 'all') {
        query = query.eq('stage', filters.stage);
      }
      if (filters.scoreMin !== undefined) {
        query = query.gte('score', filters.scoreMin);
      }

      const { data, error } = await query;
      if (error) throw error;
      leadsToSync = data || [];
    } else if (leadIds && leadIds.length > 0) {
      // 显式传入 leadIds 时也要按 tenant 过滤 —— 即使前端传了别 tenant 的 id，
      // 这里也把它们 filter 掉。
      for (const id of leadIds) {
        const lead = await getLeadById(id);
        if (lead && lead.tenant_id === ctx.tenantId) {
          leadsToSync.push(lead);
        }
      }
    }

    if (leadsToSync.length === 0) {
      return NextResponse.json({
        success: true,
        queued: 0,
        message: 'No leads to sync',
      });
    }

    // Create sync logs for each lead
    const syncLogs = [];
    for (const lead of leadsToSync) {
      const log = await createSyncLog({
        tenantId: ctx.tenantId,
        leadId: lead.id,
        status: 'syncing',
        requestPayload: expandLeadForSync(lead),
      });
      syncLogs.push({ lead, log });
    }

    // Call external API
    const apiKey = config.secrets.revoScmApiKey;
    const apiResponse = await syncLeadsToExternal(leadsToSync, apiKey);
    const results = processSyncResults(leadsToSync, apiResponse);

    // Update sync logs with results
    let successCount = 0;
    let failedCount = 0;

    for (const result of results) {
      const syncLog = syncLogs.find(sl => sl.lead.id === result.leadId);
      if (syncLog) {
        await updateSyncLog(syncLog.log.id, {
          status: result.status,
          externalId: result.externalId,
          externalNo: result.externalNo,
          responsePayload: apiResponse,
          errorMessage: result.error,
          syncedAt: result.status === 'success' ? new Date().toISOString() : null,
        });

        if (result.status === 'success') {
          successCount++;
        } else {
          failedCount++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      queued: leadsToSync.length,
      synced: successCount,
      failed: failedCount,
      message: `${successCount} synced, ${failedCount} failed`,
    });
  } catch (error) {
    console.error('Error syncing leads:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
