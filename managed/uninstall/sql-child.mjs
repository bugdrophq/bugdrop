// Local harness subprocess keeps a blocked Postgres transaction off the Workerd host event loop.
import { pathToFileURL } from 'node:url';
const { applyVerifiedUninstall } = await import(pathToFileURL(process.argv[2]).href);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2048) throw new Error('local_reconciliation_command_too_large');
}
try {
  process.stdout.write(JSON.stringify(await applyVerifiedUninstall(JSON.parse(input))));
} catch {
  process.exitCode = 1;
}
