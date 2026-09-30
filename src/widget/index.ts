import { getDomNodeCount, getRedactionCount, isFullPageDisabled } from './screenshot';
import { runScreenshotCaptureFlow } from './capture-flow';
import { injectStyles, createModal, showSuccessModal, type IssueLinkVisibility } from './ui';
import {
  resolveTheme,
  applyThemeClass,
  applyCustomStyles,
  attachSystemThemeListener,
  isValidTheme,
  type ThemeMode,
} from './theme';
import {
  escapeHtml,
  sanitizeCssColor,
  sanitizeCssFontFamily,
  sanitizeNonNegativeNumber,
  sanitizeNonNegativePixelValue,
  sanitizePositiveInteger,
  sanitizeShadowPreset,
  sanitizeUrl,
} from './sanitize';
import {
  getAuthHeaders,
  resolveAuthTokenProvider,
  type BugDropAuthTokenProvider,
} from './auth-token';
import {
  getConsoleLogSnapshot,
  startConsoleLogCapture,
  type ConsoleLogEntry,
} from './console-logs';
import { escapeWidgetText, resolveLocale, setLocale, t, type SupportedLocale } from './i18n';
import { installRadixDialogCompatibility } from './radix-compat';
import { closeActiveVariantModal } from './variants/modal-coordinator';
import { resolveAccentColor } from '../defaults';
import type { BugDropPublicAPI } from './variants/public-types';
import { createVariantManager, type VariantManager } from './variants/manager';
import { runDefaultJourney } from './default-flow/runtime';
import { normalizeDefaultDefinition } from './default-flow/definition';
import { createFlowManager, type FlowManager } from './flows/manager';
import { parseAppVersion } from '../app-version';
import { getPrefill, type BugDropPrefill } from './prefill';

declare const __BUGDROP_ENABLE_TEST_HOOKS__: boolean;
declare const __BUGDROP_DEFAULT_FLOW_RUNTIME__: 'fixed' | 'private';

type FeedbackCategory = 'bug' | 'feature' | 'question';
type CategoryLabelConfig = Partial<Record<FeedbackCategory, string | string[]>>;
type FeedbackAttachment = {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

interface WidgetConfig {
  repo: string;
  apiUrl: string;
  authTokenProvider?: BugDropAuthTokenProvider;
  prefillProviderName?: string;
  appVersion?: string;
  position: 'bottom-right' | 'bottom-left';
  theme: 'light' | 'dark' | 'auto';
  // Name/email field configuration
  showName: boolean;
  requireName: boolean;
  showEmail: boolean;
  requireEmail: boolean;
  // Dismissible button configuration
  buttonDismissible: boolean;
  dismissDuration?: number; // Days before dismissed button reappears (undefined = forever)
  showRestore: boolean; // Show a pull tab after dismissing (default true when dismissible)
  // Button visibility (false = API-only mode)
  showButton: boolean;
  // Custom accent color (hex)
  accentColor?: string;
  // Custom icon URL (replaces default bug emoji), or 'none' to hide the icon
  iconUrl?: string;
  // Custom trigger button label text; defaults to the active locale's triggerLabel
  label?: string;
  // Optional mapping from built-in feedback categories to GitHub labels
  categoryLabels?: CategoryLabelConfig;
  // Tier 1 styling customization
  font?: string; // 'inherit' to use host page font, or a custom font-family string
  radius?: string; // Border radius in px (e.g., '0', '8', '16')
  bgColor?: string; // Background color override (e.g., '#fffef0')
  textColor?: string; // Text color override (e.g., '#1a1a1a')
  // Tier 2 styling customization
  borderWidth?: string; // Border width in px (e.g., '4')
  borderColor?: string; // Border color (e.g., '#1a1a1a')
  shadow?: string; // Shadow preset: 'none', 'soft' (default), 'hard'
  // Welcome screen behavior
  welcome: 'once' | 'always' | 'never';
  // Screenshot configuration
  screenshotMode: 'optional' | 'auto' | 'required';
  screenshotScale?: number; // Minimum pixel ratio for captures (default: 2)
  maxScreenshotSizeBytes?: number;
  elementContextMaxArea?: number; // Max ancestor capture area as a viewport multiplier
  issueLinkVisibility: IssueLinkVisibility;
  sendConsoleLogs: boolean;
  // UI language for widget texts
  locale: SupportedLocale;
}

// Declare global BugDrop API
declare global {
  interface Window {
    BugDrop?: BugDropPublicAPI;
  }
}

interface FeedbackData {
  title: string;
  description: string;
  category: FeedbackCategory;
  screenshot: string | null;
  attachments: FeedbackAttachment[];
  elementSelector: string | null;
  fullElementSelector: string | null;
  selectedElementHighlightColor: string | null;
  sendConsoleLogs: boolean;
  name?: string;
  email?: string;
}

// localStorage key for dismissed state
const BUGDROP_DISMISSED_KEY = 'bugdrop_dismissed';
const BUGDROP_TRIGGER_POSITION_PREFIX = 'bugdrop_trigger_position_';
const BUGDROP_WELCOMED_PREFIX = 'bugdrop_welcomed_';
const BUGDROP_COMPLEX_SCREENSHOT_SKIPPED_PREFIX = 'bugdrop_complex_screenshot_skipped_';
const COMPLEX_SCREENSHOT_SKIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRIGGER_VIEWPORT_MARGIN_PX = 8;
const TRIGGER_KEYBOARD_MOVE_PX = 16;
const MAX_UPLOAD_FILES = 5;
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_UPLOAD_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

// Parse user agent to extract browser info
function parseBrowser(ua: string): { name: string; version: string } {
  // Order matters - check more specific patterns first
  const browsers: Array<{ name: string; pattern: RegExp }> = [
    { name: 'Edge', pattern: /Edg(?:e|A|iOS)?\/(\d+[\d.]*)/ },
    { name: 'Opera', pattern: /(?:OPR|Opera)\/(\d+[\d.]*)/ },
    { name: 'Chrome', pattern: /Chrome\/(\d+[\d.]*)/ },
    { name: 'Safari', pattern: /Version\/(\d+[\d.]*).*Safari/ },
    { name: 'Firefox', pattern: /Firefox\/(\d+[\d.]*)/ },
  ];

  for (const { name, pattern } of browsers) {
    const match = ua.match(pattern);
    if (match) {
      return { name, version: match[1] || 'unknown' };
    }
  }

  return { name: 'Unknown', version: 'unknown' };
}

// Parse user agent to extract OS info
function parseOS(ua: string): { name: string; version: string } {
  const osPatterns: Array<{ name: string; pattern: RegExp; versionIndex?: number }> = [
    { name: 'iOS', pattern: /iPhone OS (\d+[_\d]*)/, versionIndex: 1 },
    { name: 'iOS', pattern: /iPad.*OS (\d+[_\d]*)/, versionIndex: 1 },
    { name: 'macOS', pattern: /Mac OS X (\d+[_.\d]*)/, versionIndex: 1 },
    { name: 'Windows', pattern: /Windows NT (\d+\.\d+)/, versionIndex: 1 },
    { name: 'Android', pattern: /Android (\d+[\d.]*)/, versionIndex: 1 },
    { name: 'Linux', pattern: /Linux/, versionIndex: undefined },
    { name: 'Chrome OS', pattern: /CrOS/, versionIndex: undefined },
  ];

  for (const { name, pattern, versionIndex } of osPatterns) {
    const match = ua.match(pattern);
    if (match) {
      const version =
        versionIndex !== undefined && match[versionIndex]
          ? match[versionIndex].replace(/_/g, '.')
          : '';
      return { name, version };
    }
  }

  return { name: 'Unknown', version: '' };
}

// Redact sensitive parts of URL (query params, common ID patterns)
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove query string and hash
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // If URL parsing fails, return as-is but try to strip query params
    return url.split('?')[0].split('#')[0];
  }
}

