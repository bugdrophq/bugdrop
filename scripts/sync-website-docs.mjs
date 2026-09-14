import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(repositoryRoot, 'docs/website');
const manifestTarget = 'src/content/docs/.widget-docs-source.json';
const WEBSITE_DOC_NAME = /^[^/\\]+\.mdx$/;

function targetPath(targetRoot, relativePath) {
  const resolvedRoot = path.resolve(targetRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TypeError(`Website documentation target escapes the repository: ${relativePath}`);
  }
  return resolved;
}

function isOwnedTarget(relativePath) {
  return (
    relativePath === 'src/lib/flow-capabilities.ts' ||
    (relativePath.startsWith('src/content/docs/') &&
      isWebsiteDocName(relativePath.slice('src/content/docs/'.length)))
  );
}

export function isWebsiteDocName(name) {
  return WEBSITE_DOC_NAME.test(name);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readPreviousManifest(targetRoot) {
  try {
    return JSON.parse(await readFile(targetPath(targetRoot, manifestTarget), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function syncWebsiteDocs(
  targetRoot,
  sourceRevision,
  sourceRepository = 'bugdrophq/bugdrop'
) {
  if (typeof sourceRevision !== 'string' || !sourceRevision.trim()) {
    throw new TypeError('A non-empty widget source revision is required');
  }
  if (!new Set(['mean-weasel/bugdrop', 'bugdrophq/bugdrop']).has(sourceRepository)) {
    throw new TypeError('The widget source repository is not an approved BugDrop location');
  }
  const packageJson = JSON.parse(await readFile(targetPath(targetRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== 'bugdrop-web') {
    throw new TypeError('Website documentation can only sync into the bugdrop-web repository');
  }

  const mdxNames = (await readdir(sourceDirectory)).filter(isWebsiteDocName).sort();
  const files = [
    ...mdxNames.map(name => ({
      source: `docs/website/${name}`,
      target: `src/content/docs/${name}`,
    })),
    {
      source: 'docs/website/flow-capabilities.ts',
      target: 'src/lib/flow-capabilities.ts',
    },
  ];
  const currentTargets = new Set(files.map(({ target }) => target));
  const previous = await readPreviousManifest(targetRoot);
  for (const entry of previous?.files ?? []) {
    if (
      typeof entry?.target === 'string' &&
      isOwnedTarget(entry.target) &&
      !currentTargets.has(entry.target)
    ) {
      await rm(targetPath(targetRoot, entry.target), { force: true });
    }
  }

  const manifestFiles = [];
  for (const entry of files) {
    const source = path.join(repositoryRoot, entry.source);
    const target = targetPath(targetRoot, entry.target);
    const contents = await readFile(source);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    manifestFiles.push({ ...entry, sha256: sha256(contents) });
  }

  const manifest = {
    schemaVersion: 1,
    sourceRepository,
    sourceRevision,
    files: manifestFiles,
  };
  const manifestPath = targetPath(targetRoot, manifestTarget);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [, , targetRoot, sourceRevision, sourceRepository] = process.argv;
  await syncWebsiteDocs(targetRoot, sourceRevision, sourceRepository);
}
