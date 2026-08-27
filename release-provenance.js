'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertReleaseDependencyContract,
  assertUnsignedNativeAddonPe,
  createReleaseToolchain,
  normalizeReleaseToolchain,
  readPeSectionRanges,
  readRegularNonLinkFile,
  readReleaseVersion,
  SHA256_PATTERN,
  sha256,
  validateReleaseNodeExecutable,
  validateReleaseSdkInputs,
} = require('./release-build-policy');
const {
  assertHardenedRepository,
  runGitInContext,
  samePath,
} = require('./scripts/hardened-git');

const RELEASE_SCHEMA_VERSION = 1;
const RELEASE_ROLE = 'kiosk-printer-native-addon';
const RELEASE_REPOSITORY = 'deliverymanager/node-printer';
const RELEASE_ORIGIN_URL = 'https://github.com/deliverymanager/node-printer.git';
const RELEASE_TARGET = 'win-x64-node-addon';
const RELEASE_ARCHITECTURE = 'x64';
const RELEASE_ARTIFACT_PATH = 'lib/node_printer.node';
const RELEASE_MANIFEST_PATH = 'lib/node_printer.release.json';
const RELEASE_IDENTITY_PATH = 'build/release/release-identity.json';
const RELEASE_HEADER_PATH = 'build/release/generated/node_printer_release_marker.generated.h';
const RELEASE_MARKER_PREFIX = 'DMKIOSK_NODE_PRINTER_PROVENANCE_V1|';
const SIGNATURE_POLICY = Object.freeze({
  mode: 'unsigned-node-addon',
  status: 'NotSigned',
  signerThumbprint: '',
  timestamped: false,
});
const BUILD_ID_PATTERN = /^[0-9a-f]{32}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function exactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${label} fields are not the exact canonical set`);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalTrackedPath(rawPath) {
  if (!rawPath.length) throw new Error('Git reported an empty tracked path');
  const decoded = rawPath.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(rawPath)) {
    throw new Error('Tracked paths must be valid canonical UTF-8');
  }
  if (decoded.startsWith('/') || decoded.includes('\\') || /^[A-Za-z]:/.test(decoded)) {
    throw new Error(`Tracked path is not repository-relative: ${decoded}`);
  }
  const components = decoded.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new Error(`Tracked path has a non-canonical component: ${decoded}`);
  }
  return decoded;
}

function nullRecords(value) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  const records = [];
  let start = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0) continue;
    records.push(contents.subarray(start, index));
    start = index + 1;
  }
  if (start !== contents.length) throw new Error('Git emitted a non-NUL-terminated record');
  return records;
}

function parseIndexEntries(output) {
  return nullRecords(output).map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Git index entry has no path separator');
    const metadata = record.subarray(0, tab).toString('ascii');
    const match = /^(100644|100755) ([0-9a-f]+) ([0-3])$/.exec(metadata);
    if (!match) throw new Error(`Unsupported Git index entry: ${metadata}`);
    if (match[3] !== '0') throw new Error('Unmerged Git index entries are not releasable');
    return { mode: match[1], objectId: match[2], path: canonicalTrackedPath(record.subarray(tab + 1)) };
  });
}

function parseTreeEntries(output) {
  return nullRecords(output).map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Git tree entry has no path separator');
    const metadata = record.subarray(0, tab).toString('ascii');
    const match = /^(100644|100755) blob ([0-9a-f]+)$/.exec(metadata);
    if (!match) throw new Error(`Unsupported Git tree entry: ${metadata}`);
    return { mode: match[1], objectId: match[2], path: canonicalTrackedPath(record.subarray(tab + 1)) };
  });
}

function compareEntrySets(indexEntries, treeEntries) {
  const serialize = (entry) => `${entry.mode} ${entry.objectId}\t${entry.path}`;
  const indexRecords = indexEntries.map(serialize);
  const treeRecords = treeEntries.map(serialize);
  if (indexRecords.length !== treeRecords.length
      || indexRecords.some((record, index) => record !== treeRecords[index])) {
    throw new Error('Git index entries do not exactly match the HEAD tree');
  }
}

function assertIndexFlags(output) {
  for (const record of nullRecords(output)) {
    if (record.length < 3 || record[1] !== 0x20) {
      throw new Error('Git emitted an invalid tracked-index flag record');
    }
    const tag = String.fromCharCode(record[0]);
    const trackedPath = canonicalTrackedPath(record.subarray(2));
    if (tag !== 'H') {
      throw new Error(`Hidden Git index flag ${tag} is not allowed: ${trackedPath}`);
    }
  }
}

function gitBlobId(contents, objectFormat) {
  const hash = crypto.createHash(objectFormat);
  hash.update(Buffer.from(`blob ${contents.length}\0`, 'ascii'));
  hash.update(contents);
  return hash.digest('hex');
}

function verifyTrackedWorktreeBytes(context, indexEntries, objectFormat) {
  const fingerprint = crypto.createHash('sha256');
  const seenPaths = new Set();
  for (const entry of indexEntries) {
    const comparisonPath = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (seenPaths.has(comparisonPath)) {
      throw new Error(`Case-colliding or duplicate tracked path: ${entry.path}`);
    }
    seenPaths.add(comparisonPath);
    const inspected = readRegularNonLinkFile(path.join(context.workTree, ...entry.path.split('/')));
    const actualObjectId = gitBlobId(inspected.contents, objectFormat);
    if (actualObjectId !== entry.objectId) {
      throw new Error(`Tracked worktree bytes do not match the Git index blob: ${entry.path}`);
    }
    fingerprint.update(entry.mode, 'ascii');
    fingerprint.update('\0', 'ascii');
    fingerprint.update(entry.objectId, 'ascii');
    fingerprint.update('\0', 'ascii');
    fingerprint.update(entry.path, 'utf8');
    fingerprint.update('\0', 'ascii');
  }
  return fingerprint.digest('hex');
}

function listUntrackedPaths(context) {
  return nullRecords(runGitInContext(context, ['ls-files', '--others', '-z'], {
    encoding: null,
  })).map(canonicalTrackedPath);
}

function isAllowedUntrackedPath(relativePath, phase) {
  if (relativePath.startsWith('node_modules/')) return true;
  if (phase !== 'postbuild') return false;
  return relativePath.startsWith('build/')
    || relativePath === RELEASE_ARTIFACT_PATH
    || relativePath === RELEASE_MANIFEST_PATH;
}

function assertUntrackedInputs(context, phase) {
  if (!['prepare', 'postbuild'].includes(phase)) {
    throw new Error(`Unknown release source-validation phase: ${phase}`);
  }
  const untracked = listUntrackedPaths(context);
  const rejected = untracked.filter(
    (relativePath) => !isAllowedUntrackedPath(relativePath, phase),
  );
  if (rejected.length > 0) {
    throw new Error(`Untracked release input is not allowed: ${rejected.slice(0, 8).join(', ')}`);
  }
  const nodeModulesPath = path.join(context.workTree, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    const entry = fs.lstatSync(nodeModulesPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('node_modules must be a real directory when present');
    }
  }
  return untracked;
}

function captureReleaseSource(repoRoot, options = {}) {
  const phase = options.phase || 'prepare';
  const context = assertHardenedRepository(repoRoot, options);
  const origin = String(runGitInContext(context, ['remote', 'get-url', 'origin'])).trim();
  if (origin !== RELEASE_ORIGIN_URL) {
    throw new Error(`Release origin must be ${RELEASE_ORIGIN_URL}; got ${origin || '<empty>'}`);
  }
  const objectFormat = String(runGitInContext(
    context,
    ['rev-parse', '--show-object-format'],
  )).trim();
  if (objectFormat !== 'sha1') {
    throw new Error(`Canonical release repository must use sha1 Git objects; got ${objectFormat}`);
  }
  const commit = String(runGitInContext(
    context,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
  )).trim();
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`Canonical HEAD commit is invalid: ${commit}`);

  const flagsOutput = runGitInContext(context, ['ls-files', '-v', '-z'], { encoding: null });
  assertIndexFlags(flagsOutput);
  const indexOutput = runGitInContext(context, ['ls-files', '-s', '-z'], {
    encoding: null,
  });
  const treeOutput = runGitInContext(
    context,
    ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    { encoding: null },
  );
  const indexEntries = parseIndexEntries(indexOutput);
  const treeEntries = parseTreeEntries(treeOutput);
  compareEntrySets(indexEntries, treeEntries);
  const trackedTreeSha256 = verifyTrackedWorktreeBytes(context, indexEntries, objectFormat);
  const untracked = assertUntrackedInputs(context, phase);

  const closingContext = assertHardenedRepository(repoRoot, options);
  if (!samePath(context.workTree, closingContext.workTree)
      || !samePath(context.gitDir, closingContext.gitDir)
      || !samePath(context.commonDir, closingContext.commonDir)) {
    throw new Error('Release Git repository resolution changed during source capture');
  }
  const closingOrigin = String(runGitInContext(context, ['remote', 'get-url', 'origin'])).trim();
  const closingObjectFormat = String(runGitInContext(
    context,
    ['rev-parse', '--show-object-format'],
  )).trim();
  const closingCommit = String(runGitInContext(
    context,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
  )).trim();
  const closingFlags = runGitInContext(context, ['ls-files', '-v', '-z'], { encoding: null });
  const closingIndex = runGitInContext(context, ['ls-files', '-s', '-z'], { encoding: null });
  const closingTree = runGitInContext(
    context,
    ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    { encoding: null },
  );
  const closingFingerprint = verifyTrackedWorktreeBytes(context, indexEntries, objectFormat);
  const closingUntracked = listUntrackedPaths(context);
  if (closingOrigin !== origin
      || closingObjectFormat !== objectFormat
      || closingCommit !== commit
      || !closingFlags.equals(flagsOutput)
      || !closingIndex.equals(indexOutput)
      || !closingTree.equals(treeOutput)
      || closingFingerprint !== trackedTreeSha256
      || closingUntracked.join('\0') !== untracked.join('\0')) {
    throw new Error('Release source state changed during its stable-snapshot validation');
  }
  return { commit, trackedTreeSha256 };
}

function normalizeSource(source) {
  exactKeys(source, ['commit', 'trackedTreeSha256'], 'Release source');
  if (!COMMIT_PATTERN.test(source.commit)) throw new Error('Release source commit is invalid');
  if (!SHA256_PATTERN.test(source.trackedTreeSha256)) {
    throw new Error('Release source trackedTreeSha256 is invalid');
  }
  return { commit: source.commit, trackedTreeSha256: source.trackedTreeSha256 };
}

function normalizeIdentity(identity) {
  exactKeys(identity, [
    'architecture',
    'buildId',
    'packageVersion',
    'repository',
    'role',
    'schemaVersion',
    'source',
    'target',
    'toolchain',
  ], 'Release identity');
  if (identity.schemaVersion !== RELEASE_SCHEMA_VERSION
      || identity.role !== RELEASE_ROLE
      || identity.repository !== RELEASE_REPOSITORY
      || identity.target !== RELEASE_TARGET
      || identity.architecture !== RELEASE_ARCHITECTURE) {
    throw new Error('Release identity fixed fields are not canonical');
  }
  if (!VERSION_PATTERN.test(identity.packageVersion)) {
    throw new Error('Release identity packageVersion is invalid');
  }
  if (!BUILD_ID_PATTERN.test(identity.buildId)) {
    throw new Error('Release identity buildId is invalid');
  }
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    role: RELEASE_ROLE,
    repository: RELEASE_REPOSITORY,
    target: RELEASE_TARGET,
    architecture: RELEASE_ARCHITECTURE,
    packageVersion: identity.packageVersion,
    buildId: identity.buildId,
    source: normalizeSource(identity.source),
    toolchain: normalizeReleaseToolchain(identity.toolchain),
  };
}

function buildReleaseMarker(identity) {
  const normalized = normalizeIdentity(identity);
  const marker = [
    RELEASE_MARKER_PREFIX.slice(0, -1),
    `role=${normalized.role}`,
    `repository=${normalized.repository}`,
    `target=${normalized.target}`,
    `architecture=${normalized.architecture}`,
    `packageVersion=${normalized.packageVersion}`,
    `buildId=${normalized.buildId}`,
    `commit=${normalized.source.commit}`,
    `trackedTreeSha256=${normalized.source.trackedTreeSha256}`,
    `nodeVersion=${normalized.toolchain.nodeVersion}`,
    `nodeModulesAbi=${normalized.toolchain.nodeModulesAbi}`,
    `npmVersion=${normalized.toolchain.npmVersion}`,
    `nodeHeadersSha256=${normalized.toolchain.nodeHeadersSha256}`,
    `nodeHeadersUrl=${normalized.toolchain.nodeHeadersUrl}`,
    `nodeImportLibrarySha256=${normalized.toolchain.nodeImportLibrarySha256}`,
    `nodeImportLibraryUrl=${normalized.toolchain.nodeImportLibraryUrl}`,
    `packageLockSha256=${normalized.toolchain.packageLockSha256}`,
  ].join('|');
  if (!marker.startsWith(RELEASE_MARKER_PREFIX)
      || !/^[A-Za-z0-9._/|=:-]+$/.test(marker)
      || Buffer.byteLength(marker, 'ascii') > 2048) {
    throw new Error('Generated release marker is not canonical ASCII');
  }
  return marker;
}

function normalizeArtifact(artifact) {
  exactKeys(artifact, ['path', 'sha256', 'size'], 'Release artifact');
  if (artifact.path !== RELEASE_ARTIFACT_PATH
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || !SHA256_PATTERN.test(artifact.sha256)) {
    throw new Error('Release artifact identity is invalid');
  }
  return { path: RELEASE_ARTIFACT_PATH, size: artifact.size, sha256: artifact.sha256 };
}

function normalizeSignaturePolicy(signaturePolicy) {
  exactKeys(
    signaturePolicy,
    ['mode', 'signerThumbprint', 'status', 'timestamped'],
    'Release signaturePolicy',
  );
  for (const [name, value] of Object.entries(SIGNATURE_POLICY)) {
    if (signaturePolicy[name] !== value) {
      throw new Error(`Release signaturePolicy ${name} must be ${JSON.stringify(value)}`);
    }
  }
  return { ...SIGNATURE_POLICY };
}

function normalizeManifest(manifest) {
  exactKeys(manifest, [
    'architecture',
    'artifact',
    'buildId',
    'embeddedIdentity',
    'packageVersion',
    'repository',
    'role',
    'schemaVersion',
    'signaturePolicy',
    'source',
    'target',
    'toolchain',
  ], 'Release manifest');
  const identity = normalizeIdentity({
    schemaVersion: manifest.schemaVersion,
    role: manifest.role,
    repository: manifest.repository,
    target: manifest.target,
    architecture: manifest.architecture,
    packageVersion: manifest.packageVersion,
    buildId: manifest.buildId,
    source: manifest.source,
    toolchain: manifest.toolchain,
  });
  const embeddedIdentity = buildReleaseMarker(identity);
  if (manifest.embeddedIdentity !== embeddedIdentity) {
    throw new Error('Release manifest embeddedIdentity does not match its canonical identity');
  }
  return {
    ...identity,
    artifact: normalizeArtifact(manifest.artifact),
    embeddedIdentity,
    signaturePolicy: normalizeSignaturePolicy(manifest.signaturePolicy),
  };
}

function markerOccurrences(contents) {
  const prefix = Buffer.from(RELEASE_MARKER_PREFIX, 'ascii');
  const occurrences = [];
  let searchOffset = 0;
  while (searchOffset < contents.length) {
    const start = contents.indexOf(prefix, searchOffset);
    if (start < 0) break;
    const terminator = contents.indexOf(0, start);
    if (terminator < 0 || terminator - start > 2048) {
      throw new Error('node_printer.node contains an unterminated release marker');
    }
    const markerBytes = contents.subarray(start, terminator);
    if ([...markerBytes].some((byte) => byte < 0x20 || byte > 0x7e)) {
      throw new Error('node_printer.node release marker is not printable ASCII');
    }
    occurrences.push({ end: terminator + 1, marker: markerBytes.toString('ascii'), start });
    searchOffset = start + prefix.length;
  }
  return occurrences;
}

function validateEmbeddedMarker(contents, expectedMarker) {
  const sections = readPeSectionRanges(contents);
  const occurrences = markerOccurrences(contents);
  if (occurrences.length !== 1 || occurrences[0].marker !== expectedMarker) {
    throw new Error('node_printer.node must contain exactly one matching release marker');
  }
  const occurrence = occurrences[0];
  if (!sections.some((section) => (
    occurrence.start >= section.start && occurrence.end <= section.end
  ))) {
    throw new Error('node_printer.node release marker is outside Authenticode-hashed PE sections');
  }
  return occurrence;
}

function validateArtifact(manifest, artifactPath) {
  const inspected = readRegularNonLinkFile(artifactPath);
  assertUnsignedNativeAddonPe(inspected.contents);
  if (inspected.size !== manifest.artifact.size || inspected.sha256 !== manifest.artifact.sha256) {
    throw new Error('node_printer.node bytes do not match the release manifest');
  }
  validateEmbeddedMarker(inspected.contents, manifest.embeddedIdentity);
  return inspected;
}

function readCanonicalJson(filePath, label) {
  const inspected = readRegularNonLinkFile(filePath);
  let value;
  try {
    value = JSON.parse(inspected.contents.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${filePath}`, { cause: error });
  }
  if (inspected.contents.toString('utf8') !== canonicalJson(value)) {
    throw new Error(`${label} is not in canonical JSON encoding`);
  }
  return value;
}

