import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const DEFAULT_POLICY = 'test-fixtures/mission-architecture-policy.v1.json';
const missionBasename = (file) => /^mission(?:[-_].+)?\.(?:ts|mts|mjs)$/i.test(basename(file));
const missionImport = (specifier) => (
  /^\.{1,2}\//.test(specifier)
  && /(?:^|\/)mission(?:$|[-_/.])/i.test(specifier)
);
const lineCount = (raw) => raw.length === 0 ? 0 : raw.replace(/\n$/, '').split('\n').length;

function sourceImports(file, raw) {
  const kind = file.endsWith('.ts') || file.endsWith('.mts')
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.ESNext, true, kind);
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function sourceFiles(root) {
  const discovered = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:ts|mts|mjs)$/.test(entry.name)) discovered.push(path);
    }
  };
  walk(join(root, 'src'));
  return discovered.sort();
}

const reviewedMissionFile = (root, file) => (
  missionBasename(file)
  && /^src\/[^/]+$/.test(relative(root, file).replaceAll('\\', '/'))
);

const looksLikeMissionFile = (root, file) => {
  const fileRelative = relative(root, file).replaceAll('\\', '/');
  return missionBasename(file) || /(?:^|\/)mission(?:\/|[-_])/i.test(fileRelative);
};

export function scanMissionArchitecture(rootInput, policyRelative = DEFAULT_POLICY) {
  const root = resolve(rootInput);
  const policyRaw = readFileSync(join(root, policyRelative));
  const policy = JSON.parse(policyRaw);
  if (policy.schema !== 'mission-client-architecture-policy.v1') {
    throw new Error('unknown Mission client architecture policy');
  }
  const errors = [];
  const allowedImporters = new Set(policy.allowedMissionImporters);

  for (const [file, limit] of Object.entries(policy.integrationLineBudgets)) {
    const current = readFileSync(join(root, file), 'utf8');
    const growth = lineCount(current) - Number(policy.baseline[file].lines);
    if (growth > Number(limit)) {
      errors.push(`${file}: net line budget exceeded (${growth}>${limit})`);
    }
    if (
      growth <= 0
      && createHash('sha256').update(current).digest('hex') !== policy.baseline[file].sha256
    ) {
      errors.push(`${file}: nonpositive-growth baseline SHA-256 mismatch`);
    }
  }

  const files = sourceFiles(root);
  const missionFiles = files.filter((file) => reviewedMissionFile(root, file));
  for (const file of files) {
    if (looksLikeMissionFile(root, file) && !reviewedMissionFile(root, file)) {
      errors.push(
        `${relative(root, file).replaceAll('\\', '/')}: `
        + 'Mission source is outside the reviewed src/mission* contour',
      );
    }
  }
  let total = 0;
  for (const file of files) {
    const fileRelative = relative(root, file).replaceAll('\\', '/');
    const raw = readFileSync(file, 'utf8');
    const imports = sourceImports(file, raw);
    for (const imported of imports) {
      const importsMission = missionImport(imported);
      if (importsMission && !reviewedMissionFile(root, file) && !allowedImporters.has(fileRelative)) {
        errors.push(`${fileRelative}: unreviewed inbound Mission edge ${imported}`);
      }
    }
    if (!reviewedMissionFile(root, file)) continue;
    const lines = lineCount(raw);
    total += lines;
    if (lines > Number(policy.missionDomain.maxLinesPerModule)) {
      errors.push(
        `${fileRelative}: module line budget exceeded `
        + `(${lines}>${policy.missionDomain.maxLinesPerModule})`,
      );
    }
    for (const imported of imports) {
      if (!imported.startsWith('.')) continue;
      if (imported.startsWith('./island')) {
        errors.push(`${fileRelative}: forbidden Island authority import ${imported}`);
      } else if (!missionImport(imported)) {
        errors.push(`${fileRelative}: unreviewed local dependency ${imported}`);
      }
    }
  }
  if (total > Number(policy.missionDomain.maxTotalLines)) {
    errors.push(
      `src/mission*: aggregate line budget exceeded `
      + `(${total}>${policy.missionDomain.maxTotalLines})`,
    );
  }
  const island = readFileSync(join(root, 'src/island.ts'), 'utf8');
  if (/\bmission(?:\b|[-_/.]|[A-Z])/i.test(island)) {
    errors.push('src/island.ts: Mission logic is forbidden');
  }
  for (const [file, anchor] of Object.entries(policy.baseline)) {
    if (!/^[0-9a-f]{64}$/.test(String(anchor.sha256))) {
      errors.push(`${file}: invalid baseline SHA-256`);
    }
  }
  return [...new Set(errors)].sort();
}

function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : '.';
  const errors = scanMissionArchitecture(root);
  if (errors.length) {
    for (const error of errors) console.error(`mission-architecture-guard: ${error}`);
    process.exitCode = 1;
    return;
  }
  const policyRaw = readFileSync(join(resolve(root), DEFAULT_POLICY));
  console.log(JSON.stringify({
    policySha256: createHash('sha256').update(policyRaw).digest('hex'),
    schema: 'mission-client-architecture-guard-receipt.v1',
    status: 'PASS',
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main();
}
