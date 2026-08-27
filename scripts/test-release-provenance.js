'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertReleaseDependencyContract,
  assertVisibleReleaseLaunchState,
  createReleaseChildEnvironment,
  normalizeReleaseToolchain,
  readPeHeader,
  readRegularNonLinkFile,
  REQUIRED_DEPENDENCIES,
  REQUIRED_MSVC_PLATFORM_TOOLSET,
  REQUIRED_NPM_VERSION,
  REQUIRED_NODE_ARCH,
  REQUIRED_NODE_HEADERS_INPUT,
  REQUIRED_NODE_HEADERS_SHA256,
  REQUIRED_NODE_HEADERS_URL,
  REQUIRED_NODE_IMPORT_LIBRARY_INPUT,
  REQUIRED_NODE_IMPORT_LIBRARY_SHA256,
  REQUIRED_NODE_IMPORT_LIBRARY_URL,
  REQUIRED_NODE_MODULES_ABI,
  REQUIRED_NODE_PLATFORM,
  REQUIRED_NODE_SHA256,
  REQUIRED_NODE_VERSION,
  RELEASE_BUILD_POLICY_VERSION,
  sha256,
  validateReleaseNodeExecutable,
  validateReleaseSdkInputs,
} = require('../release-build-policy');
const {
  buildReleaseMarker,
  canonicalJson,
  captureReleaseSource,
  createReleaseIdentity,
  createReleaseManifest,
  normalizeManifest,
  RELEASE_ARTIFACT_PATH,
  RELEASE_MARKER_PREFIX,
  RELEASE_ORIGIN_URL,
  validateEmbeddedMarker,
  validateReleaseProvenance,
} = require('../release-provenance');
const { createGitEnvironment } = require('./hardened-git');
const {
  canonicalArchiveEntryPath,
  downloadPinnedFile,
  validateArchiveEntry,
  validateDownloadedBytes,
  validateDownloadResponse,
} = require('./materialize-node-sdk');
const {
  cleanNpmInjectedPath,
  createNpmReleaseChildEnvironment,
  RELEASE_COMMANDS,
} = require('./release-launcher');
const {
  cleanupDetachedReleaseWorktree,
  createDetachedReleaseWorktree,
  EXPORTED_RELEASE_FILES,
  publishFreshReleaseOutputs,
  removeOwnedOutputPath,
  resetCanonicalReleaseOutputs,
} = require('./release-output-transaction');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;

function test(name, action) {
  try {
    action();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function expectFailure(action, pattern) {
  assert.throws(action, pattern);
}

function temporaryDirectory(label) {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `node-printer-${label}-`)),
  );
}

function canonicalGitEnvironment(extra = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(name)) environment[name] = value;
  }
  return { ...environment, ...extra };
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: canonicalGitEnvironment(),
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function createRepositoryFixture() {
  const root = temporaryDirectory('git');
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  git(repository, ['init', '-b', 'master']);
  git(repository, ['config', 'user.email', 'release-tests@example.invalid']);
  git(repository, ['config', 'user.name', 'Release Tests']);
  git(repository, ['remote', 'add', 'origin', RELEASE_ORIGIN_URL]);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'alpha\n');
  git(repository, ['add', 'tracked.txt']);
  git(repository, ['commit', '-m', 'fixture']);
  return { repository, root };
}