function validateReleaseProvenance(options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : __dirname;
  const manifestPath = path.resolve(
    options.manifestPath || path.join(repoRoot, ...RELEASE_MANIFEST_PATH.split('/')),
  );
  const artifactPath = path.resolve(
    options.artifactPath || path.join(repoRoot, ...RELEASE_ARTIFACT_PATH.split('/')),
  );
  const manifest = normalizeManifest(readCanonicalJson(manifestPath, 'release manifest'));
  validateArtifact(manifest, artifactPath);
  return manifest;
}

function assertSameJson(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label} does not match`);
}

function readReleaseIdentity(repoRoot) {
  const identityPath = path.join(repoRoot, ...RELEASE_IDENTITY_PATH.split('/'));
  return normalizeIdentity(readCanonicalJson(identityPath, 'release build identity'));
}

function validatePreSignRelease(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || __dirname);
  const manifest = validateReleaseProvenance({
    repoRoot,
    artifactPath: options.artifactPath,
    manifestPath: options.manifestPath,
  });
  const source = captureReleaseSource(repoRoot, { phase: 'postbuild' });
  assertSameJson(manifest.source, source, 'Release receipt source');
  const packageVersion = readReleaseVersion(repoRoot);
  if (manifest.packageVersion !== packageVersion) {
    throw new Error('Release receipt packageVersion does not match the tracked package');
  }
  const packageLockSha256 = assertReleaseDependencyContract(repoRoot);
  if (manifest.toolchain.packageLockSha256 !== packageLockSha256) {
    throw new Error('Release receipt package-lock hash does not match the tracked lock');
  }
  const sdkValidation = validateReleaseSdkInputs(repoRoot);
  if (manifest.toolchain.nodeHeadersSha256 !== sdkValidation.headers.sha256
      || manifest.toolchain.nodeImportLibrarySha256 !== sdkValidation.importLibrary.sha256) {
    throw new Error('Release receipt Node SDK inputs do not match the pinned local inputs');
  }
  const identity = readReleaseIdentity(repoRoot);
  assertSameJson(identity, {
    schemaVersion: manifest.schemaVersion,
    role: manifest.role,
    repository: manifest.repository,
    target: manifest.target,
    architecture: manifest.architecture,
    packageVersion: manifest.packageVersion,
    buildId: manifest.buildId,
    source: manifest.source,
    toolchain: manifest.toolchain,
  }, 'Release build identity');
  const generatedHeader = readRegularNonLinkFile(path.join(
    repoRoot,
    ...RELEASE_HEADER_PATH.split('/'),
  )).contents.toString('utf8');
  if (generatedHeader !== releaseHeader(buildReleaseMarker(identity))) {
    throw new Error('Generated release marker header does not match the release identity');
  }
  return manifest;
}

function ensureOutputDirectory(repoRoot, relativeDirectory) {
  const root = fs.realpathSync.native(path.resolve(repoRoot));
  let current = root;
  for (const component of relativeDirectory.split('/').filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const entry = fs.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Release output directory is not a real directory: ${current}`);
    }
    if (!fs.realpathSync.native(current).startsWith(`${root}${path.sep}`)) {
      throw new Error(`Release output directory escapes the repository: ${current}`);
    }
  }
  return current;
}

