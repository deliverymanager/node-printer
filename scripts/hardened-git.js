'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const UNSAFE_LOCAL_CONFIG = Object.freeze([
  /^core\.(alternaterefscommand|attributesfile|autocrlf|checkstat|eol|excludesfile|fscache|fsmonitor|gitproxy|hookspath|ignorestat|sparsecheckout|sparsecheckoutcone|sshcommand|trustctime|untrackedcache|worktree)$/i,
  /^credential\./i,
  /^diff\.(external|[^.]+\.(command|textconv))$/i,
  /^extensions\.(partialclone|worktreeconfig)$/i,
  /^feature\.manyfiles$/i,
  /^filter\.[^.]+\.(clean|process|smudge)$/i,
  /^http\./i,
  /^include(if)?\./i,
  /^index\.sparse$/i,
  /^protocol\./i,
  /^remote\.origin\.(proxy|uploadpack|vcs)$/i,
  /^remote\.[^.]+\.(partialclonefilter|promisor)$/i,
  /^url\..*\.(insteadof|pushinsteadof)$/i,
]);

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function realPath(existingPath, label, fsImpl = fs) {
  try {
    return fsImpl.realpathSync.native(existingPath);
  } catch (error) {
    throw new Error(`Unable to resolve ${label}: ${existingPath}`, { cause: error });
  }
}

function readGitDirMarker(workTree, fsImpl = fs) {
  const markerPath = path.join(workTree, '.git');
  let marker;
  try {
    marker = fsImpl.lstatSync(markerPath);
  } catch (error) {
    throw new Error(`Release repository has no resolvable .git entry: ${markerPath}`, {
      cause: error,
    });
  }
  if (marker.isDirectory() && !marker.isSymbolicLink()) {
    return realPath(markerPath, 'Git directory', fsImpl);
  }
  if (!marker.isFile() || marker.isSymbolicLink()) {
    throw new Error(
      'Release repository .git entry must be a directory or a regular linked-worktree marker',
    );
  }
  const markerValue = fsImpl.readFileSync(markerPath, 'utf8').trim();
  const match = /^gitdir: ([^\0\r\n]+)$/.exec(markerValue);
  if (!match) throw new Error('Release repository has an invalid linked-worktree .git marker');
  return realPath(path.resolve(workTree, match[1]), 'linked-worktree Git directory', fsImpl);
}

function readCommonDir(gitDir, fsImpl = fs) {
  const markerPath = path.join(gitDir, 'commondir');
  if (!fsImpl.existsSync(markerPath)) return gitDir;
  const marker = fsImpl.lstatSync(markerPath);
  if (!marker.isFile() || marker.isSymbolicLink()) {
    throw new Error('Git commondir marker must be a regular file');
  }
  const markerValue = fsImpl.readFileSync(markerPath, 'utf8').trim();
  if (!markerValue || /[\0\r\n]/.test(markerValue)) {
    throw new Error('Git commondir marker is invalid');
  }
  return realPath(path.resolve(gitDir, markerValue), 'Git common directory', fsImpl);
}

function createGitContext(repoRoot, fsImpl = fs) {
  const workTree = realPath(path.resolve(repoRoot), 'release worktree', fsImpl);
  const gitDir = readGitDirMarker(workTree, fsImpl);
  const commonDir = readCommonDir(gitDir, fsImpl);
  return Object.freeze({ commonDir, fsImpl, gitDir, workTree });
}

function createGitEnvironment(sourceEnvironment = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (!/^GIT_/i.test(name)) environment[name] = value;
  }
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function hardenedGitArgs(context, args) {
  return [
    '--no-replace-objects',
    `--git-dir=${context.gitDir}`,
    `--work-tree=${context.workTree}`,
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=true',
    '-c', 'core.useReplaceRefs=false',
    '-c', 'fetch.fsckObjects=true',
    '-c', 'transfer.fsckObjects=true',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'protocol.ext.allow=never',
    ...args,
  ];
}

