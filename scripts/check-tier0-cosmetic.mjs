#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const allowed = new Set(['src/styles.css', 'src/operator-presentation-vocabulary.mjs']);
const maxChangedLines = 80;
const forbiddenCss = /(?:@import\b|url\s*\(|expression\s*\(|(?<![-\w])behavior\s*:|-moz-binding\s*:)/iu;

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--base' || !/^[A-Za-z0-9_./-]+$/u.test(args[1])) {
  throw new Error('usage: check-tier0-cosmetic --base <git-ref>');
}
const base = args[1];

function git(command) {
  const result = spawnSync('/usr/bin/git', command, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error(`git failed: ${String(result.stderr || result.error?.message || result.signal).split('\n')[0]}`);
  }
  return String(result.stdout);
}

function copyLineShape(line) {
  const patterns = [
    /^(\s*(?:[A-Za-z][A-Za-z0-9]*:\s*Object\.freeze\(\{\s*)?label:\s*)'[^'\\]*(?:\\.[^'\\]*)*'(.*)$/u,
    /^(\s*(?:(?:let\s+)?(?:summary|blocker)\s*=\s*))'[^'\\]*(?:\\.[^'\\]*)*'(;\s*)$/u,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return `${match[1]}<operator-copy>${match[2]}`;
  }
  return null;
}

function assertCopyOnly(path) {
  const before = git(['show', `${base}:${path}`]).split('\n');
  const after = git(['show', `HEAD:${path}`]).split('\n');
  if (before.length !== after.length) throw new Error('Tier 0 copy changed structure');
  let differences = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    differences += 1;
    const left = copyLineShape(before[index]);
    const right = copyLineShape(after[index]);
    if (left === null || left !== right) throw new Error('Tier 0 copy changed executable structure');
  }
  if (differences < 1 || differences * 2 > maxChangedLines) throw new Error('Tier 0 copy bound invalid');
}

const paths = git(['diff', '--name-only', `${base}...HEAD`, '--']).trim().split('\n').filter(Boolean);
if (paths.length < 1 || paths.some((path) => !allowed.has(path))) {
  throw new Error(`Tier 0 path scope invalid: ${paths.join(',')}`);
}
const patch = git(['diff', '--unified=0', `${base}...HEAD`, '--', ...paths]);
const changed = patch.split('\n').filter((line) => (
  (line.startsWith('+') && !line.startsWith('+++'))
  || (line.startsWith('-') && !line.startsWith('---'))
));
if (changed.length < 1 || changed.length > maxChangedLines) throw new Error('Tier 0 change bound invalid');
if (paths.includes('src/styles.css')) {
  const additions = changed.filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1)).join('\n').replace(/\/\*[\s\S]*?\*\//gu, '');
  if (forbiddenCss.test(additions)) throw new Error('Tier 0 CSS introduces external/runtime capability');
}
if (paths.includes('src/operator-presentation-vocabulary.mjs')) {
  assertCopyOnly('src/operator-presentation-vocabulary.mjs');
}
console.log(`Tier 0 cosmetic scope: PASS (${paths.join(', ')}, ${changed.length} changed lines)`);
