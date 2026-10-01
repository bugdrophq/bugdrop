type PrefillCategory = 'bug' | 'feature' | 'question';
export interface BugDropPrefill {
  name?: string;
  email?: string;
  descriptionTemplates?: Partial<Record<PrefillCategory, string>>;
}

type BugDropPrefillProvider = () => BugDropPrefill | null | undefined;
export const PREFILL_NAME_LIMIT = 100;
export const PREFILL_EMAIL_LIMIT = 254;
export const PREFILL_TEMPLATE_LIMIT = 4000;

type ProviderWindow = Window & Record<string, unknown>;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;
const IDENTITY_CONTROLS = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;
// Match the single-address syntax accepted by the form's HTML email input.
const EMAIL_ADDRESS =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/u;

function readField(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    console.warn('[BugDrop] Prefill field could not be read. Ignoring field.');
    return undefined;
  }
}

function boundedString(value: unknown, limit: number, identity = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    console.warn('[BugDrop] Invalid prefill field type. Ignoring field.');
    return undefined;
  }
  if (value.length > limit) {
    console.warn('[BugDrop] Prefill field exceeds its length limit. Ignoring field.');
    return undefined;
  }
  if ((identity ? IDENTITY_CONTROLS : BIDI_CONTROLS).test(value)) {
    console.warn('[BugDrop] Prefill field contains unsupported characters. Ignoring field.');
    return undefined;
  }
  return value;
}

export function getPrefill(
  providerName: string | undefined,
  globalObject: ProviderWindow = window as unknown as ProviderWindow
): BugDropPrefill {
  if (!providerName) return {};
  let provider: unknown;
  try {
    provider = globalObject[providerName];
  } catch {
    console.warn('[BugDrop] Prefill provider lookup failed. Opening an empty form.');
    return {};
  }
  if (typeof provider !== 'function') {
    console.warn('[BugDrop] data-prefill-provider must reference a function.');
    return {};
  }

  let supplied: unknown;
  try {
    supplied = (provider as BugDropPrefillProvider)();
  } catch {
    console.warn('[BugDrop] Prefill provider failed. Opening an empty form.');
    return {};
  }
  if (supplied == null) return {};
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    console.warn('[BugDrop] Prefill provider must return an object.');
    return {};
  }
  const candidate = supplied as Record<string, unknown>;
  if (typeof readField(candidate, 'then') === 'function') {
    // A rejected Promise must be observed even though asynchronous defaults are unsupported.
    void Promise.resolve(supplied).catch(() => undefined);
    console.warn('[BugDrop] Prefill provider must return synchronously.');
    return {};
  }
  const name = boundedString(readField(candidate, 'name'), PREFILL_NAME_LIMIT, true);
  const rawEmail = boundedString(readField(candidate, 'email'), PREFILL_EMAIL_LIMIT, true);
  let email = rawEmail;
  if (email !== undefined && email !== '' && !EMAIL_ADDRESS.test(email)) {
    console.warn('[BugDrop] Invalid prefill email. Ignoring field.');
    email = undefined;
  }
  const templates = readField(candidate, 'descriptionTemplates');
  const descriptionTemplates: BugDropPrefill['descriptionTemplates'] = {};
  if (templates !== undefined && templates !== null) {
    if (typeof templates !== 'object' || Array.isArray(templates)) {
      console.warn('[BugDrop] Prefill descriptionTemplates must be an object.');
    } else {
      const values = templates as Record<string, unknown>;
      for (const category of ['bug', 'feature', 'question'] as const) {
        descriptionTemplates[category] = boundedString(
          readField(values, category),
          PREFILL_TEMPLATE_LIMIT
        );
      }
    }
  }
  return { name, email, descriptionTemplates };
}
