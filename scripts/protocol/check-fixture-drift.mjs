import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../../test/protocol/v1/fixtures/', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(fixtures, 'upstream.json'), 'utf8'));
const sdkRoot = process.argv[2];
for (const [name, expected] of Object.entries(manifest.files)) {
  const local = readFileSync(resolve(fixtures, name));
  if (createHash('sha256').update(local).digest('hex') !== expected) {
    throw new Error(`Pinned fixture changed: ${name}; review and update provenance explicitly`);
  }
  if (sdkRoot && !local.equals(readFileSync(resolve(sdkRoot, manifest.directory, name)))) {
    throw new Error(`SDK fixture drift: ${name}`);
  }
}
console.log(
  `Protocol fixtures match ${manifest.commit}${sdkRoot ? ' and supplied SDK checkout' : ''}`
);
