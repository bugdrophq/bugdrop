import { isRepositoryAllowed, isValidRepositoryName } from '../lib/repository-policy';
/* eslint-disable max-lines -- Keep the isolated structured contract out of the legacy route. */
import type { Context } from 'hono';
import { GitHubLabelError, createIssue, getInstallationAccess, isRepoPublic } from '../lib/github';
import {
  escapeMarkdownLiteral,
  formatMarkdownCodeSpan,
  formatMarkdownTableCodeSpan,
} from '../lib/markdown';
import type {
  Env,
  FeedbackMetadata,
  StructuredFeedbackClassification,
  StructuredFeedbackPayload,
  StructuredFeedbackSectionFormat,
} from '../types';
import { parseAppVersion } from '../app-version';
import { scheduleSuccessfulFeedbackCount } from '../lib/feedback-counter';
import { isCanonicalGitHubIssue } from '../lib/github-issue-result';

const STRUCTURED_KIND = 'bugdrop.variant-submission';
const STRUCTURED_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_SECTIONS = 20;
const MAX_VARIANT_ID_CHARS = 64;
const MAX_SUBMISSION_ID_CHARS = 128;
const MAX_TITLE_CHARS = 256;
const MAX_HEADING_CHARS = 120;
const MAX_SECTION_VALUE_CHARS = 5_000;
const MAX_ISSUE_BODY_CHARS = 65_536;
const MAX_LABELS = 5;
const MAX_LABEL_CHARS = 50;
const VARIANT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLASSIFICATIONS = new Set<StructuredFeedbackClassification>([
  'bug',
  'feature',
  'question',
  'feedback',
]);
const SECTION_FORMATS = new Set<StructuredFeedbackSectionFormat>(['text', 'quote', 'code']);
const TOP_LEVEL_KEYS = new Set([
  'kind',
  'schemaVersion',
  'repo',
  'variantId',
  'submissionId',
  'issue',
  'metadata',
]);
const ISSUE_KEYS = new Set(['title', 'classification', 'sections']);
const SECTION_KEYS = new Set(['heading', 'value', 'format']);
const METADATA_KEYS = new Set([
  'url',
  'userAgent',
  'viewport',
  'timestamp',
  'appVersion',
  'elementSelector',
  'fullElementSelector',
  'selectedElementHighlightColor',
  'browser',
  'os',
  'devicePixelRatio',
  'language',
]);

type StructuredContext = Context<{
  Bindings: Env;
  Variables: { feedbackPayload?: unknown };
}>;

type ValidationResult =
  { valid: true; payload: StructuredFeedbackPayload } | { valid: false; error: string };

type LabelResolution = {
  labels: string[];
  warnings: string[];
  usedCustomLabels: boolean;
};

export function isStructuredFeedbackRequest(value: unknown): boolean {
  return isPlainObject(value) && value.kind === STRUCTURED_KIND;
}

export async function handleStructuredFeedback(c: StructuredContext, input: unknown) {
  const validation = validateStructuredFeedback(input);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const payload = validation.payload;
  if (!isRepositoryAllowed(c.env.ALLOWED_REPOSITORIES, payload.repo)) {
    return c.json({ error: 'Repository is not allowed' }, 403);
  }
  const [owner, repo] = payload.repo.split('/');

  try {
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

    const labelResolution = resolveVariantLabels(
      c.env.VARIANT_LABELS,
      payload.repo,
      payload.variantId,
      payload.issue.classification
    );
    if (labelResolution.warnings.length > 0) {
      console.warn('[BugDrop] Variant label config warnings:', {
        repo: payload.repo,
        variantId: payload.variantId,
        warnings: labelResolution.warnings,
      });
    }

    let warnings = labelResolution.warnings;
    let body = formatStructuredIssueBody(payload, warnings);
    assertIssueBodyWithinLimit(body);
    const isPublic = await isRepoPublic(token, owner, repo);
    let issue;
    try {
      issue = await createIssue(
        token,
        owner,
        repo,
        payload.issue.title,
        body,
        labelResolution.labels
      );
    } catch (error) {
      if (!labelResolution.usedCustomLabels || !(error instanceof GitHubLabelError)) throw error;

      const fallbackLabels = defaultLabels(payload.issue.classification);
      warnings = [
        ...warnings,
        `GitHub rejected configured labels (${formatLabelList(labelResolution.labels)}); BugDrop retried with defaults (${formatLabelList(fallbackLabels)}).`,
      ];
      body = formatStructuredIssueBody(payload, warnings);
      assertIssueBodyWithinLimit(body);
      issue = await createIssue(token, owner, repo, payload.issue.title, body, fallbackLabels);
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
      ...(warnings.length > 0 ? { labelMappingWarnings: warnings } : {}),
    });
  } catch (error) {
    console.error('Error creating structured feedback:', error);
    if (error instanceof StructuredFeedbackBodyError) {
      return c.json({ error: error.message }, 400);
    }
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to create issue' },
      500
    );
  }
}

