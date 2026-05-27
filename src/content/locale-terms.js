/**
 * locale-terms.js
 *
 * All UI text strings the content script searches for in Twitch's player menus,
 * organised by language. Add a new locale block here to support an additional
 * Twitch UI language — no other file needs to change.
 *
 * Structure
 * ---------
 * CORE_LOCALES   — always active (en + de ship by default)
 * EXTENDED_LOCALES — currently unused; reserved for a future "rare languages" setting
 *                   that the user can toggle on in the popup
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

  // Italian / Italiano  (extended — not active by default)
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

  // Polish / Polski  (extended — not active by default)
  pl: {
    source:            ['źródło', 'zrodlo'],
    auto:              ['automatyczna', 'auto'],
    qualityEntry:      ['jakość', 'jakosc'],
    settingsTrigger:   ['ustawienia'],
    settingsQuality:   ['jakość', 'jakosc'],
    settingsSubtitles: ['napisy'],
    settingsAdvanced:  ['zaawansowane'],
    settingsClose:     ['zamknij'],
    settingsBack:      ['wstecz'],
  },

  // Russian / Русский  (extended — not active by default)
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
};

// ---------------------------------------------------------------------------
// Active locale sets
// ---------------------------------------------------------------------------

/** Always-on languages. Covers the vast majority of Twitch users. */
export const CORE_LOCALES = ['en', 'de', 'fr', 'es', 'pt'];

/**
 * Opt-in languages for future "enable rare languages" setting.
 * Currently unused — reserved so the infrastructure is ready.
 */
export const EXTENDED_LOCALES = ['it', 'pl', 'ru'];

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

/**
 * Build the flat term arrays used by the rest of the content script from a
 * given set of active locale codes. Pass [...CORE_LOCALES, ...EXTENDED_LOCALES]
 * when the user enables the "rare languages" setting in the future.
 *
 * @param {string[]} locales
 */
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
