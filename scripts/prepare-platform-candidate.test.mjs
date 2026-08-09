import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PlatformCandidateError,
  checkPlatformCandidate,
  normalizePlatformCandidateRemote,
  platformCandidateTicketSegment,
  preparePlatformCandidate,
  verifyPlatformCandidateRepositoryClosure,
} from './prepare-platform-candidate.mjs';

const TICKET = 'Glera/p4g-workspace-meta#17';
const VERSION = 'ticket 17 · feed candidate';
const DRY_TICKET = 'local-spike-17';
const SCRIPT = fileURLToPath(new URL('./prepare-platform-candidate.mjs', import.meta.url));

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, relative, value) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function repository(root, files) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'master');
  git(root, 'config', 'user.name', 'Platform candidate test');
  git(root, 'config', 'user.email', 'platform-candidate@example.invalid');
  for (const [relative, value] of Object.entries(files)) write(root, relative, value);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture base');
  return git(root, 'rev-parse', 'HEAD');
}

function fixture({ embedSource = true, includeLockfile = true } = {}) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'platform-candidate-test-'));
  const feed = path.join(sandbox, 'feed-prototype');
  const ugc = path.join(sandbox, 'swipe-ugc');
  const platform = path.join(sandbox, 'swipe-platform-candidate');
  const feedFiles = {
    '.gitignore': 'dist/\nnode_modules/\n',
    'package.json': '{"private":true,"type":"module","scripts":{"build":"node build.mjs"}}\n',
    'build.mjs': [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "if (existsSync('node_modules/leak.txt')) throw new Error('preexisting node_modules leaked into build');",
      "if (!process.env.HOME?.includes('platform-candidate-build-')) throw new Error('HOME is not isolated');",
      "if (!process.env.NPM_CONFIG_CACHE?.includes('platform-candidate-build-')) throw new Error('npm cache is not isolated');",
      "if (!existsSync(process.env.NPM_CONFIG_USERCONFIG || '')) throw new Error('user npm config is not isolated');",
      "if (!existsSync(process.env.NPM_CONFIG_GLOBALCONFIG || '')) throw new Error('global npm config is not isolated');",
      "if (process.env.PATH?.includes('untrusted-bin')) throw new Error('ambient PATH leaked into build');",
      "if (process.env.NPM_CONFIG_SENTINEL || process.env.VITE_UNTRUSTED) throw new Error('ambient config leaked into build');",
      "const source = process.env.PLATFORM_SOURCE_SHA || 'missing-source';",
      "const version = process.env.PLATFORM_VERSION || 'missing-version';",
      "const ugc = readFileSync('../swipe-ugc/recipes/sort/recipe.mjs', 'utf8').trim();",
      "mkdirSync('dist', { recursive: true });",
      `writeFileSync('dist/index.html', \`<!doctype html><html><body>\${version}|${embedSource ? '${source}' : 'source-omitted'}|ugc:\${ugc}|closed:true</body></html>\\n\`);`,
      '',
    ].join('\n'),
    'src/main.ts': 'export {};\n',
  };
  if (includeLockfile) {
    feedFiles['package-lock.json'] = '{"name":"candidate-fixture","lockfileVersion":3,"requires":true,"packages":{"":{"name":"candidate-fixture"}}}\n';
  }
  const feedSha = repository(feed, feedFiles);
  git(feed, 'remote', 'add', 'origin', 'https://github.com/Example/not-feed-prototype.git');
  const ugcSha = repository(ugc, {
    'recipes/sort/recipe.mjs': 'ugc-recipe-v1\n',
  });
  git(ugc, 'remote', 'add', 'origin', 'https://github.com/Example/not-swipe-ugc.git');
  const platformBaseSha = repository(platform, {
    'index.html': '<!doctype html><title>production</title>\n',
    'release.json': '{"schemaVersion":2}\n',
    'versions.json': '{}\n',
    'mechanic.html': '<!doctype html><title>mechanic</title>\n',
  });
  git(platform, 'remote', 'add', 'origin', 'https://github.com/Example/not-swipe-platform.git');
  const options = {
    ticketId: TICKET,
    dryRun: true,
    feedWorktree: feed,
    feedSourceSha: feedSha,
    feedSourceBranch: 'candidate/test',
    platformWorktree: platform,
    platformBaseSha,
    ugcSourceSha: ugcSha,
    ugcSourceBranch: 'master',
    platformVersion: VERSION,
  };
  return { sandbox, feed, ugc, platform, feedSha, ugcSha, platformBaseSha, options };
}

