import { INQUIRY_QUALITY_ORDER, BUSINESS_VALUE_ORDER } from './inquiries-filters.js';

const TIME_ZONE = 'Asia/Shanghai';

const QUALITY_ORDER = INQUIRY_QUALITY_ORDER;
const QUALITY_RANK = Object.fromEntries(QUALITY_ORDER.map((value, index) => [value, index]));

const BUSINESS_VALUE_RANK = Object.fromEntries(BUSINESS_VALUE_ORDER.map((value, index) => [value, index]));

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateInTimeZone(date) {
  const parts = DATE_FORMATTER.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function shiftDateString(dateString, deltaDays) {
  const [year, month, day] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().split('T')[0];
}

export function diffDaysInclusive(startDate, endDate) {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.floor((end - start) / 86400000) + 1;
}

export function localDateToUtcIso(dateString, endOfDay = false) {
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${dateString}T${time}+08:00`).toISOString();
}

export function buildDateWindows({ days, preset, startDate, endDate, now = new Date() }) {
  if (startDate && endDate) {
    const spanDays = diffDaysInclusive(startDate, endDate);
    const prevToDate = shiftDateString(startDate, -1);
    const prevFromDate = shiftDateString(prevToDate, -(spanDays - 1));

    return {
      current: {
        fromDate: startDate,
        toDate: endDate,
        fromISO: localDateToUtcIso(startDate, false),
        toISO: localDateToUtcIso(endDate, true),
      },
      previous: {
        fromDate: prevFromDate,
        toDate: prevToDate,
        fromISO: localDateToUtcIso(prevFromDate, false),
        toISO: localDateToUtcIso(prevToDate, true),
      },
    };
  }

  const today = formatDateInTimeZone(now);
  if (preset === '1d') {
    const yesterday = shiftDateString(today, -1);
    const previousDay = shiftDateString(yesterday, -1);

    return {
      current: {
        fromDate: yesterday,
        toDate: yesterday,
        fromISO: localDateToUtcIso(yesterday, false),
        toISO: localDateToUtcIso(yesterday, true),
      },
      previous: {
        fromDate: previousDay,
        toDate: previousDay,
        fromISO: localDateToUtcIso(previousDay, false),
        toISO: localDateToUtcIso(previousDay, true),
      },
    };
  }

  const spanDays = Math.max(days || 7, 1);
  const fromDate = shiftDateString(today, -(spanDays - 1));
  const prevToDate = shiftDateString(fromDate, -1);
  const prevFromDate = shiftDateString(prevToDate, -(spanDays - 1));

  return {
    current: {
      fromDate,
      toDate: today,
      fromISO: localDateToUtcIso(fromDate, false),
      toISO: now.toISOString(),
    },
    previous: {
      fromDate: prevFromDate,
      toDate: prevToDate,
      fromISO: localDateToUtcIso(prevFromDate, false),
      toISO: localDateToUtcIso(prevToDate, true),
    },
  };
}

export function getProductName(lead, productLine) {
  const details = lead.details || {};
  switch (productLine) {
    case 'vehicle':
      return lead.car_model || lead.brand || lead.product_name || null;
    case 'auto_parts':
      return details.part_name || lead.product_name || details.oem_code || null;
    case 'agri_machinery':
      return details.machinery_type || lead.product_name || null;
    default:
      return lead.product_name || lead.car_model || null;
  }
}

export function parseIntents(raw) {
  if (!raw) return [];
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      raw = JSON.parse(raw).join(',');
    } catch {
      raw = raw.replace(/[\[\]"]/g, '');
    }
  }
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

function pickBestQuality(leads) {
  let best = 'BAD';
  for (const lead of leads) {
    const quality = lead.inquiry_quality || 'BAD';
    if ((QUALITY_RANK[quality] ?? -1) > (QUALITY_RANK[best] ?? -1)) {
      best = quality;
    }
  }
  return best;
}

function pickBestBusinessValue(leads) {
  let best = null;
  for (const lead of leads) {
    const value = lead.business_value || null;
    if (!value) continue;
    if (!best || (BUSINESS_VALUE_RANK[value] ?? -1) > (BUSINESS_VALUE_RANK[best] ?? -1)) {
      best = value;
    }
  }
  return best;
}

function choosePrimaryLead(leads) {
  if (leads.length === 0) return null;

  return [...leads].sort((left, right) => {
    const qualityDiff = (QUALITY_RANK[right.inquiry_quality || 'BAD'] ?? -1) - (QUALITY_RANK[left.inquiry_quality || 'BAD'] ?? -1);
    if (qualityDiff !== 0) return qualityDiff;

    const businessValueDiff = (BUSINESS_VALUE_RANK[right.business_value || 'LOW'] ?? -1) - (BUSINESS_VALUE_RANK[left.business_value || 'LOW'] ?? -1);
    if (businessValueDiff !== 0) return businessValueDiff;

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  })[0];
}

export function buildInquiryRecords({ conversations, leads, agentMap }) {
  const leadsByConversation = new Map();
  for (const lead of leads) {
    const existing = leadsByConversation.get(lead.conversation_id);
    if (existing) {
      existing.push(lead);
    } else {
      leadsByConversation.set(lead.conversation_id, [lead]);
    }
  }

  return conversations.map(conversation => {
    const conversationLeads = leadsByConversation.get(conversation.id) || [];
    const primaryLead = choosePrimaryLead(conversationLeads);
    const agent = agentMap[conversation.agent_id];
    const primaryIntent = primaryLead ? parseIntents(primaryLead.conversation_intent)[0] : null;

    return {
      conversationId: conversation.id,
      agentId: conversation.agent_id,
      agentName: agent?.name || 'Unknown',
      productLine: agent?.product_line || 'unknown',
      date: formatDateInTimeZone(new Date(conversation.created_at)),
      quality: pickBestQuality(conversationLeads),
      businessValue: pickBestBusinessValue(conversationLeads),
      country: primaryLead?.destination_country || 'Unknown',
      buyerType: primaryLead?.buyer_type || 'other',
      intent: primaryIntent || 'other',
      productName: primaryLead ? getProductName(primaryLead, agent?.product_line || 'unknown') : null,
    };
  });
}

export function createDateSeries(fromDate, toDate) {
  const dates = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    dates.push(cursor);
    cursor = shiftDateString(cursor, 1);
  }
  return dates;
}
