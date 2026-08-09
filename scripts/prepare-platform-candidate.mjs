#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GITHUB_TICKET = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}#[1-9][0-9]{0,9}$/;
const LIVE_TICKET = /^Glera\/p4g-workspace-meta#[1-9][0-9]{0,9}$/;
const MANIFEST_SCHEMA = 'platform.candidate-manifest.v1';
const RECEIPT_SCHEMA = 'platform.candidate-preparation-receipt.v1';
const BUILD_PROFILE_SCHEMA = 'platform.candidate-build-profile.v1';
const BUILD_TEMP_PREFIX = 'platform-candidate-build-';
const OFFICIAL_REPOSITORIES = Object.freeze({
  feed: Object.freeze({ repository: 'Glera/feed-prototype', branchPolicy: 'explicit' }),
  platform: Object.freeze({ repository: 'Glera/swipe-platform', branchPolicy: 'master' }),
  ugc: Object.freeze({ repository: 'Glera/swipe-ugc', branchPolicy: 'explicit' }),
});
const NPM_CI_ARGS = Object.freeze(['ci', '--include=dev', '--no-audit', '--no-fund']);
const NPM_BUILD_ARGS = Object.freeze(['run', 'build']);

let cachedBuildTools;

export class PlatformCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformCandidateError';
    this.code = code;
  }
}

function refuse(code, message) {
  throw new PlatformCandidateError(code, message);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prettyStableJson(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function regularFile(rawPath, code, message) {
  if (!existsSync(rawPath)) refuse(code, message);
  const resolved = realpathSync(rawPath);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(code, message);
  return resolved;
}

function fileDigest(rawPath) {
  return sha256(readFileSync(rawPath));
}

function git(root, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return null;
    refuse(
      'platform_candidate_git_failed',
      `git ${args.join(' ')} failed in ${root}: ${String(error?.stderr || error?.message || '').trim()}`,
    );
  }
}

function nullSeparated(output) {
  return String(output || '').split('\0').filter(Boolean);
}

function dirtyPaths(root) {
  const values = new Set([
    ...nullSeparated(git(root, ['diff', '--name-only', '-z'])),
    ...nullSeparated(git(root, ['diff', '--cached', '--name-only', '-z'])),
    ...nullSeparated(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ]);
  return [...values].sort();
}

function changedPaths(root, base, candidate = null) {
  const range = candidate ? `${base}..${candidate}` : base;
  const tracked = nullSeparated(git(root, ['diff', '--name-only', '-z', range, '--']));
  if (candidate) return [...new Set(tracked)].sort();
  const untracked = nullSeparated(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

function samePaths(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function requireSha(value, label) {
  if (!SHA.test(String(value || ''))) {
    refuse('platform_candidate_input_invalid', `${label} must be one full lowercase Git SHA`);
  }
  return String(value);
}

function requireBranch(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 200
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value)) {
    refuse('platform_candidate_input_invalid', `${label} must be one safe explicit Git branch name`);
  }
  return value;
}

function requirePlatformVersion(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 200
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    refuse('platform_candidate_input_invalid', 'PLATFORM_VERSION must be 1-200 printable characters without surrounding whitespace');
  }
  return value;
}

function requireDryRun(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    refuse('platform_candidate_input_invalid', 'dryRun must be a boolean');
  }
  return value;
}

function requireTicket(value, { dryRun = false } = {}) {
  if (typeof value !== 'string'
    || value.includes('..')
    || (dryRun
      ? (!SAFE_TICKET.test(value) && !GITHUB_TICKET.test(value))
      : !LIVE_TICKET.test(value))) {
    refuse(
      'platform_candidate_ticket_invalid',
      dryRun
        ? 'dry-run ticket id must be a safe opaque id or canonical owner/repository#number identity'
        : 'live candidate ticket id must be exact Glera/p4g-workspace-meta#N',
    );
  }
  return value;
}

export function platformCandidateTicketSegment(ticketId, { dryRun = false } = {}) {
  const ticket = requireTicket(ticketId, { dryRun });
  const readable = ticket.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const digest = createHash('sha256').update(ticket).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

function requireWorktree(rawPath, label) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    refuse('platform_candidate_input_invalid', `${label} worktree path is required`);
  }
  const resolved = path.resolve(rawPath);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    refuse('platform_candidate_worktree_invalid', `${label} worktree does not exist: ${resolved}`);
  }
  const real = realpathSync(resolved);
  const top = String(git(real, ['rev-parse', '--show-toplevel'])).trim();
  if (realpathSync(top) !== real) {
    refuse('platform_candidate_worktree_invalid', `${label} path must name the Git worktree root`);
  }
  return real;
}

