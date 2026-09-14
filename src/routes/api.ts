import { isRepositoryAllowed, isValidRepositoryName } from '../lib/repository-policy';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import type {
  ConsoleLogEntry,
  Env,
  FeedbackAttachment,
  FeedbackCategory,
  FeedbackPayload,
} from '../types';
import { redactConsoleLogMessage } from '../widget/console-log-redaction';
import {
  getInstallationToken,
  getInstallationAccess,
  createIssue,
  uploadScreenshotAsAsset,
  uploadAttachmentAsAsset,
  isRepoPublic,
  GitHubLabelError,
} from '../lib/github';
import { rateLimit, rateLimitByRepo } from '../middleware/rateLimit';
import { resolveAccentColor } from '../defaults';
import { verifyBugDropAuthToken } from '../lib/authToken';
import {
  escapeMarkdownTableCell,
  formatMarkdownCodeSpan,
  formatMarkdownTableCodeSpan,
} from '../lib/markdown';
import { handleStructuredFeedback, isStructuredFeedbackRequest } from './structured-feedback';
import { parseAppVersion } from '../app-version';
import { getPublicFeedbackCount, scheduleSuccessfulFeedbackCount } from '../lib/feedback-counter';
import { isCanonicalGitHubIssue } from '../lib/github-issue-result';

type ApiVariables = {
  feedbackPayload?: unknown;
};
type ApiEnv = { Bindings: Env; Variables: ApiVariables };

const api = new Hono<ApiEnv>();

const DEFAULT_CATEGORY_LABELS: Record<FeedbackCategory, string[]> = {
  bug: ['bug'],
  feature: ['enhancement'],
  question: ['question'],
};

const CATEGORY_KEYS: FeedbackCategory[] = ['bug', 'feature', 'question'];
const MAX_LABELS_PER_CATEGORY = 5;
const MAX_ATTACHMENTS = 5;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);
const MAX_CONSOLE_LOG_ENTRIES = 50;
const MAX_CONSOLE_LOG_BODY_CHARS = 12_000;
const MAX_CONSOLE_LOG_MESSAGE_CHARS = 1_000;
// GitHub enforces a 50-char limit on label names; keep validation in lockstep
// so over-long configured labels surface as a clear local warning rather than
// going out, getting rejected, and triggering the GitHub-error fallback path.
const MAX_LABEL_LENGTH = 50;

// CORS middleware with origin whitelist
api.use('*', async (c, next) => {
  const allowedOrigins = c.env.ALLOWED_ORIGINS || '*';

  // Parse allowed origins
  const originList =
    allowedOrigins === '*'
      ? ['*']
      : allowedOrigins
          .split(',')
          .map(o => o.trim())
          .filter(Boolean);

  const corsMiddleware = cors({
    origin: origin => {
      // Allow requests with no origin (e.g., curl, server-to-server)
      if (!origin) return '*';
      // Wildcard allows all
      if (originList.includes('*')) return origin;
      // Check if origin is in whitelist
      return originList.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  });

  return corsMiddleware(c, next);
});

// Additive deployment identity for preview canaries. Keep it off unconfigured deployments.
api.use('/feedback', async (c, next) => {
  await next();
  const buildSha = getBuildSha(c.env);
  if (buildSha) c.header('X-BugDrop-Build-SHA', buildSha);
});

// Rate limit: 20 requests per 15 minutes per IP
api.use(
  '/feedback',
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 20,
    keyPrefix: 'ip',
  })
);

// Authenticate protected submissions before shared repo quota accounting.
api.use('/feedback', requireBugDropFeedbackAuthToken);

// Rate limit: 50 requests per hour per repo
api.use(
  '/feedback',
  rateLimitByRepo({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 50,
  })
);

// Health check
api.get('/health', c => {
  const buildSha = getBuildSha(c.env);
  return c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    capabilities: { appVersionMetadata: true },
    ...(buildSha ? { buildSha } : {}),
  });
});