// Collect system info for feedback submission
function getSystemInfo(): {
  browser: { name: string; version: string };
  os: { name: string; version: string };
  devicePixelRatio: number;
  language: string;
  url: string;
} {
  const ua = navigator.userAgent;
  return {
    browser: parseBrowser(ua),
    os: parseOS(ua),
    devicePixelRatio: window.devicePixelRatio || 1,
    language: navigator.language || 'unknown',
    url: redactUrl(window.location.href),
  };
}

// Store widget state for API access
let _widgetRoot: HTMLElement | null = null;
let _triggerButton: HTMLElement | null = null;
let _pullTab: HTMLElement | null = null;
let _isModalOpen = false;
let _widgetConfig: WidgetConfig | null = null;
let _triggerDragMoved = false;

// Helper to check if button was dismissed
function isButtonDismissed(dismissDuration?: number): boolean {
  try {
    const dismissedAt = localStorage.getItem(BUGDROP_DISMISSED_KEY);
    if (!dismissedAt) return false;

    // Legacy support: if stored value is 'true', treat as permanently dismissed
    if (dismissedAt === 'true') return true;

    const timestamp = parseInt(dismissedAt, 10);
    if (isNaN(timestamp)) return false;

    // If no duration set, dismissed forever
    if (dismissDuration === undefined) return true;

    // Check if duration has passed (duration is in days)
    const durationMs = dismissDuration * 24 * 60 * 60 * 1000;
    return Date.now() - timestamp < durationMs;
  } catch {
    // localStorage may be blocked in some contexts
    return false;
  }
}

// Helper to dismiss the button
function dismissButton(): void {
  try {
    localStorage.setItem(BUGDROP_DISMISSED_KEY, Date.now().toString());
  } catch {
    // localStorage may be blocked in some contexts
  }
}

function hasSeenWelcome(repo: string): boolean {
  try {
    return localStorage.getItem(BUGDROP_WELCOMED_PREFIX + repo) !== null;
  } catch {
    return false;
  }
}