function commandOptions(context, options) {
  return {
    cwd: context.workTree,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: createGitEnvironment(options.environment),
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function runGitInContext(context, args, options = {}) {
  const runner = options.execFileSyncImpl || execFileSync;
  return runner('git', hardenedGitArgs(context, args), commandOptions(context, options));
}

function spawnGitInContext(context, args, options = {}) {
  const runner = options.spawnSyncImpl || spawnSync;
  return runner('git', hardenedGitArgs(context, args), commandOptions(context, {
    ...options,
    stdio: options.stdio || 'ignore',
  }));
}

function parseNullSeparated(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function assertResolvedRepository(context, options = {}) {
  const current = createGitContext(context.workTree, context.fsImpl);
  if (!samePath(current.workTree, context.workTree)
      || !samePath(current.gitDir, context.gitDir)
      || !samePath(current.commonDir, context.commonDir)) {
    throw new Error('Release repository .git/commondir resolution changed during validation');
  }
  const run = (args) => String(runGitInContext(context, args, options)).trim();
  const reportedWorkTree = realPath(run(['rev-parse', '--show-toplevel']), 'Git worktree');
  const reportedGitDir = realPath(run(['rev-parse', '--absolute-git-dir']), 'Git directory');
  const reportedCommonDir = realPath(
    run(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'Git common directory',
  );
  if (!samePath(reportedWorkTree, context.workTree)
      || !samePath(reportedGitDir, context.gitDir)
      || !samePath(reportedCommonDir, context.commonDir)) {
    throw new Error('Resolved Git paths do not match the approved release repository');
  }
  const indexPath = path.resolve(run([
    'rev-parse', '--path-format=absolute', '--git-path', 'index',
  ]));
  const expectedIndexPath = path.resolve(context.gitDir, 'index');
  if (!samePath(indexPath, expectedIndexPath)) {
    throw new Error(`Git index path override rejected: ${indexPath}`);
  }
  if (context.fsImpl.existsSync(indexPath)) {
    const entry = context.fsImpl.lstatSync(indexPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Git index must be a regular file inside the resolved Git directory');
    }
  }
}

function assertNoObjectSubstitution(context, options = {}) {
  const forbidden = [
    ['Git alternates', path.join(context.commonDir, 'objects', 'info', 'alternates')],
    ['Git HTTP alternates', path.join(context.commonDir, 'objects', 'info', 'http-alternates')],
    ['Git grafts', path.join(context.commonDir, 'info', 'grafts')],
    ['shallow repository marker', path.join(context.commonDir, 'shallow')],
  ];
  if (!samePath(context.gitDir, context.commonDir)) {
    forbidden.push(
      ['worktree Git grafts', path.join(context.gitDir, 'info', 'grafts')],
      ['worktree shallow marker', path.join(context.gitDir, 'shallow')],
    );
  }
  for (const [label, metadataPath] of forbidden) {
    if (context.fsImpl.existsSync(metadataPath)) {
      throw new Error(`${label} is not allowed for release provenance: ${metadataPath}`);
    }
  }
  const packDirectory = path.join(context.commonDir, 'objects', 'pack');
  if (context.fsImpl.existsSync(packDirectory)
      && context.fsImpl.readdirSync(packDirectory).some((entry) => entry.endsWith('.promisor'))) {
    throw new Error('Partial-clone promisor object packs are not allowed for release provenance');
  }
  if (context.fsImpl.existsSync(path.join(context.commonDir, 'config.worktree'))
      || context.fsImpl.existsSync(path.join(context.gitDir, 'config.worktree'))) {
    throw new Error('Per-worktree Git configuration is not allowed for release provenance');
  }
  const replaceRefs = String(runGitInContext(
    context,
    ['for-each-ref', '--format=%(refname)', 'refs/replace/'],
    options,
  )).trim();
  if (replaceRefs) {
    throw new Error(`Git replace refs are not allowed for release provenance: ${replaceRefs}`);
  }
}

function assertSafeLocalConfig(context, options = {}) {
  const names = parseNullSeparated(runGitInContext(
    context,
    ['config', '--local', '--no-includes', '--null', '--name-only', '--list'],
    options,
  ));
  const unsafe = names.filter((name) => UNSAFE_LOCAL_CONFIG.some((pattern) => pattern.test(name)));
  if (unsafe.length > 0) {
    throw new Error(`Unsafe local Git configuration is not allowed: ${unsafe.join(', ')}`);
  }
}

function assertHardenedRepository(repoRoot, options = {}) {
  const context = createGitContext(repoRoot, options.fsImpl || fs);
  assertResolvedRepository(context, options);
  assertNoObjectSubstitution(context, options);
  assertSafeLocalConfig(context, options);
  return context;
}

function runHardenedGit(repoRoot, args, options = {}) {
  const context = assertHardenedRepository(repoRoot, options);
  return runGitInContext(context, args, options);
}

function spawnHardenedGit(repoRoot, args, options = {}) {
  const context = assertHardenedRepository(repoRoot, options);
  return spawnGitInContext(context, args, options);
}

module.exports = {
  UNSAFE_LOCAL_CONFIG,
  assertHardenedRepository,
  createGitContext,
  createGitEnvironment,
  hardenedGitArgs,
  runGitInContext,
  runHardenedGit,
  samePath,
  spawnGitInContext,
  spawnHardenedGit,
};