api.get('/stats/feedback-issues', async c => {
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = '';
  cacheUrl.hash = '';
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const sharedCache = typeof caches === 'undefined' ? undefined : caches.default;
  if (sharedCache) {
    try {
      const cached = await sharedCache.match(cacheKey);
      if (cached) {
        const response = new Response(cached.body, cached);
        // CORS is request-specific and is reapplied by the outer middleware.
        response.headers.delete('Access-Control-Allow-Origin');
        response.headers.delete('Access-Control-Allow-Credentials');
        response.headers.delete('Vary');
        return response;
      }
    } catch (error) {
      console.warn('[BugDrop] Failed to read cached public feedback count:', error);
    }
  }

  try {
    const feedbackIssuesCreated = await getPublicFeedbackCount(c.env);
    if (feedbackIssuesCreated === null) {
      return c.json({ error: 'Feedback count unavailable' }, 503, {
        'Cache-Control': 'no-store',
      });
    }
    const response = Response.json(
      {
        feedbackIssuesCreated,
        display: `${feedbackIssuesCreated.toLocaleString('en-US')}+`,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
        },
      }
    );
    if (sharedCache) {
      try {
        await sharedCache.put(cacheKey, response.clone());
      } catch (error) {
        console.warn('[BugDrop] Failed to cache public feedback count:', error);
      }
    }
    return response;
  } catch (error) {
    console.error('[BugDrop] Failed to read anonymous feedback counter:', error);
    return c.json({ error: 'Feedback count unavailable' }, 503, {
      'Cache-Control': 'no-store',
    });
  }
});

function getBuildSha(env: Env): string | undefined {
  return env.BUILD_SHA?.trim() || undefined;
}

