export function cardCallbackResponseBody(type, content, card = null) {
  void card;
  return {
    toast: { type, content },
  };
}

export function cardCallbackResponse(type, content, card = null) {
  return Response.json(cardCallbackResponseBody(type, content, card));
}

export function requirementActionToastMessage({ action, syncResult }) {
  const base = action === 'generate_plan'
    ? '方案刷新会在后续版本接入'
    : '已更新';
  if (!syncResult && action !== 'generate_plan') return `${base}，多维表格后台同步中`;

  if (syncResult?.ok) return `${base}，已同步多维表格`;
  if (syncResult?.skipped) return `${base}，但没有同步多维表格：${syncResult.reason || '未配置'}`;
  if (syncResult && syncResult.ok === false) {
    return `${base}，但同步多维表格失败：${syncResult.error || '未知错误'}`;
  }
  return base;
}
