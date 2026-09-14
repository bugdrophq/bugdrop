const REPO = 'mean-weasel/bugdrop-widget-test';
const MIGRATION_REPOSITORIES = Object.freeze([REPO, 'bugdrophq/bugdrop-widget-test']);

const PROFILES = Object.freeze({
  preview: Object.freeze({
    id: 'preview',
    repo: REPO,
    venueOrigin: 'https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app',
    widgetOrigin: 'https://bugdrop-preview.neonwatty.workers.dev',
    titlePrefix: '[BugDrop CI canary]',
    markerPattern: /^bugdrop-ci-canary:[0-9]+:[0-9]+:[a-f0-9]{40}$/,
    variantId: 'merge-queue-canary',
    dialogTitle: 'Merge-queue canary',
  }),
  production: Object.freeze({
    id: 'production',
    repo: REPO,
    venueOrigin: 'https://bugdrop-widget-test.vercel.app',
    widgetOrigin: 'https://bugdrop.neonwatty.workers.dev',
    titlePrefix: '[BugDrop production heartbeat]',
    markerPattern: /^bugdrop-production-heartbeat:[0-9]+:[0-9]+:[a-f0-9]{40}$/,
    variantId: 'production-heartbeat',
    dialogTitle: 'Production heartbeat',
    expectedAuthor: 'neonwatty-bugdrop[bot]',
    expectedLabels: Object.freeze(['bug', 'bugdrop']),
  }),
});

const CANARY_PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));
export const PREVIEW_CANARY_PROFILE = PROFILES.preview;
export const PRODUCTION_CANARY_PROFILE = PROFILES.production;

export function isSameGitHubRepository(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export function isGitHubIssueUrlForRepository(value, repo, number) {
  if (typeof value !== 'string' || !Number.isInteger(number) || number <= 0) return false;
  const repositoryParts = repo.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some(part => !part)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const pathParts = url.pathname.split('/');
  return (
    url.origin === 'https://github.com' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    pathParts.length === 5 &&
    pathParts[1].toLowerCase() === repositoryParts[0].toLowerCase() &&
    pathParts[2].toLowerCase() === repositoryParts[1].toLowerCase() &&
    pathParts[3] === 'issues' &&
    pathParts[4] === String(number)
  );
}

export function getCanaryProfile(name, environment = process.env) {
  const profile =
    name === 'production'
      ? runtimeProductionProfile(environment)
      : name === 'preview'
        ? runtimePreviewProfile(environment)
        : undefined;
  if (!profile) {
    throw new Error(
      `Unknown canary profile: ${name || '(missing)'}; expected ${CANARY_PROFILE_NAMES.join(' or ')}`
    );
  }
  return profile;
}

function runtimePreviewProfile(environment) {
  const repo = environment.BUGDROP_CANARY_REPO?.trim() || REPO;
  if (!MIGRATION_REPOSITORIES.some(candidate => isSameGitHubRepository(repo, candidate))) {
    throw new Error('Preview canary repository is not an approved BugDrop migration target');
  }
  if (isSameGitHubRepository(repo, REPO)) return PROFILES.preview;
  return Object.freeze({ ...PROFILES.preview, repo });
}

export function validateCanarySelector({
  profile: profileName,
  repo,
  marker,
  prefix,
  expectedWorkerSha,
  environment = process.env,
}) {
  const profile = getCanaryProfile(profileName, environment);
  requireExact(repo, profile.repo, 'repo', profile.id);
  if (Boolean(marker) === Boolean(prefix)) {
    throw new Error('Exactly one of marker or prefix is required');
  }
  if (marker) {
    if (!profile.markerPattern.test(marker)) {
      throw new Error(`marker does not match the ${profile.id} canary profile`);
    }
    if (expectedWorkerSha !== undefined) {
      if (!/^[a-f0-9]{40}$/.test(expectedWorkerSha)) {
        throw new Error('expected Worker SHA must be a full lowercase Git SHA');
      }
      if (!marker.endsWith(`:${expectedWorkerSha}`)) {
        throw new Error(`marker does not end with the expected Worker SHA for ${profile.id}`);
      }
    }
    return { profile, marker };
  }
  requireExact(prefix, profile.titlePrefix, 'prefix', profile.id);
  return { profile, prefix };
}

export function resolveBrowserCanaryProfile({
  profile: profileName,
  repo,
  venueOrigin,
  widgetOrigin,
  marker,
  expectedWorkerSha,
  environment = process.env,
}) {
  const profile = getCanaryProfile(profileName, environment);
  requireExact(repo, profile.repo, 'repo', profile.id);
  requireExact(
    normalizeOrigin(venueOrigin, 'venue origin'),
    profile.venueOrigin,
    'venue origin',
    profile.id
  );
  requireExact(
    normalizeOrigin(widgetOrigin, 'widget origin'),
    profile.widgetOrigin,
    'widget origin',
    profile.id
  );
  if (!profile.markerPattern.test(marker)) {
    throw new Error(`marker does not match the ${profile.id} canary profile`);
  }
  if (!/^[a-f0-9]{40}$/.test(expectedWorkerSha)) {
    throw new Error('expected Worker SHA must be a full lowercase Git SHA');
  }
  if (!marker.endsWith(`:${expectedWorkerSha}`)) {
    throw new Error(`marker does not end with the expected Worker SHA for ${profile.id}`);
  }
  return profile;
}

function runtimeProductionProfile(environment) {
  const values = {
    repo: environment.BUGDROP_CANARY_REPO?.trim(),
    venueOrigin: environment.PLAYWRIGHT_BASE_URL?.trim(),
    widgetOrigin: environment.EXPECTED_WIDGET_ORIGIN?.trim(),
    expectedAuthor: environment.BUGDROP_CANARY_EXPECTED_AUTHOR?.trim(),
    expectedLabels: environment.BUGDROP_CANARY_EXPECTED_LABELS_JSON?.trim(),
  };
  const configured = Object.values(values).some(Boolean);
  if (!configured) return PROFILES.production;
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Production canary runtime configuration is incomplete: ${missing.join(', ')}`);
  }
  let expectedLabels;
  try {
    expectedLabels = JSON.parse(values.expectedLabels);
  } catch {
    throw new Error('Production canary expected labels must be valid JSON');
  }
  if (
    !Array.isArray(expectedLabels) ||
    expectedLabels.length === 0 ||
    expectedLabels.some(label => typeof label !== 'string' || !label)
  ) {
    throw new Error('Production canary expected labels must be a non-empty string array');
  }
  return Object.freeze({
    ...PROFILES.production,
    repo: values.repo,
    venueOrigin: normalizeOrigin(values.venueOrigin, 'venue origin'),
    widgetOrigin: normalizeOrigin(values.widgetOrigin, 'widget origin'),
    expectedAuthor: values.expectedAuthor,
    expectedLabels: Object.freeze(expectedLabels),
  });
}

function normalizeOrigin(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an HTTPS origin`);
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error(`${field} must be an HTTPS origin without a path or credentials`);
  }
  return value;
}

function requireExact(actual, expected, field, profile) {
  if (actual !== expected) {
    throw new Error(`${field} must equal ${expected} for the ${profile} canary profile`);
  }
}