export function normalizePlatformCandidateRemote(rawUrl) {
  const value = String(rawUrl || '').trim();
  let repositoryPath;
  const scp = /^git@github\.com:([^/?#]+\/[^/?#]+)$/i.exec(value);
  if (scp) {
    repositoryPath = scp[1];
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      refuse('platform_candidate_repository_remote_invalid', `repository remote is not an approved GitHub URL: ${value || '<empty>'}`);
    }
    const protocol = parsed.protocol.toLowerCase();
    const https = protocol === 'https:'
      && parsed.username === ''
      && parsed.password === '';
    const ssh = protocol === 'ssh:'
      && parsed.username === 'git'
      && parsed.password === '';
    if ((!https && !ssh)
      || parsed.hostname.toLowerCase() !== 'github.com'
      || parsed.port !== ''
      || parsed.search !== ''
      || parsed.hash !== '') {
      refuse('platform_candidate_repository_remote_invalid', `repository remote is not an approved GitHub URL: ${value || '<empty>'}`);
    }
    const match = /^\/([^/]+\/[^/]+)$/.exec(parsed.pathname);
    if (!match || parsed.pathname.includes('%')) {
      refuse('platform_candidate_repository_remote_invalid', `repository remote is not an approved GitHub URL: ${value || '<empty>'}`);
    }
    repositoryPath = match[1];
  }
  const repository = repositoryPath.endsWith('.git')
    ? repositoryPath.slice(0, -4)
    : repositoryPath;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) {
    refuse('platform_candidate_repository_remote_invalid', `repository remote is not an approved GitHub URL: ${value || '<empty>'}`);
  }
  return Object.freeze({
    repository,
    url: `https://github.com/${repository}.git`,
  });
}

function remoteSha(output, ref, repository) {
  const lines = String(output || '').trim().split('\n').filter(Boolean);
  if (lines.length !== 1) {
    refuse('platform_candidate_repository_ref_invalid', `${repository} must expose exactly one ${ref} remote ref`);
  }
  const [sha, actualRef, ...extra] = lines[0].trim().split(/\s+/u);
  if (extra.length > 0 || actualRef !== ref || !SHA.test(sha)) {
    refuse('platform_candidate_repository_ref_invalid', `${repository} returned an invalid ${ref} remote ref`);
  }
  return sha;
}

function verifyOfficialRepository(definition, runGit) {
  const expected = OFFICIAL_REPOSITORIES[definition.role];
  const ref = `refs/heads/${definition.branch}`;
  const beforeRemote = normalizePlatformCandidateRemote(runGit(
    definition.root,
    ['remote', 'get-url', 'origin'],
  ));
  if (beforeRemote.repository !== expected.repository) {
    refuse(
      'platform_candidate_repository_identity_mismatch',
      `${definition.role} origin is ${beforeRemote.repository}; expected ${expected.repository}`,
    );
  }
  const localHead = String(runGit(definition.root, ['rev-parse', 'HEAD'])).trim();
  if (localHead !== definition.sourceSha) {
    refuse(
      'platform_candidate_repository_head_mismatch',
      `${definition.role} HEAD ${localHead} does not equal ${definition.sourceSha}`,
    );
  }
  const beforeSha = remoteSha(
    runGit(definition.root, ['ls-remote', '--exit-code', 'origin', ref]),
    ref,
    expected.repository,
  );
  if (beforeSha !== definition.sourceSha) {
    refuse(
      'platform_candidate_repository_cas_mismatch',
      `${expected.repository} ${ref} is ${beforeSha}; expected ${definition.sourceSha}`,
    );
  }
  runGit(definition.root, [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    'origin',
    ref,
  ]);
  const afterRemote = normalizePlatformCandidateRemote(runGit(
    definition.root,
    ['remote', 'get-url', 'origin'],
  ));
  const afterSha = remoteSha(
    runGit(definition.root, ['ls-remote', '--exit-code', 'origin', ref]),
    ref,
    expected.repository,
  );
  if (afterRemote.repository !== beforeRemote.repository
    || afterRemote.url !== beforeRemote.url
    || afterSha !== beforeSha) {
    refuse(
      'platform_candidate_repository_cas_changed',
      `${expected.repository} ${ref} or origin identity changed across fetch`,
    );
  }
  return Object.freeze({
    official: true,
    repository: expected.repository,
    remote: 'origin',
    remoteUrl: beforeRemote.url,
    ref,
    sourceSha: definition.sourceSha,
  });
}

export function verifyPlatformCandidateRepositoryClosure(input, { runGit = git } = {}) {
  if (typeof runGit !== 'function') {
    refuse('platform_candidate_input_invalid', 'repository verifier requires a Git runner');
  }
  const feedSourceSha = requireSha(input.feedSourceSha, 'feed source SHA');
  const platformBaseSha = requireSha(input.platformBaseSha, 'platform base SHA');
  const ugcSourceSha = requireSha(input.ugcSourceSha, 'swipe-ugc source SHA');
  const feedSourceBranch = requireBranch(input.feedSourceBranch, 'feed source branch');
  const ugcSourceBranch = requireBranch(input.ugcSourceBranch, 'swipe-ugc source branch');
  return Object.freeze({
    feed: verifyOfficialRepository({
      role: 'feed',
      root: input.feedRoot,
      sourceSha: feedSourceSha,
      branch: feedSourceBranch,
    }, runGit),
    platform: verifyOfficialRepository({
      role: 'platform',
      root: input.platformRoot,
      sourceSha: platformBaseSha,
      branch: 'master',
    }, runGit),
    ugc: verifyOfficialRepository({
      role: 'ugc',
      root: input.ugcRoot,
      sourceSha: ugcSourceSha,
      branch: ugcSourceBranch,
    }, runGit),
  });
}

