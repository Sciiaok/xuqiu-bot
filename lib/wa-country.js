import { PHONE_COUNTRY_PREFIXES } from '@/lib/phone-country-prefixes';

const sortedPrefixes = Object.keys(PHONE_COUNTRY_PREFIXES).sort((a, b) => b.length - a.length);
const displayNamesCache = new Map();

function normalizeWaId(waId) {
  return String(waId || '').replace(/\D+/g, '');
}

function getDisplayNames(locale) {
  const normalizedLocale = locale === 'zh' ? 'zh-Hans' : 'en';
  if (!displayNamesCache.has(normalizedLocale)) {
    displayNamesCache.set(
      normalizedLocale,
      new Intl.DisplayNames([normalizedLocale], { type: 'region' })
    );
  }

  return displayNamesCache.get(normalizedLocale);
}

export function getWaCountry(waId) {
  const normalized = normalizeWaId(waId);
  if (!normalized) return null;

  for (const prefix of sortedPrefixes) {
    if (normalized.startsWith(prefix)) {
      return {
        prefix,
        ...PHONE_COUNTRY_PREFIXES[prefix],
      };
    }
  }

  return null;
}

export function getWaCountryLabel(waId, locale = 'en') {
  const region = getWaCountry(waId);
  if (!region) return null;

  if (region.labels) {
    return locale === 'zh' ? region.labels.zh : region.labels.en;
  }

  if (!region.isoCode) return null;

  try {
    return getDisplayNames(locale).of(region.isoCode) || region.isoCode;
  } catch {
    return region.isoCode;
  }
}