class StructuredFeedbackBodyError extends Error {}

function assertIssueBodyWithinLimit(body: string): void {
  if (body.length > MAX_ISSUE_BODY_CHARS) {
    throw new StructuredFeedbackBodyError(
      `Structured Issue body exceeds ${MAX_ISSUE_BODY_CHARS} characters after formatting`
    );
  }
}

function validateStructuredFeedback(input: unknown): ValidationResult {
  if (!isPlainObject(input)) return invalid('Invalid structured feedback payload');

  let payloadSize: number;
  try {
    payloadSize = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return invalid('Invalid structured feedback payload');
  }
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    return invalid(`Structured feedback payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const unknownTopLevelKey = firstUnknownKey(input, TOP_LEVEL_KEYS);
  if (unknownTopLevelKey) {
    return invalid(`Unknown structured feedback property: ${unknownTopLevelKey}`);
  }
  if (input.kind !== STRUCTURED_KIND) return invalid('Invalid structured feedback kind');
  if (input.schemaVersion !== STRUCTURED_SCHEMA_VERSION) {
    return invalid(`Unsupported structured feedback schemaVersion: ${String(input.schemaVersion)}`);
  }
  if (!isValidRepositoryName(input.repo)) {
    return invalid('Invalid repo format. Expected: owner/repo');
  }
  if (
    typeof input.variantId !== 'string' ||
    input.variantId.length > MAX_VARIANT_ID_CHARS ||
    !VARIANT_ID_PATTERN.test(input.variantId)
  ) {
    return invalid('Invalid variantId');
  }
  if (
    typeof input.submissionId !== 'string' ||
    input.submissionId.length > MAX_SUBMISSION_ID_CHARS ||
    !SUBMISSION_ID_PATTERN.test(input.submissionId)
  ) {
    return invalid('Invalid submissionId');
  }

  const issueResult = validateIssue(input.issue);
  if (!issueResult.valid) return issueResult;
  const metadataResult = validateMetadata(input.metadata);
  if (!metadataResult.valid) return metadataResult;

  return {
    valid: true,
    payload: {
      kind: STRUCTURED_KIND,
      schemaVersion: STRUCTURED_SCHEMA_VERSION,
      repo: input.repo,
      variantId: input.variantId,
      submissionId: input.submissionId,
      issue: issueResult.issue,
      metadata: metadataResult.metadata,
    },
  };
}

function validateIssue(
  value: unknown
): { valid: true; issue: StructuredFeedbackPayload['issue'] } | { valid: false; error: string } {
  if (!isPlainObject(value)) return invalid('Invalid structured Issue draft');
  const unknownKey = firstUnknownKey(value, ISSUE_KEYS);
  if (unknownKey) return invalid(`Unknown structured Issue property: ${unknownKey}`);
  if (typeof value.title !== 'string') return invalid('Invalid structured Issue title');

  const title = collapseWhitespace(value.title);
  if (!title || title.length > MAX_TITLE_CHARS) {
    return invalid(`Structured Issue title must be 1-${MAX_TITLE_CHARS} characters`);
  }
  const classification = value.classification;
  if (
    classification !== undefined &&
    (typeof classification !== 'string' ||
      !CLASSIFICATIONS.has(classification as StructuredFeedbackClassification))
  ) {
    return invalid('Invalid structured Issue classification');
  }
  if (!Array.isArray(value.sections) || value.sections.length > MAX_SECTIONS) {
    return invalid(`Structured Issue sections must contain at most ${MAX_SECTIONS} entries`);
  }

  const headings = new Set<string>();
  const sections: StructuredFeedbackPayload['issue']['sections'] = [];
  for (const section of value.sections) {
    if (!isPlainObject(section)) return invalid('Invalid structured Issue section');
    const unknownKey = firstUnknownKey(section, SECTION_KEYS);
    if (unknownKey) return invalid(`Unknown structured Issue section property: ${unknownKey}`);
    if (typeof section.heading !== 'string' || typeof section.value !== 'string') {
      return invalid('Structured Issue section heading and value must be strings');
    }
    const heading = section.heading.trim();
    if (!heading || heading.length > MAX_HEADING_CHARS || hasControlChars(heading)) {
      return invalid(`Structured Issue headings must be 1-${MAX_HEADING_CHARS} characters`);
    }
    const headingKey = heading.toLocaleLowerCase('en-US');
    if (headings.has(headingKey)) return invalid(`Duplicate structured Issue heading: ${heading}`);
    headings.add(headingKey);
    if (section.value.length > MAX_SECTION_VALUE_CHARS) {
      return invalid(
        `Structured Issue section values must be at most ${MAX_SECTION_VALUE_CHARS} characters`
      );
    }
    const format = section.format ?? 'text';
    if (
      typeof format !== 'string' ||
      !SECTION_FORMATS.has(format as StructuredFeedbackSectionFormat)
    ) {
      return invalid('Invalid structured Issue section format');
    }

    if (section.value.trim()) {
      sections.push({
        heading,
        value: section.value,
        format: format as StructuredFeedbackSectionFormat,
      });
    }
  }

  return {
    valid: true,
    issue: {
      title,
      ...(classification
        ? { classification: classification as StructuredFeedbackClassification }
        : {}),
      sections,
    },
  };
}

function validateMetadata(
  value: unknown
): { valid: true; metadata: FeedbackMetadata } | { valid: false; error: string } {
  if (!isPlainObject(value)) return invalid('Invalid structured feedback metadata');
  const unknownKey = firstUnknownKey(value, METADATA_KEYS);
  if (unknownKey) return invalid(`Unknown structured metadata property: ${unknownKey}`);
  if (typeof value.url !== 'string' || value.url.length > 2_048) {
    return invalid('Invalid structured metadata URL');
  }

  let redactedUrl: string;
  try {
    const parsed = new URL(value.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    parsed.search = '';
    parsed.hash = '';
    redactedUrl = parsed.toString();
  } catch {
    return invalid('Invalid structured metadata URL');
  }
  if (typeof value.userAgent !== 'string' || value.userAgent.length > 1_000) {
    return invalid('Invalid structured metadata userAgent');
  }
  if (
    !isPlainObject(value.viewport) ||
    !hasOnlyKeys(value.viewport, new Set(['width', 'height']))
  ) {
    return invalid('Invalid structured metadata viewport');
  }
  const width = value.viewport.width;
  const height = value.viewport.height;
  if (!isPositiveBoundedInteger(width, 100_000) || !isPositiveBoundedInteger(height, 100_000)) {
    return invalid('Invalid structured metadata viewport');
  }
  if (
    typeof value.timestamp !== 'string' ||
    value.timestamp.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.timestamp) ||
    Number.isNaN(Date.parse(value.timestamp))
  ) {
    return invalid('Invalid structured metadata timestamp');
  }

  const metadata: FeedbackMetadata = {
    url: redactedUrl,
    userAgent: value.userAgent,
    viewport: { width, height },
    timestamp: value.timestamp,
  };
  if (value.appVersion !== undefined) {
    const appVersion = parseAppVersion(value.appVersion);
    if (!appVersion) return invalid('Invalid structured metadata appVersion');
    metadata.appVersion = appVersion;
  }
  for (const key of [
    'elementSelector',
    'fullElementSelector',
    'selectedElementHighlightColor',
    'language',
  ] as const) {
    const optionalValue = value[key];
    if (optionalValue === undefined) continue;
    if (typeof optionalValue !== 'string' || optionalValue.length > 2_048) {
      return invalid(`Invalid structured metadata ${key}`);
    }
    metadata[key] = optionalValue;
  }
  for (const key of ['browser', 'os'] as const) {
    const optionalValue = value[key];
    if (optionalValue === undefined) continue;
    if (
      !isPlainObject(optionalValue) ||
      !hasOnlyKeys(optionalValue, new Set(['name', 'version'])) ||
      typeof optionalValue.name !== 'string' ||
      typeof optionalValue.version !== 'string' ||
      !optionalValue.name ||
      optionalValue.name.length > 120 ||
      optionalValue.version.length > 120
    ) {
      return invalid(`Invalid structured metadata ${key}`);
    }
    metadata[key] = { name: optionalValue.name, version: optionalValue.version };
  }
  if (value.devicePixelRatio !== undefined) {
    if (
      typeof value.devicePixelRatio !== 'number' ||
      !Number.isFinite(value.devicePixelRatio) ||
      value.devicePixelRatio <= 0 ||
      value.devicePixelRatio > 10
    ) {
      return invalid('Invalid structured metadata devicePixelRatio');
    }
    metadata.devicePixelRatio = value.devicePixelRatio;
  }

  return { valid: true, metadata };
}

function resolveVariantLabels(
  rawConfig: string | undefined,
  repo: string,
  variantId: string,
  classification: StructuredFeedbackClassification | undefined
): LabelResolution {
  const fallback = defaultLabels(classification);
  if (!rawConfig) return { labels: fallback, warnings: [], usedCustomLabels: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return labelFallback(fallback, 'Invalid server variant label config: malformed JSON.');
  }
  if (!isPlainObject(parsed)) {
    return labelFallback(fallback, 'Invalid server variant label config: expected an object.');
  }
  const repoConfig = parsed[repo] ?? parsed['*'];
  if (!isPlainObject(repoConfig)) {
    return labelFallback(
      fallback,
      `Server variant label config has no mapping for ${formatInlineCode(repo)} and no wildcard fallback.`
    );
  }
  if (!(variantId in repoConfig)) {
    return labelFallback(
      fallback,
      `Server variant label config has no mapping for ${formatInlineCode(`${repo}:${variantId}`)}.`
    );
  }

  const normalized = normalizeLabels(repoConfig[variantId]);
  if (!normalized.valid) return labelFallback(fallback, normalized.warning);
  return {
    labels: addBugDropLabel(normalized.labels),
    warnings: [],
    usedCustomLabels: true,
  };
}

function normalizeLabels(
  value: unknown
): { valid: true; labels: string[] } | { valid: false; warning: string } {
  const rawLabels = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!rawLabels || rawLabels.length === 0 || rawLabels.length > MAX_LABELS) {
    return {
      valid: false,
      warning: `Invalid server variant labels: expected 1-${MAX_LABELS} labels.`,
    };
  }

  const labels: string[] = [];
  for (const value of rawLabels) {
    if (
      typeof value !== 'string' ||
      hasControlChars(value) ||
      !value.trim() ||
      value.trim().length > MAX_LABEL_CHARS
    ) {
      return {
        valid: false,
        warning: `Invalid server variant labels: labels must be 1-${MAX_LABEL_CHARS} characters without control characters.`,
      };
    }
    labels.push(value.trim());
  }
  return { valid: true, labels: [...new Set(labels)] };
}

function defaultLabels(classification: StructuredFeedbackClassification | undefined): string[] {
  const labels =
    classification === 'bug'
      ? ['bug']
      : classification === 'feature'
        ? ['enhancement']
        : classification === 'question'
          ? ['question']
          : [];
  return addBugDropLabel(labels);
}

function addBugDropLabel(labels: string[]): string[] {
  return [...new Set([...labels, 'bugdrop'])];
}

function labelFallback(labels: string[], warning: string): LabelResolution {
  return { labels, warnings: [warning], usedCustomLabels: false };
}

function formatStructuredIssueBody(payload: StructuredFeedbackPayload, warnings: string[]): string {
  const sections: string[] = [];
  for (const section of payload.issue.sections) {
    sections.push(`## ${escapeMarkdownLiteral(section.heading)}`);
    sections.push('');
    sections.push(formatSectionValue(section.value, section.format ?? 'text'));
    sections.push('');
  }
  if (warnings.length > 0) {
    sections.push('## Label mapping warning', '');
    for (const warning of warnings) sections.push(`- ${escapeMarkdownLiteral(warning)}`);
    sections.push('');
  }

  sections.push('<details>', '<summary>System Info</summary>', '');
  sections.push('| Property | Value |', '|----------|-------|');
  if (payload.metadata.appVersion) {
    sections.push(
      `| **App Version** | ${formatMarkdownTableCodeSpan(payload.metadata.appVersion)} |`
    );
  }
  if (payload.metadata.browser) {
    sections.push(
      `| **Browser** | ${escapeTableValue(`${payload.metadata.browser.name} ${payload.metadata.browser.version}`.trim())} |`
    );
  }
  if (payload.metadata.os) {
    sections.push(
      `| **OS** | ${escapeTableValue(`${payload.metadata.os.name} ${payload.metadata.os.version}`.trim())} |`
    );
  }
  const ratio = payload.metadata.devicePixelRatio ? ` @${payload.metadata.devicePixelRatio}x` : '';
  sections.push(
    `| **Viewport** | ${payload.metadata.viewport.width}×${payload.metadata.viewport.height}${ratio} |`
  );
  if (payload.metadata.language) {
    sections.push(`| **Language** | ${escapeTableValue(payload.metadata.language)} |`);
  }
  sections.push(`| **Page** | ${escapeTableValue(payload.metadata.url)} |`);
  sections.push(`| **Timestamp** | ${escapeTableValue(payload.metadata.timestamp)} |`);
  sections.push('', '</details>', '');
  sections.push(`<!-- bugdrop-submission: ${payload.submissionId} -->`, '');
  sections.push('---');
  sections.push('*Submitted via [BugDrop](https://github.com/mean-weasel/bugdrop)*');
  return sections.join('\n');
}