function writeNewCanonicalFile(repoRoot, relativePath, contents) {
  const components = relativePath.split('/');
  const fileName = components.pop();
  const directory = ensureOutputDirectory(repoRoot, components.join('/'));
  const destination = path.join(directory, fileName);
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing release output: ${relativePath}`);
  }
  const temporary = path.join(
    directory,
    `.${fileName}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

function createReleaseIdentity(options) {
  const identity = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    role: RELEASE_ROLE,
    repository: RELEASE_REPOSITORY,
    target: RELEASE_TARGET,
    architecture: RELEASE_ARCHITECTURE,
    packageVersion: options.packageVersion,
    buildId: options.buildId,
    source: options.source,
    toolchain: options.toolchain,
  };
  return normalizeIdentity(identity);
}

function releaseHeader(marker) {
  if (!marker.startsWith(RELEASE_MARKER_PREFIX) || marker.includes('"') || marker.includes('\\')) {
    throw new Error('Release marker cannot be represented by the generated C++ header');
  }
  return [
    '#ifndef DMKIOSK_NODE_PRINTER_RELEASE_MARKER_GENERATED_H',
    '#define DMKIOSK_NODE_PRINTER_RELEASE_MARKER_GENERATED_H',
    `#define DMKIOSK_NODE_PRINTER_RELEASE_MARKER "${marker}"`,
    '#endif',
    '',
  ].join('\n');
}