function markWelcomeSeen(repo: string): void {
  try {
    localStorage.setItem(BUGDROP_WELCOMED_PREFIX + repo, Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}

function getComplexScreenshotSkipKey(repo: string): string {
  return `${BUGDROP_COMPLEX_SCREENSHOT_SKIPPED_PREFIX}${repo}:${redactUrl(window.location.href)}`;
}

function hasSkippedComplexScreenshots(repo: string): boolean {
  try {
    const key = getComplexScreenshotSkipKey(repo);
    const skippedAt = localStorage.getItem(key);
    if (!skippedAt) return false;

    const timestamp = parseInt(skippedAt, 10);
    if (isNaN(timestamp) || Date.now() - timestamp > COMPLEX_SCREENSHOT_SKIP_TTL_MS) {
      localStorage.removeItem(key);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function markComplexScreenshotsSkipped(repo: string): void {
  try {
    localStorage.setItem(getComplexScreenshotSkipKey(repo), Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}

function clearComplexScreenshotsSkipped(repo: string): void {
  try {
    localStorage.removeItem(getComplexScreenshotSkipKey(repo));
  } catch {
    // localStorage may be blocked
  }
}

function rememberComplexScreenshotSkip(config: WidgetConfig, formResult: FeedbackFormResult): void {
  if (!isFullPageDisabled()) return;
  markComplexScreenshotsSkipped(config.repo);
  formResult.includeScreenshot = false;
}

function parseCategoryLabels(rawValue: string | undefined): CategoryLabelConfig | undefined {
  if (!rawValue) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    console.warn(
      `[BugDrop] Invalid data-category-labels JSON${detail}. Using default GitHub labels.`
    );
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      '[BugDrop] Invalid data-category-labels: expected a JSON object. Using default GitHub labels.'
    );
    return undefined;
  }

  // Validate per-category shape so misconfig surfaces in browser DevTools rather
  // than only inside the issue body the operator may never read. The server
  // re-validates regardless — this layer exists for operator feedback.
  const knownCategories: FeedbackCategory[] = ['bug', 'feature', 'question'];
  const result: CategoryLabelConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!knownCategories.includes(key as FeedbackCategory)) {
      console.warn(
        `[BugDrop] Invalid data-category-labels: unknown category "${key}" (expected ${knownCategories.join(', ')}). Ignoring.`
      );
      continue;
    }
    if (typeof value === 'string') {
      result[key as FeedbackCategory] = value;
    } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      result[key as FeedbackCategory] = value;
    } else {
      console.warn(
        `[BugDrop] Invalid data-category-labels: value for "${key}" must be a string or string array. Ignoring.`
      );
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Read config from script tag (fallback to src-based lookup for async/defer)
const script = (document.currentScript ||
  document.querySelector('script[src*="bugdrop"][src*="widget"]')) as HTMLScriptElement;
if (!document.currentScript) {
  console.warn(
    '[BugDrop] document.currentScript is null — do not use async or defer on the BugDrop script tag.'
  );
}
const rawTheme = script?.dataset.theme;
if (rawTheme && !isValidTheme(rawTheme)) {
  console.warn(`[BugDrop] Invalid data-theme "${rawTheme}". Expected "light", "dark", or "auto".`);
}
const locale = resolveLocale(script?.dataset.locale || document.documentElement.lang);
const requireName = script?.dataset.requireName === 'true';
const requireEmail = script?.dataset.requireEmail === 'true';
const rawPosition = script?.dataset.position;
if (rawPosition && rawPosition !== 'bottom-right' && rawPosition !== 'bottom-left') {
  console.warn(
    `[BugDrop] Invalid data-position "${rawPosition}". Expected "bottom-right" or "bottom-left".`
  );
}
const rawDismissDuration = script?.dataset.dismissDuration;
const dismissDuration = sanitizePositiveInteger(rawDismissDuration);
if (rawDismissDuration && dismissDuration === undefined) {
  console.warn(
    '[BugDrop] Invalid data-dismiss-duration. Expected a positive whole number of days.'
  );
}
const rawScreenshotScale = script?.dataset.screenshotScale;
const screenshotScale = sanitizeNonNegativeNumber(rawScreenshotScale);
if (rawScreenshotScale && screenshotScale === undefined) {
  console.warn('[BugDrop] Invalid data-screenshot-scale. Expected a non-negative number.');
}
const rawElementContextMaxArea = script?.dataset.elementContextMaxArea;
const elementContextMaxArea = sanitizeNonNegativeNumber(rawElementContextMaxArea);
if (rawElementContextMaxArea && elementContextMaxArea === undefined) {
  console.warn('[BugDrop] Invalid data-element-context-max-area. Expected a non-negative number.');
}
const rawShadow = script?.dataset.shadow;
const shadow = sanitizeShadowPreset(rawShadow);
if (rawShadow && !shadow) {
  console.warn('[BugDrop] Invalid data-shadow. Expected "soft", "hard", or "none".');
}
const rawShowIssueLink = script?.dataset.showIssueLink;
const issueLinkVisibility: IssueLinkVisibility =
  rawShowIssueLink === 'always' || rawShowIssueLink === 'never' ? rawShowIssueLink : 'public';
if (rawShowIssueLink && rawShowIssueLink !== 'public' && rawShowIssueLink !== issueLinkVisibility) {
  console.warn(
    `[BugDrop] Invalid data-show-issue-link "${rawShowIssueLink}". Expected "public", "always", or "never".`
  );
}
const rawAppVersion = script?.dataset.appVersion;
const appVersion = parseAppVersion(rawAppVersion);
if (rawAppVersion !== undefined && appVersion === undefined) {
  console.warn('[BugDrop] Invalid data-app-version. Expected 1 to 128 printable characters.');
}
const config: WidgetConfig = {
  repo: script?.dataset.repo || '',
  apiUrl: script?.src.replace(/\/widget(?:\.v[\d.]+)?\.js$/, '/api') || '',
  authTokenProvider: resolveAuthTokenProvider(script?.dataset.authTokenProvider),
  prefillProviderName: script?.dataset.prefillProvider,
  appVersion,
  position: rawPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right',
  theme: isValidTheme(rawTheme) ? rawTheme : 'auto', // Default to auto-detection
  // Name/email field configuration (all default to false for backwards compatibility)
  showName: script?.dataset.showName === 'true' || requireName,
  requireName,
  showEmail: script?.dataset.showEmail === 'true' || requireEmail,
  requireEmail,
  // Dismissible button configuration
  buttonDismissible: script?.dataset.buttonDismissible === 'true',
  dismissDuration,
  // Show restore pill after dismissing (default true when dismissible, unless explicitly false)
  showRestore: script?.dataset.showRestore !== 'false',
  // Button visibility (default true, set to false for API-only mode)
  showButton: script?.dataset.button !== 'false',
  // Custom accent color (e.g., "#FF6B35")
  accentColor: sanitizeCssColor(script?.dataset.color),
  // Custom icon URL (or 'none' to hide)
  iconUrl: sanitizeUrl(script?.dataset.icon),
  // Custom trigger label
  label: script?.dataset.label || undefined,
  categoryLabels: parseCategoryLabels(script?.dataset.categoryLabels),
  // Tier 1 styling customization
  font: sanitizeCssFontFamily(script?.dataset.font),
  radius: sanitizeNonNegativePixelValue(script?.dataset.radius)?.toString(),
  bgColor: sanitizeCssColor(script?.dataset.bg),
  textColor: sanitizeCssColor(script?.dataset.text),
  // Tier 2 styling customization
  borderWidth: sanitizeNonNegativePixelValue(script?.dataset.borderWidth)?.toString(),
  borderColor: sanitizeCssColor(script?.dataset.borderColor),
  shadow,
  // Welcome screen behavior (default: 'once')
  welcome: (() => {
    const val = script?.dataset.welcome;
    if (val === 'false' || val === 'never') return 'never' as const;
    if (val === 'always') return 'always' as const;
    return 'once' as const;
  })(),
  // Screenshot configuration
  screenshotMode: (() => {
    const val = script?.dataset.screenshot;
    if (val === 'auto' || val === 'required') return val;
    if (val && val !== 'optional') {
      console.warn(
        `[BugDrop] Invalid data-screenshot "${val}". Expected "optional", "auto", or "required".`
      );
    }
    return 'optional' as const;
  })(),
  screenshotScale,
  elementContextMaxArea,
  issueLinkVisibility,
  sendConsoleLogs: script?.dataset.sendConsoleLogs === 'true',
  locale,
};

setLocale(config.locale);

startConsoleLogCapture();

// Validate config
if (!config.repo) {
  console.error('[BugDrop] Missing data-repo attribute');
} else if (!/^[^/]+\/[^/]+$/.test(config.repo)) {
  console.error(
    `[BugDrop] Invalid data-repo format "${config.repo}". Expected "owner/repo" (e.g., "octocat/hello-world").`
  );
} else {
  initWidget(config);
}

// Build the trigger button label text
function getTriggerLabel(config: WidgetConfig): string {
  return config.label !== undefined ? config.label : t().triggerLabel;
}

function appendTriggerContent(trigger: HTMLElement, config: WidgetConfig): void {
  if (config.position === 'bottom-left') {
    trigger.appendChild(createTriggerDragHandle());
  }

  if (config.iconUrl !== 'none') {
    const icon = document.createElement('span');
    icon.className = 'bd-trigger-icon';

    if (config.iconUrl) {
      const image = document.createElement('img');
      image.src = config.iconUrl;
      image.alt = '';
      const fallback = document.createElement('span');
      fallback.textContent = '🐛';
      fallback.style.display = 'none';
      image.addEventListener('error', () => {
        image.style.display = 'none';
        fallback.style.display = '';
      });
      icon.append(image, fallback);
    } else {
      icon.textContent = '🐛';
    }

    trigger.appendChild(icon);
  }

  const label = document.createElement('span');
  label.className = 'bd-trigger-label';
  label.textContent = getTriggerLabel(config);
  trigger.appendChild(label);

  if (config.position !== 'bottom-left') {
    trigger.appendChild(createTriggerDragHandle());
  }
}

function createTriggerDragHandle(): HTMLElement {
  const handle = document.createElement('span');
  handle.className = 'bd-trigger-drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.title = t().dragHandleTitle;
  handle.innerHTML = `
    <svg viewBox="0 0 12 24" aria-hidden="true" focusable="false">
      <circle cx="4" cy="5" r="1.5" fill="currentColor"></circle>
      <circle cx="8" cy="5" r="1.5" fill="currentColor"></circle>
      <circle cx="4" cy="9.5" r="1.5" fill="currentColor"></circle>
      <circle cx="8" cy="9.5" r="1.5" fill="currentColor"></circle>
      <circle cx="4" cy="14" r="1.5" fill="currentColor"></circle>
      <circle cx="8" cy="14" r="1.5" fill="currentColor"></circle>
      <circle cx="4" cy="18.5" r="1.5" fill="currentColor"></circle>
      <circle cx="8" cy="18.5" r="1.5" fill="currentColor"></circle>
    </svg>
  `;
  return handle;
}

function getTriggerClassName(config: WidgetConfig, isRestoring = false): string {
  const classes = [
    'bd-trigger',
    `bd-trigger--${config.position === 'bottom-left' ? 'left' : 'right'}`,
  ];
  if (isRestoring) classes.push('bd-trigger--restoring');
  return classes.join(' ');
}

function getTriggerPositionKey(config: WidgetConfig): string {
  return `${BUGDROP_TRIGGER_POSITION_PREFIX}${config.repo}_${config.position}`;
}

function getStoredTriggerTop(config: WidgetConfig): number | null {
  try {
    const raw = localStorage.getItem(getTriggerPositionKey(config));
    if (!raw) return null;

    const top = Number(raw);
    return Number.isFinite(top) ? top : null;
  } catch {
    return null;
  }
}

function saveTriggerTop(config: WidgetConfig, top: number): void {
  try {
    localStorage.setItem(getTriggerPositionKey(config), String(Math.round(top)));
  } catch {
    // localStorage may be blocked
  }
}

function clampTriggerTop(trigger: HTMLElement, top: number): number {
  const rect = trigger.getBoundingClientRect();
  const maxTop = Math.max(
    TRIGGER_VIEWPORT_MARGIN_PX,
    window.innerHeight - rect.height - TRIGGER_VIEWPORT_MARGIN_PX
  );
  return Math.min(Math.max(top, TRIGGER_VIEWPORT_MARGIN_PX), maxTop);
}

function setTriggerTop(trigger: HTMLElement, top: number): number {
  const clampedTop = clampTriggerTop(trigger, top);
  trigger.style.top = `${clampedTop}px`;
  trigger.style.bottom = 'auto';
  return clampedTop;
}

function applyStoredTriggerPosition(trigger: HTMLElement, config: WidgetConfig): void {
  const top = getStoredTriggerTop(config);
  if (top === null) return;
  trigger.classList.add('bd-trigger--positioned');
  setTriggerTop(trigger, top);
}

function reclampVisibleTriggerPosition(trigger: HTMLElement, config: WidgetConfig): void {
  if (!trigger.style.top) return;

  const rect = trigger.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const renderedTop = parseFloat(trigger.style.top);
  if (!Number.isFinite(renderedTop)) return;

  const desiredTop = trigger.classList.contains('bd-trigger--dragging')
    ? renderedTop
    : (getStoredTriggerTop(config) ?? renderedTop);
  setTriggerTop(trigger, desiredTop);
}

function attachTriggerViewportClamp(trigger: HTMLElement, config: WidgetConfig): void {
  const reclamp = () => {
    if (!trigger.isConnected) {
      cleanup();
      return;
    }
    reclampVisibleTriggerPosition(trigger, config);
  };

  const cleanup = () => {
    window.removeEventListener('resize', reclamp);
    window.visualViewport?.removeEventListener('resize', reclamp);
  };

  window.addEventListener('resize', reclamp);
  window.visualViewport?.addEventListener('resize', reclamp);
}

function attachTriggerDragBehavior(trigger: HTMLElement, config: WidgetConfig): void {
  const handle = trigger.querySelector<HTMLElement>('.bd-trigger-drag-handle');
  if (!handle) return;

  let pointerId: number | null = null;
  let startPointerY = 0;
  let startTop = 0;
  let moved = false;

  const endDrag = () => {
    if (pointerId === null) return;
    pointerId = null;
    trigger.classList.remove('bd-trigger--dragging');
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerCancel);

    if (moved) {
      saveTriggerTop(config, trigger.getBoundingClientRect().top);
      window.setTimeout(() => {
        _triggerDragMoved = false;
      }, 0);
    }
  };

  function handlePointerMove(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return;
    const nextTop = startTop + e.clientY - startPointerY;
    if (Math.abs(e.clientY - startPointerY) > 3) {
      moved = true;
      _triggerDragMoved = true;
    }
    setTriggerTop(trigger, nextTop);
  }

  function handlePointerUp(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return;
    endDrag();
  }

  function handlePointerCancel(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return;
    endDrag();
  }

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();

    const rect = trigger.getBoundingClientRect();
    pointerId = e.pointerId;
    startPointerY = e.clientY;
    startTop = rect.top;
    moved = false;
    trigger.classList.add('bd-trigger--dragging');
    handle.setPointerCapture(e.pointerId);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  });

  handle.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
  });
}

