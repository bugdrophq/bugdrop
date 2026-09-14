import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FLOW_CAPABILITIES } from '../docs/website/flow-capabilities';
import { isWebsiteDocName, syncWebsiteDocs } from '../scripts/sync-website-docs.mjs';

const temporaryRoots: string[] = [];

async function temporaryWebsite(name = 'bugdrop-web') {
  const root = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), 'bugdrop-doc-sync-'))
  );
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name }));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true })));
});

describe('website documentation sync', () => {
  it('binds documented field limits and MIME values to the released validator source', async () => {
    const source = await readFile('src/widget/flows/field-validation.ts', 'utf8');
    const numericSource = source.replaceAll('_', '');
    const constraints = FLOW_CAPABILITIES.fields.constraints;

    expect(numericSource).toContain(
      `const minimum = field.minLength ?? ${constraints.text.minLength.default}`
    );
    expect(numericSource).toContain(
      `const maximum = field.maxLength ?? (field.type === 'shortText' ? ${constraints.text.maxLength.defaults.shortText} : ${constraints.text.maxLength.defaults.longText})`
    );
    expect(numericSource).toContain(
      `boundedInteger(minimum, ${constraints.text.minLength.minimum}, ${constraints.text.minLength.maximum})`
    );
    expect(numericSource).toContain(
      `boundedInteger(maximum, ${constraints.text.maxLength.minimum}, ${constraints.text.maxLength.maximum})`
    );
    expect(numericSource).toContain(
      `boundedInteger(field.rows, ${constraints.text.longTextRows.minimum}, ${constraints.text.longTextRows.maximum})`
    );
    expect(numericSource).toContain(
      `field.options.length < ${constraints.singleChoiceOptions.minimum} || field.options.length > ${constraints.singleChoiceOptions.maximum}`
    );
    expect(numericSource).toContain(
      `boundedInteger(field.maxFiles, ${constraints.attachments.maxFiles.minimum}, ${constraints.attachments.maxFiles.maximum})`
    );
    expect(numericSource).toContain(
      `field.maxFiles ?? ${constraints.attachments.maxFiles.default}`
    );
    expect(constraints.attachments.maxFileSizeBytes.maximum).toBe(5 * 1024 * 1024);
    expect(constraints.attachments.maxFileSizeBytes.default).toBe(5 * 1024 * 1024);
    expect(numericSource).toContain(
      `boundedInteger(field.maxFileSize, ${constraints.attachments.maxFileSizeBytes.minimum}, 5 * 1024 * 1024)`
    );
    expect(numericSource).toContain('field.maxFileSize ?? 5 * 1024 * 1024');
    expect(constraints.attachments.acceptCount.minimum).toBe(1);
    expect(numericSource).toContain('field.accept.length === 0');
    expect(numericSource).toContain(
      `field.accept.length > ${constraints.attachments.acceptCount.maximum}`
    );

    const allowedTypes = source.match(/const ALLOWED_ATTACHMENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(allowedTypes).not.toBeNull();
    expect([...allowedTypes![1].matchAll(/'([^']+)'/g)].map(match => match[1])).toEqual(
      constraints.attachments.acceptedMimeTypes
    );
  });

  it('binds documented flow-wide validation boundaries to the released validator source', async () => {
    const validationSource = await readFile('src/widget/flows/validate-config.ts', 'utf8');
    const conditionSource = await readFile('src/widget/flows/conditions.ts', 'utf8');
    const constraints = FLOW_CAPABILITIES.validation;

    expect(validationSource).toContain('input.forms.length === 0');
    expect(validationSource).toContain(`input.forms.length > ${constraints.forms.maximum}`);
    expect(validationSource).toContain('input.screens.length === 0');
    expect(validationSource).toContain(`input.screens.length > ${constraints.screens.maximum}`);
    expect(validationSource).toContain('form.fields.length === 0');
    expect(validationSource).toContain(`form.fields.length > ${constraints.fieldsPerForm.maximum}`);
    expect(validationSource).toContain(`++screenshots > ${constraints.screenshotScreens.maximum}`);
    expect(validationSource).toContain(
      `issue.sections.length > ${constraints.issueSections.maximum}`
    );
    expect(conditionSource).toContain(
      `const MAX_CONDITION_DEPTH = ${constraints.conditionDepth.maximum}`
    );
    expect(conditionSource).toContain(
      `const MAX_CONDITION_NODES = ${constraints.conditionNodes.maximum}`
    );
    expect(validationSource).toContain(
      `children.length > ${constraints.conditionGroupEntries.maximum}`
    );
    expect(validationSource).toContain('children.length < 1');
    expect(validationSource).toContain('may be referenced only once');
    expect(validationSource).toContain('at least one screen must be unconditional');
    expect(validationSource).toContain('condition answer must reference an earlier field');
    expect(validationSource).toContain(
      'issue title must contain text or reference a required answer'
    );
  });

  it('keeps the copyable styling flow backed by a guaranteed title answer', async () => {
    const styling = await readFile('docs/website/styling.mdx', 'utf8');
    expect(styling).toMatch(
      /id: 'summary',[\s\S]*?required: true,[\s\S]*?issue: \{ title: '\{\{feedback\.summary\}\}' \}/
    );
  });

  it('keeps distribution and gallery guidance aligned with supported release paths', async () => {
    const api = await readFile('docs/website/javascript-api.mdx', 'utf8');
    const examples = await readFile('docs/website/flow-examples.mdx', 'utf8');
    const customFlows = await readFile('docs/website/custom-flows.mdx', 'utf8');
    const motion = await readFile('docs/website/flow-presentation-and-motion.mdx', 'utf8');

    expect(api).toContain('BugDrop does not currently publish an npm package');
    expect(api).not.toContain('from the `bugdrop` package');
    expect(examples).toContain('interactive launcher is enabled only in local development');
    expect(examples).toContain('Deployed documentation never loads the preview runtime');
    expect(customFlows).toContain('local development also enables the interactive launcher');
    expect(motion).toContain('preview them interactively in local development');
  });

  it('uses the same safe filename grammar for discovery and retirement', () => {
    expect(isWebsiteDocName('flow-reference.mdx')).toBe(true);
    expect(isWebsiteDocName('api_v2.mdx')).toBe(true);
    expect(isWebsiteDocName('Flow-Reference.mdx')).toBe(true);
    expect(isWebsiteDocName('../flow-reference.mdx')).toBe(false);
    expect(isWebsiteDocName('nested/flow-reference.mdx')).toBe(false);
  });

  it('stages both documentation and constrains the destination migration bridge', async () => {
    const workflow = await readFile('.github/workflows/sync-docs.yml', 'utf8');
    expect(workflow).toContain('git add src/content/docs/ src/lib/flow-capabilities.ts');
    expect(workflow).toContain('${REQUESTED_REPOSITORY:-mean-weasel/bugdrop-web}');
    expect(workflow).toContain('mean-weasel/bugdrop-web|bugdrophq/bugdrop-web');
    expect(workflow).toContain('repository: ${{ steps.destination.outputs.repository }}');
    expect(workflow).toContain('"$GITHUB_SHA" "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('gh pr create --repo "$BUGDROP_WEB_REPOSITORY"');
  });

  it('copies every canonical page and capability manifest with content hashes', async () => {
    const target = await temporaryWebsite();
    const manifest = await syncWebsiteDocs(target, 'source-revision');

    expect(manifest.sourceRepository).toBe('mean-weasel/bugdrop');
    expect(manifest.files).toContainEqual(
      expect.objectContaining({
        source: 'docs/website/flow-capabilities.ts',
        target: 'src/lib/flow-capabilities.ts',
      })
    );
    for (const entry of manifest.files) {
      expect(await readFile(path.join(target, entry.target), 'utf8')).toBe(
        await readFile(path.resolve(entry.source), 'utf8')
      );
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('records the destination organization after repository transfer', async () => {
    const target = await temporaryWebsite();
    const manifest = await syncWebsiteDocs(target, 'source-revision', 'bugdrophq/bugdrop');

    expect(manifest.sourceRepository).toBe('bugdrophq/bugdrop');
  });

  it('rejects source repositories outside the migration allowlist', async () => {
    const target = await temporaryWebsite();

    await expect(
      syncWebsiteDocs(target, 'source-revision', 'someone-else/bugdrop')
    ).rejects.toThrow('not an approved BugDrop location');
  });

  it('removes only retired files previously owned by the manifest', async () => {
    const target = await temporaryWebsite();
    await syncWebsiteDocs(target, 'first');
    const retired = 'src/content/docs/api_v2.mdx';
    const unrelated = 'src/content/docs/website-only.mdx';
    await writeFile(path.join(target, retired), 'retired');
    await writeFile(path.join(target, unrelated), 'website only');
    const manifestPath = path.join(target, 'src/content/docs/.widget-docs-source.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files.push({
      source: 'docs/website/api_v2.mdx',
      target: retired,
      sha256: '0'.repeat(64),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));

    await syncWebsiteDocs(target, 'second');

    await expect(readFile(path.join(target, retired), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(path.join(target, unrelated), 'utf8')).resolves.toBe('website only');
  });

  it('rejects a target that is not the website repository', async () => {
    const target = await temporaryWebsite('another-project');
    await expect(syncWebsiteDocs(target, 'source-revision')).rejects.toThrow('bugdrop-web');
  });
});
