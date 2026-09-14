import { describe, expect, it } from 'vitest';

import {
  CANONICAL_HEARTBEAT_CONFIG,
  heartbeatEnvironment,
  resolveProductionHeartbeatConfig,
} from '../scripts/production-heartbeat-config.mjs';

const SELF_HOSTED = {
  BUGDROP_HEARTBEAT_WIDGET_ORIGIN: 'https://bugdrop.example.com',
  BUGDROP_HEARTBEAT_VENUE_ORIGIN: 'https://heartbeat.example.com',
  BUGDROP_HEARTBEAT_TEST_REPO: 'acme/bugdrop-heartbeat-test',
  BUGDROP_HEARTBEAT_EXPECTED_AUTHOR: 'acme-bugdrop[bot]',
  BUGDROP_HEARTBEAT_EXPECTED_LABELS: 'bug, bugdrop',
};

describe('production heartbeat configuration', () => {
  it('uses canonical defaults only in the canonical repository', () => {
    expect(resolveProductionHeartbeatConfig({ repository: 'mean-weasel/bugdrop' })).toEqual(
      CANONICAL_HEARTBEAT_CONFIG
    );
    expect(resolveProductionHeartbeatConfig({ repository: 'bugdrophq/bugdrop' })).toEqual(
      CANONICAL_HEARTBEAT_CONFIG
    );
    expect(() => resolveProductionHeartbeatConfig({ repository: 'acme/bugdrop' })).toThrow(
      'configuration is incomplete'
    );
  });

  it('switches only the canonical test repository during migration', () => {
    expect(
      resolveProductionHeartbeatConfig({
        repository: 'bugdrophq/bugdrop',
        variables: { BUGDROP_TEST_REPOSITORY: 'bugdrophq/bugdrop-widget-test' },
      })
    ).toEqual({
      ...CANONICAL_HEARTBEAT_CONFIG,
      testRepo: 'bugdrophq/bugdrop-widget-test',
    });
  });

  it('rejects an unapproved canonical test-repository migration target', () => {
    expect(() =>
      resolveProductionHeartbeatConfig({
        repository: 'bugdrophq/bugdrop',
        variables: { BUGDROP_TEST_REPOSITORY: 'someone-else/bugdrop-widget-test' },
      })
    ).toThrow('not an approved BugDrop migration target');
  });

  it('rejects mixed migration and self-hosted heartbeat overrides', () => {
    expect(() =>
      resolveProductionHeartbeatConfig({
        repository: 'bugdrophq/bugdrop',
        variables: {
          BUGDROP_TEST_REPOSITORY: 'bugdrophq/bugdrop-widget-test',
          BUGDROP_HEARTBEAT_EXPECTED_LABELS: 'bug,bugdrop',
        },
      })
    ).toThrow('cannot be combined');
  });

  it('accepts a complete self-hosted configuration and exports bounded runtime values', () => {
    const config = resolveProductionHeartbeatConfig({
      repository: 'acme/bugdrop',
      variables: SELF_HOSTED,
    });
    expect(heartbeatEnvironment(config, 'acme/bugdrop')).toEqual({
      EXPECTED_WIDGET_ORIGIN: 'https://bugdrop.example.com',
      PLAYWRIGHT_BASE_URL: 'https://heartbeat.example.com',
      BUGDROP_CANARY_REPO: 'acme/bugdrop-heartbeat-test',
      BUGDROP_CANARY_REPO_OWNER: 'acme',
      BUGDROP_CANARY_REPO_NAME: 'bugdrop-heartbeat-test',
      BUGDROP_CANARY_EXPECTED_AUTHOR: 'acme-bugdrop[bot]',
      BUGDROP_CANARY_EXPECTED_LABELS_JSON: '["bug","bugdrop"]',
      BUGDROP_HEARTBEAT_INCIDENT_REPO: 'acme/bugdrop',
    });
  });

  it.each([
    ['partial configuration', { ...SELF_HOSTED, BUGDROP_HEARTBEAT_TEST_REPO: '' }],
    [
      'non-HTTPS widget',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_WIDGET_ORIGIN: 'http://bugdrop.example.com' },
    ],
    [
      'origin with a path',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_VENUE_ORIGIN: 'https://heartbeat.example.com/test' },
    ],
    [
      'operational repo reused as test repo',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_TEST_REPO: 'acme/bugdrop' },
    ],
    [
      'case-aliased operational repo reused as test repo',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_TEST_REPO: 'ACME/BugDrop' },
    ],
    [
      'venue and widget sharing an origin',
      {
        ...SELF_HOSTED,
        BUGDROP_HEARTBEAT_VENUE_ORIGIN: SELF_HOSTED.BUGDROP_HEARTBEAT_WIDGET_ORIGIN,
      },
    ],
    [
      'expected labels without the invariant bugdrop label',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_EXPECTED_LABELS: 'synthetic' },
    ],
    [
      'expected labels containing control characters',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_EXPECTED_LABELS: 'bugdrop,synthetic\tlabel' },
    ],
    [
      'case-aliased duplicate expected labels',
      { ...SELF_HOSTED, BUGDROP_HEARTBEAT_EXPECTED_LABELS: 'bug,BugDrop,bugdrop' },
    ],
    ['repository traversal', { ...SELF_HOSTED, BUGDROP_HEARTBEAT_TEST_REPO: 'acme/..' }],
  ])('rejects %s', (_description, variables) => {
    expect(() =>
      resolveProductionHeartbeatConfig({ repository: 'acme/bugdrop', variables })
    ).toThrow();
  });

  it('does not permit partial overrides of canonical defaults', () => {
    expect(() =>
      resolveProductionHeartbeatConfig({
        repository: 'mean-weasel/bugdrop',
        variables: { BUGDROP_HEARTBEAT_WIDGET_ORIGIN: 'https://other.example.com' },
      })
    ).toThrow('configuration is incomplete');
  });
});