function attachTriggerKeyboardMove(trigger: HTMLElement, config: WidgetConfig): void {
  trigger.addEventListener('keydown', e => {
    if (e.target !== trigger) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = trigger.getBoundingClientRect();
    const maxTop = window.innerHeight - rect.height - TRIGGER_VIEWPORT_MARGIN_PX;
    const nextTop =
      e.key === 'ArrowUp'
        ? rect.top - TRIGGER_KEYBOARD_MOVE_PX
        : e.key === 'ArrowDown'
          ? rect.top + TRIGGER_KEYBOARD_MOVE_PX
          : e.key === 'Home'
            ? TRIGGER_VIEWPORT_MARGIN_PX
            : maxTop;

    trigger.classList.add('bd-trigger--positioned');
    saveTriggerTop(config, setTriggerTop(trigger, nextTop));
  });
}

// Create the pull tab shown after dismissing the button
function createPullTab(root: HTMLElement, config: WidgetConfig): HTMLElement {
  const tab = document.createElement('div');
  tab.className =
    config.position === 'bottom-left' ? 'bd-pull-tab bd-pull-tab--left' : 'bd-pull-tab';
  tab.innerHTML = '<span class="bd-pull-tab-chevron">‹</span>';
  tab.setAttribute('role', 'button');
  tab.setAttribute('tabindex', '0');
  tab.setAttribute('aria-label', t().pullTabAriaLabel);

  const handleRestore = () => {
    // Clear dismissed state
    try {
      localStorage.removeItem(BUGDROP_DISMISSED_KEY);
    } catch {
      // localStorage may be blocked
    }

    // Remove the pull tab
    tab.remove();
    _pullTab = null;

    // Recreate the trigger button with restore animation
    createTriggerButton(root, config, true);
  };

  tab.addEventListener('click', handleRestore);
  tab.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleRestore();
    }
  });

  root.appendChild(tab);
  _pullTab = tab;
  return tab;
}

function initWidget(config: WidgetConfig) {
  // Store config for API access
  _widgetConfig = config;

  // If button is not dismissible, clear any stale dismissed state from localStorage
  // This ensures the button shows on non-dismissible pages even after visiting dismissible ones
  if (!config.buttonDismissible) {
    try {
      localStorage.removeItem(BUGDROP_DISMISSED_KEY);
    } catch {
      // localStorage may be blocked
    }
  }

  // Create Shadow DOM for style isolation
  const host = document.createElement('div');
  host.id = 'bugdrop-host';
  host.style.pointerEvents = 'auto';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  installRadixDialogCompatibility(host);

  // Prevent keyboard events from leaking to host page (e.g., ERPNext console shortcuts)
  for (const eventType of ['keydown', 'keypress', 'keyup'] as const) {
    shadow.addEventListener(eventType, (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        e.stopPropagation();
      }
    });
  }

  // Inject styles and create root wrapper
  const root = injectStyles(shadow, config);
  _widgetRoot = root;

  // Determine if button should be rendered
  const shouldShowButton =
    config.showButton && !(config.buttonDismissible && isButtonDismissed(config.dismissDuration));

  if (shouldShowButton) {
    const trigger = document.createElement('button');
    trigger.className = getTriggerClassName(config);
    appendTriggerContent(trigger, config);
    trigger.setAttribute('aria-label', t().triggerAriaLabel);

    // Add close button if dismissible
    if (config.buttonDismissible) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'bd-trigger-close';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', t().dismissButtonAriaLabel);
      trigger.appendChild(closeBtn);

      // Handle close button click
      closeBtn.addEventListener('click', e => {
        e.stopPropagation(); // Don't trigger the main button
        dismissButton();

        // Remove restoring class if present (to avoid animation conflicts)
        trigger.classList.remove('bd-trigger--restoring');

        // Add dismiss animation
        trigger.classList.add('bd-trigger--dismissing');

        // Wait for animation to finish before removing
        trigger.addEventListener(
          'animationend',
          () => {
            trigger.remove();
            _triggerButton = null;

            // Show pull tab if enabled
            if (config.showRestore) {
              createPullTab(root, config);
            }
          },
          { once: true }
        );
      });
    }

    root.appendChild(trigger);
    _triggerButton = trigger;
    applyStoredTriggerPosition(trigger, config);
    attachTriggerViewportClamp(trigger, config);
    attachTriggerDragBehavior(trigger, config);
    attachTriggerKeyboardMove(trigger, config);

    // Handle trigger click
    trigger.addEventListener('click', () => {
      if (_triggerDragMoved) {
        _triggerDragMoved = false;
        return;
      }
      openFeedbackFlow(root, config);
    });
  } else if (
    config.showButton &&
    config.buttonDismissible &&
    config.showRestore &&
    isButtonDismissed(config.dismissDuration)
  ) {
    // Button was previously dismissed - show pull tab
    createPullTab(root, config);
  }

  // Expose the BugDrop API
  exposeBugDropAPI(root, config);

  // Dispatch ready event
  window.dispatchEvent(new CustomEvent('bugdrop:ready'));
}

