#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const browserAssertionPath = 'scripts/check-developer-feed-diff-browser.mjs';
const allowed = new Set([
  browserAssertionPath,
  'src/styles.css',
  'src/operator-presentation-vocabulary.mjs',
]);
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

const mergeBase = git(['merge-base', base, 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/u.test(mergeBase)) throw new Error('Tier 0 merge base invalid');

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
  const before = git(['show', `${mergeBase}:${path}`]).split('\n');
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

function developerBadgeColor(source) {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const blocks = [...uncommented.matchAll(
    /\.candidate-feed-preview__badge--developer\s*\{([\s\S]*?)\}/gu,
  )];
  if (blocks.length !== 1) throw new Error('Tier 0 browser assertion invalid');
  const color = blocks[0][1].match(
    /(?:^|\n)\s*border-color:\s*rgba\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*((?:0(?:\.[0-9]+)?|1(?:\.0+)?))\s*\)\s*;/u,
  );
  if (!color) throw new Error('Tier 0 browser assertion invalid');
  const rgb = color.slice(1, 4).map(Number);
  if (rgb.some((channel) => channel < 0 || channel > 255)) {
    throw new Error('Tier 0 browser assertion invalid');
  }
  const alpha = Number(color[4]);
  return { rgb, alpha };
}

function assertDeveloperBadgeCssColorOnly() {
  const before = git(['show', `${mergeBase}:src/styles.css`]).split('\n');
  const after = git(['show', 'HEAD:src/styles.css']).split('\n');
  if (before.length !== after.length) throw new Error('Tier 0 browser assertion invalid');
  const differences = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) differences.push(index);
  }
  if (differences.length !== 1) throw new Error('Tier 0 browser assertion invalid');
  const index = differences[0];
  const colorPattern = /^(\s*border-color:\s*rgba\(\s*)([0-9]{1,3})(\s*,\s*)([0-9]{1,3})(\s*,\s*)([0-9]{1,3})(\s*,\s*)((?:0(?:\.[0-9]+)?|1(?:\.0+)?))(\s*\)\s*;\s*)$/u;
  const left = before[index].match(colorPattern);
  const right = after[index].match(colorPattern);
  if (!left || !right
      || before[index - 1]?.trim() !== '.candidate-feed-preview__badge--developer {'
      || after[index - 1] !== before[index - 1]
      || after[index + 1] !== before[index + 1]
      || left[1] !== right[1] || left[3] !== right[3] || left[5] !== right[5]
      || left[7] !== right[7] || left[8] !== right[8] || left[9] !== right[9]) {
    throw new Error('Tier 0 browser assertion invalid');
  }
}

function assertBrowserColorOnly() {
  const before = git(['show', `${mergeBase}:${browserAssertionPath}`]).split('\n');
  const after = git(['show', `HEAD:${browserAssertionPath}`]).split('\n');
  if (before.length !== after.length) throw new Error('Tier 0 browser assertion invalid');
  const differences = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) differences.push(index);
  }
  if (differences.length < 1 || differences.length > 2) {
    throw new Error('Tier 0 browser assertion invalid');
  }
  const arrayPattern = /^(\s*)\[([0-9]{1,3}), ([0-9]{1,3}), ([0-9]{1,3})\],(\s*)$/u;
  const messagePattern = /^(\s*)`the dev-feed badge border is not ([a-z][a-z -]{0,31}): \$\{badgeBorderColor\.serialized\}`,(\s*)$/u;
  const beforeArray = before[differences[0]].match(arrayPattern);
  const afterArray = after[differences[0]].match(arrayPattern);
  if (!beforeArray || !afterArray || beforeArray[1] !== afterArray[1]
      || beforeArray[5] !== afterArray[5]
      || after[differences[0] - 2]?.trim() !== 'assert.deepEqual('
      || after[differences[0] - 1]?.trim()
        !== '[badgeBorderColor.red, badgeBorderColor.green, badgeBorderColor.blue],') {
    throw new Error('Tier 0 browser assertion invalid');
  }
  if (differences.length === 2) {
    const beforeMessage = before[differences[1]].match(messagePattern);
    const afterMessage = after[differences[1]].match(messagePattern);
    if (differences[1] !== differences[0] + 1 || !beforeMessage || !afterMessage
        || beforeMessage[1] !== afterMessage[1] || beforeMessage[3] !== afterMessage[3]) {
      throw new Error('Tier 0 browser assertion invalid');
    }
  }
  const asserted = afterArray.slice(2, 5).map(Number);
  const cssRgb = developerBadgeColor(git(['show', 'HEAD:src/styles.css'])).rgb;
  if (asserted.some((channel) => channel > 255)
      || asserted.some((channel, index) => channel !== cssRgb[index])) {
    throw new Error('Tier 0 browser assertion invalid');
  }
}

function assertDeveloperBadgeAlphaUnchanged() {
  const before = developerBadgeColor(git(['show', `${mergeBase}:src/styles.css`]));
  const after = developerBadgeColor(git(['show', 'HEAD:src/styles.css']));
  if (before.alpha !== after.alpha) throw new Error('Tier 0 badge alpha change requires Tier 1');
}

const paths = git(['diff', '--name-only', `${mergeBase}..HEAD`, '--']).trim().split('\n').filter(Boolean);
if (paths.length < 1 || paths.some((path) => !allowed.has(path))) {
  throw new Error(`Tier 0 path scope invalid: ${paths.join(',')}`);
}
if (paths.includes(browserAssertionPath) && !paths.includes('src/styles.css')) {
  throw new Error('Tier 0 browser assertion requires styles.css');
}
const patch = git(['diff', '--unified=0', `${mergeBase}..HEAD`, '--', ...paths]);
const changed = patch.split('\n').filter((line) => (
  (line.startsWith('+') && !line.startsWith('+++'))
  || (line.startsWith('-') && !line.startsWith('---'))
));
if (changed.length < 1 || changed.length > maxChangedLines) throw new Error('Tier 0 change bound invalid');
if (paths.includes('src/styles.css')) {
  const additions = changed.filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1)).join('\n').replace(/\/\*[\s\S]*?\*\//gu, '');
  if (forbiddenCss.test(additions)) throw new Error('Tier 0 CSS introduces external/runtime capability');
  assertDeveloperBadgeAlphaUnchanged();
}
if (paths.includes('src/operator-presentation-vocabulary.mjs')) {
  assertCopyOnly('src/operator-presentation-vocabulary.mjs');
}
if (paths.includes(browserAssertionPath)) {
  assertDeveloperBadgeCssColorOnly();
  assertBrowserColorOnly();
}
console.log(`Tier 0 cosmetic scope: PASS (${paths.join(', ')}, ${changed.length} changed lines)`);
