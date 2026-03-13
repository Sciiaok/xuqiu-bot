export function orderConversationIds(conversationIds = [], targetConversationId = null) {
  const uniqueIds = Array.from(new Set((conversationIds || []).filter(Boolean)));

  if (!targetConversationId || !uniqueIds.includes(targetConversationId)) {
    return uniqueIds;
  }

  return [targetConversationId, ...uniqueIds.filter((id) => id !== targetConversationId)];
}

export function buildConversationSelection(conversationIds = [], options = {}) {
  const { targetConversationId = null, focusConversation = false } = options;
  const orderedConversationIds = orderConversationIds(conversationIds, targetConversationId);

  if (!focusConversation || !targetConversationId || !orderedConversationIds.includes(targetConversationId)) {
    return {
      orderedConversationIds,
      panelConversationIds: orderedConversationIds,
    };
  }

  return {
    orderedConversationIds,
    panelConversationIds: [targetConversationId],
  };
}

export function buildJumpSelectionOptions(options = {}) {
  const {
    initialWaId = null,
    initialConversationId = null,
    resolvedFromParams = false,
    contact = null,
  } = options;

  if (initialConversationId) {
    return {
      conversationId: initialConversationId,
      focusConversation: true,
    };
  }

  if (initialWaId && resolvedFromParams && contact?.latestConversationId) {
    return {
      conversationId: contact.latestConversationId,
      focusConversation: true,
    };
  }

  return {
    conversationId: null,
    focusConversation: false,
  };
}

export function shouldApplyJumpSelection({
  jumpSignature = null,
  appliedJumpSignature = null,
  pendingJumpSignature = null,
} = {}) {
  if (!jumpSignature) return false;
  if (jumpSignature === appliedJumpSignature) return false;
  if (jumpSignature === pendingJumpSignature) return false;
  return true;
}

export function buildInboxPathWithoutJumpParams(searchParamsString = '') {
  const nextParams = new URLSearchParams(searchParamsString);
  nextParams.delete('wa_id');
  nextParams.delete('conversation_id');

  const nextQuery = nextParams.toString();
  return nextQuery ? `/dashboard/inbox?${nextQuery}` : '/dashboard/inbox';
}