// Create and expose the BugDrop JavaScript API
function exposeBugDropAPI(root: HTMLElement, config: WidgetConfig) {
  // Closure-captured so each widget instance has its own mode state. Read by
  // the matchMedia listener below and mutated by setTheme. No module-level
  // state needed — keeps per-init isolation if multi-instance is ever added.
  let currentMode: ThemeMode = config.theme;
  let variantManager: VariantManager | undefined;
  let flowManager: FlowManager | undefined;

  window.BugDrop = {
    // Open the feedback modal programmatically
    open: () => {
      if (!_isModalOpen) {
        openFeedbackFlow(root, config, { skipWelcome: true });
      }
    },

    // Close the current modal
    close: () => {
      if (_isModalOpen) {
        // Find and remove any open modal
        const modal = root.querySelector('.bd-modal');
        if (modal) {
          modal.remove();
        }
        _isModalOpen = false;
      }
    },

    // Hide the floating button
    hide: () => {
      if (_triggerButton) {
        _triggerButton.style.display = 'none';
      }
    },

    // Show the floating button (clears dismissed state when called)
    show: () => {
      // Clear dismissed state when explicitly called
      try {
        localStorage.removeItem(BUGDROP_DISMISSED_KEY);
      } catch {
        // localStorage may be blocked
      }

      // Remove pull tab if present
      if (_pullTab) {
        _pullTab.remove();
        _pullTab = null;
      }

      if (_triggerButton) {
        _triggerButton.style.display = '';
        reclampVisibleTriggerPosition(_triggerButton, config);
        window.requestAnimationFrame(() => {
          if (_triggerButton) reclampVisibleTriggerPosition(_triggerButton, config);
        });
      } else if (config.showButton) {
        // Recreate button if it was removed
        createTriggerButton(root, config);
      }
    },

    // Check if modal is currently open
    isOpen: () => _isModalOpen,

    // Check if floating button is visible
    isButtonVisible: () => {
      return _triggerButton !== null && _triggerButton.style.display !== 'none';
    },

    // Set the widget theme at runtime. Accepts 'light' | 'dark' | 'auto'.
    // Invalid input warns and no-ops. Only toggles the root class and re-runs
    // the custom-color inline styles — it does NOT re-inject the <style> block
    // because the dark-mode CSS variables are already defined statically in
    // `.bd-root.bd-dark { ... }` and get activated by the class flip alone.
    setTheme: (mode: unknown) => {
      if (!isValidTheme(mode)) {
        console.warn(
          `[BugDrop] Invalid theme ${String(mode)}. Expected 'light' | 'dark' | 'auto'.`
        );
        return;
      }
      currentMode = mode;
      const resolved = resolveTheme(mode);
      applyThemeClass(root, resolved);
      applyCustomStyles(root, config, resolved);
    },

    // The sidecar is created only on the first registration. Legacy-only pages
    // do not allocate variant maps, IDs, DOM, listeners, observers, or storage.
    registerVariant: variantConfig => {
      variantManager ??= createVariantManager(
        {
          repo: config.repo,
          apiUrl: config.apiUrl,
          authTokenProvider: config.authTokenProvider,
          appVersion: config.appVersion,
        },
        { isLegacyModalOpen: () => _isModalOpen }
      );
      return variantManager.register(variantConfig);
    },

    registerFlow: flowConfig => {
      flowManager ??= createFlowManager(
        {
          repo: config.repo,
          apiUrl: config.apiUrl,
          authTokenProvider: config.authTokenProvider,
          categoryLabels: config.categoryLabels,
          appVersion: config.appVersion,
        },
        {
          preflight: () => checkInstallation(config),
          capture: async (screen, includeScreenshot, signal) => {
            const result = await runScreenshotCaptureFlow(
              root,
              { ...config, screenshotMode: screen.mode },
              includeScreenshot,
              () => {},
              signal
            );
            return result;
          },
        },
        { isLegacyModalOpen: () => _isModalOpen }
      );
      return flowManager.register(flowConfig);
    },
  };

  // Fix for data-theme="auto" not following OS changes after init. One
  // persistent listener gated by `currentMode === 'auto'` so explicit
  // light/dark modes ignore OS changes. Cleanup fn is discarded — widgets
  // live for the page lifetime.
  attachSystemThemeListener(resolved => {
    if (currentMode !== 'auto') return;
    applyThemeClass(root, resolved);
    applyCustomStyles(root, config, resolved);
  });
}

// Helper to create the trigger button (used by show() API and pull tab restore)
function createTriggerButton(root: HTMLElement, config: WidgetConfig, isRestoring = false) {
  const trigger = document.createElement('button');
  trigger.className = getTriggerClassName(config, isRestoring);
  appendTriggerContent(trigger, config);
  trigger.setAttribute('aria-label', t().triggerAriaLabel);

  if (config.buttonDismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bd-trigger-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', t().dismissButtonAriaLabel);
    trigger.appendChild(closeBtn);

    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      dismissButton();

      // Remove restoring class if present (to avoid animation conflicts)
      trigger.classList.remove('bd-trigger--restoring');

      // Add dismiss animation
      trigger.classList.add('bd-trigger--dismissing');

      // Wait for animation to finish before removing
      trigger.addEventListener(
        'animationend',
        () => {
          trigger.remove();
          _triggerButton = null;

          // Show pull tab if enabled
          if (config.showRestore) {
            createPullTab(root, config);
          }
        },
        { once: true }
      );
    });
  }

  root.appendChild(trigger);
  _triggerButton = trigger;
  applyStoredTriggerPosition(trigger, config);
  attachTriggerViewportClamp(trigger, config);
  attachTriggerDragBehavior(trigger, config);
  attachTriggerKeyboardMove(trigger, config);

  trigger.addEventListener('click', () => {
    if (_triggerDragMoved) {
      _triggerDragMoved = false;
      return;
    }
    openFeedbackFlow(root, config);
  });
}

async function openFeedbackFlow(
  root: HTMLElement,
  config: WidgetConfig,
  opts?: { skipWelcome?: boolean }
) {
  if (_isModalOpen) {
    return;
  }

  closeActiveVariantModal();

  // Mark modal as open
  _isModalOpen = true;

  const testRuntime = __BUGDROP_ENABLE_TEST_HOOKS__ ? requestedDefaultJourney() : undefined;
  const useFlowRuntime =
    testRuntime === 'private' ||
    (testRuntime !== 'fixed' && __BUGDROP_DEFAULT_FLOW_RUNTIME__ === 'private');
  if (useFlowRuntime) {
    const outcome = await runPrivateDefaultJourney(root, config, opts);
    if (outcome === 'preflight-blocked') return;
  } else {
    // Check if app is installed
    const { status: installStatus, appName } = await checkInstallation(config);
    if (installStatus === 'not_installed') {
      showInstallPrompt(root, config, undefined, appName);
      return;
    }
    if (installStatus === 'unreachable') {
      showInstallPrompt(root, config, t().apiUnreachableMessage, appName);
      return;
    }

    await runFixedDefaultJourney(root, config, opts);
  }

  // Flow complete
  _isModalOpen = false;
}

function requestedDefaultJourney(): 'fixed' | 'private' | undefined {
  const value = (window as unknown as { __bugdropDefaultFlowRuntime?: unknown })
    .__bugdropDefaultFlowRuntime;
  return value === 'fixed' || value === 'private' ? value : undefined;
}

async function runFixedDefaultJourney(
  root: HTMLElement,
  config: WidgetConfig,
  opts?: { skipWelcome?: boolean }
) {
  // Step 1: Welcome screen (conditional)
  const skipWelcome =
    opts?.skipWelcome ||
    config.welcome === 'never' ||
    (config.welcome === 'once' && hasSeenWelcome(config.repo));

  if (!skipWelcome) {
    const continueFlow = await showWelcomeScreen(root);
    if (!continueFlow) {
      _isModalOpen = false;
      return;
    }
    if (config.welcome === 'once') {
      markWelcomeSeen(config.repo);
    }
  }

  let formResult: FeedbackFormResult | null = null;
  while (true) {
    // Step 2: Feedback form (with optional screenshot checkbox)
    formResult = await showFeedbackFormWithScreenshotOption(root, config, formResult);
    if (!formResult) {
      // User cancelled
      _isModalOpen = false;
      return;
    }

    const submittedFormResult = formResult;
    const screenshotResult = await runScreenshotCaptureFlow(
      root,
      config,
      submittedFormResult.includeScreenshot,
      () => rememberComplexScreenshotSkip(config, submittedFormResult)
    );

    if (screenshotResult.returnToForm) continue;

    // Submit
    await submitFeedback(root, config, {
      title: formResult.title,
      description: formResult.description,
      category: formResult.category,
      name: formResult.name,
      email: formResult.email,
      screenshot: screenshotResult.screenshot,
      attachments: formResult.attachments,
      elementSelector: screenshotResult.elementSelector,
      fullElementSelector: screenshotResult.fullElementSelector,
      selectedElementHighlightColor: screenshotResult.elementSelector
        ? resolveAccentColor(config.accentColor)
        : null,
      sendConsoleLogs: formResult.sendConsoleLogs,
    });
    break;
  }
}

