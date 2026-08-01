import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { scanMissionArchitecture } from './mission-architecture-guard.mjs';

const root = resolve('.');
const sandbox = () => {
  const target = mkdtempSync(join(tmpdir(), 'p4g-mission-guard-'));
  cpSync(join(root, 'src'), join(target, 'src'), { recursive: true });
  cpSync(
    join(root, 'test-fixtures/mission-architecture-policy.v1.json'),
    join(target, 'test-fixtures/mission-architecture-policy.v1.json'),
    { recursive: true },
  );
  return target;
};

assert.deepEqual(scanMissionArchitecture(root), []);

{
  const target = sandbox();
  try {
    writeFileSync(
      join(target, 'src/mission-service.ts'),
      "import { x } from './island';\nexport { x };\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('forbidden Island authority import')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(
      join(target, 'src/Mission.ts'),
      "import { x } from './island';\nexport { x };\n",
    );
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "import { x } from './Mission';\nexport { x };\n",
    );
    mkdirSync(join(target, 'src/Mission'), { recursive: true });
    writeFileSync(join(target, 'src/Mission/hidden.ts'), 'export const hidden = true;\n');
    const errors = scanMissionArchitecture(target);
    assert(
      errors.some((error) => error.includes('forbidden Island authority import')),
      errors.join('\n'),
    );
    assert(
      errors.some((error) => error.includes('unreviewed inbound Mission edge ./Mission')),
      errors.join('\n'),
    );
    assert(
      errors.some((error) => error.includes('src/Mission/hidden.ts: Mission source is outside')),
      errors.join('\n'),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    mkdirSync(join(target, 'src/mission'), { recursive: true });
    writeFileSync(join(target, 'src/mission/hidden.ts'), 'export const hidden = true;\n');
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('outside the reviewed')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(
      join(target, 'src/mission.ts'),
      "import { x } from './island';\nexport { x };\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('forbidden Island authority import')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    const policy = JSON.parse(
      readFileSync(
        join(target, 'test-fixtures/mission-architecture-policy.v1.json'),
        'utf8',
      ),
    );
    const baseline = policy.baseline['src/feed.ts'].lines;
    const limit = policy.integrationLineBudgets['src/feed.ts'];
    const feed = readFileSync(join(target, 'src/feed.ts'), 'utf8').split('\n');
    writeFileSync(
      join(target, 'src/feed.ts'),
      [...feed.slice(0, baseline), ...Array(limit + 1).fill('// mission mutant')].join('\n'),
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('src/feed.ts: net line budget exceeded')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(join(target, 'src/mission.ts'), 'export const mission = true;\n');
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "import './mission';\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('unreviewed inbound Mission edge')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "import './mission-service';\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('unreviewed inbound Mission edge')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(join(target, 'src/mission.mjs'), 'export const mission = true;\n');
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "import { mission } from './mission.mjs';\nexport { mission };\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('unreviewed inbound Mission edge')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(join(target, 'src/mission.mjs'), 'export const mission = true;\n');
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "export { mission } from './mission.mjs';\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('unreviewed inbound Mission edge')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(join(target, 'src/mission.mjs'), 'export const mission = true;\n');
    writeFileSync(
      join(target, 'src/unreviewed.ts'),
      "export const loadMission = () => import('./mission.mjs');\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('unreviewed inbound Mission edge')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    writeFileSync(
      join(target, 'src/mission-service.ts'),
      "export const loadIsland = () => import('./island');\n",
    );
    assert(
      scanMissionArchitecture(target)
        .some((error) => error.includes('forbidden Island authority import')),
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    const islandPath = join(target, 'src/island.ts');
    const island = readFileSync(islandPath, 'utf8').split('\n');
    const replaced = island.findIndex((line) => line.length > 0);
    assert.notEqual(replaced, -1);
    island[replaced] = 'const MISSION_FLAG = 1;';
    writeFileSync(islandPath, island.join('\n'));
    const errors = scanMissionArchitecture(target);
    assert(
      errors.includes('src/island.ts: Mission logic is forbidden'),
      errors.join('\n'),
    );
    assert(
      errors.includes('src/island.ts: nonpositive-growth baseline SHA-256 mismatch'),
      errors.join('\n'),
    );
    assert(!errors.some((error) => error.includes('net line budget exceeded')));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

{
  const target = sandbox();
  try {
    const feedPath = join(target, 'src/feed.ts');
    const feed = readFileSync(feedPath, 'utf8').split('\n');
    const removed = feed.findIndex((line) => line.length > 0);
    assert.notEqual(removed, -1);
    feed.splice(removed, 1);
    writeFileSync(feedPath, feed.join('\n'));
    const errors = scanMissionArchitecture(target);
    assert(
      errors.includes('src/feed.ts: nonpositive-growth baseline SHA-256 mismatch'),
      errors.join('\n'),
    );
    assert(!errors.some((error) => error.includes('net line budget exceeded')));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

console.log('mission architecture mutants: PASS');
