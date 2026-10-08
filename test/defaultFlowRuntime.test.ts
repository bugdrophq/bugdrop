import { describe, expect, it, vi } from 'vitest';
import { runDefaultJourney, type DefaultJourneyPorts } from '../src/widget/default-flow/runtime';
import { normalizeDefaultDefinition } from '../src/widget/default-flow/definition';
import type {
  DefaultDetailsStep,
  DefaultScreenshotStep,
} from '../src/widget/default-flow/definition';

type Details = { title: string };
type Capture = { screenshot: string | null };

function createPorts(
  overrides: Partial<DefaultJourneyPorts<Details, Capture>> = {}
): DefaultJourneyPorts<Details, Capture> {
  return {
    preflight: vi.fn(async () => ({ status: 'installed' as const })),
    showPreflightFailure: vi.fn(),
    showWelcome: vi.fn(async () => true),
    rememberWelcome: vi.fn(),
    showDetails: vi.fn(async () => ({ title: 'kept' })),
    capture: vi.fn(async () => ({ screenshot: 'image', returnToDetails: false })),
    submit: vi.fn(async () => undefined),
    ...overrides,
  };
}

function definition(welcome: 'once' | 'always' | 'never' = 'once') {
  return normalizeDefaultDefinition({
    repo: 'owner/repo',
    apiUrl: 'https://bugdrop.example/api',
    welcome,
    screenshotMode: 'optional',
    skipWelcome: false,
    hasSeenWelcome: false,
    showName: false,
    requireName: false,
    showEmail: false,
    requireEmail: false,
    sendConsoleLogs: false,
    issueLinkVisibility: 'public',
  });
}

describe('private default journey runtime', () => {
  it('runs welcome, details, capture, and submission in order', async () => {
    const trace: string[] = [];
    const ports = createPorts({
      showWelcome: async () => (trace.push('welcome'), true),
      rememberWelcome: () => trace.push('remember-welcome'),
      showDetails: async step => (trace.push(`details:${step.kind}`), { title: 'report' }),
      capture: async step => (
        trace.push(`capture:${step.mode}`),
        { screenshot: 'image', returnToDetails: false }
      ),
      submit: async (recipe, details, capture) => {
        trace.push(`recipe:${recipe.kind}`);
        trace.push(`submit:${details.title}:${capture.screenshot}`);
      },
    });

    await runDefaultJourney(definition(), ports);

    expect(trace).toEqual([
      'welcome',
      'remember-welcome',
      'details:details',
      'capture:optional',
      'recipe:legacy-feedback',
      'submit:report:image',
    ]);
  });

  it('stops when welcome is closed without remembering it', async () => {
    const ports = createPorts({ showWelcome: vi.fn(async () => false) });

    await runDefaultJourney(definition(), ports);

    expect(ports.rememberWelcome).not.toHaveBeenCalled();
    expect(ports.showDetails).not.toHaveBeenCalled();
  });

  it('skips welcome and stops when details are cancelled', async () => {
    const ports = createPorts({
      showDetails: vi.fn(async () => null),
    });

    await runDefaultJourney(definition('never'), ports);

    expect(ports.showWelcome).not.toHaveBeenCalled();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
  });

  it('returns to details with retained answers before submitting', async () => {
    const first = { title: 'retained' };
    const second = { title: 'updated' };
    const showDetails = vi
      .fn<(_step: DefaultDetailsStep, previous: Details | null) => Promise<Details | null>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const capture = vi
      .fn<
        (
          _step: DefaultScreenshotStep,
          details: Details
        ) => Promise<Capture & { returnToDetails: boolean }>
      >()
      .mockResolvedValueOnce({ screenshot: null, returnToDetails: true })
      .mockResolvedValueOnce({ screenshot: 'final', returnToDetails: false });
    const ports = createPorts({ showDetails, capture });

    await runDefaultJourney(definition('never'), ports);

    expect(showDetails).toHaveBeenNthCalledWith(1, definition('never').steps[1], null);
    expect(showDetails).toHaveBeenNthCalledWith(2, definition('never').steps[1], first);
    expect(capture).toHaveBeenNthCalledWith(1, definition('never').steps[2], first);
    expect(capture).toHaveBeenNthCalledWith(2, definition('never').steps[2], second);
    expect(ports.submit).toHaveBeenCalledWith(definition('never').system.submission, second, {
      screenshot: 'final',
      returnToDetails: false,
    });
  });

  it('does not revisit details or submit when capture is aborted by the host', async () => {
    const controller = new AbortController();
    const ports = createPorts({
      capture: vi.fn(async () => {
        controller.abort();
        return { screenshot: null, returnToDetails: true };
      }),
    });

    await runDefaultJourney(definition('never'), ports, controller.signal);

    expect(ports.showDetails).toHaveBeenCalledTimes(1);
    expect(ports.submit).not.toHaveBeenCalled();
  });

  it.each(['not_installed', 'unreachable'] as const)(
    'owns %s preflight and stops before user steps',
    async status => {
      const ports = createPorts({
        preflight: vi.fn(async () => ({ status, appName: 'test-app' })),
      });

      await expect(runDefaultJourney(definition(), ports)).resolves.toBe('preflight-blocked');

      expect(ports.showPreflightFailure).toHaveBeenCalledWith({ status, appName: 'test-app' });
      expect(ports.showWelcome).not.toHaveBeenCalled();
      expect(ports.showDetails).not.toHaveBeenCalled();
    }
  );
});
