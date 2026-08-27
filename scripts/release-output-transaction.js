'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readRegularNonLinkFile,
  REQUIRED_NODE_HEADERS_INPUT,
  REQUIRED_NODE_IMPORT_LIBRARY_INPUT,
} = require('../release-build-policy');
const {
  RELEASE_ARTIFACT_PATH,
  RELEASE_HEADER_PATH,
  RELEASE_IDENTITY_PATH,
  RELEASE_MANIFEST_PATH,
} = require('../release-provenance');
const {
  assertHardenedRepository,
  runGitInContext,
} = require('./hardened-git');

const BUILD_ROOT = 'build';
const EXPORTED_BUILD_FILES = Object.freeze([
  RELEASE_IDENTITY_PATH,
  RELEASE_HEADER_PATH,
  REQUIRED_NODE_HEADERS_INPUT,
  REQUIRED_NODE_IMPORT_LIBRARY_INPUT,
]);
const EXPORTED_LIB_FILES = Object.freeze([
  RELEASE_ARTIFACT_PATH,
  RELEASE_MANIFEST_PATH,
]);
const EXPORTED_RELEASE_FILES = Object.freeze([
  ...EXPORTED_BUILD_FILES,
  ...EXPORTED_LIB_FILES,
]);

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalized(filePath, platform = process.platform) {
  let resolved = path.resolve(filePath);
  if (platform === 'win32' && resolved.startsWith('\\\\?\\UNC\\')) {
    resolved = `\\\\${resolved.slice(8)}`;
  } else if (platform === 'win32' && resolved.startsWith('\\\\?\\')) {
    resolved = resolved.slice(4);
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameCanonicalPath(left, right) {
  return normalized(left) === normalized(right);
}

function assertInside(root, candidate, label) {
  const resolvedRoot = normalized(root);
  const resolvedCandidate = normalized(candidate);
  if (resolvedCandidate === resolvedRoot
      || !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its approved root: ${candidate}`);
  }
  return path.resolve(candidate);
}

function assertCanonicalDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const entry = fs.lstatSync(resolved);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  const real = fs.realpathSync.native(resolved);
  if (!sameCanonicalPath(real, resolved)) {
    throw new Error(`${label} must be canonical and non-reparse: ${resolved} -> ${real}`);
  }
  return real;
}

function sameEntryIdentity(left, right) {
  if (!left || !right || left.isDirectory() !== right.isDirectory()
      || left.isFile() !== right.isFile() || left.isSymbolicLink() !== right.isSymbolicLink()) {
    return false;
  }
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  if (left.isFile() && (left.size !== right.size || left.nlink !== right.nlink)) return false;
  return true;
}

function inspectOwnedOutputEntry(root, entryPath, entries) {
  const absolute = assertInside(root, entryPath, 'Release output entry');
  const entry = fs.lstatSync(absolute);
  if (entry.isSymbolicLink()) {
    throw new Error(`Release output tree contains a link or junction: ${absolute}`);
  }
  const real = fs.realpathSync.native(absolute);
  if (!sameCanonicalPath(real, absolute)) {
    throw new Error(`Release output tree contains a non-canonical reparse path: ${absolute}`);
  }
  if (entry.isFile()) {
    if (entry.nlink !== 1) {
      throw new Error(`Release output tree contains a hardlink alias: ${absolute}`);
    }
    entries.set(absolute, entry);
    return;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Release output tree contains an unsupported filesystem entry: ${absolute}`);
  }
  entries.set(absolute, entry);
  for (const name of fs.readdirSync(absolute).sort()) {
    if (!name || name === '.' || name === '..' || name.includes(path.sep)) {
      throw new Error(`Release output tree contains a non-canonical entry name: ${name}`);
    }
    inspectOwnedOutputEntry(root, path.join(absolute, name), entries);
  }
}

function inspectOwnedOutputPath(repoRoot, outputPath) {
  const repository = assertCanonicalDirectory(repoRoot, 'Release repository');
  const absolute = assertInside(repository, outputPath, 'Release output');
  if (!lstatOrNull(absolute)) return new Map();
  const entries = new Map();
  inspectOwnedOutputEntry(repository, absolute, entries);
  return entries;
}

function removeInspectedEntry(root, entryPath, inspected, options) {
  const absolute = assertInside(root, entryPath, 'Release output removal');
  const approved = inspected.get(absolute);
  if (!approved) throw new Error(`Release output was not approved for removal: ${absolute}`);
  if (options.onBeforeEntryRemoval) options.onBeforeEntryRemoval(absolute, approved);
  const current = fs.lstatSync(absolute);
  if (!sameEntryIdentity(approved, current) || current.isSymbolicLink()) {
    throw new Error(`Release output changed before removal: ${absolute}`);
  }
  const real = fs.realpathSync.native(absolute);
  if (!sameCanonicalPath(real, absolute)) {
    throw new Error(`Release output became non-canonical before removal: ${absolute}`);
  }
  if (current.isFile()) {
    if (current.nlink !== 1) {
      throw new Error(`Release output acquired a hardlink alias before removal: ${absolute}`);
    }
    fs.unlinkSync(absolute);
    return;
  }
  const currentNames = fs.readdirSync(absolute).sort();
  const approvedNames = [...inspected.keys()]
    .filter((candidate) => path.dirname(candidate) === absolute)
    .map((candidate) => path.basename(candidate))
    .sort();
  if (currentNames.join('\0') !== approvedNames.join('\0')) {
    throw new Error(`Release output directory changed before removal: ${absolute}`);
  }
  for (const name of currentNames) {
    removeInspectedEntry(root, path.join(absolute, name), inspected, options);
  }
  const closing = fs.lstatSync(absolute);
  if (!closing.isDirectory() || closing.isSymbolicLink()
      || (approved.dev && closing.dev && approved.dev !== closing.dev)
      || (approved.ino && closing.ino && approved.ino !== closing.ino)) {
    throw new Error(`Release output directory changed during removal: ${absolute}`);
  }
  fs.rmdirSync(absolute);
}

function removeOwnedOutputPath(repoRoot, outputPath, options = {}) {
  const repository = assertCanonicalDirectory(repoRoot, 'Release repository');
  const absolute = assertInside(repository, outputPath, 'Release output');
  if (!lstatOrNull(absolute)) return false;
  const inspected = inspectOwnedOutputPath(repository, absolute);
  removeInspectedEntry(repository, absolute, inspected, options);
  if (lstatOrNull(absolute)) {
    throw new Error(`Release output still exists after removal: ${absolute}`);
  }
  return true;
}

function assertCanonicalOutputsUntracked(repoRoot) {
  const context = assertHardenedRepository(repoRoot);
  const tracked = runGitInContext(context, [
    'ls-files', '-z', '--', BUILD_ROOT, ...EXPORTED_LIB_FILES,
  ], { encoding: null });
  if (tracked.length !== 0) {
    throw new Error('Canonical release output paths unexpectedly contain tracked files');
  }
  return context;
}

function resetCanonicalReleaseOutputs(repoRoot, options = {}) {
  const context = assertCanonicalOutputsUntracked(repoRoot);
  const repository = context.workTree;
  const targets = [
    path.join(repository, BUILD_ROOT),
    ...EXPORTED_LIB_FILES.map((relative) => path.join(repository, ...relative.split('/'))),
  ];
  for (const target of targets) {
    removeOwnedOutputPath(repository, target, options);
  }
  assertCanonicalDirectory(path.join(repository, 'lib'), 'Tracked lib directory');
  return repository;
}

function createDetachedReleaseWorktree(repoRoot, commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ''))) {
    throw new Error('Detached release worktree requires an exact SHA-1 commit');
  }
  const context = assertHardenedRepository(repoRoot);
  const temporaryParent = fs.realpathSync.native(fs.mkdtempSync(path.join(
    os.tmpdir(),
    'dmkiosk-node-printer-release-',
  )));
  assertCanonicalDirectory(temporaryParent, 'Release transaction directory');
  fs.chmodSync(temporaryParent, 0o700);
  const hooksDirectory = path.join(temporaryParent, 'disabled-hooks');
  fs.mkdirSync(hooksDirectory, { mode: 0o700 });
  assertCanonicalDirectory(hooksDirectory, 'Disabled Git hooks directory');
  const workTree = path.join(temporaryParent, 'repository');
  try {
    runGitInContext(context, [
      '-c', `core.hooksPath=${hooksDirectory}`,
      'worktree', 'add', '--detach', workTree, commit,
    ]);
    const transaction = assertHardenedRepository(workTree);
    if (!sameCanonicalPath(transaction.commonDir, context.commonDir)) {
      throw new Error('Detached release worktree does not share the approved Git object store');
    }
    const transactionCommit = String(runGitInContext(
      transaction,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    )).trim();
    if (transactionCommit !== commit) {
      throw new Error('Detached release worktree checked out a different commit');
    }
    return { context, hooksDirectory, temporaryParent, workTree };
  } catch (error) {
    if (lstatOrNull(workTree)) {
      try {
        runGitInContext(context, [
          '-c', `core.hooksPath=${hooksDirectory}`,
          'worktree', 'remove', '--force', workTree,
        ]);
      } catch (_) {
        // Keep the exact transaction path for forensic cleanup if Git cannot remove it safely.
      }
    }
    try {
      if (lstatOrNull(hooksDirectory)) fs.rmdirSync(hooksDirectory);
      if (lstatOrNull(temporaryParent)) fs.rmdirSync(temporaryParent);
    } catch (_) {
      // The primary failure remains the useful fail-closed result.
    }
    throw error;
  }
}

