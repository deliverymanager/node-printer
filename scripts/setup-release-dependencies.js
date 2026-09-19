'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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
  // npm rejects loading the same path for both config layers, including NUL.
  // Use distinct empty files so neither layer can inherit machine credentials
  // or toolchain overrides. Remove only these exact files after npm exits.
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-printer-npm-config-'));
  const userConfig = path.join(configRoot, 'user.npmrc');
  const globalConfig = path.join(configRoot, 'global.npmrc');
  let result;
  try {
    fs.writeFileSync(userConfig, '', { flag: 'wx' });
    fs.writeFileSync(globalConfig, '', { flag: 'wx' });
    result = spawnSync(process.execPath, [
    npmCli,
    'install',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
    `--userconfig=${userConfig}`,
    `--globalconfig=${globalConfig}`,
    '--registry=https://registry.npmjs.org/',
    '--strict-ssl=true',
  ], {
    cwd: repoRoot,
    env: createReleaseChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
    });
  } finally {
    for (const config of [userConfig, globalConfig]) {
      if (fs.existsSync(config)) fs.unlinkSync(config);
    }
    fs.rmdirSync(configRoot);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install exited with status ${result.status}`);
  if (assertReleaseDependencyContract(repoRoot) !== lockHash) {
    throw new Error('npm install changed the canonical package lock');
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
