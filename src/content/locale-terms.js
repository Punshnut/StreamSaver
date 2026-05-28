/**
 * locale-terms.js
 *
 * All UI text strings the content script searches for in Twitch's player menus,
 * organised by language. Add a new locale block here to support an additional
 * Twitch UI language — no other file needs to change.
 *
 * CORE_LOCALES covers all 12 languages Twitch natively supports in its UI.
 *
 * Each locale entry has these optional keys (omit a key if the language reuses
 * an English term or if the term simply doesn't exist in that language):
 *
 *   source           – labels for the highest native bitrate option (e.g. "Source", "Quelle")
 *   auto             – labels for the automatic quality option (e.g. "Auto", "Automatisch")
 *   qualityEntry     – labels that identify the quality row inside the settings panel
 *   settingsTrigger  – labels for the gear / settings button that opens the panel
 *   settingsQuality  – labels for the quality group inside the settings submenu
 *   settingsSubtitles – labels for the subtitles group
 *   settingsAdvanced – labels for the advanced group
 *   settingsClose    – labels for the close button of the settings panel
 *   settingsBack     – labels for the back button inside the settings panel
 */

// ---------------------------------------------------------------------------
// Per-locale term definitions
// ---------------------------------------------------------------------------

const TERMS_BY_LOCALE = {
  // English (Twitch default)
  en: {
    source:            ['source', 'chunked'],
    auto:              ['auto'],
    qualityEntry:      ['quality', 'video quality', 'resolution'],
    settingsTrigger:   ['settings'],
    settingsQuality:   ['quality', 'resolution'],
    settingsSubtitles: ['subtitles'],
    settingsAdvanced:  ['advanced'],
    settingsClose:     ['close'],
    settingsBack:      ['back', 'go back'],
  },

  // German / Deutsch
  de: {
    source:            ['quelle'],
    auto:              ['automatisch'],
    qualityEntry:      ['qualität', 'auflösung'],
    settingsTrigger:   ['einstellungen'],
    settingsQuality:   ['qualität', 'auflösung'],
    settingsSubtitles: ['untertitel'],
    settingsAdvanced:  ['erweitert'],
    settingsClose:     ['schließen', 'schliessen'],
    settingsBack:      ['zurück', 'zurueck'],
  },

  // French / Français
  fr: {
    source:            ['source'],
    auto:              ['automatique'],
    qualityEntry:      ['qualité', 'résolution'],
    settingsTrigger:   ['paramètres', 'parametres'],
    settingsQuality:   ['qualité', 'résolution'],
    settingsSubtitles: ['sous-titres'],
    settingsAdvanced:  ['avancé', 'avance'],
    settingsClose:     ['fermer'],
    settingsBack:      ['retour'],
  },

  // Spanish / Español
  es: {
    source:            ['fuente'],
    auto:              ['automático', 'automatico'],
    qualityEntry:      ['calidad', 'resolución', 'resolucion'],
    settingsTrigger:   ['configuración', 'configuracion', 'ajustes'],
    settingsQuality:   ['calidad', 'resolución', 'resolucion'],
    settingsSubtitles: ['subtítulos', 'subtitulos'],
    settingsAdvanced:  ['avanzado'],
    settingsClose:     ['cerrar'],
    settingsBack:      ['volver', 'atrás', 'atras'],
  },

  // Portuguese / Português
  pt: {
    source:            ['fonte'],
    auto:              ['automático', 'automatico'],
    qualityEntry:      ['qualidade', 'resolução', 'resolucao'],
    settingsTrigger:   ['configurações', 'configuracoes'],
    settingsQuality:   ['qualidade', 'resolução', 'resolucao'],
    settingsSubtitles: ['legendas'],
    settingsAdvanced:  ['avançado', 'avancado'],
    settingsClose:     ['fechar'],
    settingsBack:      ['voltar'],
  },

  // Italian / Italiano
  it: {
    source:            ['sorgente'],
    auto:              ['automatico'],
    qualityEntry:      ['qualità', 'qualita', 'risoluzione'],
    settingsTrigger:   ['impostazioni'],
    settingsQuality:   ['qualità', 'qualita', 'risoluzione'],
    settingsSubtitles: ['sottotitoli'],
    settingsAdvanced:  ['avanzate'],
    settingsClose:     ['chiudi'],
    settingsBack:      ['indietro'],
  },

  // Russian / Русский
  ru: {
    auto:              ['авто'],
    qualityEntry:      ['качество'],
    settingsTrigger:   ['настройки'],
    settingsQuality:   ['качество'],
    settingsSubtitles: ['субтитры'],
    settingsAdvanced:  ['дополнительно'],
    settingsClose:     ['закрыть'],
    settingsBack:      ['назад'],
  },

  // Japanese / 日本語
  ja: {
    source:            ['ソース'],
    auto:              ['自動'],
    qualityEntry:      ['画質', '解像度'],
    settingsTrigger:   ['設定'],
    settingsQuality:   ['画質', '解像度'],
    settingsSubtitles: ['字幕'],
    settingsAdvanced:  ['詳細設定', '詳細'],
    settingsClose:     ['閉じる'],
    settingsBack:      ['戻る'],
  },

  // Simplified Chinese / 简体中文
  'zh-CN': {
    source:            ['原始', '源'],
    auto:              ['自动'],
    qualityEntry:      ['画质', '分辨率'],
    settingsTrigger:   ['设置'],
    settingsQuality:   ['画质', '分辨率'],
    settingsSubtitles: ['字幕'],
    settingsAdvanced:  ['高级'],
    settingsClose:     ['关闭'],
    settingsBack:      ['返回', '后退'],
  },

  // Bahasa Indonesia
  id: {
    source:            ['sumber'],
    auto:              ['otomatis'],
    qualityEntry:      ['kualitas', 'resolusi'],
    settingsTrigger:   ['pengaturan'],
    settingsQuality:   ['kualitas', 'resolusi'],
    settingsSubtitles: ['teks'],
    settingsAdvanced:  ['lanjutan'],
    settingsClose:     ['tutup'],
    settingsBack:      ['kembali'],
  },

  // Danish / Dansk
  da: {
    source:            ['kilde'],
    auto:              ['automatisk'],
    qualityEntry:      ['kvalitet', 'opløsning', 'oplosning'],
    settingsTrigger:   ['indstillinger'],
    settingsQuality:   ['kvalitet', 'opløsning', 'oplosning'],
    settingsSubtitles: ['undertekster'],
    settingsAdvanced:  ['avanceret'],
    settingsClose:     ['luk'],
    settingsBack:      ['tilbage'],
  },

  // Ukrainian / Українська  (beta)  TODO: verify against live Twitch Ukrainian UI
  uk: {
    source:            ['джерело'],
    auto:              ['авто'],
    qualityEntry:      ['якість', 'роздільна здатність'],
    settingsTrigger:   ['налаштування'],
    settingsQuality:   ['якість'],
    settingsSubtitles: ['субтитри'],
    settingsAdvanced:  ['розширені'],
    settingsClose:     ['закрити'],
    settingsBack:      ['назад', 'повернутися'],
  },
};

