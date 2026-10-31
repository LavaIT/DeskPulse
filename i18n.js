// i18n.js —— shared localization module (main process + all renderer windows)
// Uses CommonJS so it can be required from main.js and from HTML pages that
// run with nodeIntegration enabled. No bundler is involved.

const zhCN = require('./locales/zh-CN.json');
const enUS = require('./locales/en-US.json');

const LOCALES = { zh: zhCN, en: enUS };
const DEFAULT_LANG = 'zh';

let _lang = DEFAULT_LANG;

// Normalize a language value to one of the supported codes.
function normalize(lang) {
  if (lang === 'en' || lang === 'en-US' || lang === 'en-GB') return 'en';
  if (lang === 'zh' || lang === 'zh-CN' || lang === 'zh-TW' || lang === 'zh-HK') return 'zh';
  return null;
}

// Guess the UI language from a system locale string (e.g. "en-US", "zh-CN").
function detectFromLocale(locale) {
  const value = String(locale || '').toLowerCase();
  return value.indexOf('zh') === 0 ? 'zh' : 'en';
}

// Resolve the effective language. A manual preference wins; otherwise follow
// the operating system locale.
function resolveLanguage(pref, systemLocale) {
  return normalize(pref) || detectFromLocale(systemLocale);
}

// Initialize with a preference ("auto" / "zh" / "en") and the system locale.
function init(pref, systemLocale) {
  _lang = resolveLanguage(pref, systemLocale);
  return _lang;
}

// Switch the language directly (used after the main process resolves it).
function setLanguage(lang) {
  const next = normalize(lang);
  if (next) _lang = next;
  return _lang;
}

function getLanguage() {
  return _lang;
}

// Return the full dictionary for the active language (for arrays such as
// weekday names, which cannot be expressed as plain strings).
function data() {
  return LOCALES[_lang] || LOCALES[DEFAULT_LANG];
}

// Look up a dot-separated key. Supports {placeholder} interpolation.
// Falls back to Chinese, then to the key itself, so missing entries never
// break the UI.
function t(key, vars) {
  let value = _lookup(LOCALES[_lang], key);
  if (typeof value !== 'string') value = _lookup(LOCALES[DEFAULT_LANG], key);
  if (typeof value !== 'string') return key;
  if (vars) {
    value = value.replace(/\{(\w+)\}/g, (match, name) => (
      vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match
    ));
  }
  return value;
}

function _lookup(dict, key) {
  let node = dict;
  const parts = String(key).split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!node) return undefined;
    node = node[parts[i]];
  }
  return node;
}

// Fill elements carrying data-i18n attributes. Safe to call repeatedly;
// language switches simply re-run it.
function applyDOM(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope) return;

  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const text = t(el.getAttribute('data-i18n-title'));
    el.title = text;
    el.setAttribute('aria-label', text);
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });

  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : 'en';
  }
}

module.exports = {
  init,
  setLanguage,
  getLanguage,
  resolveLanguage,
  detectFromLocale,
  normalize,
  data,
  t,
  applyDOM
};
