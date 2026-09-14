import { describe, expect, it } from 'vitest';

import {
  PREVIEW_CANARY_PROFILE,
  PRODUCTION_CANARY_PROFILE,
  getCanaryProfile,
  isGitHubIssueUrlForRepository,
  isSameGitHubRepository,
  resolveBrowserCanaryProfile,
  validateCanarySelector,
} from '../scripts/github-issue-canary-profiles.mjs';

const SHA = 'a'.repeat(40);

describe('GitHub Issue canary profiles', () => {
  it('preserves the preview contract and reserves a distinct production namespace', () => {
    expect(PREVIEW_CANARY_PROFILE).toMatchObject({
      repo: 'mean-weasel/bugdrop-widget-test',
      titlePrefix: '[BugDrop CI canary]',
      widgetOrigin: 'https://bugdrop-preview.neonwatty.workers.dev',
      venueOrigin: 'https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app',
    });
    expect(PRODUCTION_CANARY_PROFILE).toMatchObject({
      repo: PREVIEW_CANARY_PROFILE.repo,
      titlePrefix: '[BugDrop production heartbeat]',
      widgetOrigin: 'https://bugdrop.neonwatty.workers.dev',
      venueOrigin: 'https://bugdrop-widget-test.vercel.app',
    });
    expect(PRODUCTION_CANARY_PROFILE.titlePrefix).not.toBe(PREVIEW_CANARY_PROFILE.titlePrefix);
  });

  it.each(['', 'staging', 'PREVIEW'])('rejects unknown profile %j', profile => {
    expect(() => getCanaryProfile(profile)).toThrow('Unknown canary profile');
  });

  it('accepts only the selected profile marker and exact reserved prefix', () => {
    expect(
      validateCanarySelector({
        profile: 'preview',
        repo: PREVIEW_CANARY_PROFILE.repo,
        marker: `bugdrop-ci-canary:123:1:${SHA}`,
      }).profile
    ).toBe(PREVIEW_CANARY_PROFILE);
    expect(() =>
      validateCanarySelector({
        profile: 'preview',
        repo: PREVIEW_CANARY_PROFILE.repo,
        marker: `bugdrop-production-heartbeat:123:1:${SHA}`,
      })
    ).toThrow('preview canary profile');
    expect(() =>
      validateCanarySelector({
        profile: 'production',
        repo: PRODUCTION_CANARY_PROFILE.repo,
        prefix: PREVIEW_CANARY_PROFILE.titlePrefix,
      })
    ).toThrow('production canary profile');
  });

  it('rejects repo and origin mismatches before a browser transaction can start', () => {
    const valid = {
      profile: 'production',
      repo: PRODUCTION_CANARY_PROFILE.repo,
      venueOrigin: PRODUCTION_CANARY_PROFILE.venueOrigin,
      widgetOrigin: PRODUCTION_CANARY_PROFILE.widgetOrigin,
      marker: `bugdrop-production-heartbeat:123:1:${SHA}`,
      expectedWorkerSha: SHA,
    };
    expect(resolveBrowserCanaryProfile(valid)).toBe(PRODUCTION_CANARY_PROFILE);
    expect(() => resolveBrowserCanaryProfile({ ...valid, repo: 'other/repo' })).toThrow('repo');
    expect(() =>
      resolveBrowserCanaryProfile({
        ...valid,
        widgetOrigin: PREVIEW_CANARY_PROFILE.widgetOrigin,
      })
    ).toThrow('widget origin');
    expect(() =>
      resolveBrowserCanaryProfile({
        ...valid,
        venueOrigin: PREVIEW_CANARY_PROFILE.venueOrigin,
      })
    ).toThrow('venue origin');
    expect(() =>
      resolveBrowserCanaryProfile({ ...valid, expectedWorkerSha: 'b'.repeat(40) })
    ).toThrow('expected Worker SHA');
  });

  it('binds the production profile to a complete self-hosted runtime configuration', () => {
    const environment = {
      BUGDROP_CANARY_REPO: 'acme/bugdrop-heartbeat-test',
      PLAYWRIGHT_BASE_URL: 'https://heartbeat.example.com',
      EXPECTED_WIDGET_ORIGIN: 'https://bugdrop.example.com',
      BUGDROP_CANARY_EXPECTED_AUTHOR: 'acme-bugdrop[bot]',
      BUGDROP_CANARY_EXPECTED_LABELS_JSON: '["bug","bugdrop"]',
    };
    const profile = resolveBrowserCanaryProfile({
      profile: 'production',
      repo: environment.BUGDROP_CANARY_REPO,
      venueOrigin: environment.PLAYWRIGHT_BASE_URL,
      widgetOrigin: environment.EXPECTED_WIDGET_ORIGIN,
      marker: `bugdrop-production-heartbeat:123:1:${SHA}`,
      expectedWorkerSha: SHA,
      environment,
    });
    expect(profile).toMatchObject({
      repo: 'acme/bugdrop-heartbeat-test',
      expectedAuthor: 'acme-bugdrop[bot]',
      expectedLabels: ['bug', 'bugdrop'],
    });
  });

  it('rejects a partial self-hosted runtime configuration', () => {
    expect(() => getCanaryProfile('production', { BUGDROP_CANARY_REPO: 'acme/test' })).toThrow(
      'runtime configuration is incomplete'
    );
  });

  it('allows preview canaries to follow the stable test repository across the organization move', () => {
    expect(
      getCanaryProfile('preview', {
        BUGDROP_CANARY_REPO: 'bugdrophq/bugdrop-widget-test',
      }).repo
    ).toBe('bugdrophq/bugdrop-widget-test');
    expect(() => getCanaryProfile('preview', { BUGDROP_CANARY_REPO: 'other/repository' })).toThrow(
      'approved BugDrop migration target'
    );
  });

  it('matches canonical GitHub Issue URLs without requiring repository display casing', () => {
    expect(
      isGitHubIssueUrlForRepository(
        'https://github.com/acme/heartbeat-test/issues/42',
        'Acme/Heartbeat-Test',
        42
      )
    ).toBe(true);
  });

  it('matches GitHub repository identity without requiring display casing', () => {
    expect(isSameGitHubRepository('Acme/Heartbeat-Test', 'acme/heartbeat-test')).toBe(true);
    expect(isSameGitHubRepository('acme/other', 'acme/heartbeat-test')).toBe(false);
    expect(isSameGitHubRepository(undefined, 'acme/heartbeat-test')).toBe(false);
  });

  it.each([
    'https://example.com/acme/heartbeat-test/issues/42',
    'https://github.com/acme/other/issues/42',
    'https://github.com/acme/heartbeat-test/issues/43',
    'https://github.com/acme/heartbeat-test/issues/42?tracked=true',
    'https://github.com/acme/heartbeat-test/issues/42/',
  ])('rejects non-canonical Issue URL %s', issueUrl => {
    expect(isGitHubIssueUrlForRepository(issueUrl, 'acme/heartbeat-test', 42)).toBe(false);
  });
});
