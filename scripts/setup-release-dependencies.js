'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  assertInstalledReleaseDependencies,
  assertReleaseDependencyContract,
  createReleaseChildEnvironment,
  REQUIRED_NPM_VERSION,
  readRegularNonLinkFile,
  validateReleaseNodeExecutable,
} = require('../release-build-policy');
const { captureReleaseSource } = require('../release-provenance');

function setupReleaseDependencies() {
  const repoRoot = path.resolve(__dirname, '..');
  validateReleaseNodeExecutable();
  captureReleaseSource(repoRoot, { phase: 'prepare' });
  const lockHash = assertReleaseDependencyContract(repoRoot);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  readRegularNonLinkFile(npmCli);
  const npmPackage = JSON.parse(readRegularNonLinkFile(
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'package.json'),
  ).contents.toString('utf8'));
  if (npmPackage.name !== 'npm' || npmPackage.version !== REQUIRED_NPM_VERSION) {
    throw new Error(`Pinned Node distribution must provide npm ${REQUIRED_NPM_VERSION}`);
  }
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = spawnSync(process.execPath, [
    npmCli,
    'ci',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
    `--userconfig=${nullConfig}`,
    `--globalconfig=${nullConfig}`,
    '--registry=https://registry.npmjs.org/',
    '--strict-ssl=true',
  ], {
    cwd: repoRoot,
    env: createReleaseChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with status ${result.status}`);
  if (assertReleaseDependencyContract(repoRoot) !== lockHash) {
    throw new Error('npm ci changed the canonical package lock');
  }
  assertInstalledReleaseDependencies(repoRoot);
  captureReleaseSource(repoRoot, { phase: 'prepare' });
  return true;
}

function main() {
  setupReleaseDependencies();
  process.stdout.write('Installed exact release dependencies without lifecycle scripts.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release dependency setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, setupReleaseDependencies };