async function runPrivateDefaultJourney(
  root: HTMLElement,
  config: WidgetConfig,
  opts?: { skipWelcome?: boolean }
) {
  const definition = normalizeDefaultDefinition({
    repo: config.repo,
    apiUrl: config.apiUrl,
    authTokenProvider: config.authTokenProvider,
    welcome: config.welcome,
    screenshotMode: config.screenshotMode,
    skipWelcome: Boolean(opts?.skipWelcome),
    hasSeenWelcome: hasSeenWelcome(config.repo),
    showName: config.showName,
    requireName: config.requireName,
    showEmail: config.showEmail,
    requireEmail: config.requireEmail,
    sendConsoleLogs: config.sendConsoleLogs,
    screenshotScale: config.screenshotScale,
    elementContextMaxArea: config.elementContextMaxArea,
    accentColor: config.accentColor,
    categoryLabels: config.categoryLabels,
    issueLinkVisibility: config.issueLinkVisibility,
  });

  return runDefaultJourney<
    FeedbackFormResult,
    Awaited<ReturnType<typeof runScreenshotCaptureFlow>>
  >(definition, {
    preflight: recipe =>
      checkInstallation(config, {
        repo: recipe.repo,
        apiUrl: recipe.apiUrl,
        authTokenProvider: recipe.authTokenProvider,
      }),
    showPreflightFailure: result =>
      showInstallPrompt(
        root,
        config,
        result.status === 'unreachable' ? t().apiUnreachableMessage : undefined,
        result.appName
      ),
    showWelcome: () => showWelcomeScreen(root),
    rememberWelcome: () => markWelcomeSeen(definition.steps[1].repo),
    showDetails: (step, previous) =>
      showFeedbackFormWithScreenshotOption(
        root,
        {
          ...config,
          repo: step.repo,
          showName: step.showName,
          requireName: step.requireName,
          showEmail: step.showEmail,
          requireEmail: step.requireEmail,
          sendConsoleLogs: step.sendConsoleLogs,
          screenshotMode: definition.steps[2].mode,
        },
        previous
      ),
    capture: async (step, details) => {
      const captureConfig: WidgetConfig = {
        ...config,
        repo: step.repo,
        screenshotMode: step.mode,
        screenshotScale: step.screenshotScale,
        elementContextMaxArea: step.elementContextMaxArea,
        accentColor: step.accentColor,
      };
      const result = await runScreenshotCaptureFlow(
        root,
        captureConfig,
        details.includeScreenshot,
        () => rememberComplexScreenshotSkip(captureConfig, details)
      );
      return { ...result, returnToDetails: result.returnToForm };
    },
    submit: (recipe, details, capture) =>
      submitFeedback(
        root,
        {
          ...config,
          repo: recipe.repo,
          apiUrl: recipe.apiUrl,
          authTokenProvider: recipe.authTokenProvider,
          categoryLabels: recipe.categoryLabels as CategoryLabelConfig | undefined,
          issueLinkVisibility: recipe.issueLinkVisibility,
        },
        {
          title: details.title,
          description: details.description,
          category: details.category,
          name: details.name,
          email: details.email,
          screenshot: capture.screenshot,
          attachments: details.attachments,
          elementSelector: capture.elementSelector,
          fullElementSelector: capture.fullElementSelector,
          selectedElementHighlightColor: capture.elementSelector
            ? resolveAccentColor(config.accentColor)
            : null,
          sendConsoleLogs: details.sendConsoleLogs,
        }
      ),
  });
}

async function checkInstallation(
  config: WidgetConfig,
  endpoint: Pick<WidgetConfig, 'repo' | 'apiUrl' | 'authTokenProvider'> = config
): Promise<{ status: 'installed' | 'not_installed' | 'unreachable'; appName?: string }> {
  try {
    const response = await fetch(`${endpoint.apiUrl}/check/${endpoint.repo}`, {
      headers: await getAuthHeaders(endpoint.authTokenProvider),
    });
    if (!response.ok) return { status: 'unreachable' };
    const data = await response.json();
    if (Number.isSafeInteger(data.maxScreenshotSizeBytes) && data.maxScreenshotSizeBytes > 0) {
      config.maxScreenshotSizeBytes = data.maxScreenshotSizeBytes;
    }
    return {
      status: data.installed === true ? 'installed' : 'not_installed',
      appName: data.appName,
    };
  } catch {
    return { status: 'unreachable' };
  }
}

