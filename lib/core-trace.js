function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined)
  );
}

export function generateTraceId(prefix = 'trace') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

export function extractTraceIdFromMessages(messages) {
  for (const message of messages || []) {
    const traceId = message?.metadata?.trace_id || message?.metadata?.ingest_trace_id;
    if (traceId) return traceId;
  }
  return null;
}

export function createTraceLogger(baseContext = {}) {
  const context = compactObject(baseContext);

  function emit(level, event, details = {}) {
    const payload = compactObject({
      ts: new Date().toISOString(),
      level,
      event,
      ...context,
      ...details,
    });

    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    child(extraContext = {}) {
      return createTraceLogger({ ...context, ...compactObject(extraContext) });
    },
    info(event, details) {
      emit('info', event, details);
    },
    warn(event, details) {
      emit('warn', event, details);
    },
    error(event, details) {
      emit('error', event, details);
    },
  };
}