function requireBuiltHtml(feedRoot, platformVersion, feedSourceSha) {
  const expected = path.join(feedRoot, 'dist', 'index.html');
  if (!existsSync(expected)) {
    refuse('platform_candidate_html_invalid', `built HTML must be ${expected}`);
  }
  const resolved = realpathSync(expected);
  if (resolved !== expected) {
    refuse('platform_candidate_html_invalid', `built HTML must be ${expected}`);
  }
  const stat = lstatSync(expected);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    refuse('platform_candidate_html_invalid', 'built dist/index.html must be one regular non-symlink file');
  }
  const bytes = readFileSync(resolved);
  if (bytes.length === 0 || !bytes.toString('utf8', 0, Math.min(bytes.length, 256)).toLowerCase().includes('<!doctype html')) {
    refuse('platform_candidate_html_invalid', 'built dist/index.html must be a non-empty HTML document');
  }
  if (!bytes.includes(Buffer.from(platformVersion, 'utf8'))) {
    refuse('platform_candidate_version_mismatch', 'built dist/index.html does not contain the supplied pinned PLATFORM_VERSION');
  }
  if (!bytes.includes(Buffer.from(feedSourceSha, 'utf8'))) {
    refuse('platform_candidate_source_mismatch', 'built dist/index.html does not contain the full exact feed source SHA');
  }
  return bytes;
}

function resolveBuildTools() {
  if (cachedBuildTools) return cachedBuildTools;
  const nodeExecutable = regularFile(
    process.execPath,
    'platform_candidate_build_tool_invalid',
    `Node executable is not one regular file: ${process.execPath}`,
  );
  const npmLauncher = path.join(path.dirname(process.execPath), 'npm');
  const npmCli = regularFile(
    npmLauncher,
    'platform_candidate_build_tool_invalid',
    `npm launcher must be adjacent to Node: ${npmLauncher}`,
  );
  const pathEntries = [...new Set([path.dirname(nodeExecutable), '/usr/bin', '/bin'])];
  cachedBuildTools = Object.freeze({
    nodeExecutable,
    nodeDigest: fileDigest(nodeExecutable),
    npmCli,
    npmDigest: fileDigest(npmCli),
    path: pathEntries.join(path.delimiter),
  });
  return cachedBuildTools;
}

