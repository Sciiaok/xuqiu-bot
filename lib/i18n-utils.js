/**
 * Shared relative time formatting functions.
 * `t` is a next-intl translator scoped to the "time" namespace.
 */

export function getRelativeTime(timestamp, t) {
  if (!timestamp) return t('unknown');
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('justNow');
  if (diffMins < 60) return t('minAgo', { count: diffMins });
  if (diffHours < 24) return t('hoursAgo', { count: diffHours });
  return t('daysAgo', { count: diffDays });
}

export function getRelativeTimeShort(timestamp, t) {
  if (!timestamp) return '';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('now');
  if (diffMins < 60) return t('minShort', { count: diffMins });
  if (diffHours < 24) return t('hourShort', { count: diffHours });
  return t('dayShort', { count: diffDays });
}

export function getRelativeTimeDay(timestamp, t) {
  if (!timestamp) return t('unknown');
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 1) return t('today');
  if (diffDays === 1) return t('yesterday');
  return t('daysAgo', { count: diffDays });
}