function cleanupDetachedReleaseWorktree(transaction) {
  if (!transaction || !transaction.context || !transaction.workTree
      || !transaction.temporaryParent || !transaction.hooksDirectory) {
    throw new Error('Detached release worktree cleanup requires its exact transaction record');
  }
  const parent = assertCanonicalDirectory(
    transaction.temporaryParent,
    'Release transaction directory',
  );
  assertInside(parent, transaction.workTree, 'Detached release worktree');
  assertInside(parent, transaction.hooksDirectory, 'Disabled Git hooks directory');
  runGitInContext(transaction.context, [
    '-c', `core.hooksPath=${transaction.hooksDirectory}`,
    'worktree', 'remove', '--force', transaction.workTree,
  ]);
  if (lstatOrNull(transaction.workTree)) {
    throw new Error('Git left the detached release worktree on disk after cleanup');
  }
  fs.rmdirSync(transaction.hooksDirectory);
  fs.rmdirSync(parent);
}

function createDirectoryPath(root, relativeDirectory) {
  let current = assertCanonicalDirectory(root, 'Release staging root');
  for (const component of relativeDirectory.split('/').filter(Boolean)) {
    if (!component || component === '.' || component === '..') {
      throw new Error(`Release staging directory is not canonical: ${relativeDirectory}`);
    }
    current = assertInside(root, path.join(current, component), 'Release staging directory');
    if (!lstatOrNull(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertCanonicalDirectory(current, 'Release staging directory');
  }
  return current;
}

function writeExclusiveFile(root, relativePath, contents) {
  const components = relativePath.split('/');
  const fileName = components.pop();
  const directory = createDirectoryPath(root, components.join('/'));
  const destination = assertInside(root, path.join(directory, fileName), 'Release staging file');
  fs.writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 });
  const inspected = readRegularNonLinkFile(destination);
  if (!inspected.contents.equals(contents)) {
    throw new Error(`Release staging bytes changed after write: ${destination}`);
  }
  return destination;
}