function isolatedBuildEnvironment(buildRoot, tools, feedSourceSha, ugcSourceSha, platformVersion) {
  const home = path.join(buildRoot, 'home');
  const cache = path.join(buildRoot, 'npm-cache');
  const prefix = path.join(buildRoot, 'npm-prefix');
  const temp = path.join(buildRoot, 'tmp');
  const npmConfigRoot = path.join(buildRoot, 'npm-config');
  for (const directory of [home, cache, prefix, temp, npmConfigRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const userConfig = path.join(npmConfigRoot, 'user.npmrc');
  const globalConfig = path.join(npmConfigRoot, 'global.npmrc');
  writeFileSync(userConfig, '', { flag: 'wx', mode: 0o600 });
  writeFileSync(globalConfig, '', { flag: 'wx', mode: 0o600 });
  return Object.freeze({
    CI: '1',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    NODE_ENV: 'production',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    PATH: tools.path,
    PLATFORM_SOURCE_SHA: feedSourceSha,
    PLATFORM_UGC_SOURCE_SHA: ugcSourceSha,
    PLATFORM_VERSION: platformVersion,
    TMPDIR: temp,
    TZ: 'UTC',
  });
}

function npmCommand(tools, args, { cwd, env, label }) {
  try {
    return execFileSync(tools.nodeExecutable, [tools.npmCli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    refuse(
      'platform_candidate_build_failed',
      `${label} failed in closed build root: ${String(error?.stderr || error?.message || '').trim()}`,
    );
  }
}

function buildRuntime(feedRoot, env, tools) {
  const npmVersion = String(npmCommand(tools, ['--version'], {
    cwd: feedRoot,
    env,
    label: 'npm --version',
  })).trim();
  return Object.freeze({
    node: Object.freeze({
      executable: tools.nodeExecutable,
      sha256: tools.nodeDigest,
      version: process.version,
    }),
    npm: Object.freeze({
      cli: tools.npmCli,
      sha256: tools.npmDigest,
      version: npmVersion,
    }),
  });
}

function buildProfile({
  feedSourceSha,
  ugcSourceSha,
  platformVersion,
  lockfileDigest,
  runtime,
  tools,
}) {
  return Object.freeze({
    schema: BUILD_PROFILE_SCHEMA,
    source: Object.freeze({
      feed: Object.freeze({ cleanHead: feedSourceSha }),
      ugc: Object.freeze({ cleanHead: ugcSourceSha }),
      packageLockSha256: lockfileDigest,
    }),
    commands: Object.freeze({
      install: Object.freeze(['node', 'npm-cli.js', ...NPM_CI_ARGS]),
      build: Object.freeze(['node', 'npm-cli.js', ...NPM_BUILD_ARGS]),
    }),
    environment: Object.freeze({
      CI: '1',
      HOME: 'isolated-empty-directory',
      LANG: 'C',
      LC_ALL: 'C',
      NODE_ENV: 'production',
      NPM_CONFIG_CACHE: 'isolated-empty-directory',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_GLOBALCONFIG: 'isolated-empty-file',
      NPM_CONFIG_PREFIX: 'isolated-empty-directory',
      NPM_CONFIG_PROGRESS: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_USERCONFIG: 'isolated-empty-file',
      PATH: tools.path,
      PLATFORM_SOURCE_SHA: feedSourceSha,
      PLATFORM_UGC_SOURCE_SHA: ugcSourceSha,
      PLATFORM_VERSION: platformVersion,
      TMPDIR: 'isolated-empty-directory',
      TZ: 'UTC',
      VITE_PUBLIC_ENV: 'unset',
    }),
    runtime,
    artifact: 'dist/index.html',
  });
}

function clearBuiltHtml(feedRoot) {
  const dist = path.join(feedRoot, 'dist');
  const expected = path.join(dist, 'index.html');
  if (existsSync(dist)) {
    const distStat = lstatSync(dist);
    if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
      refuse('platform_candidate_html_invalid', 'feed dist must be a real directory');
    }
  }
  if (!existsSync(expected)) return;
  const stat = lstatSync(expected);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    refuse('platform_candidate_html_invalid', 'existing dist/index.html must be a regular non-symlink file');
  }
  rmSync(expected);
}

function cloneCleanSnapshot(sourceRoot, sourceSha, targetRoot, label) {
  git(sourceRoot, [
    'clone',
    '--quiet',
    '--no-checkout',
    '--no-hardlinks',
    sourceRoot,
    targetRoot,
  ]);
  git(targetRoot, ['checkout', '--quiet', '--detach', sourceSha]);
  const head = String(git(targetRoot, ['rev-parse', 'HEAD'])).trim();
  if (head !== sourceSha) {
    refuse('platform_candidate_build_source_invalid', `${label} snapshot HEAD ${head} does not equal ${sourceSha}`);
  }
  if (existsSync(path.join(targetRoot, 'node_modules'))) {
    refuse('platform_candidate_dependency_closure_invalid', `${label} snapshot unexpectedly contains node_modules`);
  }
}

function requireTrackedLockfile(feedRoot, feedSourceSha) {
  if (git(feedRoot, ['cat-file', '-e', `${feedSourceSha}:package-lock.json`], { allowFailure: true }) === null) {
    refuse('platform_candidate_lockfile_invalid', 'feed source must contain a tracked package-lock.json');
  }
  const lockPath = path.join(feedRoot, 'package-lock.json');
  if (!existsSync(lockPath)) {
    refuse('platform_candidate_lockfile_invalid', 'package-lock.json must be one regular tracked file');
  }
  const lockStat = lstatSync(lockPath);
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    refuse('platform_candidate_lockfile_invalid', 'package-lock.json must be one regular tracked file');
  }
  const bytes = readFileSync(lockPath);
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    refuse('platform_candidate_lockfile_invalid', 'package-lock.json must contain valid JSON');
  }
  if (![2, 3].includes(parsed?.lockfileVersion) || !parsed?.packages || typeof parsed.packages !== 'object') {
    refuse('platform_candidate_lockfile_invalid', 'package-lock.json must be npm lockfile v2/v3 with a packages closure');
  }
  return Object.freeze({ bytes, digest: sha256(bytes) });
}

