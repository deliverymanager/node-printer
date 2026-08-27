'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  assertInstalledReleaseDependencies,
  createReleaseChildEnvironment,
  readRegularNonLinkFile,
  validateReleaseNodeExecutable,
} = require('../release-build-policy');
const {
  captureReleaseSource,
  prepareReleaseBuild,
  writeReleaseManifest,
} = require('../release-provenance');
const {
  inspectOwnedOutputPath,
} = require('./release-output-transaction');
const { setupReleaseDependencies } = require('./setup-release-dependencies');
const {
  materializePinnedNodeSdk,
  verifyMaterializedNodeSdk,
} = require('./materialize-node-sdk');

function sameSource(left, right) {
  return left && right && left.commit === right.commit
    && left.trackedTreeSha256 === right.trackedTreeSha256;
}

function recheckReleaseInputs(repoRoot, expectedSource, sdk) {
  const source = captureReleaseSource(repoRoot, { phase: 'postbuild' });
  if (!sameSource(source, expectedSource)) {
    throw new Error('Release source changed across the native build transaction');
  }
  inspectOwnedOutputPath(repoRoot, path.join(repoRoot, 'build'));
  verifyMaterializedNodeSdk(sdk.sdkRoot, sdk.treeSha256);
  return true;
}

function runNodeGyp(repoRoot, nodeGypCli, args) {
  const result = spawnSync(process.execPath, [nodeGypCli, ...args], {
    cwd: repoRoot,
    env: createReleaseChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`node-gyp ${args[0]} exited with status ${result.status}`);
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const nodeValidation = validateReleaseNodeExecutable();
  setupReleaseDependencies();
  assertInstalledReleaseDependencies(repoRoot);
  const prepared = prepareReleaseBuild({ repoRoot, nodeValidation });
  const sdk = await materializePinnedNodeSdk(repoRoot);
  const nodeGypCli = path.join(repoRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  readRegularNonLinkFile(nodeGypCli);

  recheckReleaseInputs(repoRoot, prepared.identity.source, sdk);
  runNodeGyp(repoRoot, nodeGypCli, [
    'configure',
    `--target=${nodeValidation.version}`,
    '--arch=x64',
    `--nodedir=${sdk.sdkRoot}`,
    '--',
    '-Ddmkiosk_release_build=1',
  ]);
  recheckReleaseInputs(repoRoot, prepared.identity.source, sdk);
  runNodeGyp(repoRoot, nodeGypCli, ['build', '--release']);
  recheckReleaseInputs(repoRoot, prepared.identity.source, sdk);

  const manifest = writeReleaseManifest({ repoRoot });
  inspectOwnedOutputPath(repoRoot, path.join(repoRoot, 'build'));
  if (manifest.buildId !== prepared.identity.buildId) {
    throw new Error('Verified receipt buildId changed during the release build');
  }
  process.stdout.write(
    `Built and verified unsigned node_printer.node transaction ${manifest.buildId}.\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Release transaction build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, recheckReleaseInputs, runNodeGyp };