function showInstallPrompt(
  root: HTMLElement,
  config: WidgetConfig,
  errorMessage?: string,
  serverAppName?: string
) {
  const appName =
    serverAppName ||
    (config.apiUrl.includes('bugdrop.neonwatty.workers.dev')
      ? 'neonwatty-bugdrop'
      : config.apiUrl.replace(/https?:\/\//, '').replace(/\..*/, ''));
  const installUrl = `https://github.com/apps/${appName}/installations/new`;
  const message = errorMessage || t().installRequiredMessage;
  const title = errorMessage ? t().connectionErrorTitle : t().installRequiredTitle;
  const modal = createModal(
    root,
    title,
    `
      <p style="margin: 0 0 16px; color: var(--bd-text-secondary);">${escapeHtml(message)}</p>
      <div class="bd-actions">
        <button class="bd-btn bd-btn-secondary" data-action="cancel">${escapeWidgetText(t().cancel)}</button>
        ${!errorMessage ? `<a href="${installUrl}" target="_blank" class="bd-btn bd-btn-primary" style="text-decoration: none;">${escapeWidgetText(t().installApp)}</a>` : ''}
      </div>
    `,
    true
  );

  const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
  const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;

  closeBtn?.addEventListener('click', () => {
    modal.remove();
    _isModalOpen = false;
  });
  cancelBtn?.addEventListener('click', () => {
    modal.remove();
    _isModalOpen = false;
  });
}

function showWelcomeScreen(root: HTMLElement): Promise<boolean> {
  return new Promise(resolve => {
    const modal = createModal(
      root,
      t().welcomeTitle,
      `
        <div style="text-align: center; padding: 8px 0 16px;">
          <div style="font-size: 3rem; margin-bottom: 12px;">💬</div>
          <p style="margin: 0 0 12px; color: var(--bd-text-primary); font-size: 1.05rem; font-weight: 500;">
            ${escapeWidgetText(t().welcomeHeadline)}
          </p>
          <p style="margin: 0 0 8px; color: var(--bd-text-secondary); font-size: 0.95rem; line-height: 1.6;">
            ${escapeWidgetText(t().welcomeBodyLine1)}<br/>
            ${escapeWidgetText(t().welcomeBodyLine2)}
          </p>
        </div>
        <div class="bd-actions" style="justify-content: center;">
          <button class="bd-btn bd-btn-primary" data-action="continue">${escapeWidgetText(t().getStarted)}</button>
        </div>
      `,
      true
    );

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const continueBtn = modal.querySelector('[data-action="continue"]') as HTMLElement;

    closeBtn?.addEventListener('click', () => {
      modal.remove();
      resolve(false);
    });

    continueBtn?.addEventListener('click', () => {
      modal.remove();
      resolve(true);
    });
  });
}

interface FeedbackFormResult {
  title: string;
  description: string;
  category: FeedbackCategory;
  name?: string;
  email?: string;
  draftName?: string;
  draftEmail?: string;
  includeScreenshot: boolean;
  attachments: FeedbackAttachment[];
  sendConsoleLogs: boolean;
  descriptionEdited: boolean;
  prefilledEmail: boolean;
  prefillSnapshot: BugDropPrefill;
}

function showFeedbackFormWithScreenshotOption(
  root: HTMLElement,
  config: WidgetConfig,
  initialValues?: FeedbackFormResult | null
): Promise<FeedbackFormResult | null> {
  return new Promise(resolve => {
    const prefill: BugDropPrefill = initialValues
      ? initialValues.prefillSnapshot
      : getPrefill(config.prefillProviderName);
    const initialDescription =
      initialValues?.description ?? prefill.descriptionTemplates?.bug ?? '';
    let descriptionEdited = initialValues?.descriptionEdited ?? false;
    const prefilledEmail =
      initialValues?.prefilledEmail ?? Boolean(config.showEmail && prefill.email);
    // Build optional name field
    const nameFieldHtml = config.showName
      ? `
          <div class="bd-form-group">
            <label class="bd-label" for="name">${escapeWidgetText(t().nameLabel)}${config.requireName ? ' *' : ''}</label>
            <input type="text" id="name" class="bd-input" ${config.requireName ? 'required' : ''} placeholder="${escapeWidgetText(t().namePlaceholder)}" />
          </div>
        `
      : '';

    // Build optional email field
    const emailFieldHtml = config.showEmail
      ? `
          <div class="bd-form-group">
            <label class="bd-label" for="email">${escapeWidgetText(t().emailLabel)}${config.requireEmail ? ' *' : ''}</label>
            <input type="email" id="email" class="bd-input" ${config.requireEmail ? 'required' : ''} ${prefilledEmail ? 'aria-describedby="bd-prefilled-email-disclosure"' : ''} placeholder="${escapeWidgetText(t().emailPlaceholder)}" />
            ${prefilledEmail ? `<p id="bd-prefilled-email-disclosure" class="bd-field-hint">${escapeWidgetText(t().prefilledEmailDisclosure)}</p>` : ''}
          </div>
        `
      : '';

    const modal = createModal(
      root,
      t().feedbackFormTitle,
      `
        <form id="feedback-form">
          <div class="bd-form-group">
            <label class="bd-label">${escapeWidgetText(t().categoryLabel)}</label>
            <div class="bd-category-selector" style="display: flex; gap: 8px; margin-top: 6px;">
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="bug" ${getCategoryChecked(initialValues, 'bug')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">🐛 ${escapeWidgetText(t().categoryBug)}</span>
              </label>
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="feature" ${getCategoryChecked(initialValues, 'feature')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">✨ ${escapeWidgetText(t().categoryFeature)}</span>
              </label>
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="question" ${getCategoryChecked(initialValues, 'question')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">❓ ${escapeWidgetText(t().categoryQuestion)}</span>
              </label>
            </div>
          </div>
          <div class="bd-form-group">
            <label class="bd-label" for="title">${escapeWidgetText(t().titleLabel)} *</label>
            <input type="text" id="title" class="bd-input" required placeholder="${escapeWidgetText(t().titlePlaceholder)}" value="${escapeHtml(initialValues?.title || '')}" />
          </div>
          <div class="bd-form-group">
            <label class="bd-label" for="description">${escapeWidgetText(t().descriptionLabel)}</label>
            <textarea id="description" class="bd-textarea" placeholder="${escapeWidgetText(t().descriptionPlaceholder)}">${escapeHtml(initialDescription)}</textarea>
          </div>
          ${nameFieldHtml}
          ${emailFieldHtml}
          <div class="bd-evidence-block">
            <div class="bd-evidence-row">
              ${getScreenshotFormControl(config, initialValues)}
              ${getUploadFormControl()}
            </div>
            <input type="file" id="attachment-upload" accept="${ACCEPTED_UPLOAD_TYPES.join(',')}" multiple class="bd-upload-input" />
            <div id="attachment-list" class="bd-upload-list" aria-live="polite">${
              initialValues?.attachments.length ? '' : ''
            }</div>
            <p id="attachment-error" class="bd-field-error" hidden></p>
            ${getConsoleLogsFormControl(config, initialValues)}
          </div>
          <div class="bd-actions">
            <button type="button" class="bd-btn bd-btn-secondary" data-action="cancel">${escapeWidgetText(t().cancel)}</button>
            <button type="submit" class="bd-btn bd-btn-primary" id="submit-btn">${config.screenshotMode === 'auto' ? escapeWidgetText(t().submit) : escapeWidgetText(t().continueButton)}</button>
          </div>
        </form>
      `
    );

    const form = modal.querySelector('#feedback-form') as HTMLFormElement;
    const nameInput = modal.querySelector('#name') as HTMLInputElement | null;
    const emailInput = modal.querySelector('#email') as HTMLInputElement | null;
    const titleInput = modal.querySelector('#title') as HTMLInputElement;
    const descInput = modal.querySelector('#description') as HTMLTextAreaElement;
    const screenshotCheckbox = modal.querySelector(
      '#include-screenshot'
    ) as HTMLInputElement | null;
    const uploadInput = modal.querySelector('#attachment-upload') as HTMLInputElement;
    const uploadButton = modal.querySelector('[data-action="choose-uploads"]') as HTMLButtonElement;
    const uploadList = modal.querySelector('#attachment-list') as HTMLElement;
    const uploadError = modal.querySelector('#attachment-error') as HTMLElement;
    const consoleLogsCheckbox = modal.querySelector('#send-console-logs') as HTMLInputElement;
    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;
    let attachments = [...(initialValues?.attachments ?? [])];
    if (nameInput)
      nameInput.value = initialValues ? (initialValues.draftName ?? '') : (prefill.name ?? '');
    if (emailInput)
      emailInput.value = initialValues ? (initialValues.draftEmail ?? '') : (prefill.email ?? '');
    descInput.addEventListener('input', () => {
      descriptionEdited = true;
    });
    modal.querySelectorAll<HTMLInputElement>('input[name="category"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!descriptionEdited) {
          descInput.value = prefill.descriptionTemplates?.[input.value as FeedbackCategory] ?? '';
        }
      });
    });

    const closeModal = () => {
      modal.remove();
      resolve(null);
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    form.addEventListener('submit', e => {
      e.preventDefault();

      // Validate required fields
      if (!titleInput.value.trim()) {
        titleInput.classList.add('bd-input--error');
        titleInput.focus();
        return;
      }

      // Validate name if required
      if (config.requireName && nameInput && !nameInput.value.trim()) {
        nameInput.classList.add('bd-input--error');
        nameInput.focus();
        return;
      }

      // Validate email if required
      if (config.requireEmail && emailInput && !emailInput.value.trim()) {
        emailInput.classList.add('bd-input--error');
        emailInput.focus();
        return;
      }

      // Get selected category
      const categoryInput = modal.querySelector(
        'input[name="category"]:checked'
      ) as HTMLInputElement;
      const category = (categoryInput?.value || 'bug') as FeedbackCategory;
      const includeScreenshot =
        config.screenshotMode === 'optional' ? (screenshotCheckbox?.checked ?? false) : true;
      if (config.screenshotMode === 'optional' && includeScreenshot) {
        clearComplexScreenshotsSkipped(config.repo);
      }

      modal.remove();
      resolve({
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        category,
        name: nameInput?.value.trim() || undefined,
        email: emailInput?.value.trim() || undefined,
        draftName: nameInput?.value.trim(),
        draftEmail: emailInput?.value.trim(),
        includeScreenshot,
        attachments,
        sendConsoleLogs: consoleLogsCheckbox.checked,
        descriptionEdited,
        prefilledEmail,
        prefillSnapshot: prefill,
      });
    });

    // Clear error styling on input
    titleInput.addEventListener('input', () => titleInput.classList.remove('bd-input--error'));
    nameInput?.addEventListener('input', () => nameInput.classList.remove('bd-input--error'));
    emailInput?.addEventListener('input', () => emailInput.classList.remove('bd-input--error'));

    const rerenderUploads = () => {
      renderUploadList(uploadList, attachments, index => {
        attachments = attachments.filter((_, itemIndex) => itemIndex !== index);
        rerenderUploads();
      });
    };

    uploadButton.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const files = Array.from(uploadInput.files ?? []);
      uploadInput.value = '';
      uploadError.textContent = '';
      uploadError.hidden = true;

      const remainingSlots = MAX_UPLOAD_FILES - attachments.length;
      if (files.length > remainingSlots) {
        showUploadError(uploadError, t().uploadTooMany(MAX_UPLOAD_FILES));
        return;
      }

      for (const file of files) {
        const validationError = validateUploadFile(file);
        if (validationError) {
          showUploadError(uploadError, validationError);
          return;
        }
      }

      try {
        const nextAttachments = await Promise.all(files.map(fileToAttachment));
        attachments = [...attachments, ...nextAttachments];
        rerenderUploads();
      } catch {
        showUploadError(uploadError, t().uploadReadError);
      }
    });

    rerenderUploads();
  });
}

