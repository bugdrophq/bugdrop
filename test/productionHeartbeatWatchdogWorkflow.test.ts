import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
const workflow = parse(readFileSync('.github/workflows/production-heartbeat.yml', 'utf8'));
type Step = {
  id?: string;
  if?: string;
  env?: Record<string, string>;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
const steps: Step[] = workflow.jobs.heartbeat.steps;
const step = (id: string): Step => steps.find(s => s.id === id)!;
describe('watchdog workflow safety contract', () => {
  it('cannot enter setup or submission when admission is denied or cancellation happened', () => {
    for (const id of [
      'node',
      'install',
      'config',
      'browser',
      'identity',
      'heartbeat-monitor-token',
      'preflight',
      'venue',
      'canary',
    ]) {
      expect(step(id).if).toContain('!cancelled()');
      expect(step(id).if).toContain("steps.admission.outputs.admitted == 'true'");
      expect(step(id).if).not.toContain('always()');
    }
    expect(step('admission').if).toContain('!cancelled()');
    expect(step('admission')['continue-on-error']).not.toBe(true);
    expect(steps.indexOf(step('admission'))).toBeLessThan(steps.indexOf(step('node')));
  });
  it('attempts cleanup and evidence after cancellation of an admitted transaction', () => {
    for (const id of [
      'verify',
      'evidence',
      'cleanup',
      'sweep',
      'summarize',
      'prepare-artifact',
      'artifact',
    ]) {
      expect(step(id).if).toContain('always()');
      expect(step(id).if).toContain("steps.admission.outputs.admitted == 'true'");
      expect(step(id).if).not.toContain('!cancelled()');
    }
    for (const id of ['incident', 'conclusion'])
      expect(workflow.jobs[id].if).toContain("needs.heartbeat.outputs.admitted == 'true'");
  });
  it('leaves at least two minutes of job budget for runner/action overhead', () => {
    const normal = steps.filter(s => s.id !== 'controlled');
    expect(normal.every(s => (s['timeout-minutes'] ?? 0) > 0)).toBe(true);
    expect(normal.reduce((sum, s) => sum + s['timeout-minutes']!, 0)).toBeLessThanOrEqual(
      workflow.jobs.heartbeat['timeout-minutes'] - 2
    );
    expect(step('browser')['timeout-minutes']).toBe(3);
  });
  it('keeps the admission credential in one step and preserves optional operator inputs', () => {
    expect(steps.filter(s => s.env?.WATCHDOG_ADMISSION_SECRET)).toEqual([step('admission')]);
    expect(workflow.on.workflow_dispatch.inputs.recovery_id.default).toBe('');
    expect(workflow.on.workflow_dispatch.inputs.controlled_failure.default).toBe(false);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('checkout failure regression', () => {
  it('preserves normal-run reporting without bypassing denied recovery admission', () => {
    expect(step('checkout')['continue-on-error']).not.toBe(true);
    for (const job of ['incident', 'conclusion']) {
      expect(workflow.jobs[job].if).toContain(
        "(!inputs.recovery_id || needs.heartbeat.outputs.admitted == 'true')"
      );
    }
  });
});
