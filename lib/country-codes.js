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
  // Chinese names
  '中国': 'CN', '美国': 'US', '英国': 'GB', '日本': 'JP', '韩国': 'KR',
  '越南': 'VN', '泰国': 'TH', '菲律宾': 'PH', '马来西亚': 'MY', '印度尼西亚': 'ID', '印尼': 'ID',
  '新加坡': 'SG', '柬埔寨': 'KH', '缅甸': 'MM', '老挝': 'LA', '蒙古': 'MN',
  '印度': 'IN', '巴基斯坦': 'PK', '孟加拉': 'BD', '斯里兰卡': 'LK', '尼泊尔': 'NP',
  '阿联酋': 'AE', '迪拜': 'AE', '沙特': 'SA', '沙特阿拉伯': 'SA', '伊拉克': 'IQ', '伊朗': 'IR',
  '土耳其': 'TR', '哈萨克斯坦': 'KZ', '乌兹别克斯坦': 'UZ', '阿富汗': 'AF',
  '俄罗斯': 'RU', '乌克兰': 'UA',
  '尼日利亚': 'NG', '肯尼亚': 'KE', '南非': 'ZA', '加纳': 'GH', '坦桑尼亚': 'TZ',
  '埃塞俄比亚': 'ET', '乌干达': 'UG', '埃及': 'EG', '摩洛哥': 'MA',
  '莫桑比克': 'MZ', '赞比亚': 'ZM', '津巴布韦': 'ZW', '安哥拉': 'AO',
  '巴西': 'BR', '墨西哥': 'MX', '哥伦比亚': 'CO', '阿根廷': 'AR', '智利': 'CL', '秘鲁': 'PE',
  '加拿大': 'CA', '澳大利亚': 'AU', '新西兰': 'NZ',
  '德国': 'DE', '法国': 'FR', '意大利': 'IT', '西班牙': 'ES', '葡萄牙': 'PT',
  '荷兰': 'NL', '比利时': 'BE', '瑞典': 'SE', '挪威': 'NO', '丹麦': 'DK',
  '芬兰': 'FI', '波兰': 'PL', '匈牙利': 'HU', '罗马尼亚': 'RO', '希腊': 'GR',
  '台湾': 'TW',
};

/**
 * Convert a country name or code to ISO 3166-1 alpha-2.
 * Returns the input unchanged if already 2 chars.
 */
export function countryToISO(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 2 && /^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  // Try exact match first
  const exact = COUNTRY_ISO_MAP[trimmed.toLowerCase()];
  if (exact) return exact;
  // Strip parenthetical suffixes: "阿联酋（迪拜）" → "阿联酋", "Dubai (UAE)" → "Dubai"
  const stripped = trimmed.replace(/[（(].*[）)]/g, '').trim();
  if (stripped !== trimmed) return COUNTRY_ISO_MAP[stripped.toLowerCase()] || null;
  return null;
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
