'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  createReleaseChildEnvironment,
  readRegularNonLinkFile,
  validateReleaseNodeExecutable,
} = require('../release-build-policy');
const {
  captureReleaseSource,
  validatePreSignRelease,
} = require('../release-provenance');
const {
  cleanupDetachedReleaseWorktree,
  createDetachedReleaseWorktree,
  publishFreshReleaseOutputs,
  resetCanonicalReleaseOutputs,
} = require('./release-output-transaction');

function sameSource(left, right) {
  return left && right && left.commit === right.commit
    && left.trackedTreeSha256 === right.trackedTreeSha256;
}

function runTransactionBuild(transactionRoot) {
  const transactionScript = path.join(
    transactionRoot,
    'scripts',
    'build-release-worktree.js',
  );
  readRegularNonLinkFile(transactionScript);
  const result = spawnSync(process.execPath, [transactionScript], {
    cwd: transactionRoot,
    env: createReleaseChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Detached release transaction exited with status ${result.status}`);
  }
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  validateReleaseNodeExecutable();
  resetCanonicalReleaseOutputs(repoRoot);
  const source = captureReleaseSource(repoRoot, { phase: 'prepare' });
  const transaction = createDetachedReleaseWorktree(repoRoot, source.commit);
  let completed = false;
  let failure;
  try {
    const transactionSource = captureReleaseSource(transaction.workTree, { phase: 'prepare' });
    if (!sameSource(transactionSource, source)) {
      throw new Error('Detached release transaction does not match the approved source snapshot');
    }
    runTransactionBuild(transaction.workTree);
    const transactionManifest = validatePreSignRelease({ repoRoot: transaction.workTree });
    if (!sameSource(transactionManifest.source, source)) {
      throw new Error('Detached release output does not bind the approved source snapshot');
    }
    const closingSource = captureReleaseSource(repoRoot, { phase: 'prepare' });
    if (!sameSource(closingSource, source)) {
      throw new Error('Canonical source checkout changed while the detached build was running');
    }
    publishFreshReleaseOutputs(transaction.workTree, repoRoot);
    const manifest = validatePreSignRelease({ repoRoot });
    if (!sameSource(manifest.source, source)
        || manifest.buildId !== transactionManifest.buildId) {
      throw new Error('Published canonical outputs differ from the detached release transaction');
    }
    completed = true;
    process.stdout.write(
      `Built and verified unsigned node_printer.node release ${manifest.buildId}.\n`,
    );
  } catch (error) {
    failure = error;
  }
  try {
    cleanupDetachedReleaseWorktree(transaction);
  } catch (cleanupError) {
    if (failure) failure.message += `; transaction cleanup also failed: ${cleanupError.message}`;
    else failure = cleanupError;
  }
  if (!completed || failure) {
    try {
      resetCanonicalReleaseOutputs(repoRoot);
    } catch (cleanupError) {
      if (failure) failure.message += `; canonical output cleanup also failed: ${cleanupError.message}`;
      else failure = cleanupError;
    }
    throw failure || new Error('Detached release transaction did not complete');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, runTransactionBuild, sameSource };
