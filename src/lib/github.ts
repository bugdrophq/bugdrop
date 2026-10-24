import { managedCanaryBlocked } from './managed-canary-exclusion';
import { generateGitHubAppJWT } from './jwt';
import type { Env, FeedbackAttachment, GitHubIssue } from '../types';

export const GITHUB_API = 'https://api.github.com';

/**
 * Thrown when GitHub rejects an issue creation specifically due to invalid
 * labels — the only failure for which the caller may safely retry with
 * default labels. Distinguishing this from a generic API error prevents
 * fragile substring matching on error messages.
 */
export class GitHubLabelError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubLabelError';
    this.status = status;
  }
}

export const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'BugDrop/1.0',
  'X-GitHub-Api-Version': '2022-11-28',
});

/**
 * Get installation ID for a repository
 */
async function getInstallationId(env: Env, owner: string, repo: string): Promise<number | null> {
  if (managedCanaryBlocked(env, owner)) return null;
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error('Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY');
    return null;
  }

  const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
    headers: githubHeaders(jwt),
  });

  if (!response.ok) {
    console.error(`Installation not found: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as { id?: unknown };
  if (managedCanaryBlocked(env, owner, data)) return null;
  return typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0
    ? data.id
    : null;
}

export interface InstallationAccess {
  installationId: number;
  token: string;
}

/**
 * Get installation access token (scoped to installed repos)
 */
export async function getInstallationToken(
  env: Env,
  owner: string,
  repo: string
): Promise<string | null> {
  return (await getInstallationAccess(env, owner, repo))?.token ?? null;
}

/**
 * Get both the installation ID and its repository-scoped access token.
 */
export async function getInstallationAccess(
  env: Env,
  owner: string,
  repo: string
): Promise<InstallationAccess | null> {
  const installationId = await getInstallationId(env, owner, repo);
  if (!installationId) return null;

  const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(jwt),
  });

  if (!response.ok) {
    console.error(`Failed to get token: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as { token?: unknown };
  return typeof data.token === 'string' && data.token.length > 0
    ? { installationId, token: data.token }
    : null;
}

/**
 * Create a GitHub issue
 */
export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[] = ['feedback']
): Promise<GitHubIssue> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ title, body, labels }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 422 && isLabelValidationFailure(errorText)) {
      throw new GitHubLabelError(`GitHub rejected labels: ${errorText}`, response.status);
    }
    throw new Error(`Failed to create issue: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * GitHub returns 422 with `{"errors":[{"field":"labels",...}]}` when an issue
 * is rejected for invalid/non-existent labels. Parse the structured response
 * rather than substring-matching the message — substring matches over user-
 * controlled error text drift silently.
 */
function isLabelValidationFailure(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ field?: unknown }>;
    };
    return Array.isArray(parsed.errors) && parsed.errors.some(e => e?.field === 'labels');
  } catch {
    return false;
  }
}

/**
 * Check if a repository is public
 */
export async function isRepoPublic(token: string, owner: string, repo: string): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: githubHeaders(token),
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as { private: boolean };
    return !data.private;
  } catch {
    return false;
  }
}

const SCREENSHOT_BRANCH = 'bugdrop-screenshots';

/**
 * Ensure the screenshot branch exists, creating it from the default branch if needed.
 */
async function ensureScreenshotBranch(token: string, owner: string, repo: string): Promise<void> {
  // Check if branch already exists
  const check = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${SCREENSHOT_BRANCH}`,
    { headers: githubHeaders(token) }
  );
  if (check.ok) return;
  if (check.status !== 404) {
    throw new Error(`Failed to check screenshot branch: ${check.status}`);
  }

  // Get default branch SHA
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: githubHeaders(token),
  });
  if (!repoRes.ok) {
    throw new Error(`Failed to get repo info: ${repoRes.status}`);
  }
  const repoData = (await repoRes.json()) as { default_branch: string };

  const refRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`,
    { headers: githubHeaders(token) }
  );
  if (!refRes.ok) {
    throw new Error(`Failed to get default branch ref: ${refRes.status}`);
  }
  const refData = (await refRes.json()) as { object: { sha: string } };

  // Create the screenshot branch
  const createRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      ref: `refs/heads/${SCREENSHOT_BRANCH}`,
      sha: refData.object.sha,
    }),
  });
  if (!createRes.ok) {
    const error = await createRes.text();
    if (createRes.status === 422 && isExistingReferenceError(error)) {
      const recheck = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${SCREENSHOT_BRANCH}`,
        { headers: githubHeaders(token) }
      );
      if (recheck.ok) return;
    }
    throw new Error(`Failed to create screenshot branch: ${createRes.status} - ${error}`);
  }
}

function isExistingReferenceError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return parsed.message === 'Reference already exists';
  } catch {
    return false;
  }
}

/**
 * Upload screenshot to a dedicated branch and return a permanent URL for embedding in issues.
 * Uses a separate branch (bugdrop-screenshots) to avoid conflicts with branch protection
 * rules on the default branch. The branch is auto-created on first use.
 * Uses the blob html_url (with ?raw=true) instead of download_url, because
 * download_url includes a temporary token that expires on private repos.
 * Requires Contents:write permission on the GitHub App.
 */
export async function uploadScreenshotAsAsset(
  token: string,
  owner: string,
  repo: string,
  base64DataUrl: string
): Promise<string> {
  // Remove data URL prefix and extract the base64 content
  const content = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');

  // Retain the timestamp for traceability and add per-upload cryptographic entropy.
  const timestamp = Date.now();
  const filename = `.bugdrop/screenshots/${timestamp}-${crypto.randomUUID()}.png`;

  return uploadBase64Asset(
    token,
    owner,
    repo,
    filename,
    content,
    `Add BugDrop screenshot ${timestamp}`
  );
}

export async function uploadAttachmentAsAsset(
  token: string,
  owner: string,
  repo: string,
  attachment: FeedbackAttachment
): Promise<string> {
  const timestamp = Date.now();
  const filename = `.bugdrop/uploads/${timestamp}-${crypto.randomUUID()}-${sanitizeAttachmentFilename(attachment.name)}`;
  const content = attachment.dataUrl.replace(/^data:[^;]+;base64,/, '');

  return uploadBase64Asset(
    token,
    owner,
    repo,
    filename,
    content,
    `Add BugDrop upload ${timestamp}`
  );
}

async function uploadBase64Asset(
  token: string,
  owner: string,
  repo: string,
  filename: string,
  content: string,
  message: string
): Promise<string> {
  // Ensure the screenshot branch exists
  await ensureScreenshotBranch(token, owner, repo);

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${filename}`, {
    method: 'PUT',
    headers: githubHeaders(token),
    body: JSON.stringify({
      message,
      content: content,
      branch: SCREENSHOT_BRANCH,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload screenshot: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as { content: { html_url: string } };
  return data.content.html_url + '?raw=true';
}

function sanitizeAttachmentFilename(name: string): string {
  const safe = name
    .trim()
    .replace(/[/\\]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return safe || 'upload';
}
