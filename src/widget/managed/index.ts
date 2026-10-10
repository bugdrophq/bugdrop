import { createRecoveryGuard } from './recovery';
import { createSubmission } from './transport';
import { isSubmissionToken, type Binding, type TokenProvider } from './protocol';
import { createManagedUI, type ManagedWidgetAPI } from './ui';

const providerName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const allowedAttributes = new Set([
  'contractVersion',
  'applicationId',
  'authTokenProvider',
  'sdkVersion',
  'theme',
  'position',
  'button',
]);

function validApplicationId(value: string | undefined): boolean {
  return (
    typeof value === 'string' && value.length >= 3 && value.length <= 200 && value === value.trim()
  );
}

function endpointFromScript(script: HTMLScriptElement): string | null {
  try {
    const url = new URL(script.src);
    const local =
      url.hostname.endsWith('.localhost') ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.origin === 'null'
    )
      return null;
    return `${url.origin}/v1/submissions`;
  } catch {
    return null;
  }
}

function resolveProvider(script: HTMLScriptElement): TokenProvider | null {
  const name = script.dataset.authTokenProvider;
  if (!name || !providerName.test(name)) return null;
  const callable: unknown = (window as unknown as Record<string, unknown>)[name];
  if (typeof callable !== 'function') return null;
  return async (binding: Binding): Promise<string> => {
    try {
      const token: unknown = await Reflect.apply(callable, window, [binding]);
      if (!isSubmissionToken(token)) throw new Error();
      return token;
    } catch {
      // Provider diagnostics and token values stay outside the widget UI.
      throw new Error('Managed authorization unavailable');
    }
  };
}

/** Synchronous, opt-in bootstrap for the separately built managed artifact. */
export function bootstrapManagedWidget(): ManagedWidgetAPI | null {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement) || 'BugDrop' in window) return null;
  if (
    script.dataset.contractVersion !== '1' ||
    !validApplicationId(script.dataset.applicationId) ||
    !Object.keys(script.dataset).every(key => allowedAttributes.has(key))
  )
    return null;
  const theme = script.dataset.theme ?? 'auto';
  const position = script.dataset.position ?? 'bottom-right';
  const button = script.dataset.button ?? 'true';
  if (
    (theme !== 'light' && theme !== 'dark' && theme !== 'auto') ||
    (position !== 'bottom-left' && position !== 'bottom-right') ||
    (button !== 'true' && button !== 'false')
  )
    return null;
  const endpoint = endpointFromScript(script);
  const tokenProvider = resolveProvider(script);
  if (!endpoint || !tokenProvider) return null;

  const parent = document.body ?? document.documentElement;
  if (!parent || document.getElementById('bugdrop-managed-host')) return null;
  const host = document.createElement('div');
  host.id = 'bugdrop-managed-host';
  try {
    const api = createManagedUI(host, {
      theme,
      position,
      buttonVisible: button !== 'false',
      guard: createRecoveryGuard(script.dataset.applicationId!, endpoint),
      createSubmission: feedback => createSubmission(feedback, endpoint, tokenProvider),
    });
    parent.append(host);
    (window as unknown as { BugDrop?: ManagedWidgetAPI }).BugDrop = api;
    window.dispatchEvent(new CustomEvent('bugdrop:ready'));
    return api;
  } catch {
    host.remove();
    return null;
  }
}

if (typeof document !== 'undefined') bootstrapManagedWidget();
