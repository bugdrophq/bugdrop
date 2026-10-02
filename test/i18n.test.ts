import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeWidgetText, resolveLocale, setLocale, t } from '../src/widget/i18n';
import { de } from '../src/widget/locales/de';
import { en } from '../src/widget/locales/en';
import { nl } from '../src/widget/locales/nl';
import { pl } from '../src/widget/locales/pl';

afterEach(() => {
  setLocale('en');
  vi.restoreAllMocks();
});

describe('resolveLocale', () => {
  it('resolves exactly matching supported locales', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('nl')).toBe('nl');
    expect(resolveLocale('pl')).toBe('pl');
  });

  it('resolves region subtags to the base language', () => {
    expect(resolveLocale('de-DE')).toBe('de');
    expect(resolveLocale('nl-NL')).toBe('nl');
    expect(resolveLocale('pl-PL')).toBe('pl');
    expect(resolveLocale('en-GB')).toBe('en');
  });

  it('resolves underscore region formats to the base language', () => {
    expect(resolveLocale('de_DE')).toBe('de');
    expect(resolveLocale('nl_NL')).toBe('nl');
    expect(resolveLocale('pl_PL')).toBe('pl');
  });

  it('is case-insensitive', () => {
    expect(resolveLocale('NL')).toBe('nl');
    expect(resolveLocale('Pl-pl')).toBe('pl');
    expect(resolveLocale('EN-us')).toBe('en');
    expect(resolveLocale('DE-de')).toBe('de');
  });

  it('falls back to English and warns for unsupported locales', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveLocale('fr')).toBe('en');

    expect(warn).toHaveBeenCalledWith(
      '[BugDrop] Unsupported data-locale "fr"; falling back to English.'
    );
  });

  it('keeps Simplified Chinese unavailable until its release', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveLocale('zh-CN')).toBe('en');
    expect(resolveLocale('zh-Hans')).toBe('en');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falls back to English without warning when no locale is provided', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('')).toBe('en');

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('setLocale and t', () => {
  it('defaults to the English dictionary', () => {
    expect(t()).toBe(en);
  });

  it('switches the active dictionary', () => {
    setLocale('de');
    expect(t()).toBe(de);

    setLocale('nl');
    expect(t()).toBe(nl);

    setLocale('pl');
    expect(t()).toBe(pl);
  });
});

describe('escapeWidgetText', () => {
  it('escapes translated text before insertion into HTML templates or attributes', () => {
    expect(escapeWidgetText('Save "draft" & <retry>')).toBe(
      'Save &quot;draft&quot; &amp; &lt;retry&gt;'
    );
  });
});

describe('locale dictionaries', () => {
  const enKeys = Object.keys(en).sort();

  it.each([
    ['de', de],
    ['nl', nl],
    ['pl', pl],
  ] as const)('%s has exactly the same keys as en', (_name, dictionary) => {
    expect(Object.keys(dictionary).sort()).toEqual(enKeys);
  });

  it.each([
    ['de', de],
    ['nl', nl],
    ['pl', pl],
  ] as const)('%s entries have the same type as their en counterparts', (_name, dictionary) => {
    for (const key of enKeys) {
      expect(typeof dictionary[key as keyof typeof en]).toBe(typeof en[key as keyof typeof en]);
    }
  });

  it('preserves trusted HTML placeholders exactly once in rich messages', () => {
    const issueLink = '<strong>#1</strong>';
    const configLink = '<a href="#docs">data-element-context-max-area</a>';

    expect(en.issueCreated(issueLink)).toBe(`Issue ${issueLink} has been created.`);
    expect(de.issueCreated(issueLink).match(/<strong>#1<\/strong>/g)).toHaveLength(1);
    expect(nl.issueCreated(issueLink).match(/<strong>#1<\/strong>/g)).toHaveLength(1);
    expect(pl.issueCreated(issueLink).match(/<strong>#1<\/strong>/g)).toHaveLength(1);

    expect(en.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(de.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(nl.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(pl.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
  });

  it('formats count-sensitive messages for singular and plural boundaries', () => {
    expect(en.rateLimited(1)).toContain('1 minute.');
    expect(en.rateLimited(2)).toContain('2 minutes.');

    expect(de.rateLimited(1)).toContain('1 Minute ');
    expect(de.rateLimited(2)).toContain('2 Minuten ');

    expect(de.redactionCountNote(1)).toContain('1 privates Element');
    expect(de.redactionCountNote(2)).toContain('2 private Elemente');

    expect(nl.redactionCountNote(1)).toContain('1 privé-item');
    expect(nl.redactionCountNote(2)).toContain('2 privé-items');

    expect(pl.rateLimited(1)).toContain('1 minutę');
    expect(pl.rateLimited(2)).toContain('2 minuty');
    expect(pl.rateLimited(5)).toContain('5 minut');
    expect(pl.rateLimited(12)).toContain('12 minut');
    expect(pl.rateLimited(22)).toContain('22 minuty');
  });
});
