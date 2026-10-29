import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  INSTALLATION_COUNT_CRON,
  INSTALLATION_COUNT_KEY,
} from '../src/lib/public-installation-count';
const mocks = vi.hoisted(() => ({ list: vi.fn(), sweep: vi.fn(), reconcile: vi.fn() }));
vi.mock('../src/lib/github-installation-inventory', () => ({
  listActiveGitHubInstallations: mocks.list,
}));
vi.mock('../src/lib/installation-retention', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/installation-retention')>()),
  sweepInstallationRecords: mocks.sweep,
}));
vi.mock('../src/lib/installation-reconciliation', () => ({
  reconcileInstallationRecords: mocks.reconcile,
}));
import { scheduled } from '../src/index';

const controller = (cron: string) => ({ cron }) as ScheduledController;
const context = {} as ExecutionContext;

describe('hourly installation total publication', () => {
  beforeEach(() => vi.resetAllMocks());

  it('does not publish a partial result or erase the previous total when GitHub pagination fails', async () => {
    const previous = 'last verified snapshot';
    const values = new Map([[INSTALLATION_COUNT_KEY, previous]]);
    const put = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const env = { INSTALLATION_ANALYTICS: { put } } as unknown as Env;
    mocks.list.mockRejectedValue(new Error('GitHub page 2 unavailable'));
    await expect(scheduled(controller(INSTALLATION_COUNT_CRON), env, context)).rejects.toThrow(
      'page 2'
    );
    expect(put).not.toHaveBeenCalled();
    expect(values.get(INSTALLATION_COUNT_KEY)).toBe(previous);
    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it('publishes an aggregate hourly without running identity reconciliation or deletion', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { INSTALLATION_ANALYTICS: { put } } as unknown as Env;
    mocks.list.mockResolvedValue({
      installationIds: Array.from({ length: 21 }, (_, i) => i),
      records: [],
      skippedCount: 21,
      pageCount: 1,
    });
    await scheduled(controller(INSTALLATION_COUNT_CRON), env, context);
    expect(JSON.parse(put.mock.calls[0][1])).toMatchObject({
      githubAppInstallations: 20,
      display: '20+',
    });
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('retains the existing daily cleanup path', async () => {
    const env = {} as Env;
    await scheduled(controller('17 3 * * *'), env, context);
    expect(mocks.sweep).toHaveBeenCalledWith(env, {
      listActiveInstallationIds: expect.any(Function),
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
