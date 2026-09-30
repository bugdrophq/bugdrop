import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  escapeWidgetText,
  resolveLocale,
  setLocale,
  submissionErrorMessage,
  t,
} from '../src/widget/i18n';
import { de } from '../src/widget/locales/de';
import { en } from '../src/widget/locales/en';
import { nl } from '../src/widget/locales/nl';
import { pl } from '../src/widget/locales/pl';
import { zhCN } from '../src/widget/locales/zh-CN';

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
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
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

  it.each(['zh-CN', 'ZH_cn', 'zh-CN-u-nu-hanidec', 'zh-Hans', 'ZH_hANS_tw', 'zh-Hans-CN'])(
    'selects Simplified Chinese for %s',
    tag => {
      expect(resolveLocale(tag)).toBe('zh-CN');
    }
  );

  it.each(['zh', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-CN', 'zh_Hant_cn', 'zh-CN-', 'zh-Hans-!'])(
    'rejects unsupported Chinese tag %s',
    tag => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(resolveLocale(tag)).toBe('en');
      expect(warn).toHaveBeenCalledWith(
        `[BugDrop] Unsupported data-locale "${tag}"; falling back to English.`
      );
    }
  );

  it('falls back to English and warns for unsupported locales', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveLocale('fr')).toBe('en');

    expect(warn).toHaveBeenCalledWith(
      '[BugDrop] Unsupported data-locale "fr"; falling back to English.'
    );
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

    setLocale('zh-CN');
    expect(t()).toBe(zhCN);
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
    ['zh-CN', zhCN],
  ] as const)('%s has exactly the same keys as en', (_name, dictionary) => {
    expect(Object.keys(dictionary).sort()).toEqual(enKeys);
  });

  it.each([
    ['de', de],
    ['nl', nl],
    ['pl', pl],
    ['zh-CN', zhCN],
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
    expect(zhCN.issueCreated(issueLink).match(/<strong>#1<\/strong>/g)).toHaveLength(1);

    expect(en.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(de.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(nl.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(pl.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
    expect(zhCN.selectedElementNote(configLink).match(/<a href="#docs">/g)).toHaveLength(1);
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

    expect(zhCN.rateLimited(2)).toContain('2 分钟');
    expect(zhCN.redactionCountNote(2)).toContain('2 处私密内容');
  });

  it('keeps privacy caveats explicit in Simplified Chinese', () => {
    expect(zhCN.screenshotAutoNote).toContain('不会显示预览');
    expect(zhCN.screenshotAutoRedactionNote).toContain('未标记的敏感信息');
    expect(zhCN.viewportRedactionWarning).toContain('无法自动遮盖');
    expect(zhCN.maskFailureMessage).toContain('已丢弃此截图');
    expect(zhCN.redactionLimitationsNote).toContain('不会检查');
    expect(zhCN.annotationInstruction).toContain('遮盖效果会永久保留在上传的图片中');
    expect(zhCN.annotationInstruction).not.toContain('遮盖内容会永久写入');
  });

  it('uses the reviewed Chinese screenshot and authorization wording', () => {
    expect(zhCN.submissionErrors.AUTH_REQUIRED).toBe('授权失败。请刷新页面，或联系网站管理员。');
    expect(zhCN.captureScreenshotTitle).toBe('截图');
    expect(zhCN.capturingScreenshot).toBe('正在截图…');
    const link = '<a href="#docs">data-element-context-max-area</a>';
    expect(zhCN.selectedElementNote(link)).toBe(
      `需要在截图中包含更多周边内容？请调整 BugDrop 脚本标签中的 ${link}。`
    );
  });

  it('has a localized message for every stable failure code', () => {
    const codes = Object.keys(en.submissionErrors).sort();
    for (const dictionary of [de, nl, pl, zhCN]) {
      expect(Object.keys(dictionary.submissionErrors).sort()).toEqual(codes);
      for (const code of codes) {
        expect(dictionary.submissionErrors[code as keyof typeof en.submissionErrors]).toBeTruthy();
      }
    }
  });
});

describe('submissionErrorMessage', () => {
  it('uses localized actionable copy instead of raw server English', () => {
    setLocale('zh-CN');
    expect(submissionErrorMessage('AUTH_REQUIRED', 'BugDrop auth token required', 'zh-CN')).toBe(
      zhCN.submissionErrors.AUTH_REQUIRED
    );
    expect(submissionErrorMessage('INVALID_SCREENSHOT', 'Invalid screenshot format', 'zh-CN')).toBe(
      zhCN.submissionErrors.INVALID_SCREENSHOT
    );
  });

  it('uses generic localized copy for unknown and legacy errors', () => {
    setLocale('zh-CN');
    expect(submissionErrorMessage('NEW_SERVER_CODE', 'Raw English backend failure', 'zh-CN')).toBe(
      zhCN.submitFailedFallback
    );
    expect(submissionErrorMessage(undefined, 'Raw English backend failure', 'zh-CN')).toBe(
      zhCN.submitFailedFallback
    );
  });

  it('preserves existing English server error presentation', () => {
    expect(submissionErrorMessage('ISSUE_CREATION_FAILED', 'GitHub rejected labels', 'en')).toBe(
      'GitHub rejected labels'
    );
  });
});