function getMaxScreenshotSizeMB(env: Env): number {
  const configured = Number.parseInt(env.MAX_SCREENSHOT_SIZE_MB || '5', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 5;
}

// Check if app is installed on repo
api.get('/check/:owner/:repo', async c => {
  const { owner, repo } = c.req.param();
  const fullRepo = `${owner}/${repo}`;

  if (!isRepositoryAllowed(c.env.ALLOWED_REPOSITORIES, fullRepo)) {
    return c.json({ error: 'Repository is not allowed' }, 403);
  }

  if (c.env.AUTH_TOKEN_REQUIRED_FOR_CHECK === 'true') {
    const authError = await requireBugDropAuthToken(c, fullRepo);
    if (authError) return authError;
  }

  const token = await getInstallationToken(c.env, owner, repo);

  return c.json({
    installed: !!token,
    repo: fullRepo,
    appName: c.env.GITHUB_APP_NAME || undefined,
    maxScreenshotSizeBytes: getMaxScreenshotSizeMB(c.env) * 1024 * 1024,
  });
});

// Submit feedback
api.post('/feedback', async c => {
  // Parse payload
  let requestPayload: unknown;
  try {
    requestPayload = c.get('feedbackPayload') ?? (await c.req.json());
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (isStructuredFeedbackRequest(requestPayload)) {
    return handleStructuredFeedback(c, requestPayload);
  }

  const payload = requestPayload as FeedbackPayload;

  // Validate required fields (description is optional — many reports are title + screenshot)
  if (!payload.repo || !payload.title) {
    return c.json(
      {
        error: 'Missing required fields: repo, title',
      },
      400
    );
  }

  if (payload.metadata?.appVersion !== undefined) {
    const appVersion = parseAppVersion(payload.metadata.appVersion);
    if (!appVersion) return c.json({ error: 'Invalid metadata appVersion' }, 400);
    payload.metadata.appVersion = appVersion;
  }

  // Validate screenshot payload. The browser widget emits PNG data URLs, but
  // callers can hit the API directly, so the server must not trust the prefix.
  const maxSizeMB = getMaxScreenshotSizeMB(c.env);
  if (payload.screenshot) {
    const validation = validateScreenshotDataUrl(payload.screenshot, maxSizeMB);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }
  }
  const attachmentValidation = validateAttachments(payload.attachments, maxSizeMB);
  if (!attachmentValidation.valid) {
    return c.json({ error: attachmentValidation.error }, 400);
  }

  // Parse owner/repo
  if (!isValidRepositoryName(payload.repo)) {
    return c.json(
      {
        error: 'Invalid repo format. Expected: owner/repo',
      },
      400
    );
  }
  const [owner, repo] = payload.repo.split('/');

  if (!isRepositoryAllowed(c.env.ALLOWED_REPOSITORIES, payload.repo)) {
    return c.json({ error: 'Repository is not allowed' }, 403);
  }

  const authError = await requireBugDropAuthToken(c, payload.repo);
  if (authError) return authError;

  try {
    // Get installation token
    const access = await getInstallationAccess(c.env, owner, repo);
    if (!access) {
      const appName = c.env.GITHUB_APP_NAME || 'your-app-name';
      return c.json(
        {
          error: 'GitHub App not installed on this repository',
          installUrl: `https://github.com/apps/${appName}/installations/new`,
        },
        403
      );
    }
    const { token, installationId } = access;

    // Upload screenshot as file and get URL
    let screenshotUrl: string | undefined;
    const imageData = payload.screenshot;
    if (imageData) {
      try {
        screenshotUrl = await uploadScreenshotAsAsset(token, owner, repo, imageData);
      } catch (error) {
        console.error('Failed to upload screenshot:', error);
        // Continue without screenshot rather than failing the whole submission
      }
    }
    const uploadedAttachments: UploadedAttachment[] = [];
    for (const attachment of payload.attachments ?? []) {
      const url = await uploadAttachmentAsAsset(token, owner, repo, attachment);
      uploadedAttachments.push({ ...attachment, url });
    }

    const labelResolution = resolveCategoryLabels(payload, c.env, payload.repo);
    if (labelResolution.warnings.length > 0) {
      // Surface warnings in worker logs so self-host operators see the misconfig
      // even when no issue is filed. Otherwise these warnings only ever appear
      // in successfully-created issue bodies.
      console.warn('[BugDrop] Category label config warnings:', {
        repo: payload.repo,
        warnings: labelResolution.warnings,
      });
    }

    // Check repo visibility (for UI to decide whether to show issue link)
    const isPublic = await isRepoPublic(token, owner, repo);

    let body = formatIssueBody(
      payload,
      screenshotUrl,
      uploadedAttachments,
      labelResolution.warnings
    );
    let issue;
    try {
      issue = await createIssue(token, owner, repo, payload.title, body, labelResolution.labels);
    } catch (error) {
      if (!labelResolution.usedCustomLabels || !(error instanceof GitHubLabelError)) {
        throw error;
      }

      const fallbackLabels = buildIssueLabels(getDefaultLabelsForCategory(payload.category));
      const warning = [
        ...labelResolution.warnings,
        `GitHub rejected the configured labels (${formatLabelList(labelResolution.labels)}), so BugDrop retried with default labels (${formatLabelList(fallbackLabels)}).`,
      ];
      body = formatIssueBody(payload, screenshotUrl, uploadedAttachments, warning);
      try {
        issue = await createIssue(token, owner, repo, payload.title, body, fallbackLabels);
      } catch (fallbackError) {
        // Both configured AND default labels failed — surface a distinct error
        // so operators can tell this from a single-call failure. Without this,
        // the outer catch reports only the second error and loses the retry
        // context entirely.
        console.error('[BugDrop] Both configured and default labels failed.', {
          configured: labelResolution.labels,
          fallback: fallbackLabels,
          originalError: error,
          fallbackError,
        });
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(
          `Failed to create issue with both configured labels (${formatLabelList(labelResolution.labels)}) and default labels (${formatLabelList(fallbackLabels)}): ${fallbackMessage}`,
          { cause: fallbackError }
        );
      }
    }

    if (!isCanonicalGitHubIssue(issue, owner, repo)) {
      throw new Error('GitHub returned an invalid Issue result');
    }

    scheduleSuccessfulFeedbackCount(c.env, payload.repo, c, installationId);

    return c.json({
      success: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      isPublic,
      ...(labelResolution.warnings.length > 0
        ? { labelMappingWarnings: labelResolution.warnings }
        : {}),
    });
  } catch (error) {
    console.error('Error creating feedback:', error);
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create issue',
      },
      500
    );
  }
});

