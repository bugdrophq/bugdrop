import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

const workflowRoot = resolve(process.argv[2] ?? '.github/workflows');
const failures = [];

const checkEqual = (location, actual, expected) => {
  if (!isDeepStrictEqual(actual, expected)) {
    failures.push(`${location}: expected ${JSON.stringify(expected)}`);
  }
};

const checkBlocking = (location, node, scoped = false) => {
  if (scoped)
    checkEqual(
      `${location}: scope condition`,
      node?.if,
      `steps.scope.outputs.${scoped} != 'false'`
    );
  for (const key of ['if', 'continue-on-error']) {
    if (node && Object.hasOwn(node, key) && !(scoped && key === 'if')) {
      failures.push(`${location}: must not define ${key}`);
    }
  }
};

const readWorkflow = async file => {
  try {
    return parse(await readFile(resolve(workflowRoot, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return {};
  }
};

const codeql = await readWorkflow('codeql.yml');
checkEqual('codeql.yml: triggers', codeql.on, {
  push: { branches: ['main'] },
  pull_request: { branches: ['main'] },
  schedule: [{ cron: '23 4 * * 2' }],
});
checkEqual('codeql.yml: top-level permissions', codeql.permissions, {});
checkEqual('codeql.yml: analyze permissions', codeql.jobs?.analyze?.permissions, {
  contents: 'read',
  'security-events': 'write',
});
checkBlocking('codeql.yml: analyze job', codeql.jobs?.analyze);

const codeqlSteps = codeql.jobs?.analyze?.steps ?? [];
const codeqlCheckout = codeqlSteps.find(step => step.name === 'Checkout repository');
const codeqlInit = codeqlSteps.find(step => step.name === 'Initialize CodeQL');
const codeqlAnalyze = codeqlSteps.find(step => step.name === 'Analyze with CodeQL');
checkBlocking('codeql.yml: checkout step', codeqlCheckout);
checkBlocking('codeql.yml: init step', codeqlInit, 'full_ci');
checkBlocking('codeql.yml: analyze step', codeqlAnalyze, 'full_ci');
checkEqual(
  'codeql.yml: checkout action',
  codeqlCheckout?.uses,
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
);
checkEqual('codeql.yml: checkout configuration', codeqlCheckout?.with, {
  'persist-credentials': false,
  'fetch-depth': 0,
});
checkEqual(
  'codeql.yml: init action',
  codeqlInit?.uses,
  'github/codeql-action/init@b96794f015dfd88f77b49b1c93e0fa7110f94c63'
);
checkEqual('codeql.yml: init configuration', codeqlInit?.with, {
  languages: 'javascript-typescript',
  'build-mode': 'none',
  'config-file': './.github/codeql/codeql-config.yml',
});
checkEqual(
  'codeql.yml: analyze action',
  codeqlAnalyze?.uses,
  'github/codeql-action/analyze@b96794f015dfd88f77b49b1c93e0fa7110f94c63'
);
checkEqual('codeql.yml: analyze configuration', codeqlAnalyze?.with, {
  category: '/language:javascript-typescript',
});

const codeqlConfig = await readWorkflow('../codeql/codeql-config.yml');
checkEqual('codeql-config.yml: configuration', codeqlConfig, {
  'paths-ignore': ['test/fixtures/legacy-compat/**'],
});

const dependencyReview = await readWorkflow('dependency-review.yml');
checkEqual('dependency-review.yml: triggers', dependencyReview.on, {
  pull_request: { branches: ['main'] },
});
checkEqual('dependency-review.yml: top-level permissions', dependencyReview.permissions, {});
checkEqual(
  'dependency-review.yml: job permissions',
  dependencyReview.jobs?.['dependency-review']?.permissions,
  { contents: 'read' }
);
checkBlocking(
  'dependency-review.yml: dependency-review job',
  dependencyReview.jobs?.['dependency-review']
);

const dependencySteps = dependencyReview.jobs?.['dependency-review']?.steps ?? [];
const dependencyCheckout = dependencySteps.find(step => step.name === 'Checkout repository');
const dependencyScan = dependencySteps.find(step => step.name === 'Review dependency changes');
checkBlocking('dependency-review.yml: checkout step', dependencyCheckout);
checkBlocking('dependency-review.yml: review step', dependencyScan, 'dependency_review');
checkEqual(
  'dependency-review.yml: checkout action',
  dependencyCheckout?.uses,
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
);
checkEqual('dependency-review.yml: checkout configuration', dependencyCheckout?.with, {
  'persist-credentials': false,
  'fetch-depth': 0,
});
checkEqual(
  'dependency-review.yml: review action',
  dependencyScan?.uses,
  'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294'
);
checkEqual('dependency-review.yml: review configuration', dependencyScan?.with, {
  'fail-on-severity': 'moderate',
  'fail-on-scopes': 'runtime, development, unknown',
  'license-check': false,
  'show-openssf-scorecard': false,
  'show-patched-versions': true,
});

for (const [name, steps] of [
  ['codeql.yml', codeqlSteps],
  ['dependency-review.yml', dependencySteps],
]) {
  checkEqual(
    `${name}: scope step`,
    steps.find(step => step.id === 'scope'),
    {
      name: 'Determine analysis scope',
      id: 'scope',
      shell: 'bash',
      env: {
        SCOPE_EVENT: '${{ github.event_name }}',
        SCOPE_BASE: '${{ github.event.pull_request.base.sha || github.event.before }}',
        SCOPE_HEAD: '${{ github.event.pull_request.head.sha || github.sha }}',
      },
      run: `scripts/ci-scope.sh "$SCOPE_EVENT" opened "$SCOPE_BASE" "$SCOPE_HEAD" '' false`,
    }
  );
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('CodeQL and dependency-review workflow contracts passed');