function buildCandidateHtml(feedRoot, feedSourceSha, ugcRoot, ugcSourceSha, platformVersion) {
  const ignored = git(feedRoot, ['check-ignore', '-q', '--', 'dist/index.html'], { allowFailure: true });
  if (ignored === null) {
    refuse('platform_candidate_html_invalid', 'dist/index.html must be ignored build output, never a tracked source artifact');
  }
  for (const relative of ['.env.local', '.env.production.local']) {
    if (existsSync(path.join(feedRoot, relative))) {
      refuse(
        'platform_candidate_build_profile_invalid',
        `machine-local Vite environment is forbidden for candidate builds: ${relative}`,
      );
    }
  }
  const tools = resolveBuildTools();
  const buildRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), BUILD_TEMP_PREFIX)));
  try {
    const sourceRoot = path.join(buildRoot, 'source');
    const buildFeedRoot = path.join(sourceRoot, 'feed-prototype');
    const buildUgcRoot = path.join(sourceRoot, 'swipe-ugc');
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    cloneCleanSnapshot(feedRoot, feedSourceSha, buildFeedRoot, 'feed');
    cloneCleanSnapshot(ugcRoot, ugcSourceSha, buildUgcRoot, 'swipe-ugc');
    const lockfile = requireTrackedLockfile(buildFeedRoot, feedSourceSha);
    const env = isolatedBuildEnvironment(buildRoot, tools, feedSourceSha, ugcSourceSha, platformVersion);
    const runtime = buildRuntime(buildFeedRoot, env, tools);
    const profile = buildProfile({
      feedSourceSha,
      ugcSourceSha,
      platformVersion,
      lockfileDigest: lockfile.digest,
      runtime,
      tools,
    });
    const profileBytes = Buffer.from(stableJson(profile));
    clearBuiltHtml(buildFeedRoot);
    npmCommand(tools, NPM_CI_ARGS, {
      cwd: buildFeedRoot,
      env,
      label: 'npm ci',
    });
    npmCommand(tools, NPM_BUILD_ARGS, {
      cwd: buildFeedRoot,
      env,
      label: 'npm run build',
    });
    assertCleanFeed(buildFeedRoot, feedSourceSha);
    assertCleanUgc(buildUgcRoot, ugcSourceSha);
    return Object.freeze({
      htmlBytes: requireBuiltHtml(buildFeedRoot, platformVersion, feedSourceSha),
      profile,
      profileDigest: sha256(profileBytes),
    });
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

function assertCleanFeed(feedRoot, feedSourceSha) {
  const head = String(git(feedRoot, ['rev-parse', 'HEAD'])).trim();
  if (head !== feedSourceSha) {
    refuse('platform_candidate_feed_head_mismatch', `feed HEAD ${head} does not equal ${feedSourceSha}`);
  }
  const dirty = dirtyPaths(feedRoot);
  if (dirty.length > 0) {
    refuse('platform_candidate_feed_dirty', `feed worktree is dirty: ${dirty.join(', ')}`);
  }
}

function assertCleanUgc(ugcRoot, ugcSourceSha) {
  const head = String(git(ugcRoot, ['rev-parse', 'HEAD'])).trim();
  if (head !== ugcSourceSha) {
    refuse('platform_candidate_ugc_head_mismatch', `swipe-ugc HEAD ${head} does not equal ${ugcSourceSha}`);
  }
  const dirty = dirtyPaths(ugcRoot);
  if (dirty.length > 0) {
    refuse('platform_candidate_ugc_dirty', `swipe-ugc worktree is dirty: ${dirty.join(', ')}`);
  }
}

function candidateLayout(ticketId, feedSourceSha, ugcSourceSha, dryRun) {
  const ticketSegment = platformCandidateTicketSegment(ticketId, { dryRun });
  const root = path.posix.join(
    dryRun ? '.platform-candidate-dry-runs' : 'platform-previews',
    ticketSegment,
    feedSourceSha,
    ugcSourceSha,
  );
  return Object.freeze({
    root,
    html: path.posix.join(root, 'index.html'),
    manifest: path.posix.join(root, 'candidate-manifest.v1.json'),
    urlPath: dryRun ? null : `/${path.posix.join(root, 'index.html')}?base=/`,
  });
}

function desiredCandidate({
  ticketId,
  feedSourceSha,
  feedSourceBranch,
  platformBaseSha,
  platformVersion,
  ugcSourceSha,
  ugcSourceBranch,
  repositories,
  buildProfile,
  buildProfileDigest,
  htmlBytes,
  dryRun,
}) {
  const layout = candidateLayout(ticketId, feedSourceSha, ugcSourceSha, dryRun);
  const htmlDigest = sha256(htmlBytes);
  const manifest = Object.freeze({
    schema: MANIFEST_SCHEMA,
    ticketId,
    feedSourceSha,
    feedSourceBranch,
    platformBaseSha,
    ugcSourceSha,
    ugcSourceBranch,
    repositories,
    build: Object.freeze({
      platformVersion,
      profile: buildProfile,
      profileDigest: buildProfileDigest,
    }),
    artifact: Object.freeze({
      relativePath: layout.html,
      bytes: htmlBytes.length,
      sha256: htmlDigest,
    }),
    candidate: Object.freeze({
      commit: null,
      hostable: !dryRun,
      mode: dryRun ? 'dry-run' : 'live',
      relativeRoot: layout.root,
      urlPath: layout.urlPath,
    }),
    creationInput: Object.freeze({
      ticketId,
      feedSourceSha,
      feedSourceBranch,
      platformBaseSha,
      platformVersion,
      ugcSourceSha,
      ugcSourceBranch,
      repositories,
      buildProfileDigest,
      htmlSha256: htmlDigest,
      mode: dryRun ? 'dry-run' : 'live',
    }),
  });
  const manifestBytes = Buffer.from(prettyStableJson(manifest));
  return Object.freeze({ layout, htmlBytes, htmlDigest, manifest, manifestBytes });
}

function candidateFiles(platformRoot, desired) {
  const entries = [
    [desired.layout.html, desired.htmlBytes],
    [desired.layout.manifest, desired.manifestBytes],
  ];
  for (const [relative] of entries) {
    const absolute = path.resolve(platformRoot, ...relative.split('/'));
    if (!absolute.startsWith(`${platformRoot}${path.sep}`)) {
      refuse('platform_candidate_path_unsafe', `candidate path escaped target worktree: ${relative}`);
    }
    let current = platformRoot;
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      if (!existsSync(current)) break;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        refuse('platform_candidate_path_unsafe', `candidate path has an unsafe ancestor: ${relative}`);
      }
    }
  }
  return entries;
}