function candidatePaths(feedSha, ugcSha, { ticketId = TICKET, dryRun = true } = {}) {
  const namespace = dryRun ? '.platform-candidate-dry-runs' : 'platform-previews';
  const root = `${namespace}/${platformCandidateTicketSegment(ticketId, { dryRun })}/${feedSha}/${ugcSha}`;
  return [`${root}/candidate-manifest.v1.json`, `${root}/index.html`].sort();
}

test('approved GitHub remote forms normalize to one canonical identity', () => {
  for (const remote of [
    'https://github.com/Glera/feed-prototype.git',
    'https://GITHUB.COM/Glera/feed-prototype',
    'ssh://git@github.com/Glera/feed-prototype.git',
    'git@github.com:Glera/feed-prototype.git',
  ]) {
    assert.deepEqual(normalizePlatformCandidateRemote(remote), {
      repository: 'Glera/feed-prototype',
      url: 'https://github.com/Glera/feed-prototype.git',
    });
  }
  for (const remote of [
    'http://github.com/Glera/feed-prototype.git',
    'https://github.com.evil.invalid/Glera/feed-prototype.git',
    'https://token@github.com/Glera/feed-prototype.git',
    'file:///tmp/feed-prototype',
  ]) {
    assert.throws(
      () => normalizePlatformCandidateRemote(remote),
      (error) => error.code === 'platform_candidate_repository_remote_invalid',
    );
  }
});

function repositoryVerifierFixture({ changePlatformAfterFetch = false } = {}) {
  const feedSha = '1'.repeat(40);
  const platformSha = '2'.repeat(40);
  const ugcSha = '3'.repeat(40);
  const facts = {
    '/feed': { remote: 'git@github.com:Glera/feed-prototype.git', sha: feedSha, branch: 'codex/candidate' },
    '/platform': { remote: 'https://github.com/Glera/swipe-platform.git', sha: platformSha, branch: 'master' },
    '/ugc': { remote: 'ssh://git@github.com/Glera/swipe-ugc.git', sha: ugcSha, branch: 'master' },
  };
  const commands = [];
  const fetched = new Set();
  const runGit = (root, args) => {
    commands.push([root, ...args]);
    const fact = facts[root];
    if (args[0] === 'remote') return `${fact.remote}\n`;
    if (args[0] === 'rev-parse') return `${fact.sha}\n`;
    if (args[0] === 'fetch') {
      fetched.add(root);
      return '';
    }
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1);
      const changed = changePlatformAfterFetch && root === '/platform' && fetched.has(root);
      return `${changed ? '4'.repeat(40) : fact.sha}\t${ref}\n`;
    }
    throw new Error(`unexpected injected Git command: ${args.join(' ')}`);
  };
  const input = {
    feedRoot: '/feed',
    feedSourceSha: feedSha,
    feedSourceBranch: 'codex/candidate',
    platformRoot: '/platform',
    platformBaseSha: platformSha,
    ugcRoot: '/ugc',
    ugcSourceSha: ugcSha,
    ugcSourceBranch: 'master',
  };
  return { commands, input, runGit };
}

test('live repository verifier pins official identities and read/fetch/read CAS', () => {
  const fixtureValue = repositoryVerifierFixture();
  const identities = verifyPlatformCandidateRepositoryClosure(
    fixtureValue.input,
    { runGit: fixtureValue.runGit },
  );
  assert.deepEqual(identities.feed, {
    official: true,
    repository: 'Glera/feed-prototype',
    remote: 'origin',
    remoteUrl: 'https://github.com/Glera/feed-prototype.git',
    ref: 'refs/heads/codex/candidate',
    sourceSha: '1'.repeat(40),
  });
  assert.equal(identities.platform.ref, 'refs/heads/master');
  assert.equal(identities.platform.sourceSha, '2'.repeat(40));
  assert.equal(identities.ugc.repository, 'Glera/swipe-ugc');
  const fetches = fixtureValue.commands.filter((command) => command[1] === 'fetch');
  assert.equal(fetches.length, 3);
  assert.ok(fetches.every((command) => command.includes('--no-write-fetch-head')));

  const changed = repositoryVerifierFixture({ changePlatformAfterFetch: true });
  assert.throws(
    () => verifyPlatformCandidateRepositoryClosure(changed.input, { runGit: changed.runGit }),
    (error) => error.code === 'platform_candidate_repository_cas_changed',
  );
});

