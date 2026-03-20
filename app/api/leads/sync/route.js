// app/api/leads/sync/route.js
import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import supabase from '@/lib/supabase';
import { getLeadsNeedingSync, getLeadById } from '@/lib/repositories/lead.repository';
import { createSyncLog, updateSyncLog, hasSuccessfulSync } from '@/lib/repositories/sync-log.repository';
import { syncLeadsToExternal, processSyncResults, expandLeadForSync } from '@/lib/services/external-sync';

export async function POST(request) {
  const demoResponse = demoGuard({ success: true, queued: 0, synced: 0, failed: 0, message: 'Demo mode' });
  if (demoResponse) return demoResponse;

  try {
    const body = await request.json();
    const { leadIds, syncAll, syncFiltered, filters } = body;

    let leadsToSync = [];

    if (syncAll) {
      // Sync all approved unsynced leads from last 24h
      const allLeads = await getLeadsNeedingSync();

      // Filter out already synced
      for (const lead of allLeads) {
        const synced = await hasSuccessfulSync(lead.id);
        if (!synced) {
          leadsToSync.push(lead);
        }
      }
    } else if (syncFiltered && filters) {
      // Sync based on filters (ignoring approved status)
      let query = supabase
        .from('leads')
        .select(`*, contact:contacts(wa_id, company_name, name)`);

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
      // Sync specific leads
      for (const id of leadIds) {
        const lead = await getLeadById(id);
        if (lead) {
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
        leadId: lead.id,
        status: 'syncing',
        requestPayload: expandLeadForSync(lead),  // Now returns array
      });
      syncLogs.push({ lead, log });
    }

    // Call external API
    const apiKey = process.env.REVO_SCM_API_KEY;
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
