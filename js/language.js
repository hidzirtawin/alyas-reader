/* Lightweight language detection for imported books.
   Script detection handles non-Latin writing systems; a small stop-word
   score handles common Latin-script languages. This is intentionally
   lightweight — it runs locally and needs no model download. */

const SCRIPTS = [
  [/[\u3040-\u30FF]/, 'ja'],
  [/[\uAC00-\uD7AF]/, 'ko'],
  [/[\u4E00-\u9FFF]/, 'zh'],
  [/[\u0400-\u04FF]/, 'ru'],
  [/[\u0370-\u03FF]/, 'el'],
  [/[\u0600-\u06FF]/, 'ar'],
  [/[\u0590-\u05FF]/, 'he'],
  [/[\u0900-\u097F]/, 'hi'],
  [/[\u0980-\u09FF]/, 'bn'],
  [/[\u0A00-\u0A7F]/, 'pa'],
  [/[\u0A80-\u0AFF]/, 'gu'],
  [/[\u0B80-\u0BFF]/, 'ta'],
  [/[\u0C00-\u0C7F]/, 'te'],
  [/[\u0C80-\u0CFF]/, 'kn'],
  [/[\u0D00-\u0D7F]/, 'ml'],
  [/[\u0E00-\u0E7F]/, 'th'],
  [/[\u10A0-\u10FF]/, 'ka'],
  [/[\u0530-\u058F]/, 'hy'],
  [/[\u1200-\u137F]/, 'am'],
];

const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'in', 'that', 'he', 'she', 'was', 'with', 'for', 'his', 'her', 'not', 'you', 'but', 'they', 'this'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'una', 'por', 'con', 'para', 'del', 'las', 'pero', 'como', 'más', 'sus', 'le'],
  fr: ['le', 'la', 'de', 'et', 'les', 'des', 'en', 'un', 'une', 'du', 'que', 'qui', 'pour', 'dans', 'pas', 'sur', 'avec', 'ce'],
  de: ['der', 'die', 'und', 'das', 'in', 'den', 'von', 'zu', 'mit', 'sich', 'des', 'auf', 'für', 'ist', 'im', 'nicht', 'ein', 'eine'],
  it: ['il', 'la', 'di', 'che', 'e', 'in', 'un', 'per', 'non', 'con', 'una', 'del', 'della', 'dei', 'le', 'gli', 'si', 'come'],
  pt: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'não', 'uma', 'os', 'as', 'dos', 'das', 'se'],
  nl: ['de', 'het', 'een', 'en', 'van', 'in', 'is', 'dat', 'op', 'te', 'zijn', 'met', 'voor', 'niet', 'aan', 'er', 'ook', 'maar'],
  sv: ['och', 'att', 'det', 'som', 'en', 'på', 'är', 'av', 'för', 'med', 'till', 'den', 'inte', 'har', 'de', 'om', 'ett', 'jag'],
  da: ['og', 'at', 'det', 'som', 'en', 'på', 'er', 'af', 'for', 'med', 'til', 'den', 'ikke', 'har', 'de', 'om', 'et', 'jeg'],
  no: ['og', 'at', 'det', 'som', 'en', 'på', 'er', 'av', 'for', 'med', 'til', 'den', 'ikke', 'har', 'de', 'om', 'et', 'jeg'],
  fi: ['ja', 'on', 'ei', 'että', 'se', 'hän', 'oli', 'kun', 'niin', 'myös', 'mutta', 'tai', 'sen', 'ovat', 'jo', 'sitä'],
  pl: ['i', 'w', 'na', 'z', 'do', 'się', 'nie', 'jest', 'że', 'to', 'jak', 'o', 'ale', 'po', 'co', 'tak', 'dla', 'od'],
  cs: ['a', 'v', 'se', 'na', 'je', 'že', 'to', 's', 'do', 'ale', 'pro', 'jak', 'by', 'co', 'tak', 'od', 'po', 'za'],
  tr: ['ve', 'bir', 'bu', 'da', 'de', 'için', 'ile', 'çok', 'daha', 'olan', 'gibi', 'ama', 'her', 'ne', 'kadar', 'sonra', 'var'],
  ro: ['și', 'în', 'de', 'la', 'a', 'cu', 'pe', 'care', 'un', 'o', 'din', 'este', 'sau', 'pentru', 'nu', 'se', 'mai', 'ca'],
  hu: ['a', 'az', 'és', 'hogy', 'nem', 'is', 'egy', 'van', 'mint', 'meg', 'csak', 'már', 'el', 'ki', 'be', 'fel', 'le', 'volt'],
  id: ['yang', 'dan', 'di', 'itu', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'dalam', 'akan', 'pada', 'juga', 'saya', 'ke', 'ada'],
  vi: ['và', 'của', 'là', 'có', 'trong', 'không', 'được', 'cho', 'một', 'người', 'với', 'này', 'đã', 'khi', 'những', 'ra', 'để'],
};

function baseTag(code = '') {
  return String(code).toLowerCase().replace('_', '-').split('-')[0];
}

export function baseLanguage(code = '') {
  return baseTag(code);
}

export function languageName(code = '') {
  const tag = baseTag(code) || 'en';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
}

export function detectLanguage(text = '', hint = '') {
  const hinted = baseTag(hint);
  const sample = String(text || '').slice(0, 30000);
  if (!sample.trim()) return hinted || 'en';

  // Writing systems are the strongest signal.
  for (const [re, code] of SCRIPTS) {
    const matches = sample.match(re);
    if (matches && matches.length >= 3) {
      // Japanese uses kana plus Han; kana wins because it is checked first.
      return code;
    }
  }

  const words = sample.toLowerCase().match(/[a-zà-ÿœæßşğıőűșțơưđ]+/gi) || [];
  if (!words.length) return hinted || 'en';
  const counts = new Map();
  for (const word of words) {
    for (const [code, list] of Object.entries(STOPWORDS)) {
      if (list.includes(word)) counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  let best = '';
  let score = 0;
  for (const [code, count] of counts) {
    if (count > score) { best = code; score = count; }
  }
  // Prefer the metadata hint when the sample is too short to be sure.
  if (score < 2 && hinted) return hinted;
  return best || hinted || 'en';
}

export function languageMatches(voiceLang = '', bookLang = '') {
  return baseTag(voiceLang) === baseTag(bookLang);
}