function formatSectionValue(value: string, format: StructuredFeedbackSectionFormat): string {
  const normalized = normalizeMultilineText(value);
  if (format === 'code') return formatFencedBlock(normalized);
  const escaped = escapeMarkdownLiteral(normalized);
  if (format === 'quote')
    return escaped
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
  return escaped;
}

function normalizeMultilineText(value: string): string {
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) {
      normalized += '\n';
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      normalized += ' ';
    } else {
      normalized += value[index];
    }
  }
  return normalized;
}

function escapeTableValue(value: string): string {
  return escapeMarkdownLiteral(normalizeMultilineText(value).replace(/\n/g, ' '));
}

function formatFencedBlock(value: string): string {
  const runs = value.match(/`+/g);
  const length = Math.max(3, runs ? Math.max(...runs.map(run => run.length)) + 1 : 3);
  const fence = '`'.repeat(length);
  return `${fence}\n${value}\n${fence}`;
}

function formatInlineCode(value: string): string {
  return formatMarkdownCodeSpan(value);
}

function formatLabelList(labels: string[]): string {
  return labels.map(formatInlineCode).join(', ');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function invalid(error: string): { valid: false; error: string } {
  return { valid: false, error };
}

function firstUnknownKey(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find(key => !allowed.has(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return firstUnknownKey(value, allowed) === undefined;
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
