export function cardCallbackResponseBody(type, content, card = null) {
  return {
    toast: { type, content },
    ...(card ? { card } : {}),
  };
}

export function cardCallbackResponse(type, content, card = null) {
  return Response.json(cardCallbackResponseBody(type, content, card));
}