async function requireBugDropFeedbackAuthToken(
  c: Context<ApiEnv>,
  next: Next
): Promise<Response | void> {
  if (!hasBugDropAuthTokenSecret(c.env) || c.req.method !== 'POST') return next();

  try {
    const payload = (await c.req.raw.clone().json()) as unknown;
    c.set('feedbackPayload', payload);
    if (!isPlainObject(payload) || typeof payload.repo !== 'string') return next();

    const authError = await requireBugDropAuthToken(c, payload.repo);
    if (authError) return authError;
  } catch {
    // Let the route handler return the existing invalid JSON response.
  }

  return next();
}

function getBearerToken(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

async function requireBugDropAuthToken(c: Context<ApiEnv>, repo: string): Promise<Response | null> {
  const secrets = getBugDropAuthTokenSecrets(c.env);
  if (secrets.length === 0) return null;

  try {
    await verifyBugDropAuthTokenWithAnySecret(
      getBearerToken(c.req.header('Authorization')),
      secrets,
      c,
      repo
    );
    return null;
  } catch (error) {
    console.warn('[BugDrop] rejected auth token', {
      repo,
      reason: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: 'BugDrop auth token required' }, 401);
  }
}

function hasBugDropAuthTokenSecret(env: Env): boolean {
  return getBugDropAuthTokenSecrets(env).length > 0;
}

function getBugDropAuthTokenSecrets(env: Env): string[] {
  return [
    env.AUTH_TOKEN_SECRET,
    ...splitAdditionalAuthTokenSecrets(env.AUTH_TOKEN_ADDITIONAL_SECRETS),
  ]
    .map(secret => secret?.trim())
    .filter((secret): secret is string => Boolean(secret));
}

function splitAdditionalAuthTokenSecrets(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map(secret => secret.trim())
    .filter(Boolean);
}

async function verifyBugDropAuthTokenWithAnySecret(
  token: string | undefined,
  secrets: string[],
  c: Context<ApiEnv>,
  repo: string
): Promise<void> {
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      await verifyBugDropAuthToken(token, {
        secret,
        repo,
        audience: c.env.AUTH_TOKEN_AUDIENCE,
        issuer: c.env.AUTH_TOKEN_ISSUER,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Missing BugDrop auth token');
}

type ScreenshotValidationResult = { valid: true } | { valid: false; error: string };
type LabelResolution = {
  labels: string[];
  warnings: string[];
  usedCustomLabels: boolean;
};
type UploadedAttachment = FeedbackAttachment & { url: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function validateScreenshotDataUrl(dataUrl: string, maxSizeMB: number): ScreenshotValidationResult {
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) {
    return {
      valid: false,
      error: 'Invalid screenshot format. Expected a PNG data URL.',
    };
  }

  const base64 = match[1];
  if (!base64) {
    return {
      valid: false,
      error: 'Invalid screenshot format. Expected a PNG data URL.',
    };
  }

  const estimatedSizeBytes =
    Math.floor((base64.length * 3) / 4) -
    (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  const estimatedSizeMB = estimatedSizeBytes / (1024 * 1024);
  if (estimatedSizeMB > maxSizeMB) {
    return {
      valid: false,
      error: `Screenshot too large: ${estimatedSizeMB.toFixed(1)}MB exceeds ${maxSizeMB}MB limit`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    return {
      valid: false,
      error: 'Invalid screenshot format. Expected valid base64 PNG data.',
    };
  }

  if (!hasPngSignature(bytes)) {
    return {
      valid: false,
      error: 'Invalid screenshot format. Expected PNG image data.',
    };
  }

  return { valid: true };
}

function validateAttachments(
  attachments: FeedbackAttachment[] | undefined,
  maxSizeMB: number
): ScreenshotValidationResult {
  if (attachments === undefined) return { valid: true };
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'Invalid upload format. Expected a list of files.' };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { valid: false, error: `Too many files. Upload up to ${MAX_ATTACHMENTS} files.` };
  }

  for (const attachment of attachments) {
    const validation = validateAttachment(attachment, maxSizeMB);
    if (!validation.valid) return validation;
  }

  return { valid: true };
}

function validateAttachment(
  attachment: FeedbackAttachment,
  maxSizeMB: number
): ScreenshotValidationResult {
  if (!isPlainObject(attachment)) {
    return { valid: false, error: 'Invalid upload format. Expected file details.' };
  }

  const name = attachment.name;
  const type = attachment.type;
  const size = attachment.size;
  const dataUrl = attachment.dataUrl;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    hasControlChars(name) ||
    typeof type !== 'string' ||
    typeof dataUrl !== 'string' ||
    typeof size !== 'number' ||
    !Number.isFinite(size)
  ) {
    return { valid: false, error: 'Invalid upload format. Expected file name, type, and data.' };
  }

  if (!ALLOWED_ATTACHMENT_TYPES.has(type)) {
    return { valid: false, error: `Unsupported file type: ${type || 'unknown'}.` };
  }

  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1] !== type || !match[2]) {
    return { valid: false, error: 'Invalid upload format. Expected a matching file data URL.' };
  }

  const estimatedSizeBytes =
    Math.floor((match[2].length * 3) / 4) -
    (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  const largerSizeBytes = Math.max(estimatedSizeBytes, size);
  const estimatedSizeMB = largerSizeBytes / (1024 * 1024);
  if (estimatedSizeMB > maxSizeMB) {
    return {
      valid: false,
      error: `File is too large: ${estimatedSizeMB.toFixed(1)}MB exceeds ${maxSizeMB}MB limit.`,
    };
  }

  try {
    base64ToBytes(match[2]);
  } catch {
    return { valid: false, error: 'Invalid upload format. Expected valid file data.' };
  }

  return { valid: true };
}

function resolveCategoryLabels(payload: FeedbackPayload, env: Env, repo: string): LabelResolution {
  const selectedCategory = isFeedbackCategory(payload.category) ? payload.category : 'bug';
  const labelsByCategory: Record<FeedbackCategory, string[]> = { ...DEFAULT_CATEGORY_LABELS };
  const warnings: string[] = [];
  const configuredLabels = getConfiguredCategoryLabels(payload, env, repo, warnings);
  let selectedCategoryWasCustomized = false;

  if (configuredLabels !== undefined) {
    for (const key of Object.keys(configuredLabels)) {
      if (!isFeedbackCategory(key)) {
        warnings.push(`Unknown category label mapping key ignored: \`${safeInlineCode(key)}\`.`);
        continue;
      }

      const normalized = normalizeLabelValue(configuredLabels[key], key);
      if (normalized.valid) {
        labelsByCategory[key] = normalized.labels;
        if (key === selectedCategory) {
          selectedCategoryWasCustomized = !sameLabels(
            normalized.labels,
            DEFAULT_CATEGORY_LABELS[selectedCategory]
          );
        }
      } else {
        warnings.push(normalized.warning);
      }
    }
  }

  return {
    labels: buildIssueLabels(labelsByCategory[selectedCategory]),
    warnings,
    usedCustomLabels: selectedCategoryWasCustomized,
  };
}

// Discriminated result of parsing CATEGORY_LABELS so the caller cannot conflate
// "env unset" with "env set but unusable" — the latter must fail closed even when
// ALLOW_CLIENT_CATEGORY_LABELS is true.
type EnvCategoryConfigResult =
  | { kind: 'unset' }
  | { kind: 'config'; value: Record<string, unknown> }
  | { kind: 'malformed'; warning: string }
  | { kind: 'invalid-shape'; warning: string }
  | { kind: 'no-match'; warning: string };

function getConfiguredCategoryLabels(
  payload: FeedbackPayload,
  env: Env,
  repo: string,
  warnings: string[]
): Record<string, unknown> | undefined {
  const envResult = parseEnvCategoryLabels(env.CATEGORY_LABELS, repo);

  switch (envResult.kind) {
    case 'config':
      return envResult.value;
    case 'malformed':
    case 'invalid-shape':
    case 'no-match':
      // Env was set but unusable — fail closed. Do NOT fall through to the
      // client mapping even when ALLOW_CLIENT_CATEGORY_LABELS=true: the operator
      // explicitly configured server authority, and a typo must not silently
      // hand label control back to the browser.
      warnings.push(envResult.warning);
      return undefined;
    case 'unset':
      if (env.ALLOW_CLIENT_CATEGORY_LABELS !== 'true') return undefined;
      if (payload.categoryLabels === undefined) return undefined;
      if (!isPlainObject(payload.categoryLabels)) {
        warnings.push('Invalid category label mapping: expected an object.');
        return undefined;
      }
      return payload.categoryLabels;
  }
}

function parseEnvCategoryLabels(
  rawValue: string | undefined,
  repo: string
): EnvCategoryConfigResult {
  if (!rawValue) return { kind: 'unset' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { kind: 'malformed', warning: 'Invalid server category label config: malformed JSON.' };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: 'invalid-shape',
      warning: 'Invalid server category label config: expected a JSON object.',
    };
  }

  // Disambiguate flat vs per-repo by syntax, not by guessing: per-repo keys are
  // either the wildcard `*` or contain a `/` (owner/repo). Category keys never do.
  const isPerRepoShape = Object.keys(parsed).some(k => k === '*' || k.includes('/'));
  if (!isPerRepoShape) {
    return { kind: 'config', value: parsed };
  }

  const match = parsed[repo] ?? parsed['*'];
  if (match === undefined) {
    return {
      kind: 'no-match',
      warning: `Server category label config has no mapping for \`${safeInlineCode(repo)}\` and no \`*\` fallback.`,
    };
  }
  if (!isPlainObject(match)) {
    return {
      kind: 'invalid-shape',
      warning: `Invalid server category label config for \`${safeInlineCode(repo)}\`: expected an object.`,
    };
  }
  return { kind: 'config', value: match };
}