// ---------------------------------------------------------------------------
// Active locale set — all 12 Twitch-native UI languages
// ---------------------------------------------------------------------------

export const CORE_LOCALES = ['en', 'de', 'fr', 'es', 'pt', 'it', 'ru', 'ja', 'zh-CN', 'id', 'da', 'uk'];

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeKey(key, locales) {
  const seen = new Set();
  const out = [];
  for (const locale of locales) {
    for (const term of TERMS_BY_LOCALE[locale]?.[key] ?? []) {
      if (!seen.has(term)) { seen.add(term); out.push(term); }
    }
  }
  return out;
}

/** @param {string[]} locales */
export function buildTermsForLocales(locales) {
  return {
    SOURCE_TERMS:              mergeKey('source',            locales),
    AUTO_TERMS:                mergeKey('auto',              locales),
    QUALITY_ENTRY_TERMS:       mergeKey('qualityEntry',      locales),
    SETTINGS_TRIGGER_TERMS:    mergeKey('settingsTrigger',   locales),
    SETTINGS_MENU_LABEL_GROUPS: {
      quality:   mergeKey('settingsQuality',   locales),
      subtitles: mergeKey('settingsSubtitles', locales),
      advanced:  mergeKey('settingsAdvanced',  locales),
    },
    SETTINGS_MENU_CLOSE_TERMS: mergeKey('settingsClose', locales),
    SETTINGS_MENU_BACK_TERMS:  mergeKey('settingsBack',  locales),
  };
}

// ---------------------------------------------------------------------------
// Default exports — built from core locales, consumed by constants.js
// ---------------------------------------------------------------------------

const _terms = buildTermsForLocales(CORE_LOCALES);

export const SOURCE_TERMS              = _terms.SOURCE_TERMS;
export const AUTO_TERMS                = _terms.AUTO_TERMS;
export const QUALITY_ENTRY_TERMS       = _terms.QUALITY_ENTRY_TERMS;
export const SETTINGS_TRIGGER_TERMS    = _terms.SETTINGS_TRIGGER_TERMS;
export const SETTINGS_MENU_LABEL_GROUPS = _terms.SETTINGS_MENU_LABEL_GROUPS;
export const SETTINGS_MENU_CLOSE_TERMS = _terms.SETTINGS_MENU_CLOSE_TERMS;
export const SETTINGS_MENU_BACK_TERMS  = _terms.SETTINGS_MENU_BACK_TERMS;

export { TERMS_BY_LOCALE };