function baseContainsPath(platformRoot, platformBaseSha, relative) {
  return git(platformRoot, ['cat-file', '-e', `${platformBaseSha}:${relative}`], { allowFailure: true }) !== null;
}

function assertFilesEqual(platformRoot, entries) {
  for (const [relative, expected] of entries) {
    const absolute = path.join(platformRoot, ...relative.split('/'));
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      refuse('platform_candidate_files_missing', `candidate file is missing or unsafe: ${relative}`);
    }
    const actual = readFileSync(absolute);
    if (!actual.equals(expected)) {
      refuse('platform_candidate_bytes_mismatch', `candidate file differs from exact input: ${relative}`);
    }
  }
}

function assertBaseDoesNotContainCandidate(platformRoot, platformBaseSha, entries) {
  for (const [relative] of entries) {
    if (baseContainsPath(platformRoot, platformBaseSha, relative)) {
      refuse('platform_candidate_target_exists', `platform base already contains candidate path: ${relative}`);
    }
  }
}

function assertPrecommitPlatform(platformRoot, platformBaseSha, entries, { allowEmpty = false } = {}) {
  const head = String(git(platformRoot, ['rev-parse', 'HEAD'])).trim();
  if (head !== platformBaseSha) {
    refuse('platform_candidate_platform_head_mismatch', `platform HEAD ${head} does not equal base ${platformBaseSha}`);
  }
  assertBaseDoesNotContainCandidate(platformRoot, platformBaseSha, entries);
  const allowed = entries.map(([relative]) => relative).sort();
  const dirty = dirtyPaths(platformRoot);
  if (dirty.length === 0) {
    if (!allowEmpty) refuse('platform_candidate_files_missing', 'candidate files have not been prepared');
    for (const [relative] of entries) {
      if (existsSync(path.join(platformRoot, ...relative.split('/')))) {
        refuse('platform_candidate_target_exists', `candidate path exists outside the expected Git diff: ${relative}`);
      }
    }
    return 'empty';
  }
  if (!samePaths(dirty, allowed)) {
    refuse('platform_candidate_platform_dirty', `platform worktree has changes outside candidate files: ${dirty.join(', ')}`);
  }
  assertFilesEqual(platformRoot, entries);
  const changed = changedPaths(platformRoot, platformBaseSha);
  if (!samePaths(changed, allowed)) {
    refuse('platform_candidate_diff_invalid', `candidate diff must contain exactly ${allowed.join(', ')}; got ${changed.join(', ')}`);
  }
  return 'replay';
}

function writeCandidate(platformRoot, entries) {
  for (const [relative, bytes] of entries) {
    const absolute = path.join(platformRoot, ...relative.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o644 });
  }
}

function assertCommittedPlatform(platformRoot, platformBaseSha, candidateCommit, entries) {
  const head = String(git(platformRoot, ['rev-parse', 'HEAD'])).trim();
  if (head !== candidateCommit) {
    refuse('platform_candidate_commit_mismatch', `platform HEAD ${head} does not equal candidate commit ${candidateCommit}`);
  }
  const dirty = dirtyPaths(platformRoot);
  if (dirty.length > 0) {
    refuse('platform_candidate_platform_dirty', `committed candidate worktree is dirty: ${dirty.join(', ')}`);
  }
  const parent = String(git(platformRoot, ['rev-parse', `${candidateCommit}^`])).trim();
  if (parent !== platformBaseSha) {
    refuse('platform_candidate_commit_parent_mismatch', `candidate commit parent ${parent} does not equal base ${platformBaseSha}`);
  }
  assertBaseDoesNotContainCandidate(platformRoot, platformBaseSha, entries);
  const allowed = entries.map(([relative]) => relative).sort();
  const changed = changedPaths(platformRoot, platformBaseSha, candidateCommit);
  if (!samePaths(changed, allowed)) {
    refuse('platform_candidate_diff_invalid', `candidate commit must contain exactly ${allowed.join(', ')}; got ${changed.join(', ')}`);
  }
  for (const [relative, expected] of entries) {
    const committed = git(platformRoot, ['show', `${candidateCommit}:${relative}`], { encoding: null });
    if (!Buffer.from(committed).equals(expected)) {
      refuse('platform_candidate_bytes_mismatch', `candidate commit bytes differ from exact input: ${relative}`);
    }
  }
  assertFilesEqual(platformRoot, entries);
}

