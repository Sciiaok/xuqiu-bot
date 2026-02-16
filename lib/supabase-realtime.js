import supabase from './supabase.js';

/**
 * Subscribe to changes on a specific session by waId
 * @param {string} waId - WhatsApp user ID to subscribe to
 * @param {Function} onUpdate - Callback function receiving (payload) with new, old, and eventType
 * @returns {Function} - Unsubscribe function to clean up the subscription
 */
export function subscribeToSession(waId, onUpdate) {
  const channel = supabase
    .channel(`session:${waId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sessions',
        filter: `wa_id=eq.${waId}`,
      },
      (payload) => {
        onUpdate({
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`Subscribed to session changes for ${waId}`);
      } else if (status === 'CHANNEL_ERROR') {
        console.error(`Failed to subscribe to session changes for ${waId}`);
      }
    });

  // Return unsubscribe function
  return () => {
    console.log(`Unsubscribing from session changes for ${waId}`);
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to changes on all sessions
 * @param {Function} onUpdate - Callback function receiving (payload) with new, old, and eventType
 * @returns {Function} - Unsubscribe function to clean up the subscription
 */
export function subscribeToAllSessions(onUpdate) {
  const channel = supabase
    .channel('all-sessions')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sessions',
      },
      (payload) => {
        onUpdate({
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Subscribed to all session changes');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('Failed to subscribe to all session changes');
      }
    });

  // Return unsubscribe function
  return () => {
    console.log('Unsubscribing from all session changes');
    supabase.removeChannel(channel);
  };
}