function snapshotReleaseExports(sourceRoot) {
  const source = assertCanonicalDirectory(sourceRoot, 'Release transaction worktree');
  const snapshots = new Map();
  for (const relative of EXPORTED_RELEASE_FILES) {
    const absolute = assertInside(
      source,
      path.join(source, ...relative.split('/')),
      'Release transaction export',
    );
    snapshots.set(relative, readRegularNonLinkFile(absolute).contents);
  }
  return snapshots;
}

function publishFreshReleaseOutputs(sourceRoot, destinationRoot) {
  const snapshots = snapshotReleaseExports(sourceRoot);
  const destination = resetCanonicalReleaseOutputs(destinationRoot);
  const nonce = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const stagedBuild = path.join(destination, `.node-printer-release-build-${nonce}`);
  const stagedArtifact = path.join(destination, 'lib', `.node_printer.node-${nonce}.tmp`);
  const stagedManifest = path.join(
    destination,
    'lib',
    `.node_printer.release.json-${nonce}.tmp`,
  );
  try {
    fs.mkdirSync(stagedBuild, { mode: 0o700 });
    assertCanonicalDirectory(stagedBuild, 'Release build staging directory');
    for (const relative of EXPORTED_BUILD_FILES) {
      const buildRelative = relative.split('/').slice(1).join('/');
      writeExclusiveFile(stagedBuild, buildRelative, snapshots.get(relative));
    }
    fs.writeFileSync(stagedArtifact, snapshots.get(RELEASE_ARTIFACT_PATH), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync(stagedManifest, snapshots.get(RELEASE_MANIFEST_PATH), {
      flag: 'wx',
      mode: 0o600,
    });
    readRegularNonLinkFile(stagedArtifact);
    readRegularNonLinkFile(stagedManifest);

    const canonicalBuild = path.join(destination, BUILD_ROOT);
    if (lstatOrNull(canonicalBuild)
        || lstatOrNull(path.join(destination, ...RELEASE_ARTIFACT_PATH.split('/')))
        || lstatOrNull(path.join(destination, ...RELEASE_MANIFEST_PATH.split('/')))) {
      throw new Error('Canonical release output appeared during atomic staging');
    }
    fs.renameSync(stagedBuild, canonicalBuild);
    fs.renameSync(stagedArtifact, path.join(
      destination,
      ...RELEASE_ARTIFACT_PATH.split('/'),
    ));
    fs.renameSync(stagedManifest, path.join(
      destination,
      ...RELEASE_MANIFEST_PATH.split('/'),
    ));
    inspectOwnedOutputPath(destination, canonicalBuild);
    readRegularNonLinkFile(path.join(destination, ...RELEASE_ARTIFACT_PATH.split('/')));
    readRegularNonLinkFile(path.join(destination, ...RELEASE_MANIFEST_PATH.split('/')));
    return true;
  } catch (error) {
    try {
      if (lstatOrNull(stagedBuild)) removeOwnedOutputPath(destination, stagedBuild);
      if (lstatOrNull(stagedArtifact)) removeOwnedOutputPath(destination, stagedArtifact);
      if (lstatOrNull(stagedManifest)) removeOwnedOutputPath(destination, stagedManifest);
      resetCanonicalReleaseOutputs(destination);
    } catch (cleanupError) {
      error.message += `; output cleanup also failed: ${cleanupError.message}`;
    }
    throw error;
  }
}

module.exports = {
  cleanupDetachedReleaseWorktree,
  createDetachedReleaseWorktree,
  EXPORTED_RELEASE_FILES,
  inspectOwnedOutputPath,
  publishFreshReleaseOutputs,
  removeOwnedOutputPath,
  resetCanonicalReleaseOutputs,
  snapshotReleaseExports,
};