function prepareReleaseBuild(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || __dirname);
  const source = captureReleaseSource(repoRoot, { phase: 'prepare' });
  const nodeValidation = options.nodeValidation || validateReleaseNodeExecutable();
  const toolchain = createReleaseToolchain(repoRoot, nodeValidation);
  const buildId = options.buildId || crypto.randomBytes(16).toString('hex');
  const identity = createReleaseIdentity({
    buildId,
    packageVersion: readReleaseVersion(repoRoot),
    source,
    toolchain,
  });
  const marker = buildReleaseMarker(identity);
  writeNewCanonicalFile(repoRoot, RELEASE_IDENTITY_PATH, canonicalJson(identity));
  writeNewCanonicalFile(repoRoot, RELEASE_HEADER_PATH, releaseHeader(marker));
  return { identity, marker };
}

function createReleaseManifest(identity, artifact) {
  const normalizedIdentity = normalizeIdentity(identity);
  return normalizeManifest({
    ...normalizedIdentity,
    artifact,
    embeddedIdentity: buildReleaseMarker(normalizedIdentity),
    signaturePolicy: { ...SIGNATURE_POLICY },
  });
}

function writeReleaseManifest(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || __dirname);
  const identity = readReleaseIdentity(repoRoot);
  const source = captureReleaseSource(repoRoot, { phase: 'postbuild' });
  assertSameJson(identity.source, source, 'Release build source');
  if (identity.packageVersion !== readReleaseVersion(repoRoot)) {
    throw new Error('Release build packageVersion changed after preparation');
  }
  const packageLockSha256 = assertReleaseDependencyContract(repoRoot);
  if (identity.toolchain.packageLockSha256 !== packageLockSha256) {
    throw new Error('package-lock.json changed after release preparation');
  }
  const artifactPath = path.join(repoRoot, ...RELEASE_ARTIFACT_PATH.split('/'));
  const artifact = readRegularNonLinkFile(artifactPath);
  assertUnsignedNativeAddonPe(artifact.contents);
  validateEmbeddedMarker(artifact.contents, buildReleaseMarker(identity));
  const manifest = createReleaseManifest(identity, {
    path: RELEASE_ARTIFACT_PATH,
    size: artifact.size,
    sha256: artifact.sha256,
  });
  writeNewCanonicalFile(repoRoot, RELEASE_MANIFEST_PATH, canonicalJson(manifest));
  return validatePreSignRelease({ repoRoot });
}

module.exports = {
  BUILD_ID_PATTERN,
  buildReleaseMarker,
  canonicalJson,
  captureReleaseSource,
  COMMIT_PATTERN,
  createReleaseIdentity,
  createReleaseManifest,
  normalizeIdentity,
  normalizeManifest,
  prepareReleaseBuild,
  readReleaseIdentity,
  RELEASE_ARCHITECTURE,
  RELEASE_ARTIFACT_PATH,
  RELEASE_HEADER_PATH,
  RELEASE_IDENTITY_PATH,
  RELEASE_MANIFEST_PATH,
  RELEASE_MARKER_PREFIX,
  RELEASE_ORIGIN_URL,
  RELEASE_REPOSITORY,
  RELEASE_ROLE,
  RELEASE_SCHEMA_VERSION,
  RELEASE_TARGET,
  SIGNATURE_POLICY,
  validateEmbeddedMarker,
  validatePreSignRelease,
  validateReleaseProvenance,
  writeReleaseManifest,
};
