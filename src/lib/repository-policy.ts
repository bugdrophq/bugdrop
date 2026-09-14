const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_NAME_PATTERN.test(value);
}

/** Optional exact repository boundary; absent, blank, or standalone '*' is unrestricted. */
export function isRepositoryAllowed(
  configuredRepositories: string | undefined,
  repo: string
): boolean {
  const configured = configuredRepositories?.trim();
  if (!configured || configured === '*') return true;

  return configured
    .split(/[,\n]/)
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(repo.trim().toLowerCase());
}
