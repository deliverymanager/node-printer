'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  createReleaseChildEnvironment,
  readRegularNonLinkFile,
  REQUIRED_NPM_VERSION,
  validateReleaseNodeExecutable,
} = require('../release-build-policy');

const RELEASE_COMMANDS = Object.freeze({
  build: Object.freeze({
    lifecycleEvent: 'release:build',
    lifecycleScript: 'node scripts/release-launcher.js build',
    target: 'scripts/build-release.js',
  }),
  setup: Object.freeze({
    lifecycleEvent: 'release:setup',
    lifecycleScript: 'node scripts/release-launcher.js setup',
    target: 'scripts/setup-release-dependencies.js',
  }),
  verify: Object.freeze({
    lifecycleEvent: 'release:verify',
    lifecycleScript: 'node scripts/release-launcher.js verify',
    target: 'scripts/verify-presign-release.js',
  }),
});

function normalizedPath(value, platform = process.platform) {
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const resolved = pathImpl.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right, platform = process.platform) {
  return normalizedPath(left, platform) === normalizedPath(right, platform);
}

function readJson(filePath, label) {
  const inspected = readRegularNonLinkFile(filePath);
  try {
    return JSON.parse(inspected.contents.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${filePath}`, { cause: error });
  }
}

function adjacentNpmPaths(execPath) {
  const npmRoot = path.join(path.dirname(execPath), 'node_modules', 'npm');
  return {
    cli: path.join(npmRoot, 'bin', 'npm-cli.js'),
    packageJson: path.join(npmRoot, 'package.json'),
  };
}

function assertCanonicalNpmInvocation(command, options = {}) {
  const definition = RELEASE_COMMANDS[command];
  if (!definition) throw new Error(`Unknown canonical release command: ${command}`);
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const environment = options.environment || process.env;
  const execPath = path.resolve(options.execPath || process.execPath);
  const cwd = path.resolve(options.cwd || process.cwd());
  const execArgv = options.execArgv === undefined ? process.execArgv : options.execArgv;
  if (!Array.isArray(execArgv) || execArgv.length !== 0) {
    throw new Error('Canonical npm release launcher forbids Node CLI injection arguments');
  }
  if (!samePath(cwd, repoRoot)
      || !environment.INIT_CWD || !samePath(environment.INIT_CWD, repoRoot)
      || !environment.npm_package_json
      || !samePath(environment.npm_package_json, path.join(repoRoot, 'package.json'))
      || environment.npm_lifecycle_event !== definition.lifecycleEvent
      || environment.npm_lifecycle_script !== definition.lifecycleScript) {
    throw new Error('Canonical npm release lifecycle identity does not match the tracked command');
  }
  if (!environment.npm_node_execpath
      || !samePath(environment.npm_node_execpath, execPath)
      || !environment.NODE || !samePath(environment.NODE, execPath)) {
    throw new Error('Canonical npm release launcher Node path does not match process.execPath');
  }

  const packageJsonPath = path.join(repoRoot, 'package.json');
  const pkg = readJson(packageJsonPath, 'release package.json');
  if (!pkg.scripts || pkg.scripts[definition.lifecycleEvent] !== definition.lifecycleScript) {
    throw new Error('Tracked package.json does not expose the exact canonical release script');
  }
  const npmPaths = adjacentNpmPaths(execPath);
  readRegularNonLinkFile(npmPaths.cli);
  const npmPackage = readJson(npmPaths.packageJson, 'adjacent npm package.json');
  if (npmPackage.name !== 'npm' || npmPackage.version !== REQUIRED_NPM_VERSION
      || !environment.npm_execpath || !samePath(environment.npm_execpath, npmPaths.cli)) {
    throw new Error(`Canonical release launcher requires adjacent npm ${REQUIRED_NPM_VERSION}`);
  }
  return { definition, execPath, repoRoot };
}

function cleanNpmInjectedPath(pathValue, execPath, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const nodeDirectory = pathImpl.dirname(execPath);
  const retained = [];
  const seen = new Set();
  for (const entry of String(pathValue || '').split(delimiter)) {
    if (!entry) continue;
    if (!pathImpl.isAbsolute(entry)) {
      throw new Error(`Canonical release PATH contains a relative entry: ${entry}`);
    }
    const normalized = normalizedPath(entry, platform);
    const slashed = normalized.replace(/\\/g, '/');
    if (/\/node_modules\/\.bin\/?$/i.test(slashed)
        || /\/@npmcli\/run-script\/lib\/node-gyp-bin\/?$/i.test(slashed)) {
      continue;
    }
    if (!seen.has(normalized)) {
      retained.push(entry);
      seen.add(normalized);
    }
  }
  const normalizedNodeDirectory = normalizedPath(nodeDirectory, platform);
  const withoutNodeDirectory = retained.filter(
    (entry) => normalizedPath(entry, platform) !== normalizedNodeDirectory,
  );
  return [nodeDirectory, ...withoutNodeDirectory].join(delimiter);
}

function createNpmReleaseChildEnvironment(environment, execPath, platform = process.platform) {
  const withoutNpm = {};
  let sourcePath = '';
  for (const [name, value] of Object.entries(environment)) {
    if (/^path$/i.test(name)) {
      sourcePath = value;
    } else if (!/^npm_/i.test(name) && !['INIT_CWD', 'NODE'].includes(name)) {
      withoutNpm[name] = value;
    }
  }
  const childEnvironment = createReleaseChildEnvironment(withoutNpm);
  for (const name of Object.keys(childEnvironment)) {
    if (/^path$/i.test(name)) delete childEnvironment[name];
  }
  childEnvironment[platform === 'win32' ? 'Path' : 'PATH'] = cleanNpmInjectedPath(
    sourcePath,
    execPath,
    platform,
  );
  return childEnvironment;
}

function main(command = process.argv[2]) {
  if (process.argv.length !== 3) {
    throw new Error('Canonical release launcher accepts exactly one command');
  }
  const invocation = assertCanonicalNpmInvocation(command);
  validateReleaseNodeExecutable({ environment: {}, execArgv: [] });
  const targetPath = path.join(
    invocation.repoRoot,
    ...invocation.definition.target.split('/'),
  );
  readRegularNonLinkFile(targetPath);
  const result = spawnSync(invocation.execPath, [targetPath], {
    cwd: invocation.repoRoot,
    env: createNpmReleaseChildEnvironment(process.env, invocation.execPath),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${invocation.definition.lifecycleEvent} exited with status ${result.status}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Canonical npm release launch failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertCanonicalNpmInvocation,
  cleanNpmInjectedPath,
  createNpmReleaseChildEnvironment,
  main,
  RELEASE_COMMANDS,
};