function getDefaultLabelsForCategory(category: FeedbackCategory | undefined): string[] {
  return DEFAULT_CATEGORY_LABELS[isFeedbackCategory(category) ? category : 'bug'];
}

function buildIssueLabels(categoryLabels: string[]): string[] {
  return uniqueLabels([...categoryLabels, 'bugdrop']);
}

function normalizeLabelValue(
  value: unknown,
  category: FeedbackCategory
): { valid: true; labels: string[] } | { valid: false; warning: string } {
  const rawLabels = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!rawLabels) {
    return {
      valid: false,
      warning: `Invalid labels for category "${category}": expected a string or string array.`,
    };
  }

  if (rawLabels.length === 0 || rawLabels.length > MAX_LABELS_PER_CATEGORY) {
    return {
      valid: false,
      warning: `Invalid labels for category "${category}": expected 1-${MAX_LABELS_PER_CATEGORY} labels.`,
    };
  }

  const labels: string[] = [];
  for (const rawLabel of rawLabels) {
    if (typeof rawLabel !== 'string') {
      return {
        valid: false,
        warning: `Invalid labels for category "${category}": all labels must be strings.`,
      };
    }

    // Reject ASCII control characters (newlines, NUL, etc). A label like
    // "foo\n## Compromised" passes length validation but breaks out of the
    // inline-code span and injects markdown into the issue body.
    if (hasControlChars(rawLabel)) {
      return {
        valid: false,
        warning: `Invalid labels for category "${category}": labels cannot contain control characters.`,
      };
    }

    const label = rawLabel.trim();
    if (!label || label.length > MAX_LABEL_LENGTH) {
      return {
        valid: false,
        warning: `Invalid labels for category "${category}": labels must be 1-${MAX_LABEL_LENGTH} characters.`,
      };
    }
    labels.push(label);
  }

  return { valid: true, labels: uniqueLabels(labels) };
}

