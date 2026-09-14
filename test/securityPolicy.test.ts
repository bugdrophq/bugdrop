import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryPolicy = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
const websitePolicy = readFileSync(
  new URL('../docs/website/security.mdx', import.meta.url),
  'utf8'
);

const privateReportUrl = 'https://github.com/bugdrophq/bugdrop/security/advisories/new';
const fallbackEmails = ['mailto:neonwatty@gmail.com', 'mailto:jeremy@mean-weasel.com'];

describe('security reporting policy', () => {
  it.each([
    ['repository policy', repositoryPolicy],
    ['website policy', websitePolicy],
  ])('publishes the same private reporting channels in the %s', (_name, policy) => {
    expect(policy).toContain(privateReportUrl);
    for (const email of fallbackEmails) {
      expect(policy).toContain(email);
    }
  });

  it('defines the maintained versions and intake process', () => {
    expect(repositoryPolicy).toContain('## Supported Versions');
    expect(repositoryPolicy).toContain('latest stable release');
    expect(repositoryPolicy).toContain('not end-to-end encrypted');
    expect(repositoryPolicy).toContain('## Triage and Coordinated Disclosure');
    expect(repositoryPolicy).toContain('dependency');
  });

  it('points website readers to the canonical repository policy', () => {
    expect(websitePolicy).toContain('https://github.com/bugdrophq/bugdrop/security/policy');
  });
});