function dryRunRepositoryClosure({
  feedRoot,
  feedSourceSha,
  feedSourceBranch,
  platformRoot,
  platformBaseSha,
  ugcRoot,
  ugcSourceSha,
  ugcSourceBranch,
  ugcWorktreeSelection,
}) {
  const identity = (root, sourceSha, branch, extra = {}) => {
    const rawRemote = git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
    let normalized = null;
    if (rawRemote !== null) {
      try {
        normalized = normalizePlatformCandidateRemote(rawRemote);
      } catch {
        normalized = null;
      }
    }
    return Object.freeze({
      official: false,
      repository: normalized?.repository ?? null,
      remote: normalized ? 'origin' : null,
      remoteUrl: normalized?.url ?? null,
      ref: `refs/heads/${branch}`,
      sourceSha,
      ...extra,
    });
  };
  return Object.freeze({
    feed: identity(feedRoot, feedSourceSha, feedSourceBranch),
    platform: identity(platformRoot, platformBaseSha, 'master'),
    ugc: identity(ugcRoot, ugcSourceSha, ugcSourceBranch, { worktreeSelection: ugcWorktreeSelection }),
  });
}

function preparationContext(rawOptions) {
  const dryRun = requireDryRun(rawOptions.dryRun);
  const ticketId = requireTicket(rawOptions.ticketId, { dryRun });
  const feedSourceSha = requireSha(rawOptions.feedSourceSha, 'feed source SHA');
  const feedSourceBranch = requireBranch(rawOptions.feedSourceBranch, 'feed source branch');
  const platformBaseSha = requireSha(rawOptions.platformBaseSha, 'platform base SHA');
  const ugcSourceSha = requireSha(rawOptions.ugcSourceSha, 'swipe-ugc source SHA');
  const ugcSourceBranch = requireBranch(rawOptions.ugcSourceBranch, 'swipe-ugc source branch');
  const platformVersion = requirePlatformVersion(rawOptions.platformVersion);
  const feedRoot = requireWorktree(rawOptions.feedWorktree, 'feed');
  const platformRoot = requireWorktree(rawOptions.platformWorktree, 'platform');
  const siblingUgcRoot = path.resolve(feedRoot, '..', 'swipe-ugc');
  const ugcWorktreeSelection = rawOptions.ugcWorktree === undefined ? 'sibling' : 'explicit';
  const ugcRoot = requireWorktree(rawOptions.ugcWorktree ?? siblingUgcRoot, 'swipe-ugc');
  if (new Set([feedRoot, platformRoot, ugcRoot]).size !== 3) {
    refuse('platform_candidate_worktree_invalid', 'feed, platform, and swipe-ugc worktrees must be separate');
  }
  assertCleanFeed(feedRoot, feedSourceSha);
  assertCleanUgc(ugcRoot, ugcSourceSha);
  const repositories = dryRun
    ? dryRunRepositoryClosure({
      feedRoot,
      feedSourceSha,
      feedSourceBranch,
      platformRoot,
      platformBaseSha,
      ugcRoot,
      ugcSourceSha,
      ugcSourceBranch,
      ugcWorktreeSelection,
    })
    : (() => {
      const verified = verifyPlatformCandidateRepositoryClosure({
        feedRoot,
        feedSourceSha,
        feedSourceBranch,
        platformRoot,
        platformBaseSha,
        ugcRoot,
        ugcSourceSha,
        ugcSourceBranch,
      });
      return Object.freeze({
        ...verified,
        ugc: Object.freeze({ ...verified.ugc, worktreeSelection: ugcWorktreeSelection }),
      });
    })();
  const built = buildCandidateHtml(feedRoot, feedSourceSha, ugcRoot, ugcSourceSha, platformVersion);
  assertCleanFeed(feedRoot, feedSourceSha);
  assertCleanUgc(ugcRoot, ugcSourceSha);
  const desired = desiredCandidate({
    ticketId,
    feedSourceSha,
    feedSourceBranch,
    platformBaseSha,
    platformVersion,
    ugcSourceSha,
    ugcSourceBranch,
    repositories,
    buildProfile: built.profile,
    buildProfileDigest: built.profileDigest,
    htmlBytes: built.htmlBytes,
    dryRun,
  });
  const entries = candidateFiles(platformRoot, desired);
  return Object.freeze({
    ticketId,
    feedSourceSha,
    feedSourceBranch,
    platformBaseSha,
    platformVersion,
    ugcSourceSha,
    ugcSourceBranch,
    repositories,
    buildProfileDigest: built.profileDigest,
    dryRun,
    feedRoot,
    platformRoot,
    ugcRoot,
    desired,
    entries,
  });
}

