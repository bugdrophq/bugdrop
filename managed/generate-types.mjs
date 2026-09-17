import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const role of [
  'ingress',
  'delivery',
  'consumer',
  'local/ingress',
  'local/delivery',
  'staging/authority',
  'staging/ingress',
  'staging/delivery',
  'staging/github',
]) {
  const leaf = role.split('/').at(-1);
  const name = `${role.startsWith('staging/') ? 'Staging' : role.startsWith('local/') ? 'Local' : 'Managed'}${leaf[0].toUpperCase()}${leaf.slice(1)}Env`;
  const path = `src/managed/${role}-env.d.ts`;
  execFileSync(
    'node_modules/.bin/wrangler',
    [
      'types',
      path,
      '-c',
      `managed/${role}.json`,
      ...(role.startsWith('staging/') ? ['--env', 'staging', '--strict-vars', 'false'] : []),
      '--env-interface',
      name,
      '--include-runtime',
      'false',
    ],
    { stdio: 'inherit' }
  );
  // Scope Wrangler's ambient declarations to this module, avoiding cross-Worker Env merging.
  appendFileSync(path, `\nexport { ${name} };\n`);
  execFileSync('node_modules/.bin/prettier', ['--write', path], { stdio: 'inherit' });
}