function uniqueLabels(labels: string[]): string[] {
  return Array.from(new Set(labels));
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sameLabels(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && CATEGORY_KEYS.includes(value as FeedbackCategory);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatLabelList(labels: string[]): string {
  return labels.map(label => `\`${safeInlineCode(label)}\``).join(', ');
}

function safeInlineCode(value: string): string {
  return value.replace(/[`\\]/g, '');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Format the issue body with markdown
 */
function formatIssueBody(
  payload: FeedbackPayload,
  screenshotDataUrl?: string,
  uploadedAttachments: UploadedAttachment[] = [],
  labelWarnings: string[] = []
): string {
  const sections: string[] = [];

  // Submitter info (if provided)
  if (payload.submitter?.name || payload.submitter?.email) {
    sections.push('## Submitted by');
    const parts: string[] = [];
    if (payload.submitter.name) {
      parts.push(`**${payload.submitter.name}**`);
    }
    if (payload.submitter.email) {
      parts.push(`(${payload.submitter.email})`);
    }
    sections.push(parts.join(' '));
    sections.push('');
  }

  // Description
  if (payload.description) {
    sections.push('## Description');
    sections.push(payload.description);
    sections.push('');
  }

  // Screenshot - embedded as base64 data URL
  if (screenshotDataUrl) {
    sections.push('## Screenshot');
    sections.push(`![Screenshot](${screenshotDataUrl})`);
    if (payload.metadata.elementSelector) {
      sections.push('');
      sections.push(
        `_Selected element is indicated by the rounded highlight border (${formatMarkdownInlineCode(getSelectedElementHighlightColor(payload))})._`
      );
    }
    sections.push('');
  }

  if (uploadedAttachments.length > 0) {
    sections.push('## Attachments');
    for (const attachment of uploadedAttachments) {
      const safeName = normalizeMarkdownValue(attachment.name);
      if (attachment.type.startsWith('image/')) {
        sections.push(`![${safeName}](${attachment.url})`);
      } else {
        sections.push(`- [${safeName}](${attachment.url})`);
      }
    }
    sections.push('');
  }

  if (labelWarnings.length > 0) {
    sections.push('## Label mapping warning');
    for (const warning of labelWarnings) {
      sections.push(`- ${warning}`);
    }
    sections.push('');
  }

  const consoleLogsSection = formatConsoleLogsSection(payload.consoleLogs);
  if (consoleLogsSection) {
    sections.push(consoleLogsSection);
    sections.push('');
  }

  // System Info
  sections.push('<details>');
  sections.push('<summary>System Info</summary>');
  sections.push('');
  sections.push('| Property | Value |');
  sections.push('|----------|-------|');

  const appVersion = parseAppVersion(payload.metadata.appVersion);
  if (appVersion) {
    sections.push(`| **App Version** | ${formatMarkdownTableCodeSpan(appVersion)} |`);
  }

  // Browser and OS (if available)
  if (payload.metadata.browser) {
    const browserVersion = payload.metadata.browser.version
      ? ` ${payload.metadata.browser.version}`
      : '';
    sections.push(`| **Browser** | ${payload.metadata.browser.name}${browserVersion} |`);
  }

  if (payload.metadata.os) {
    const osVersion = payload.metadata.os.version ? ` ${payload.metadata.os.version}` : '';
    sections.push(`| **OS** | ${payload.metadata.os.name}${osVersion} |`);
  }

  // Viewport with pixel ratio
  const pixelRatio = payload.metadata.devicePixelRatio
    ? ` @${payload.metadata.devicePixelRatio}x`
    : '';
  sections.push(
    `| **Viewport** | ${payload.metadata.viewport.width}×${payload.metadata.viewport.height}${pixelRatio} |`
  );

  // Language
  if (payload.metadata.language) {
    sections.push(`| **Language** | ${payload.metadata.language} |`);
  }

  // URL (redacted)
  sections.push(`| **Page** | ${payload.metadata.url} |`);
  sections.push(`| **Timestamp** | ${payload.metadata.timestamp} |`);

  if (payload.metadata.elementSelector) {
    sections.push(`| **Element** | ${formatMarkdownTableCode(payload.metadata.elementSelector)} |`);
  }

  if (payload.metadata.fullElementSelector) {
    sections.push(
      `| **Full CSS path** | ${formatMarkdownTableCode(payload.metadata.fullElementSelector)} |`
    );
  }

  sections.push('');
  sections.push('</details>');
  sections.push('');
  sections.push('---');
  sections.push('*Submitted via [BugDrop](https://github.com/mean-weasel/bugdrop)*');

  return sections.join('\n');
}

function getSelectedElementHighlightColor(payload: FeedbackPayload): string {
  const color = payload.metadata.selectedElementHighlightColor;
  if (!color || hasControlChars(color)) return resolveAccentColor();
  return normalizeMarkdownValue(color) || resolveAccentColor();
}

function formatMarkdownTableCode(value: string): string {
  const tableSafeValue = escapeMarkdownTableCell(normalizeMarkdownValue(value));
  return formatMarkdownCodeSpan(tableSafeValue);
}

function formatMarkdownInlineCode(value: string): string {
  return formatMarkdownCodeSpan(normalizeMarkdownValue(value));
}

function formatConsoleLogsSection(entries: ConsoleLogEntry[] | undefined): string | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const logs = entries.slice(0, MAX_CONSOLE_LOG_ENTRIES).map(formatConsoleLogEntry).filter(Boolean);
  if (logs.length === 0) return null;

  if (entries.length > MAX_CONSOLE_LOG_ENTRIES) {
    logs.push(
      `Console logs truncated: showing ${MAX_CONSOLE_LOG_ENTRIES} of ${entries.length} entries.`
    );
  }

  let body = logs.join('\n');
  if (body.length > MAX_CONSOLE_LOG_BODY_CHARS) {
    body = `${body.slice(0, MAX_CONSOLE_LOG_BODY_CHARS)}\nConsole logs truncated because the output was too large.`;
  }

  return [
    '<details>',
    '<summary>Console Logs</summary>',
    '',
    formatFencedBlock(body),
    '</details>',
  ].join('\n');
}

function formatConsoleLogEntry(entry: ConsoleLogEntry): string {
  if (!entry || typeof entry.message !== 'string') return '';

  const level = isConsoleLogLevel(entry.level) ? entry.level : 'log';
  const timestamp =
    typeof entry.timestamp === 'string' ? normalizeMarkdownValue(entry.timestamp) : '';
  const source = formatConsoleLogSource(entry);
  const message = redactConsoleLogMessage(normalizeMarkdownValue(entry.message)).slice(
    0,
    MAX_CONSOLE_LOG_MESSAGE_CHARS
  );
  const prefix = timestamp ? `${timestamp} [${level}]` : `[${level}]`;
  return `${prefix} ${message}${source}`;
}

function formatConsoleLogSource(entry: ConsoleLogEntry): string {
  if (!entry.sourceUrl) return '';

  const source = redactConsoleLogMessage(normalizeMarkdownValue(entry.sourceUrl));
  const line = Number.isFinite(entry.lineNumber) ? entry.lineNumber : undefined;
  const column = Number.isFinite(entry.columnNumber) ? entry.columnNumber : undefined;

  if (line !== undefined && column !== undefined) return ` (${source}:${line}:${column})`;
  if (line !== undefined) return ` (${source}:${line})`;
  return ` (${source})`;
}

function isConsoleLogLevel(value: unknown): value is ConsoleLogEntry['level'] {
  return value === 'log' || value === 'info' || value === 'warn' || value === 'error';
}

function formatFencedBlock(value: string): string {
  const matches = value.match(/`+/g);
  const longestBacktickRun = matches ? Math.max(...matches.map(match => match.length)) : 0;
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

function normalizeMarkdownValue(value: string): string {
  let normalized = '';
  let previousWasControl = false;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isControl = code < 0x20 || code === 0x7f;

    if (isControl) {
      if (!previousWasControl) normalized += ' ';
      previousWasControl = true;
      continue;
    }

    normalized += value[i];
    previousWasControl = false;
  }

  return normalized.trim();
}

export default api;