function receipt(context, candidateCommit) {
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    ticketId: context.ticketId,
    feedSourceSha: context.feedSourceSha,
    feedSourceBranch: context.feedSourceBranch,
    platformBaseSha: context.platformBaseSha,
    platformVersion: context.platformVersion,
    ugcSourceSha: context.ugcSourceSha,
    ugcSourceBranch: context.ugcSourceBranch,
    repositories: context.repositories,
    buildProfileDigest: context.buildProfileDigest,
    htmlSha256: context.desired.htmlDigest,
    candidateManifestSha256: sha256(context.desired.manifestBytes),
    candidateRelativePath: context.desired.layout.html,
    candidateUrlPath: context.desired.layout.urlPath,
    candidateHostable: !context.dryRun,
    candidateMode: context.dryRun ? 'dry-run' : 'live',
    candidateCommit,
  });
}

export function preparePlatformCandidate(options) {
  const context = preparationContext(options);
  const state = assertPrecommitPlatform(
    context.platformRoot,
    context.platformBaseSha,
    context.entries,
    { allowEmpty: true },
  );
  if (state === 'empty') writeCandidate(context.platformRoot, context.entries);
  assertPrecommitPlatform(context.platformRoot, context.platformBaseSha, context.entries);
  return receipt(context, null);
}

export function checkPlatformCandidate(options) {
  if (options.dryRun === true && options.candidateCommit !== undefined && options.candidateCommit !== null) {
    refuse('platform_candidate_dry_run_not_committable', 'dry-run candidate cannot pass a committed/live check');
  }
  const context = preparationContext(options);
  const candidateCommit = options.candidateCommit === undefined || options.candidateCommit === null
    ? null
    : requireSha(options.candidateCommit, 'candidate commit');
  if (candidateCommit) {
    assertCommittedPlatform(context.platformRoot, context.platformBaseSha, candidateCommit, context.entries);
  } else {
    assertPrecommitPlatform(context.platformRoot, context.platformBaseSha, context.entries);
  }
  return receipt(context, candidateCommit);
}

function parseArgs(argv) {
  const result = { check: false, dryRun: false };
  const names = new Map([
    ['--ticket', 'ticketId'],
    ['--feed-worktree', 'feedWorktree'],
    ['--feed-source-sha', 'feedSourceSha'],
    ['--feed-source-branch', 'feedSourceBranch'],
    ['--platform-worktree', 'platformWorktree'],
    ['--platform-base-sha', 'platformBaseSha'],
    ['--ugc-worktree', 'ugcWorktree'],
    ['--ugc-source-sha', 'ugcSourceSha'],
    ['--ugc-source-branch', 'ugcSourceBranch'],
    ['--platform-version', 'platformVersion'],
    ['--candidate-commit', 'candidateCommit'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      result.check = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const key = names.get(arg);
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      refuse('platform_candidate_cli_invalid', `unknown or incomplete argument: ${arg}`);
    }
    if (result[key] !== undefined) refuse('platform_candidate_cli_invalid', `duplicate argument: ${arg}`);
    result[key] = argv[index + 1];
    index += 1;
  }
  if (result.candidateCommit && !result.check) {
    refuse('platform_candidate_cli_invalid', '--candidate-commit is valid only with --check');
  }
  if (result.candidateCommit && result.dryRun) {
    refuse('platform_candidate_cli_invalid', '--candidate-commit cannot be combined with --dry-run');
  }
  return result;
}

function usage() {
  return [
    'Usage: node scripts/prepare-platform-candidate.mjs [--check] [--dry-run]',
    '  --ticket <Glera/p4g-workspace-meta#N>',
    '    (other safe ids require --dry-run and produce no hostable URL)',
    '  --feed-worktree <clean-feed-worktree>',
    '  --feed-source-sha <40-hex-clean-HEAD>',
    '  --feed-source-branch <exact-pushed-origin-branch>',
    '  --platform-worktree <separate-swipe-platform-worktree>',
    '  --platform-base-sha <exact-origin-master-HEAD>',
    '  [--ugc-worktree <clean-swipe-ugc-worktree>]',
    '    (defaults to the exact ../swipe-ugc sibling of the feed worktree)',
    '  --ugc-source-sha <40-hex-clean-HEAD>',
    '  --ugc-source-branch <exact-pushed-origin-branch>',
    '  --platform-version <pinned-build-value>',
    '  (live mode pins official origins with read/fetch/read CAS)',
    '  (the tool clones exact clean sources, runs npm ci, then the real Vite build)',
    '  [--candidate-commit <40-hex-HEAD>]',
  ].join('\n');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const value = options.check ? checkPlatformCandidate(options) : preparePlatformCandidate(options);
    process.stdout.write(prettyStableJson(value));
  } catch (error) {
    process.stderr.write(`${error?.code || 'platform_candidate_failed'}: ${error?.message || error}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