function getUploadFormControl(): string {
  return `
    <div class="bd-upload-group">
      <div class="bd-upload-row" aria-label="${escapeWidgetText(t().uploadsAriaLabel)}">
        <button type="button" class="bd-btn bd-btn-secondary bd-upload-button" data-action="choose-uploads" aria-label="${escapeWidgetText(t().uploadFilesAriaLabel)}">
          <svg class="bd-upload-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M8 11V3" />
            <path d="M4.5 6.5 8 3l3.5 3.5" />
            <path d="M3 12.5h10" />
          </svg>
          ${escapeWidgetText(t().uploadButton)}
        </button>
      </div>
    </div>
  `;
}

function validateUploadFile(file: File): string | null {
  if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) {
    return t().uploadUnsupportedType;
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return t().uploadTooLarge(formatFileSize(MAX_UPLOAD_SIZE_BYTES));
  }
  return null;
}

function showUploadError(target: HTMLElement, message: string) {
  target.textContent = message;
  target.hidden = false;
}

function renderUploadList(
  target: HTMLElement,
  attachments: FeedbackAttachment[],
  onRemove: (index: number) => void
) {
  target.innerHTML = attachments
    .map(
      (attachment, index) => `
        <div class="bd-upload-item">
          <span class="bd-upload-item__name">${escapeHtml(attachment.name)}</span>
          <span class="bd-upload-item__meta">${formatFileSize(attachment.size)}</span>
          <button type="button" class="bd-upload-remove" data-index="${index}" aria-label="${escapeWidgetText(t().removeAttachmentAriaLabel(attachment.name))}">&times;</button>
        </div>
      `
    )
    .join('');

  target.querySelectorAll('.bd-upload-remove').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number((button as HTMLElement).dataset.index);
      if (Number.isInteger(index)) onRemove(index);
    });
  });
}

function fileToAttachment(file: File): Promise<FeedbackAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read file.'));
        return;
      }
      resolve({
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: reader.result,
      });
    });
    reader.addEventListener('error', () => reject(new Error('Could not read file.')));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function getScreenshotFormControl(
  config: WidgetConfig,
  initialValues?: FeedbackFormResult | null
): string {
  if (config.screenshotMode === 'auto') {
    const redactionNote =
      getRedactionCount() > 0 ? ` ${escapeWidgetText(t().screenshotAutoRedactionNote)}` : '';
    return `
      <p style="margin: 8px 0 0; color: var(--bd-text-secondary); font-size: 0.95rem;">
        ${escapeWidgetText(t().screenshotAutoNote)}${redactionNote}
      </p>
    `;
  }

  if (config.screenshotMode === 'required') {
    return `
      <p style="margin: 8px 0 0; color: var(--bd-text-secondary); font-size: 0.95rem;">
        ${escapeWidgetText(t().screenshotRequiredNote)}
      </p>
    `;
  }

  const includeScreenshot =
    initialValues?.includeScreenshot ??
    (!isFullPageDisabled() || !hasSkippedComplexScreenshots(config.repo));

  return `
    <div class="bd-screenshot-control">
      <input type="checkbox" id="include-screenshot" ${includeScreenshot ? 'checked' : ''} class="bd-checkbox" />
      <label for="include-screenshot" class="bd-checkbox-label">
        ${escapeWidgetText(t().includeScreenshotLabel)}
      </label>
    </div>
  `;
}

function getConsoleLogsFormControl(
  config: WidgetConfig,
  initialValues?: FeedbackFormResult | null
): string {
  const sendConsoleLogs = initialValues?.sendConsoleLogs ?? config.sendConsoleLogs;

  return `
    <div class="bd-form-group" style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
      <input type="checkbox" id="send-console-logs" ${sendConsoleLogs ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--bd-primary); cursor: pointer;" />
      <label for="send-console-logs" style="font-size: 0.95rem; color: var(--bd-text-secondary); cursor: pointer; user-select: none;">
        ${escapeWidgetText(t().sendConsoleLogsLabel)}
      </label>
    </div>
  `;
}

function getCategoryChecked(
  initialValues: FeedbackFormResult | null | undefined,
  category: FeedbackCategory
): string {
  return (initialValues?.category || 'bug') === category ? 'checked' : '';
}

async function submitFeedback(root: HTMLElement, config: WidgetConfig, data: FeedbackData) {
  // Show submitting modal with loading state
  const modal = createModal(
    root,
    t().submittingTitle,
    `
      <div style="display: flex; flex-direction: column; align-items: center; padding: 20px;">
        <div class="bd-spinner bd-spinner--lg"></div>
        <p class="bd-loading-text" style="margin-top: 12px;">${escapeWidgetText(t().creatingIssue)}</p>
      </div>
    `
  );

  try {
    // Build submitter info if provided
    const submitter = data.name || data.email ? { name: data.name, email: data.email } : undefined;

    // Collect system info
    const systemInfo = getSystemInfo();
    const domNodeCount = getDomNodeCount();
    const consoleLogs: ConsoleLogEntry[] | undefined = data.sendConsoleLogs
      ? getConsoleLogSnapshot()
      : undefined;

    const response = await fetch(`${config.apiUrl}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await getAuthHeaders(config.authTokenProvider)),
      },
      body: JSON.stringify({
        repo: config.repo,
        title: data.title,
        description: data.description,
        category: data.category,
        categoryLabels: config.categoryLabels,
        screenshot: data.screenshot,
        attachments: data.attachments,
        consoleLogs,
        submitter,
        metadata: {
          url: systemInfo.url, // Redacted URL (no query params)
          userAgent: navigator.userAgent,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          timestamp: new Date().toISOString(),
          appVersion: config.appVersion,
          elementSelector: data.elementSelector,
          fullElementSelector: data.fullElementSelector,
          selectedElementHighlightColor: data.selectedElementHighlightColor || undefined,
          domNodeCount,
          fullPageDisabled: isFullPageDisabled(),
          // Parsed system info
          browser: systemInfo.browser,
          os: systemInfo.os,
          devicePixelRatio: systemInfo.devicePixelRatio,
          language: systemInfo.language,
        },
      }),
    });

    modal.remove();

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const minutes = retryAfter ? Math.ceil(parseInt(retryAfter, 10) / 60) : 15;
      showSubmitError(root, config, data, t().rateLimited(minutes));
      return;
    }

    const result = await response.json();

    if (result.success) {
      await showSuccessModal(
        root,
        result.issueNumber,
        result.issueUrl,
        result.isPublic ?? false,
        config.issueLinkVisibility
      );
    } else {
      showSubmitError(root, config, data, result.error || t().submitFailedFallback);
    }
  } catch (_error) {
    modal.remove();
    showSubmitError(root, config, data, t().networkError);
  }
}

function showSubmitError(
  root: HTMLElement,
  config: WidgetConfig,
  data: FeedbackData,
  errorMessage: string
) {
  const modal = createModal(
    root,
    t().submissionFailedTitle,
    `
      <div class="bd-error-message">
        <svg class="bd-error-message__icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0-9.5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5.5zm0 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
        </svg>
        <span class="bd-error-message__text">${escapeHtml(errorMessage)}</span>
      </div>
      <div class="bd-actions">
        <button class="bd-btn bd-btn-secondary" data-action="cancel">${escapeWidgetText(t().cancel)}</button>
        <button class="bd-btn bd-btn-primary" data-action="retry">${escapeWidgetText(t().tryAgain)}</button>
      </div>
    `,
    true
  );

  const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
  const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;
  const retryBtn = modal.querySelector('[data-action="retry"]') as HTMLElement;

  closeBtn?.addEventListener('click', () => modal.remove());
  cancelBtn?.addEventListener('click', () => modal.remove());

  retryBtn?.addEventListener('click', async () => {
    modal.remove();
    await submitFeedback(root, config, data);
  });
}
