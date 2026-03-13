import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const routeModuleUrl = pathToFileURL(resolve(process.cwd(), 'app/api/ads/route.js')).href;
const supabaseModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

function applyFilter(rows, filter) {
  switch (filter.type) {
    case 'not':
      if (filter.operator === 'is' && filter.value === null) {
        return rows.filter((row) => row[filter.column] !== null && row[filter.column] !== undefined);
      }
      return rows;
    case 'gte':
      return rows.filter((row) => row[filter.column] >= filter.value);
    case 'lte':
      return rows.filter((row) => row[filter.column] <= filter.value);
    case 'in':
      return rows.filter((row) => filter.values.includes(row[filter.column]));
    default:
      return rows;
  }
}

function createSupabaseMock(fixtures) {
  const executedQueries = [];

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.sort = null;
      this.limitCount = null;
    }

    select() {
      return this;
    }

    not(column, operator, value) {
      this.filters.push({ type: 'not', column, operator, value });
      return this;
    }

    gte(column, value) {
      this.filters.push({ type: 'gte', column, value });
      return this;
    }

    lte(column, value) {
      this.filters.push({ type: 'lte', column, value });
      return this;
    }

    in(column, values) {
      this.filters.push({ type: 'in', column, values });
      return this;
    }

    order(column, options = {}) {
      this.sort = {
        column,
        ascending: options.ascending !== false,
      };
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    then(resolvePromise, rejectPromise) {
      try {
        let rows = [...(fixtures[this.table] || [])];
        for (const filter of this.filters) {
          rows = applyFilter(rows, filter);
        }

        if (this.sort) {
          const { column, ascending } = this.sort;
          rows.sort((left, right) => {
            if (left[column] === right[column]) return 0;
            return ascending
              ? (left[column] < right[column] ? -1 : 1)
              : (left[column] > right[column] ? -1 : 1);
          });
        }

        if (typeof this.limitCount === 'number') {
          rows = rows.slice(0, this.limitCount);
        }

        executedQueries.push({
          table: this.table,
          filters: this.filters,
        });

        return Promise.resolve({ data: rows, error: null }).then(resolvePromise, rejectPromise);
      } catch (error) {
        return Promise.reject(error).then(resolvePromise, rejectPromise);
      }
    }
  }

  return {
    supabase: {
      from(table) {
        return new QueryBuilder(table);
      },
    },
    executedQueries,
  };
}

test('GET only counts inquiry-quality leads from conversations created inside the selected range', async () => {
  const { supabase, executedQueries } = createSupabaseMock({
    conversations: [
      {
        id: 'conv-in-range',
        meta_ad_id: 'meta-ad-1',
        created_at: '2026-03-11T08:00:00.000Z',
      },
      {
        id: 'conv-out-of-range',
        meta_ad_id: 'meta-ad-1',
        created_at: '2026-02-15T08:00:00.000Z',
      },
    ],
    leads: [
      {
        conversation_id: 'conv-out-of-range',
        inquiry_quality: 'QUALIFY',
        created_at: '2026-03-11T12:00:00.000Z',
      },
      {
        conversation_id: 'conv-in-range',
        inquiry_quality: 'PROOF',
        created_at: '2026-03-11T13:00:00.000Z',
      },
    ],
  });

  mock.module(supabaseModuleUrl, {
    defaultExport: supabase,
  });

  const { GET } = await import(`${routeModuleUrl}?test=${Date.now()}-${Math.random()}`);
  const response = await GET(new Request('http://localhost/api/ads?startDate=2026-03-10&endDate=2026-03-12'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.summary.length, 1);
  assert.deepEqual(payload.summary[0], {
    metaAdId: 'meta-ad-1',
    conversationCount: 1,
    qualifyConversationCount: 0,
    proofConversationCount: 1,
    qualifyConversationRate: 0,
    proofConversationRate: 100,
    lastConversationAt: '2026-03-11T08:00:00.000Z',
    dailyConversations: [
      { date: '2026-03-10', count: 0 },
      { date: '2026-03-11', count: 1 },
      { date: '2026-03-12', count: 0 },
    ],
  });

  assert.equal(payload.totals.conversationCount, 1);
  assert.equal(payload.totals.qualifyConversationCount, 0);
  assert.equal(payload.totals.proofConversationCount, 1);

  const leadQuery = executedQueries.find((query) => query.table === 'leads');
  assert.ok(leadQuery);
  assert.deepEqual(leadQuery.filters, [
    {
      type: 'in',
      column: 'conversation_id',
      values: ['conv-in-range'],
    },
  ]);
});
