/**
 * Map common country names to ISO 3166-1 alpha-2 codes.
 * Used by research agent (Ad Library) and execution agent (Meta targeting).
 */
const COUNTRY_ISO_MAP = {
  'china': 'CN', 'usa': 'US', 'united states': 'US', 'uk': 'GB', 'united kingdom': 'GB',
  'nigeria': 'NG', 'kenya': 'KE', 'south africa': 'ZA', 'ghana': 'GH', 'tanzania': 'TZ',
  'ethiopia': 'ET', 'uganda': 'UG', 'egypt': 'EG', 'morocco': 'MA', 'algeria': 'DZ',
  'india': 'IN', 'pakistan': 'PK', 'bangladesh': 'BD', 'indonesia': 'ID', 'vietnam': 'VN',
  'thailand': 'TH', 'philippines': 'PH', 'malaysia': 'MY', 'myanmar': 'MM', 'cambodia': 'KH',
  'uae': 'AE', 'united arab emirates': 'AE', 'saudi arabia': 'SA', 'iraq': 'IQ', 'iran': 'IR',
  'turkey': 'TR', 'russia': 'RU', 'brazil': 'BR', 'mexico': 'MX', 'colombia': 'CO',
  'kazakhstan': 'KZ', 'uzbekistan': 'UZ', 'turkmenistan': 'TM', 'afghanistan': 'AF',
  'sri lanka': 'LK', 'nepal': 'NP', 'laos': 'LA', 'mongolia': 'MN', 'japan': 'JP',
  'south korea': 'KR', 'taiwan': 'TW', 'singapore': 'SG', 'australia': 'AU',
  'new zealand': 'NZ', 'canada': 'CA', 'argentina': 'AR', 'chile': 'CL', 'peru': 'PE',
  'germany': 'DE', 'france': 'FR', 'italy': 'IT', 'spain': 'ES', 'portugal': 'PT',
  'netherlands': 'NL', 'belgium': 'BE', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
  'finland': 'FI', 'poland': 'PL', 'czech republic': 'CZ', 'czechia': 'CZ',
  'hungary': 'HU', 'romania': 'RO', 'ukraine': 'UA', 'greece': 'GR',
  'senegal': 'SN', 'cameroon': 'CM', 'ivory coast': 'CI', "cote d'ivoire": 'CI',
  'mozambique': 'MZ', 'zambia': 'ZM', 'zimbabwe': 'ZW', 'angola': 'AO',
  'democratic republic of congo': 'CD', 'congo': 'CG', 'sudan': 'SD',
};

/**
 * Convert a country name or code to ISO 3166-1 alpha-2.
 * Returns the input unchanged if already 2 chars.
 */
export function countryToISO(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return COUNTRY_ISO_MAP[trimmed.toLowerCase()] || null;
}

/**
 * Map an array of country names/codes to ISO codes.
 * Filters out any that can't be mapped.
 */
export function mapCountriesToISO(countries) {
  return (countries || [])
    .map(countryToISO)
    .filter(Boolean);
}
