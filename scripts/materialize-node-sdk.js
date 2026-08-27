'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const {
  REQUIRED_NODE_HEADERS_INPUT,
  REQUIRED_NODE_HEADERS_SHA256,
  REQUIRED_NODE_HEADERS_URL,
  REQUIRED_NODE_IMPORT_LIBRARY_INPUT,
  REQUIRED_NODE_IMPORT_LIBRARY_SHA256,
  REQUIRED_NODE_IMPORT_LIBRARY_URL,
  readRegularNonLinkFile,
  validateReleaseSdkInputs,
} = require('../release-build-policy');

const SDK_RELATIVE_PATH = 'build/release/node-sdk';
const ARCHIVE_COPY_RELATIVE_PATH = REQUIRED_NODE_HEADERS_INPUT;
const MAX_ARCHIVE_ENTRIES = 20000;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HEADERS_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_LIBRARY_DOWNLOAD_BYTES = 128 * 1024 * 1024;

function validateDownloadedBytes(label, contents, expectedSha256, maximumBytes) {
  if (!Buffer.isBuffer(contents) || contents.length <= 0 || contents.length > maximumBytes) {
    throw new Error(`${label} download size is outside the release limit`);
  }
  const actualSha256 = crypto.createHash('sha256').update(contents).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} SHA-256 is ${actualSha256}; expected ${expectedSha256}`);
  }
  return contents;
}

function validateDownloadResponse(statusCode, headers, maximumBytes) {
  if (statusCode !== 200) {
    throw new Error(`Pinned Node SDK download returned HTTP ${statusCode}`);
  }
  if (headers.location
      || (headers['content-encoding']
        && String(headers['content-encoding']).toLowerCase() !== 'identity')) {
    throw new Error('Pinned Node SDK download redirected or changed content encoding');
  }
  const lengthHeader = headers['content-length'];
  if (lengthHeader === undefined) return 0;
  if (Array.isArray(lengthHeader) || !/^[1-9]\d*$/.test(String(lengthHeader))) {
    throw new Error('Pinned Node SDK download Content-Length is invalid');
  }
  const declaredLength = Number(lengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
    throw new Error('Pinned Node SDK download Content-Length is invalid');
  }
  return declaredLength;
}

function downloadPinnedFile(url, expectedSha256, maximumBytes, requestImpl = https.get) {
  const parsed = new URL(url);
  if (![REQUIRED_NODE_HEADERS_URL, REQUIRED_NODE_IMPORT_LIBRARY_URL].includes(url)
      || parsed.protocol !== 'https:' || parsed.hostname !== 'nodejs.org' || parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Pinned Node SDK URL is not canonical: ${url}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    const request = requestImpl(parsed, {
      agent: false,
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'dmkiosk-node-printer-release-v1' },
      method: 'GET',
    }, (response) => {
      let declaredLength;
      try {
        declaredLength = validateDownloadResponse(
          response.statusCode,
          response.headers,
          maximumBytes,
        );
      } catch (error) {
        response.resume();
        finish(reject, error);
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maximumBytes) {
          response.destroy(new Error('Pinned Node SDK download exceeded the release limit'));
          return;
        }
        chunks.push(bytes);
      });
      response.once('aborted', () => finish(reject, new Error('Pinned Node SDK download aborted')));
      response.once('error', (error) => finish(reject, error));
      response.once('end', () => {
        try {
          const contents = Buffer.concat(chunks, received);
          if (declaredLength && contents.length !== declaredLength) {
            throw new Error('Pinned Node SDK download length does not match Content-Length');
          }
          finish(resolve, validateDownloadedBytes(
            parsed.pathname,
            contents,
            expectedSha256,
            maximumBytes,
          ));
        } catch (error) {
          finish(reject, error);
        }
      });
    });
    request.once('error', (error) => finish(reject, error));
    request.setTimeout(30000, () => request.destroy(new Error('Pinned Node SDK download timed out')));
  });
}

function canonicalArchiveEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath || entryPath.includes('\\')
      || entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) {
    throw new Error(`Node headers archive path is not canonical: ${entryPath}`);
  }
  const components = entryPath.replace(/\/$/, '').split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new Error(`Node headers archive path has an unsafe component: ${entryPath}`);
  }
  if (components.shift() !== 'node-v24.19.0') {
    throw new Error(`Node headers archive has an unexpected root: ${entryPath}`);
  }
  return components.join('/');
}

function validateArchiveEntry(entry, state) {
  const type = entry.type;
  if (!['Directory', 'File', 'OldFile'].includes(type)) {
    throw new Error(`Node headers archive entry type is not allowed: ${type}`);
  }
  const relativePath = canonicalArchiveEntryPath(entry.path);
  if (!relativePath) {
    if (type !== 'Directory') throw new Error('Node headers archive root must be a directory');
    return '';
  }
  const comparisonPath = relativePath.toLowerCase();
  if (state.paths.has(comparisonPath)) {
    throw new Error(`Node headers archive has a duplicate/case-colliding path: ${relativePath}`);
  }
  state.paths.add(comparisonPath);
  state.entries += 1;
  if (state.entries > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Node headers archive has too many entries');
  }
  if (type !== 'Directory') {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error(`Node headers archive file size is invalid: ${relativePath}`);
    }
    state.bytes += entry.size;
    if (state.bytes > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error('Node headers archive expands beyond the release limit');
    }
  }
  return relativePath;
}

function newArchiveState() {
  return { bytes: 0, entries: 0, paths: new Set() };
}

function inspectOutputTree(root) {
  const fingerprint = crypto.createHash('sha256');
  const paths = [];
  function visit(directory, relativeDirectory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) throw new Error(`Materialized Node SDK contains a link: ${relative}`);
      if (entry.isDirectory()) {
        paths.push({ relative, type: 'directory' });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const inspected = readRegularNonLinkFile(absolute);
        paths.push({ relative, sha256: inspected.sha256, size: inspected.size, type: 'file' });
      } else {
        throw new Error(`Materialized Node SDK contains an unsupported entry: ${relative}`);
      }
    }
  }
  visit(root, '');
  const collisions = new Set();
  for (const entry of paths) {
    const folded = entry.relative.toLowerCase();
    if (collisions.has(folded)) {
      throw new Error(`Materialized Node SDK has a case-colliding path: ${entry.relative}`);
    }
    collisions.add(folded);
    fingerprint.update(entry.type, 'ascii');
    fingerprint.update('\0', 'ascii');
    fingerprint.update(entry.relative, 'utf8');
    fingerprint.update('\0', 'ascii');
    if (entry.type === 'file') {
      fingerprint.update(String(entry.size), 'ascii');
      fingerprint.update('\0', 'ascii');
      fingerprint.update(entry.sha256, 'ascii');
      fingerprint.update('\0', 'ascii');
    }
  }
  return fingerprint.digest('hex');
}

function assertReleaseDirectory(repoRoot) {
  const repository = fs.realpathSync.native(path.resolve(repoRoot));
  const releaseDirectory = path.join(repository, 'build', 'release');
  const entry = fs.lstatSync(releaseDirectory);
  if (!entry.isDirectory() || entry.isSymbolicLink()
      || fs.realpathSync.native(releaseDirectory) !== releaseDirectory) {
    throw new Error('Release output directory must be a real canonical directory');
  }
  return { releaseDirectory, repository };
}

function consumeTarBytes(stream, contents, completionEvent) {
  if (!stream || typeof stream.once !== 'function' || typeof stream.end !== 'function') {
    throw new Error('Pinned tar implementation did not return a byte-stream parser');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    stream.once('error', (error) => finish(reject, error));
    stream.once(completionEvent, () => finish(resolve));
    stream.end(contents);
  });
}

async function materializePinnedNodeSdk(repoRoot) {
  const { releaseDirectory, repository } = assertReleaseDirectory(repoRoot);
  const archiveCopy = path.join(repository, ...ARCHIVE_COPY_RELATIVE_PATH.split('/'));
  const importLibraryCopy = path.join(
    repository,
    ...REQUIRED_NODE_IMPORT_LIBRARY_INPUT.split('/'),
  );
  const sdkRoot = path.join(repository, ...SDK_RELATIVE_PATH.split('/'));
  if (path.dirname(archiveCopy) !== releaseDirectory
      || path.dirname(importLibraryCopy) !== releaseDirectory
      || fs.existsSync(archiveCopy) || fs.existsSync(importLibraryCopy) || fs.existsSync(sdkRoot)) {
    throw new Error('Refusing to overwrite an existing materialized Node SDK');
  }
  const [headersContents, importLibraryContents] = await Promise.all([
    downloadPinnedFile(
      REQUIRED_NODE_HEADERS_URL,
      REQUIRED_NODE_HEADERS_SHA256,
      MAX_HEADERS_DOWNLOAD_BYTES,
    ),
    downloadPinnedFile(
      REQUIRED_NODE_IMPORT_LIBRARY_URL,
      REQUIRED_NODE_IMPORT_LIBRARY_SHA256,
      MAX_IMPORT_LIBRARY_DOWNLOAD_BYTES,
    ),
  ]);
  fs.writeFileSync(archiveCopy, headersContents, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(importLibraryCopy, importLibraryContents, { flag: 'wx', mode: 0o600 });
  const sdkValidation = validateReleaseSdkInputs(repoRoot);
  if (!sdkValidation.headers.contents.equals(headersContents)
      || !sdkValidation.importLibrary.contents.equals(importLibraryContents)) {
    throw new Error('Pinned Node SDK copies differ from the validated download snapshot');
  }
  fs.mkdirSync(sdkRoot, { mode: 0o700 });

  // Loaded only on the real Windows build lane, after exact-lock `npm ci` validation.
  // Source tests remain dependency-free and never extract or build native artifacts.
  const tar = require('tar'); // eslint-disable-line global-require
  const inspectionState = newArchiveState();
  await consumeTarBytes(tar.t({
    onentry: (entry) => validateArchiveEntry(entry, inspectionState),
    strict: true,
  }), headersContents, 'end');
  const extractionState = newArchiveState();
  await consumeTarBytes(tar.x({
    cwd: sdkRoot,
    filter: (_entryPath, entry) => {
      validateArchiveEntry(entry, extractionState);
      return true;
    },
    noChmod: true,
    preservePaths: false,
    strict: true,
    strip: 1,
  }), headersContents, 'close');
  if (inspectionState.entries !== extractionState.entries
      || inspectionState.bytes !== extractionState.bytes) {
    throw new Error('Node headers archive inspection/extraction entry sets disagree');
  }

  const x64Directory = path.join(sdkRoot, 'x64');
  if (!fs.existsSync(x64Directory)) fs.mkdirSync(x64Directory, { mode: 0o700 });
  const nodeLibPath = path.join(x64Directory, 'node.lib');
  fs.writeFileSync(nodeLibPath, importLibraryContents, { flag: 'wx', mode: 0o600 });
  if (readRegularNonLinkFile(nodeLibPath).sha256 !== REQUIRED_NODE_IMPORT_LIBRARY_SHA256) {
    throw new Error('Materialized x64 node.lib changed after validation');
  }
  for (const required of ['common.gypi', 'include/node/node.h', 'include/node/node_version.h']) {
    readRegularNonLinkFile(path.join(sdkRoot, ...required.split('/')));
  }
  const closingSdkValidation = validateReleaseSdkInputs(repoRoot);
  if (!closingSdkValidation.headers.contents.equals(headersContents)
      || !closingSdkValidation.importLibrary.contents.equals(importLibraryContents)) {
    throw new Error('Pinned Node SDK inputs changed during in-memory materialization');
  }
  const treeSha256 = inspectOutputTree(sdkRoot);
  return { sdkRoot, treeSha256 };
}

function verifyMaterializedNodeSdk(sdkRoot, expectedTreeSha256) {
  const root = fs.realpathSync.native(path.resolve(sdkRoot));
  const actualTreeSha256 = inspectOutputTree(root);
  if (actualTreeSha256 !== expectedTreeSha256) {
    throw new Error('Materialized Node SDK changed during the release build');
  }
  return actualTreeSha256;
}

module.exports = {
  ARCHIVE_COPY_RELATIVE_PATH,
  canonicalArchiveEntryPath,
  consumeTarBytes,
  downloadPinnedFile,
  materializePinnedNodeSdk,
  SDK_RELATIVE_PATH,
  validateArchiveEntry,
  validateDownloadedBytes,
  validateDownloadResponse,
  verifyMaterializedNodeSdk,
};