function withRepository(action) {
  const fixture = createRepositoryFixture();
  try {
    return action(fixture.repository, fixture.root);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
}

function addTrackedOutputFixture(repository) {
  fs.mkdirSync(path.join(repository, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'lib', 'printer.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), 'build/*\n*.node\nlib/node_printer.release.json\n');
  git(repository, ['add', '.gitignore', 'lib/printer.js']);
  git(repository, ['commit', '-m', 'output fixture']);
}

function withEnvironment(overrides, action) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name] : undefined);
    process.env[name] = value;
  }
  try {
    return action();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fixtureToolchain(overrides = {}) {
  return {
    policyVersion: RELEASE_BUILD_POLICY_VERSION,
    nodeVersion: REQUIRED_NODE_VERSION,
    nodeModulesAbi: REQUIRED_NODE_MODULES_ABI,
    nodePlatform: REQUIRED_NODE_PLATFORM,
    nodeArch: REQUIRED_NODE_ARCH,
    nodeSha256: REQUIRED_NODE_SHA256,
    npmVersion: REQUIRED_NPM_VERSION,
    nodeHeadersSha256: REQUIRED_NODE_HEADERS_SHA256,
    nodeHeadersUrl: REQUIRED_NODE_HEADERS_URL,
    nodeImportLibrarySha256: REQUIRED_NODE_IMPORT_LIBRARY_SHA256,
    nodeImportLibraryUrl: REQUIRED_NODE_IMPORT_LIBRARY_URL,
    packageLockSha256: 'a'.repeat(64),
    nodeGypVersion: REQUIRED_DEPENDENCIES['node-gyp'].version,
    nanVersion: REQUIRED_DEPENDENCIES.nan.version,
    nodePreGypVersion: REQUIRED_DEPENDENCIES['node-pre-gyp'].version,
    tarVersion: REQUIRED_DEPENDENCIES.tar.version,
    msvcPlatformToolset: REQUIRED_MSVC_PLATFORM_TOOLSET,
    ...overrides,
  };
}

function fixtureIdentity(overrides = {}) {
  return createReleaseIdentity({
    packageVersion: '0.4.1',
    buildId: 'b'.repeat(32),
    source: { commit: 'c'.repeat(40), trackedTreeSha256: 'd'.repeat(64) },
    toolchain: fixtureToolchain(),
    ...overrides,
  });
}

function createPe(marker, options = {}) {
  const sectionStart = 0x200;
  const sectionSize = 0x1000;
  const contents = Buffer.alloc(sectionStart + sectionSize, 0);
  contents.write('MZ', 0, 'ascii');
  contents.writeUInt32LE(0x80, 0x3c);
  contents.write('PE\0\0', 0x80, 'ascii');
  contents.writeUInt16LE(options.machine === undefined ? 0x8664 : options.machine, 0x84);
  contents.writeUInt16LE(1, 0x86);
  contents.writeUInt16LE(0xf0, 0x94);
  contents.writeUInt16LE(
    options.characteristics === undefined ? 0x2022 : options.characteristics,
    0x96,
  );
  const optional = 0x98;
  contents.writeUInt16LE(options.magic === undefined ? 0x20b : options.magic, optional);
  contents.writeUInt32LE(16, optional + 108);
  if (options.certificate) {
    contents.writeUInt32LE(contents.length - 8, optional + 112 + (4 * 8));
    contents.writeUInt32LE(8, optional + 112 + (4 * 8) + 4);
  }
  if (options.clr) {
    contents.writeUInt32LE(0x1000, optional + 112 + (14 * 8));
    contents.writeUInt32LE(0x48, optional + 112 + (14 * 8) + 4);
  }
  const section = optional + 0xf0;
  contents.write('.rdata\0\0', section, 'ascii');
  contents.writeUInt32LE(sectionSize, section + 8);
  contents.writeUInt32LE(0x1000, section + 12);
  contents.writeUInt32LE(sectionSize, section + 16);
  contents.writeUInt32LE(sectionStart, section + 20);
  contents.writeUInt32LE(0x40000040, section + 36);
  if (marker) contents.write(`${marker}\0`, options.markerOffset || 0x240, 'ascii');
  return contents;
}

function writeReceiptFixture(root, contents, identity = fixtureIdentity()) {
  const artifactPath = path.join(root, 'node_printer.node');
  const manifestPath = path.join(root, 'node_printer.release.json');
  fs.writeFileSync(artifactPath, contents);
  const manifest = createReleaseManifest(identity, {
    path: RELEASE_ARTIFACT_PATH,
    size: contents.length,
    sha256: sha256(contents),
  });
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
  return { artifactPath, manifest, manifestPath };
}

test('canonical toolchain accepts only its exact field set', () => {
  assert.deepEqual(normalizeReleaseToolchain(fixtureToolchain()), fixtureToolchain());
  expectFailure(
    () => normalizeReleaseToolchain({ ...fixtureToolchain(), extra: true }),
    /exact canonical set/,
  );
});

test('canonical release marker binds source, lock, ABI, version, and build id', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  assert.ok(marker.startsWith(RELEASE_MARKER_PREFIX));
  for (const fragment of [
    'packageVersion=0.4.1',
    `buildId=${'b'.repeat(32)}`,
    `commit=${'c'.repeat(40)}`,
    `trackedTreeSha256=${'d'.repeat(64)}`,
    `nodeVersion=${REQUIRED_NODE_VERSION}`,
    `nodeModulesAbi=${REQUIRED_NODE_MODULES_ABI}`,
    `npmVersion=${REQUIRED_NPM_VERSION}`,
    `nodeHeadersSha256=${REQUIRED_NODE_HEADERS_SHA256}`,
    `nodeHeadersUrl=${REQUIRED_NODE_HEADERS_URL}`,
    `nodeImportLibrarySha256=${REQUIRED_NODE_IMPORT_LIBRARY_SHA256}`,
    `nodeImportLibraryUrl=${REQUIRED_NODE_IMPORT_LIBRARY_URL}`,
    `packageLockSha256=${'a'.repeat(64)}`,
  ]) assert.ok(marker.includes(fragment));
});

test('valid AMD64 PE32+ unsigned native DLL marker is accepted', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  assert.equal(validateEmbeddedMarker(createPe(marker), marker).start, 0x240);
});

test('x86 PE is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { machine: 0x014c }), marker), /AMD64/);
});

test('PE32 native addon is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { magic: 0x10b }), marker), /PE32\+/);
});

test('non-executable PE is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { characteristics: 0x2020 }), marker), /not executable/);
});

test('non-DLL PE is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { characteristics: 0x0022 }), marker), /not a DLL/);
});

test('Authenticode certificate table is rejected by unsigned-node-addon policy', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { certificate: true }), marker), /remain unsigned/);
});

test('CLR data directory is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(marker, { clr: true }), marker), /native addon/);
});

test('missing embedded marker is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  expectFailure(() => validateEmbeddedMarker(createPe(), marker), /exactly one/);
});

test('duplicate embedded marker is rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  const contents = createPe(marker);
  contents.write(`${marker}\0`, 0x700, 'ascii');
  expectFailure(() => validateEmbeddedMarker(contents, marker), /exactly one/);
});

test('conflicting family marker is rejected', () => {
  const expected = buildReleaseMarker(fixtureIdentity());
  const conflicting = buildReleaseMarker(fixtureIdentity({ buildId: 'e'.repeat(32) }));
  expectFailure(() => validateEmbeddedMarker(createPe(conflicting), expected), /exactly one/);
});

test('overlay-only marker is rejected as outside Authenticode-hashed sections', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  const contents = Buffer.concat([createPe(), Buffer.from(`${marker}\0`, 'ascii')]);
  expectFailure(() => validateEmbeddedMarker(contents, marker), /outside Authenticode-hashed/);
});

test('receipt validates canonical bytes and artifact hash', () => {
  const root = temporaryDirectory('receipt');
  try {
    const marker = buildReleaseMarker(fixtureIdentity());
    const receipt = writeReceiptFixture(root, createPe(marker));
    assert.deepEqual(validateReleaseProvenance(receipt), receipt.manifest);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('receipt rejects non-canonical JSON bytes', () => {
  const root = temporaryDirectory('receipt-json');
  try {
    const identity = fixtureIdentity();
    const receipt = writeReceiptFixture(root, createPe(buildReleaseMarker(identity)), identity);
    fs.writeFileSync(receipt.manifestPath, JSON.stringify(receipt.manifest));
    expectFailure(() => validateReleaseProvenance(receipt), /canonical JSON/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('receipt rejects extra schema fields', () => {
  const identity = fixtureIdentity();
  const contents = createPe(buildReleaseMarker(identity));
  const manifest = createReleaseManifest(identity, {
    path: RELEASE_ARTIFACT_PATH,
    size: contents.length,
    sha256: sha256(contents),
  });
  expectFailure(() => normalizeManifest({ ...manifest, publishedAt: 'never' }), /exact canonical set/);
});

test('receipt rejects altered fixed role', () => {
  const identity = fixtureIdentity();
  const contents = createPe(buildReleaseMarker(identity));
  const manifest = createReleaseManifest(identity, {
    path: RELEASE_ARTIFACT_PATH,
    size: contents.length,
    sha256: sha256(contents),
  });
  expectFailure(() => normalizeManifest({ ...manifest, role: 'generic-addon' }), /fixed fields/);
});

test('receipt rejects any signed policy alias or truthy value', () => {
  const identity = fixtureIdentity();
  const contents = createPe(buildReleaseMarker(identity));
  const manifest = createReleaseManifest(identity, {
    path: RELEASE_ARTIFACT_PATH,
    size: contents.length,
    sha256: sha256(contents),
  });
  expectFailure(
    () => normalizeManifest({
      ...manifest,
      signaturePolicy: { ...manifest.signaturePolicy, timestamped: 'false' },
    }),
    /timestamped/,
  );
});

test('pinned Node validation rejects a nearby Node version before reading an executable', () => {
  expectFailure(() => validateReleaseNodeExecutable({
    version: '24.19.1',
    modulesAbi: REQUIRED_NODE_MODULES_ABI,
    platform: REQUIRED_NODE_PLATFORM,
    arch: REQUIRED_NODE_ARCH,
    execPath: '/does/not/matter',
    environment: {},
    execArgv: [],
  }), /requires Node/);
});

test('ambient compiler, header, Python, GYP, and target overrides fail closed', () => {
  for (const name of [
    'CC',
    'CXX',
    'CL',
    'LINK',
    'INCLUDE',
    'LIB',
    'PYTHON',
    'GYP_DEFINES',
    'npm_config_msvs_version',
    'npm_config_target',
    'npm_config_node_gyp',
    'npm_config_tarball',
    'npm_config_devdir',
    'SIGN_EXE',
  ]) {
    expectFailure(
      () => assertVisibleReleaseLaunchState({ environment: { [name]: 'poison' }, execArgv: [] }),
      /prohibited variables/,
    );
  }
});

test('tracked package scripts expose the exact fail-closed npm release launcher', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const definition of Object.values(RELEASE_COMMANDS)) {
    assert.equal(pkg.scripts[definition.lifecycleEvent], definition.lifecycleScript);
  }
});

test('npm release launcher removes lifecycle channels and injected executable paths', () => {
  const injectedPath = [
    '/work/node_modules/.bin',
    '/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
    '/trusted/bin',
  ].join(path.delimiter);
  assert.equal(
    cleanNpmInjectedPath(injectedPath, '/runtime/node'),
    ['/runtime', '/trusted/bin'].join(path.delimiter),
  );
  assert.equal(
    cleanNpmInjectedPath(
      'C:\\work\\node_modules\\.bin;C:\\Windows\\System32',
      'C:\\runtime\\node.exe',
      'win32',
    ),
    'C:\\runtime;C:\\Windows\\System32',
  );
  const child = createNpmReleaseChildEnvironment({
    PATH: injectedPath,
    INIT_CWD: '/work',
    NODE: '/runtime/node',
    npm_config_target: 'ia32',
    npm_lifecycle_event: 'release:build',
    GIT_DIR: '/poison',
  }, '/runtime/node');
  assert.equal(child.PATH, ['/runtime', '/trusted/bin'].join(path.delimiter));
  assert.equal(child.INIT_CWD, undefined);
  assert.equal(child.NODE, undefined);
  assert.equal(child.npm_config_target, undefined);
  assert.equal(child.npm_lifecycle_event, undefined);
  assert.equal(child.GIT_DIR, undefined);
});

test('release child environment strips all npm, GIT, and GYP ambient channels', () => {
  const environment = createReleaseChildEnvironment({
    PATH: '/trusted',
    npm_config_registry: 'https://poison.invalid',
    npm_package_config_arch: 'ia32',
    GIT_DIR: '/poison',
    git_index_file: '/poison-index',
  });
  assert.equal(environment.PATH, '/trusted');
  assert.equal(environment.npm_config_registry, undefined);
  assert.equal(environment.npm_package_config_arch, undefined);
  assert.equal(environment.GIT_DIR, undefined);
  assert.equal(environment.git_index_file, undefined);
});

test('PE header helper enforces AMD64 and executable characteristics', () => {
  assert.equal(readPeHeader(createPe()).machine, 0x8664);
  expectFailure(() => readPeHeader(createPe(null, { characteristics: 0x2020 })), /not executable/);
});

test('pinned Node SDK input files reject non-official bytes', () => {
  const root = temporaryDirectory('sdk-inputs');
  try {
    fs.mkdirSync(path.join(root, 'build', 'release'), { recursive: true });
    fs.writeFileSync(path.join(root, ...REQUIRED_NODE_HEADERS_INPUT.split('/')), 'wrong headers');
    fs.writeFileSync(
      path.join(root, ...REQUIRED_NODE_IMPORT_LIBRARY_INPUT.split('/')),
      'wrong node.lib',
    );
    expectFailure(() => validateReleaseSdkInputs(root), /headers archive SHA-256/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('stable release reads reject hardlink aliases for all provenance inputs', () => {
  const root = temporaryDirectory('hardlink-read');
  try {
    const original = path.join(root, 'original');
    const alias = path.join(root, 'alias');
    fs.writeFileSync(original, 'same bytes');
    fs.linkSync(original, alias);
    expectFailure(() => readRegularNonLinkFile(alias), /hardlink aliases/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('downloaded Node SDK bytes fail closed on empty, oversized, or wrong hashes', () => {
  expectFailure(
    () => validateDownloadedBytes('headers', Buffer.alloc(0), 'a'.repeat(64), 10),
    /size is outside/,
  );
  expectFailure(
    () => validateDownloadedBytes('headers', Buffer.alloc(11), 'a'.repeat(64), 10),
    /size is outside/,
  );
  expectFailure(
    () => validateDownloadedBytes('headers', Buffer.from('bytes'), 'a'.repeat(64), 10),
    /SHA-256/,
  );
});

test('Node SDK HTTP boundary rejects alternate URLs, redirects, encodings, and lengths', () => {
  expectFailure(
    () => downloadPinnedFile(
      'https://nodejs.org/download/release/v24.19.0/other',
      'a'.repeat(64),
      10,
    ),
    /URL is not canonical/,
  );
  expectFailure(() => validateDownloadResponse(302, {}, 10), /HTTP 302/);
  expectFailure(
    () => validateDownloadResponse(200, { location: 'https://example.invalid' }, 10),
    /redirected/,
  );
  expectFailure(
    () => validateDownloadResponse(200, { 'content-encoding': 'gzip' }, 10),
    /content encoding/,
  );
  expectFailure(
    () => validateDownloadResponse(200, { 'content-length': 'not-a-number' }, 10),
    /Content-Length/,
  );
  expectFailure(
    () => validateDownloadResponse(200, { 'content-length': '11' }, 10),
    /Content-Length/,
  );
  assert.equal(validateDownloadResponse(200, { 'content-length': '10' }, 10), 10);
});

test('Node headers archive entry policy rejects traversal, links, and case collisions', () => {
  assert.equal(
    canonicalArchiveEntryPath('node-v24.19.0/include/node/node.h'),
    'include/node/node.h',
  );
  expectFailure(
    () => canonicalArchiveEntryPath('node-v24.19.0/../escape'),
    /unsafe component/,
  );
  expectFailure(
    () => validateArchiveEntry(
      { path: 'node-v24.19.0/link', size: 0, type: 'SymbolicLink' },
      { bytes: 0, entries: 0, paths: new Set() },
    ),
    /type is not allowed/,
  );
  const state = { bytes: 0, entries: 0, paths: new Set() };
  validateArchiveEntry(
    { path: 'node-v24.19.0/Include/node.h', size: 1, type: 'File' },
    state,
  );
  expectFailure(
    () => validateArchiveEntry(
      { path: 'node-v24.19.0/include/node.h', size: 1, type: 'File' },
      state,
    ),
    /case-colliding/,
  );
});

test('non-canonical PE optional-header and directory layouts are rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  const truncatedOptional = createPe(marker);
  truncatedOptional.writeUInt16LE(0xe0, 0x94);
  expectFailure(() => validateEmbeddedMarker(truncatedOptional, marker), /truncated optional header/);
  const shortDirectories = createPe(marker);
  shortDirectories.writeUInt32LE(15, 0x98 + 108);
  expectFailure(() => validateEmbeddedMarker(shortDirectories, marker), /canonical 16/);
});

test('overlapping PE raw sections are rejected', () => {
  const marker = buildReleaseMarker(fixtureIdentity());
  const contents = createPe(marker);
  contents.writeUInt16LE(2, 0x86);
  const secondSection = 0x98 + 0xf0 + 40;
  contents.write('.extra\0\0', secondSection, 'ascii');
  contents.writeUInt32LE(0x100, secondSection + 8);
  contents.writeUInt32LE(0x2000, secondSection + 12);
  contents.writeUInt32LE(0x100, secondSection + 16);
  contents.writeUInt32LE(0x240, secondSection + 20);
  expectFailure(() => validateEmbeddedMarker(contents, marker), /overlapping PE/);
});

test('clean canonical repository captures commit and tracked-tree fingerprint', () => {
  withRepository((repository) => {
    const source = captureReleaseSource(repository);
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.match(source.trackedTreeSha256, /^[0-9a-f]{64}$/);
  });
});

test('wrong Git origin is rejected', () => {
  withRepository((repository) => {
    git(repository, ['remote', 'set-url', 'origin', 'https://github.com/example/fork.git']);
    expectFailure(() => captureReleaseSource(repository), /Release origin must be/);
  });
});

test('staged index changes are rejected independently of status output', () => {
  withRepository((repository) => {
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'bravo\n');
    git(repository, ['add', 'tracked.txt']);
    expectFailure(() => captureReleaseSource(repository), /index entries do not exactly match/);
  });
});

test('same-size worktree mutation with restored mtime is caught by direct blob hashing', () => {
  withRepository((repository) => {
    const tracked = path.join(repository, 'tracked.txt');
    git(repository, ['update-index', '--refresh']);
    const before = fs.statSync(tracked);
    fs.writeFileSync(tracked, 'omega\n');
    fs.utimesSync(tracked, before.atime, before.mtime);
    expectFailure(() => captureReleaseSource(repository), /worktree bytes do not match/);
  });
});

test('assume-unchanged index flags are rejected', () => {
  withRepository((repository) => {
    git(repository, ['update-index', '--assume-unchanged', 'tracked.txt']);
    expectFailure(() => captureReleaseSource(repository), /Hidden Git index flag/);
  });
});

test('skip-worktree index flags are rejected', () => {
  withRepository((repository) => {
    git(repository, ['update-index', '--skip-worktree', 'tracked.txt']);
    expectFailure(() => captureReleaseSource(repository), /Hidden Git index flag/);
  });
});

test('ignored untracked build input is still rejected', () => {
  withRepository((repository) => {
    fs.writeFileSync(path.join(repository, '.gitignore'), '*.cc\n');
    git(repository, ['add', '.gitignore']);
    git(repository, ['commit', '-m', 'ignore fixture']);
    fs.writeFileSync(path.join(repository, 'hidden.cc'), 'malicious\n');
    expectFailure(() => captureReleaseSource(repository), /Untracked release input/);
  });
});

test('node_modules content is an explicitly bounded prepare-phase input prefix', () => {
  withRepository((repository) => {
    fs.mkdirSync(path.join(repository, 'node_modules', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'node_modules', 'fixture', 'index.js'), 'module.exports=1;\n');
    assert.match(captureReleaseSource(repository).trackedTreeSha256, /^[0-9a-f]{64}$/);
  });
});

test('postbuild phase permits only canonical output locations', () => {
  withRepository((repository) => {
    fs.mkdirSync(path.join(repository, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'build', 'Release', 'intermediate.obj'), 'fixture');
    fs.mkdirSync(path.join(repository, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'lib', 'node_printer.node'), 'fixture');
    assert.match(
      captureReleaseSource(repository, { phase: 'postbuild' }).trackedTreeSha256,
      /^[0-9a-f]{64}$/,
    );
    fs.writeFileSync(path.join(repository, 'lib', 'other.node'), 'fixture');
    expectFailure(
      () => captureReleaseSource(repository, { phase: 'postbuild' }),
      /Untracked release input/,
    );
  });
});

test('canonical output reset removes stale build objects and exact old release files only', () => {
  withRepository((repository) => {
    addTrackedOutputFixture(repository);
    fs.mkdirSync(path.join(repository, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'build', 'Release', 'stale.obj'), 'stale object');
    fs.writeFileSync(path.join(repository, 'lib', 'node_printer.node'), 'stale addon');
    fs.writeFileSync(path.join(repository, 'lib', 'node_printer.release.json'), 'stale receipt');
    resetCanonicalReleaseOutputs(repository);
    assert.equal(fs.existsSync(path.join(repository, 'build')), false);
    assert.equal(fs.existsSync(path.join(repository, 'lib', 'node_printer.node')), false);
    assert.equal(fs.existsSync(path.join(repository, 'lib', 'node_printer.release.json')), false);
    assert.equal(fs.readFileSync(path.join(repository, 'lib', 'printer.js'), 'utf8'), 'module.exports = {};\n');
  });
});

test('canonical output reset rejects symlink or junction abstractions without following them', () => {
  withRepository((repository, root) => {
    addTrackedOutputFixture(repository);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(repository, 'build'), 'dir');
    expectFailure(() => resetCanonicalReleaseOutputs(repository), /link or junction/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('canonical output reset rejects a broken output link instead of treating it as absent', () => {
  withRepository((repository) => {
    addTrackedOutputFixture(repository);
    fs.symlinkSync('missing-target', path.join(repository, 'build'), 'dir');
    expectFailure(() => resetCanonicalReleaseOutputs(repository), /link or junction/);
  });
});

test('canonical output reset rejects nested links and hardlink aliases', () => {
  withRepository((repository, root) => {
    addTrackedOutputFixture(repository);
    const outside = path.join(root, 'outside.bin');
    fs.writeFileSync(outside, 'outside');
    fs.mkdirSync(path.join(repository, 'build'));
    fs.symlinkSync(outside, path.join(repository, 'build', 'linked.obj'));
    expectFailure(() => resetCanonicalReleaseOutputs(repository), /link or junction/);
    fs.unlinkSync(path.join(repository, 'build', 'linked.obj'));
    fs.linkSync(outside, path.join(repository, 'build', 'hardlinked.obj'));
    expectFailure(() => resetCanonicalReleaseOutputs(repository), /hardlink alias/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  });
});

test('output removal detects a file-to-link swap before mutation', () => {
  withRepository((repository, root) => {
    addTrackedOutputFixture(repository);
    const outside = path.join(root, 'outside.txt');
    const build = path.join(repository, 'build');
    const stale = path.join(build, 'stale.obj');
    const displaced = path.join(root, 'displaced.obj');
    fs.writeFileSync(outside, 'outside stays');
    fs.mkdirSync(build);
    fs.writeFileSync(stale, 'stale');
    let swapped = false;
    expectFailure(() => removeOwnedOutputPath(repository, build, {
      onBeforeEntryRemoval(entryPath) {
        if (!swapped && entryPath === stale) {
          fs.renameSync(stale, displaced);
          fs.symlinkSync(outside, stale);
          swapped = true;
        }
      },
    }), /changed before removal/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside stays');
    assert.equal(fs.readFileSync(displaced, 'utf8'), 'stale');
  });
});

test('detached build transaction starts without ignored source-checkout outputs', () => {
  withRepository((repository) => {
    addTrackedOutputFixture(repository);
    fs.mkdirSync(path.join(repository, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'build', 'Release', 'poison.obj'), 'poison');
    resetCanonicalReleaseOutputs(repository);
    const source = captureReleaseSource(repository);
    const transaction = createDetachedReleaseWorktree(repository, source.commit);
    try {
      assert.equal(fs.existsSync(path.join(transaction.workTree, 'build')), false);
      assert.equal(fs.existsSync(path.join(transaction.workTree, 'lib', 'node_printer.node')), false);
      assert.deepEqual(captureReleaseSource(transaction.workTree), source);
    } finally {
      cleanupDetachedReleaseWorktree(transaction);
    }
  });
});

test('verified transaction exports are staged into only the canonical fresh output paths', () => {
  withRepository((repository) => {
    addTrackedOutputFixture(repository);
    const source = temporaryDirectory('exports');
    try {
      for (const [index, relative] of EXPORTED_RELEASE_FILES.entries()) {
        const absolute = path.join(source, ...relative.split('/'));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `export-${index}`);
      }
      publishFreshReleaseOutputs(source, repository);
      for (const [index, relative] of EXPORTED_RELEASE_FILES.entries()) {
        assert.equal(
          fs.readFileSync(path.join(repository, ...relative.split('/')), 'utf8'),
          `export-${index}`,
        );
      }
      assert.equal(
        fs.readdirSync(repository).some((name) => name.startsWith('.node-printer-release-build-')),
        false,
      );
      assert.deepEqual(fs.readdirSync(path.join(repository, 'lib')).sort(), [
        'node_printer.node',
        'node_printer.release.json',
        'printer.js',
      ]);
    } finally {
      fs.rmSync(source, { force: true, recursive: true });
    }
  });
});

test('tracked symlinks are rejected as unsupported release inputs', () => {
  withRepository((repository) => {
    fs.symlinkSync('tracked.txt', path.join(repository, 'tracked-link'));
    git(repository, ['add', 'tracked-link']);
    git(repository, ['commit', '-m', 'symlink fixture']);
    expectFailure(() => captureReleaseSource(repository), /Unsupported Git index entry/);
  });
});

test('GIT_DIR, index, object, alternates, and config injection variables are ignored', () => {
  withRepository((repository, root) => {
    const poison = path.join(root, 'poison');
    fs.mkdirSync(poison);
    withEnvironment({
      GIT_DIR: poison,
      GIT_WORK_TREE: poison,
      GIT_INDEX_FILE: path.join(poison, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(poison, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: poison,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: poison,
    }, () => {
      assert.match(captureReleaseSource(repository).commit, /^[0-9a-f]{40}$/);
    });
  });
});

test('case-insensitive GIT variables are removed from child environments', () => {
  const environment = createGitEnvironment({
    PATH: '/bin',
    GIT_DIR: '/poison',
    git_work_tree: '/also-poison',
  });
  assert.equal(environment.GIT_DIR, undefined);
  assert.equal(environment.git_work_tree, undefined);
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.GIT_NO_REPLACE_OBJECTS, '1');
});

test('unsafe local Git core configuration is rejected', () => {
  withRepository((repository) => {
    git(repository, ['config', 'core.autocrlf', 'true']);
    expectFailure(() => captureReleaseSource(repository), /Unsafe local Git configuration/);
  });
});

for (const [configName, configValue] of [
  ['core.checkStat', 'minimal'],
  ['core.fscache', 'true'],
  ['core.trustctime', 'false'],
  ['core.untrackedCache', 'true'],
  ['feature.manyFiles', 'true'],
]) {
  test(`unsafe local Git cache/stat configuration ${configName} is rejected`, () => {
    withRepository((repository) => {
      git(repository, ['config', configName, configValue]);
      expectFailure(() => captureReleaseSource(repository), /Unsafe local Git configuration/);
    });
  });
}

test('local include and diff command configuration are rejected', () => {
  withRepository((repository, root) => {
    const included = path.join(root, 'included-config');
    fs.writeFileSync(included, '[core]\n\tignorestat = true\n');
    git(repository, ['config', 'include.path', included]);
    git(repository, ['config', 'diff.fixture.command', '/bin/false']);
    expectFailure(() => captureReleaseSource(repository), /Unsafe local Git configuration/);
  });
});

test('Git replace refs are rejected even though commands disable substitution', () => {
  withRepository((repository) => {
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'bravo\n');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '-m', 'second fixture']);
    git(repository, ['replace', 'HEAD', 'HEAD~1']);
    expectFailure(() => captureReleaseSource(repository), /replace refs/);
  });
});

test('Git alternates metadata is rejected', () => {
  withRepository((repository) => {
    const alternates = path.join(repository, '.git', 'objects', 'info', 'alternates');
    fs.writeFileSync(alternates, `${path.join(repository, '.git', 'objects')}\n`);
    expectFailure(() => captureReleaseSource(repository), /Git alternates/);
  });
});

test('per-worktree Git configuration file is rejected', () => {
  withRepository((repository) => {
    fs.writeFileSync(path.join(repository, '.git', 'config.worktree'), '[core]\n');
    expectFailure(() => captureReleaseSource(repository), /Per-worktree Git configuration/);
  });
});

test('linked Git worktree resolves to its exact own index and common directory', () => {
  withRepository((repository, root) => {
    const linked = path.join(root, 'linked');
    git(repository, ['worktree', 'add', '-b', 'fixture-linked', linked, 'HEAD']);
    assert.match(captureReleaseSource(linked).commit, /^[0-9a-f]{40}$/);
  });
});

test('repository subdirectory cannot be substituted for the canonical root', () => {
  withRepository((repository) => {
    const subdirectory = path.join(repository, 'subdirectory');
    fs.mkdirSync(subdirectory);
    expectFailure(() => captureReleaseSource(subdirectory), /no resolvable \.git entry/);
  });
});

test('tracked package lock and exact direct dependency contract are valid', () => {
  assert.match(assertReleaseDependencyContract(repoRoot), /^[0-9a-f]{64}$/);
});

test('binding and source marker hook are release-only and deterministic', () => {
  const binding = fs.readFileSync(path.join(repoRoot, 'binding.gyp'), 'utf8');
  const releaseSource = fs.readFileSync(path.join(repoRoot, 'src', 'release_provenance.cc'), 'utf8');
  const sourceEnumerator = fs.readFileSync(path.join(repoRoot, 'tools', 'getSourceFiles.py'), 'utf8');
  assert.match(binding, /dmkiosk_release_build%/);
  assert.match(binding, /DMKIOSK_NODE_PRINTER_RELEASE_BUILD=1/);
  assert.match(binding, /msvs_toolset[^\n]+v143/);
  assert.match(releaseSource, /#if defined\(DMKIOSK_NODE_PRINTER_RELEASE_BUILD\)/);
  assert.match(releaseSource, /node_printer_release_marker\.generated\.h/);
  assert.match(sourceEnumerator, /sorted\(os\.listdir\(folder\)\)/);
});

test('build orchestrator uses a fresh detached worktree and verifies before publishing', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-release.js'), 'utf8');
  const resetAt = build.indexOf('resetCanonicalReleaseOutputs(repoRoot)');
  const transactionAt = build.indexOf('createDetachedReleaseWorktree(repoRoot, source.commit)');
  const runAt = build.indexOf('runTransactionBuild(transaction.workTree)');
  const verifyAt = build.indexOf('validatePreSignRelease({ repoRoot: transaction.workTree })');
  const publishAt = build.indexOf('publishFreshReleaseOutputs(transaction.workTree, repoRoot)');
  assert.ok(
    resetAt >= 0 && transactionAt > resetAt && runAt > transactionAt
      && verifyAt > runAt && publishAt > verifyAt,
  );
  assert.match(build, /cleanupDetachedReleaseWorktree/);
  assert.match(build, /closingSource/);
  assert.doesNotMatch(build, /runNodeGyp/);
  assert.doesNotMatch(build, /signtool|SIGN_EXE|aws\s|upload/i);
});

test('detached build rechecks source, output tree, and SDK around both node-gyp phases', () => {
  const build = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'build-release-worktree.js'),
    'utf8',
  );
  const prepareAt = build.indexOf('prepareReleaseBuild({');
  const configureAt = build.indexOf("runNodeGyp(repoRoot, nodeGypCli, [\n    'configure'");
  const buildAt = build.indexOf("runNodeGyp(repoRoot, nodeGypCli, ['build', '--release'])");
  const receiptAt = build.indexOf('writeReleaseManifest({');
  assert.ok(prepareAt >= 0 && configureAt > prepareAt && buildAt > configureAt
    && receiptAt > buildAt);
  assert.equal((build.match(/recheckReleaseInputs\(repoRoot/g) || []).length, 4);
  assert.match(build, /-Ddmkiosk_release_build=1/);
  assert.match(build, /--nodedir=/);
  assert.match(build, /--target=/);
  assert.match(build, /verifyMaterializedNodeSdk/);
  assert.doesNotMatch(build, /'rebuild'/);
  assert.doesNotMatch(build, /signtool|SIGN_EXE|aws\s|upload/i);
});

test('SDK tar inspection and extraction consume the same validated in-memory bytes', () => {
  const materializer = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'materialize-node-sdk.js'),
    'utf8',
  );
  assert.match(materializer, /consumeTarBytes\(tar\.t\(/);
  assert.match(materializer, /consumeTarBytes\(tar\.x\(/);
  assert.equal((materializer.match(/\), headersContents, /g) || []).length, 2);
  assert.doesNotMatch(materializer, /file:\s*archiveCopy/);
  assert.match(materializer, /Pinned Node SDK inputs changed during in-memory materialization/);
});

test('dependency setup is lifecycle-script-free and exact-lock based', () => {
  const setup = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'setup-release-dependencies.js'),
    'utf8',
  );
  assert.match(setup, /'ci'/);
  assert.match(setup, /'--ignore-scripts'/);
  assert.doesNotMatch(setup, /npm\s+install|shell:\s*true/);
});

test('standalone verifier calls strict pre-stage validation and fails via exitCode', () => {
  const verifier = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-presign-release.js'), 'utf8');
  assert.match(verifier, /validatePreSignRelease\(\{ repoRoot \}\)/);
  assert.match(verifier, /process\.exitCode = 1/);
});

if (process.exitCode) {
  process.stderr.write(`${passed} release provenance source tests passed before failure.\n`);
} else {
  process.stdout.write(`1..${passed}\n${passed} release provenance source tests passed.\n`);
}