test('preparation is reproducible and an identical replay is idempotent', () => {
  const value = fixture();
  const previousVite = process.env.VITE_UNTRUSTED;
  const previousSentinel = process.env.NPM_CONFIG_SENTINEL;
  const previousPath = process.env.PATH;
  try {
    process.env.VITE_UNTRUSTED = 'must-not-enter-build';
    process.env.NPM_CONFIG_SENTINEL = 'must-not-enter-build';
    process.env.PATH = `${previousPath}${path.delimiter}/untrusted-bin`;
    write(value.feed, 'dist/index.html', '<!doctype html><title>stale ignored output</title>\n');
    write(value.feed, 'node_modules/leak.txt', 'must not enter source snapshot\n');
    const forgedProfileDigest = `sha256:${'7'.repeat(64)}`;
    const first = preparePlatformCandidate({ ...value.options, buildProfileDigest: forgedProfileDigest });
    const paths = candidatePaths(value.feedSha, value.ugcSha);
    assert.equal(first.candidateCommit, null);
    assert.equal(first.candidateUrlPath, null);
    assert.deepEqual(
      git(value.platform, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).sort(),
      paths,
    );
    assert.deepEqual(git(value.platform, 'diff', '--name-only', value.platformBaseSha).split('\n').filter(Boolean).sort(), []);
    const manifestPath = path.join(value.platform, paths[0]);
    const firstManifest = readFileSync(manifestPath);
    const firstHtml = readFileSync(path.join(value.platform, paths[1]), 'utf8');
    assert.match(firstHtml, new RegExp(value.feedSha));
    assert.match(firstHtml, /ugc:ugc-recipe-v1\|closed:true/);
    assert.doesNotMatch(firstHtml, /stale ignored output|must-not-enter-build|leak/);

    const replay = preparePlatformCandidate(value.options);
    assert.deepEqual(replay, first);
    assert.ok(readFileSync(manifestPath).equals(firstManifest));
    assert.deepEqual(checkPlatformCandidate(value.options), first);
    const manifest = JSON.parse(firstManifest);
    assert.equal(manifest.candidate.commit, null);
    assert.equal(manifest.candidate.hostable, false);
    assert.equal(manifest.candidate.mode, 'dry-run');
    assert.equal(manifest.build.profile.environment.PLATFORM_SOURCE_SHA, value.feedSha);
    assert.equal(manifest.build.profile.environment.PLATFORM_UGC_SOURCE_SHA, value.ugcSha);
    assert.equal(manifest.build.profile.environment.VITE_PUBLIC_ENV, 'unset');
    assert.equal(manifest.build.profile.source.ugc.cleanHead, value.ugcSha);
    assert.match(manifest.build.profile.source.packageLockSha256, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(manifest.build.profile.commands.install, ['node', 'npm-cli.js', 'ci', '--include=dev', '--no-audit', '--no-fund']);
    assert.equal(manifest.repositories.feed.official, false);
    assert.equal(manifest.repositories.ugc.worktreeSelection, 'sibling');
    assert.equal(first.repositories.ugc.sourceSha, value.ugcSha);
    assert.equal(manifest.build.profileDigest, first.buildProfileDigest);
    assert.match(first.buildProfileDigest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(first.buildProfileDigest, forgedProfileDigest);
    assert.equal('createdAt' in manifest, false);
  } finally {
    if (previousVite === undefined) delete process.env.VITE_UNTRUSTED;
    else process.env.VITE_UNTRUSTED = previousVite;
    if (previousSentinel === undefined) delete process.env.NPM_CONFIG_SENTINEL;
    else process.env.NPM_CONFIG_SENTINEL = previousSentinel;
    process.env.PATH = previousPath;
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('generic repository fixtures cannot enter live mode', () => {
  const value = fixture();
  try {
    assert.throws(
      () => preparePlatformCandidate({ ...value.options, dryRun: false }),
      (error) => error.code === 'platform_candidate_repository_identity_mismatch',
    );
    assert.equal(git(value.platform, 'status', '--short'), '');
  } finally {
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('ticket path traversal and unsafe ticket identities fail before writes', () => {
  const value = fixture();
  try {
    assert.throws(
      () => preparePlatformCandidate({ ...value.options, ticketId: '../../escape' }),
      (error) => error instanceof PlatformCandidateError && error.code === 'platform_candidate_ticket_invalid',
    );
    assert.throws(
      () => preparePlatformCandidate({ ...value.options, ticketId: '/absolute' }),
      (error) => error instanceof PlatformCandidateError && error.code === 'platform_candidate_ticket_invalid',
    );
    assert.throws(
      () => preparePlatformCandidate({ ...value.options, ticketId: 'has spaces' }),
      (error) => error instanceof PlatformCandidateError && error.code === 'platform_candidate_ticket_invalid',
    );
    assert.equal(git(value.platform, 'status', '--short'), '');
  } finally {
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('non-canonical tickets require explicit dry-run and produce a non-hostable record', () => {
  const value = fixture();
  const dryOptions = { ...value.options, ticketId: DRY_TICKET, dryRun: true };
  const cliArgs = [
    '--ticket', DRY_TICKET,
    '--feed-worktree', value.feed,
    '--feed-source-sha', value.feedSha,
    '--feed-source-branch', 'candidate/test',
    '--platform-worktree', value.platform,
    '--platform-base-sha', value.platformBaseSha,
    '--ugc-source-sha', value.ugcSha,
    '--ugc-source-branch', 'master',
    '--platform-version', VERSION,
  ];
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, ...cliArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (error) => String(error.stderr).includes('live candidate ticket id must be exact Glera/p4g-workspace-meta#N'),
    );
    const receipt = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT, '--dry-run', ...cliArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    const paths = candidatePaths(value.feedSha, value.ugcSha, { ticketId: DRY_TICKET, dryRun: true });
    assert.equal(receipt.candidateMode, 'dry-run');
    assert.equal(receipt.candidateHostable, false);
    assert.equal(receipt.candidateUrlPath, null);
    assert.deepEqual(
      git(value.platform, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).sort(),
      paths,
    );
    const manifest = JSON.parse(readFileSync(path.join(value.platform, paths[0]), 'utf8'));
    assert.equal(manifest.candidate.mode, 'dry-run');
    assert.equal(manifest.candidate.hostable, false);
    assert.equal(manifest.candidate.urlPath, null);
    assert.deepEqual(checkPlatformCandidate(dryOptions), receipt);

    git(value.platform, 'add', '.');
    git(value.platform, 'commit', '-m', 'record local dry run');
    const dryCommit = git(value.platform, 'rev-parse', 'HEAD');
    assert.throws(
      () => checkPlatformCandidate({ ...dryOptions, candidateCommit: dryCommit }),
      (error) => error.code === 'platform_candidate_dry_run_not_committable',
    );
    assert.throws(
      () => checkPlatformCandidate({ ...value.options, dryRun: false, ticketId: DRY_TICKET, candidateCommit: dryCommit }),
      (error) => error.code === 'platform_candidate_ticket_invalid',
    );
  } finally {
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('a symlinked candidate namespace cannot escape the platform worktree', () => {
  const value = fixture();
  try {
    const outside = path.join(value.sandbox, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(value.platform, '.platform-candidate-dry-runs'));
    assert.throws(
      () => preparePlatformCandidate(value.options),
      (error) => error.code === 'platform_candidate_path_unsafe',
    );
    assert.deepEqual(readFileSync(path.join(value.platform, 'index.html'), 'utf8'), '<!doctype html><title>production</title>\n');
  } finally {
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('dirty feed, dirty platform, and head mismatches fail closed', () => {
  const feedDirty = fixture();
  try {
    write(feedDirty.feed, 'src/main.ts', 'export const dirty = true;\n');
    assert.throws(
      () => preparePlatformCandidate(feedDirty.options),
      (error) => error.code === 'platform_candidate_feed_dirty',
    );
  } finally {
    rmSync(feedDirty.sandbox, { recursive: true, force: true });
  }

  const platformDirty = fixture();
  try {
    write(platformDirty.platform, 'index.html', '<!doctype html><title>dirty root</title>\n');
    assert.throws(
      () => preparePlatformCandidate(platformDirty.options),
      (error) => error.code === 'platform_candidate_platform_dirty',
    );
  } finally {
    rmSync(platformDirty.sandbox, { recursive: true, force: true });
  }

  const mismatch = fixture();
  try {
    assert.throws(
      () => preparePlatformCandidate({ ...mismatch.options, platformBaseSha: mismatch.feedSha }),
      (error) => error.code === 'platform_candidate_platform_head_mismatch',
    );
  } finally {
    rmSync(mismatch.sandbox, { recursive: true, force: true });
  }
});

test('different existing candidate bytes and unrelated diff paths are rejected', () => {
  const different = fixture();
  try {
    preparePlatformCandidate(different.options);
    const htmlPath = path.join(different.platform, candidatePaths(different.feedSha, different.ugcSha)[1]);
    writeFileSync(htmlPath, '<!doctype html><title>wrong bytes</title>\n');
    assert.throws(
      () => preparePlatformCandidate(different.options),
      (error) => error.code === 'platform_candidate_bytes_mismatch',
    );
  } finally {
    rmSync(different.sandbox, { recursive: true, force: true });
  }

  const unrelated = fixture();
  try {
    preparePlatformCandidate(unrelated.options);
    write(unrelated.platform, 'unexpected.txt', 'not allowed\n');
    assert.throws(
      () => checkPlatformCandidate(unrelated.options),
      (error) => error.code === 'platform_candidate_platform_dirty',
    );
  } finally {
    rmSync(unrelated.sandbox, { recursive: true, force: true });
  }
});

test('freshly built HTML must carry the full exact feed source SHA', () => {
  const value = fixture({ embedSource: false });
  try {
    assert.throws(
      () => preparePlatformCandidate(value.options),
      (error) => error.code === 'platform_candidate_source_mismatch',
    );
    assert.equal(git(value.platform, 'status', '--short'), '');
  } finally {
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});

test('swipe-ugc is exact, clean, and may be selected explicitly', () => {
  const dirty = fixture();
  try {
    write(dirty.ugc, 'recipes/sort/recipe.mjs', 'dirty recipe\n');
    assert.throws(
      () => preparePlatformCandidate(dirty.options),
      (error) => error.code === 'platform_candidate_ugc_dirty',
    );
    assert.equal(git(dirty.platform, 'status', '--short'), '');
  } finally {
    rmSync(dirty.sandbox, { recursive: true, force: true });
  }

  const explicit = fixture();
  try {
    const receipt = preparePlatformCandidate({ ...explicit.options, ugcWorktree: explicit.ugc });
    const manifestPath = path.join(
      explicit.platform,
      candidatePaths(explicit.feedSha, explicit.ugcSha)[0],
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(receipt.repositories.ugc.sourceSha, explicit.ugcSha);
    assert.equal(manifest.repositories.ugc.worktreeSelection, 'explicit');
  } finally {
    rmSync(explicit.sandbox, { recursive: true, force: true });
  }
});

test('missing lockfile fails closed and the isolated build root is removed', () => {
  const value = fixture({ includeLockfile: false });
  const previousTmp = process.env.TMPDIR;
  const isolatedTmp = path.join(value.sandbox, 'isolated-tmp');
  mkdirSync(isolatedTmp);
  try {
    process.env.TMPDIR = isolatedTmp;
    assert.throws(
      () => preparePlatformCandidate(value.options),
      (error) => error.code === 'platform_candidate_lockfile_invalid',
    );
    assert.deepEqual(readdirSync(isolatedTmp), []);
    assert.equal(git(value.platform, 'status', '--short'), '');
    assert.equal(existsSync(path.join(value.feed, 'node_modules')), false);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(value.sandbox, { recursive: true, force: true });
  }
});
