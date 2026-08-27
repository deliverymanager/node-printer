'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_BUILD_POLICY_VERSION = 'dmkiosk-node-printer-release/v1';
const REQUIRED_NODE_VERSION = '24.19.0';
const REQUIRED_NODE_MODULES_ABI = '137';
const REQUIRED_NODE_PLATFORM = 'win32';
const REQUIRED_NODE_ARCH = 'x64';
const REQUIRED_NPM_VERSION = '11.17.0';
const REQUIRED_NODE_SHA256 = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const REQUIRED_NODE_HEADERS_SHA256 = '54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c';
const REQUIRED_NODE_IMPORT_LIBRARY_SHA256 = '63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9';
const REQUIRED_NODE_HEADERS_URL = 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-headers.tar.gz';
const REQUIRED_NODE_IMPORT_LIBRARY_URL = 'https://nodejs.org/download/release/v24.19.0/win-x64/node.lib';
const REQUIRED_NODE_HEADERS_INPUT = 'build/release/pinned-node-v24.19.0-headers.tar.gz';
const REQUIRED_NODE_IMPORT_LIBRARY_INPUT = 'build/release/pinned-win-x64-node.lib';
const REQUIRED_MSVC_PLATFORM_TOOLSET = 'v143';
const REQUIRED_DEPENDENCIES = Object.freeze({
  nan: Object.freeze({
    version: '2.24.0',
    resolved: 'https://registry.npmjs.org/nan/-/nan-2.24.0.tgz',
    integrity: 'sha512-Vpf9qnVW1RaDkoNKFUvfxqAbtI8ncb8OJlqZ9wwpXzWPEsvsB1nvdUi6oYrHIkQ1Y/tMDnr1h4nczS0VB9Xykg==',
  }),
  'node-gyp': Object.freeze({
    version: '9.4.1',
    resolved: 'https://registry.npmjs.org/node-gyp/-/node-gyp-9.4.1.tgz',
    integrity: 'sha512-OQkWKbjQKbGkMf/xqI1jjy3oCTgMKJac58G2+bjZb3fza6gW2YrCSdMQYaoTb70crvE//Gngr4f0AgVHmqHvBQ==',
  }),
  'node-pre-gyp': Object.freeze({
    version: '0.14.0',
    resolved: 'https://registry.npmjs.org/node-pre-gyp/-/node-pre-gyp-0.14.0.tgz',
    integrity: 'sha512-+CvDC7ZttU/sSt9rFjix/P05iS43qHCOOGzcr3Ry99bXG7VX953+vFyEuph/tfqoYu8dttBkE86JSKBO2OzcxA==',
  }),
  tar: Object.freeze({
    version: '6.2.1',
    resolved: 'https://registry.npmjs.org/tar/-/tar-6.2.1.tgz',
    integrity: 'sha512-DZ4yORTwrbTj/7MZYq2w+/ZFdI6OZ/f9SFHR+71gIVUZhOQPHzVCLpvRnPgyaMpfWxxk/4ONva3GQSyNIKRv6A==',
  }),
});
const PROHIBITED_RELEASE_ENV = Object.freeze([
  'CC',
  'CL',
  'CPP',
  'CXX',
  'GYP_DEFINES',
  'GYP_MSVS_OVERRIDE_PATH',
  'INCLUDE',
  'LIB',
  'LIBPATH',
  'LINK',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_LIFECYCLE_EVENT',
  'PYTHON',
  'PYTHONHOME',
  'PYTHONPATH',
  'SIGN_EXE',
  'PlatformToolset',
  'PreferredToolArchitecture',
  'UniversalCRTSdkDir',
  'UCRTVersion',
  'VCINSTALLDIR',
  'VCToolsInstallDir',
  'VSCMD_ARG_HOST_ARCH',
  'VSCMD_ARG_TGT_ARCH',
  'VSCMD_VER',
  'VisualStudioVersion',
  'WindowsSdkDir',
  'WindowsSDKVersion',
  'npm_config_arch',
  'npm_config_cafile',
  'npm_config_debug',
  'npm_config_devdir',
  'npm_config_directory',
  'npm_config_disturl',
  'npm_config_ensure',
  'npm_config_force_process_config',
  'npm_config_make',
  'npm_config_msvs_version',
  'npm_config_nodedir',
  'npm_config_node_gyp',
  'npm_config_python',
  'npm_config_release',
  'npm_config_runtime',
  'npm_config_solution',
  'npm_config_tarball',
  'npm_config_target',
  'npm_config_thin',
  'NODE_GYP_FORCE_PYTHON',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function normalizePathForComparison(filePath, platform = process.platform) {
  let normalized = path.resolve(filePath);
  if (platform === 'win32' && normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.size !== right.size || left.nlink !== right.nlink) return false;
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  return true;
}

function readRegularNonLinkFile(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const resolved = path.resolve(filePath);
  const before = fsImpl.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Release input must be a regular non-link file: ${resolved}`);
  }
  if (before.nlink !== 1) {
    throw new Error(`Release input must not have hardlink aliases: ${resolved}`);
  }
  const realpath = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (normalizePathForComparison(realpath, platform)
      !== normalizePathForComparison(resolved, platform)) {
    throw new Error(`Release input final path is not canonical: ${resolved} -> ${realpath}`);
  }

  let descriptor;
  let descriptorStat;
  let contents;
  try {
    const noFollow = fsImpl.constants.O_NOFOLLOW || 0;
    descriptor = fsImpl.openSync(resolved, fsImpl.constants.O_RDONLY | noFollow);
    descriptorStat = fsImpl.fstatSync(descriptor);
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1
        || !sameFileIdentity(before, descriptorStat)) {
      throw new Error(`Release input changed before it was opened: ${resolved}`);
    }
    contents = fsImpl.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }

  const after = fsImpl.lstatSync(resolved);
  const finalRealpath = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
      || !sameFileIdentity(descriptorStat, after)
      || contents.length !== descriptorStat.size
      || normalizePathForComparison(finalRealpath, platform)
        !== normalizePathForComparison(resolved, platform)) {
    throw new Error(`Release input changed while it was read: ${resolved}`);
  }
  return { contents, path: resolved, sha256: sha256(contents), size: contents.length };
}

function assertVisibleReleaseLaunchState(options = {}) {
  const environment = options.environment || process.env;
  const execArgv = options.execArgv || process.execArgv;
  const present = Object.keys(environment).filter((name) => (
    PROHIBITED_RELEASE_ENV.some((expected) => name.toLowerCase() === expected.toLowerCase())
      || /^GYP_/i.test(name)
  ));
  if (present.length > 0) {
    throw new Error(`Release process exposes prohibited variables: ${present.join(', ')}`);
  }
  if (!Array.isArray(execArgv) || execArgv.length !== 0) {
    throw new Error('Release process must start without Node CLI injection arguments');
  }
  return true;
}

function createReleaseChildEnvironment(environment = process.env) {
  assertVisibleReleaseLaunchState({ environment, execArgv: [] });
  const childEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    const isToolchainOverride = PROHIBITED_RELEASE_ENV.some(
      (expected) => name.toLowerCase() === expected.toLowerCase(),
    );
    if (!/^GIT_/i.test(name)
        && !/^GYP_/i.test(name)
        && !/^npm_/i.test(name)
        && !isToolchainOverride) {
      childEnvironment[name] = value;
    }
  }
  childEnvironment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  childEnvironment.GIT_CONFIG_NOSYSTEM = '1';
  childEnvironment.GIT_NO_REPLACE_OBJECTS = '1';
  childEnvironment.GIT_OPTIONAL_LOCKS = '0';
  childEnvironment.GIT_TERMINAL_PROMPT = '0';
  return childEnvironment;
}

function readPeHeader(contents, options = {}) {
  const label = options.label || 'Release PE';
  if (!Buffer.isBuffer(contents) || contents.length < 0x40
      || contents.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${label} is not a PE image`);
  }
  const peOffset = contents.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > contents.length
      || contents.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${label} has an invalid PE header`);
  }
  const machine = contents.readUInt16LE(peOffset + 4);
  const sectionCount = contents.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = contents.readUInt16LE(peOffset + 20);
  const characteristics = contents.readUInt16LE(peOffset + 22);
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderSize;
  if (machine !== 0x8664) throw new Error(`${label} Machine must be AMD64 (0x8664)`);
  if (sectionCount < 1 || sectionCount > 96) throw new Error(`${label} section count is invalid`);
  if ((characteristics & 0x0002) === 0) throw new Error(`${label} is not executable`);
  if (options.requireDll && (characteristics & 0x2000) === 0) {
    throw new Error(`${label} is not a DLL`);
  }
  if (optionalHeaderSize !== 0xf0 || optionalHeaderEnd > contents.length) {
    throw new Error(`${label} has a truncated optional header`);
  }
  const magic = contents.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x20b) throw new Error(`${label} must be PE32+ (0x20b)`);
  return {
    characteristics,
    machine,
    optionalHeaderEnd,
    optionalHeaderOffset,
    optionalHeaderSize,
    peOffset,
    sectionCount,
  };
}

function readPeDataDirectory(contents, header, index, label) {
  const countOffset = header.optionalHeaderOffset + 108;
  const directoriesOffset = header.optionalHeaderOffset + 112;
  if (countOffset + 4 > header.optionalHeaderEnd) {
    throw new Error(`${label} omits the PE data-directory count`);
  }
  const count = contents.readUInt32LE(countOffset);
  if (count <= index) return { size: 0, start: 0 };
  const offset = directoriesOffset + (index * 8);
  if (offset + 8 > header.optionalHeaderEnd) {
    throw new Error(`${label} truncates PE data directory ${index}`);
  }
  return { start: contents.readUInt32LE(offset), size: contents.readUInt32LE(offset + 4) };
}

function assertUnsignedNativeAddonPe(contents) {
  const label = 'node_printer.node';
  const header = readPeHeader(contents, { label, requireDll: true });
  const directoryCount = contents.readUInt32LE(header.optionalHeaderOffset + 108);
  if (directoryCount !== 16) {
    throw new Error(`${label} must expose the canonical 16 PE data directories`);
  }
  const certificate = readPeDataDirectory(contents, header, 4, label);
  if (certificate.start !== 0 || certificate.size !== 0) {
    throw new Error(`${label} must remain unsigned (certificate table is non-empty)`);
  }
  const clr = readPeDataDirectory(contents, header, 14, label);
  if (clr.start !== 0 || clr.size !== 0) {
    throw new Error(`${label} must be a native addon, not a CLR assembly`);
  }
  return header;
}

function readPeSectionRanges(contents) {
  const header = assertUnsignedNativeAddonPe(contents);
  const sectionTableOffset = header.optionalHeaderOffset + header.optionalHeaderSize;
  if (sectionTableOffset + (header.sectionCount * 40) > contents.length) {
    throw new Error('node_printer.node has a truncated section table');
  }
  const ranges = [];
  for (let index = 0; index < header.sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + (index * 40);
    const size = contents.readUInt32LE(sectionOffset + 16);
    const start = contents.readUInt32LE(sectionOffset + 20);
    if (size === 0) continue;
    const end = start + size;
    if (start < sectionTableOffset + (header.sectionCount * 40)
        || end < start || end > contents.length) {
      throw new Error(`node_printer.node section ${index} has an invalid raw-data range`);
    }
    ranges.push({ end, start });
  }
  if (ranges.length === 0) throw new Error('node_printer.node has no non-empty PE sections');
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
    throw new Error('node_printer.node has overlapping PE raw-data sections');
  }
  return ranges;
}

function readJson(filePath, label) {
  const inspected = readRegularNonLinkFile(filePath);
  try {
    return JSON.parse(inspected.contents.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${filePath}`, { cause: error });
  }
}

function readReleaseVersion(repoRoot) {
  const pkg = readJson(path.join(repoRoot, 'package.json'), 'package.json');
  const lock = readJson(path.join(repoRoot, 'package-lock.json'), 'package-lock.json');
  if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version || ''))) {
    throw new Error('package.json release version is invalid');
  }
  if (lock.name !== pkg.name || lock.version !== pkg.version || lock.lockfileVersion !== 3
      || !lock.packages || !lock.packages[''] || lock.packages[''].version !== pkg.version) {
    throw new Error('package-lock.json root identity does not match package.json');
  }
  return pkg.version;
}

function assertReleaseDependencyContract(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const pkg = readJson(packagePath, 'package.json');
  const lock = readJson(lockPath, 'package-lock.json');
  readReleaseVersion(repoRoot);
  const requiredNames = Object.keys(REQUIRED_DEPENDENCIES).sort();
  if (!pkg.dependencies
      || Object.keys(pkg.dependencies).sort().join('\0') !== requiredNames.join('\0')
      || !lock.packages[''].dependencies
      || Object.keys(lock.packages[''].dependencies).sort().join('\0') !== requiredNames.join('\0')) {
    throw new Error('Release dependency names are not the exact canonical set');
  }
  for (const [name, expected] of Object.entries(REQUIRED_DEPENDENCIES)) {
    if (!pkg.dependencies || pkg.dependencies[name] !== expected.version
        || !lock.packages[''].dependencies
        || lock.packages[''].dependencies[name] !== expected.version) {
      throw new Error(`Release dependency ${name} must be exactly ${expected.version}`);
    }
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || entry.version !== expected.version || entry.resolved !== expected.resolved
        || entry.integrity !== expected.integrity) {
      throw new Error(`package-lock.json entry for ${name} is not canonical`);
    }
  }
  return sha256(readRegularNonLinkFile(lockPath).contents);
}

function assertInstalledReleaseDependencies(repoRoot) {
  for (const [name, expected] of Object.entries(REQUIRED_DEPENDENCIES)) {
    const packagePath = path.join(repoRoot, 'node_modules', name, 'package.json');
    const installed = readJson(packagePath, `${name} installed package`);
    if (installed.name !== name || installed.version !== expected.version) {
      throw new Error(`Installed release dependency ${name} must be exactly ${expected.version}`);
    }
  }
  readRegularNonLinkFile(path.join(repoRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
  readRegularNonLinkFile(path.join(repoRoot, 'node_modules', 'nan', 'nan.h'));
  return true;
}

function validateReleaseNodeExecutable(options = {}) {
  const version = String(options.version || process.versions.node).replace(/^v/, '');
  const modulesAbi = String(options.modulesAbi || process.versions.modules || '');
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const execPath = options.execPath || process.execPath;
  assertVisibleReleaseLaunchState({
    environment: options.environment || process.env,
    execArgv: options.execArgv || process.execArgv,
  });
  if (version !== REQUIRED_NODE_VERSION || modulesAbi !== REQUIRED_NODE_MODULES_ABI
      || platform !== REQUIRED_NODE_PLATFORM || arch !== REQUIRED_NODE_ARCH) {
    throw new Error(
      `Release build requires Node ${REQUIRED_NODE_VERSION} ABI ${REQUIRED_NODE_MODULES_ABI} win32/x64; got ${version} ABI ${modulesAbi} ${platform}/${arch}`,
    );
  }
  const inspected = readRegularNonLinkFile(execPath, {
    fsImpl: options.fsImpl,
    platform,
  });
  readPeHeader(inspected.contents, { label: 'Release Node executable' });
  if (inspected.sha256 !== REQUIRED_NODE_SHA256) {
    throw new Error(
      `Release Node SHA-256 is ${inspected.sha256}; expected ${REQUIRED_NODE_SHA256}`,
    );
  }
  return { ...inspected, arch, modulesAbi, platform, version };
}

function validateReleaseSdkInputs(repoRoot) {
  const headers = readRegularNonLinkFile(path.join(
    repoRoot,
    ...REQUIRED_NODE_HEADERS_INPUT.split('/'),
  ));
  if (headers.sha256 !== REQUIRED_NODE_HEADERS_SHA256) {
    throw new Error(
      `Node headers archive SHA-256 is ${headers.sha256}; expected ${REQUIRED_NODE_HEADERS_SHA256}`,
    );
  }
  const importLibrary = readRegularNonLinkFile(path.join(
    repoRoot,
    ...REQUIRED_NODE_IMPORT_LIBRARY_INPUT.split('/'),
  ));
  if (importLibrary.sha256 !== REQUIRED_NODE_IMPORT_LIBRARY_SHA256) {
    throw new Error(
      `Node x64 import library SHA-256 is ${importLibrary.sha256}; expected ${REQUIRED_NODE_IMPORT_LIBRARY_SHA256}`,
    );
  }
  return { headers, importLibrary };
}

function createReleaseToolchain(repoRoot, nodeValidation) {
  if (!nodeValidation || nodeValidation.version !== REQUIRED_NODE_VERSION
      || nodeValidation.modulesAbi !== REQUIRED_NODE_MODULES_ABI
      || nodeValidation.platform !== REQUIRED_NODE_PLATFORM
      || nodeValidation.arch !== REQUIRED_NODE_ARCH
      || nodeValidation.sha256 !== REQUIRED_NODE_SHA256) {
    throw new Error('Pinned release Node validation is required');
  }
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
    packageLockSha256: assertReleaseDependencyContract(repoRoot),
    nodeGypVersion: REQUIRED_DEPENDENCIES['node-gyp'].version,
    nanVersion: REQUIRED_DEPENDENCIES.nan.version,
    nodePreGypVersion: REQUIRED_DEPENDENCIES['node-pre-gyp'].version,
    tarVersion: REQUIRED_DEPENDENCIES.tar.version,
    msvcPlatformToolset: REQUIRED_MSVC_PLATFORM_TOOLSET,
  };
}

function normalizeReleaseToolchain(toolchain) {
  const expected = {
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
    nodeGypVersion: REQUIRED_DEPENDENCIES['node-gyp'].version,
    nanVersion: REQUIRED_DEPENDENCIES.nan.version,
    nodePreGypVersion: REQUIRED_DEPENDENCIES['node-pre-gyp'].version,
    tarVersion: REQUIRED_DEPENDENCIES.tar.version,
    msvcPlatformToolset: REQUIRED_MSVC_PLATFORM_TOOLSET,
  };
  const keys = [...Object.keys(expected), 'packageLockSha256'].sort();
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)
      || Object.keys(toolchain).sort().join('\0') !== keys.join('\0')) {
    throw new Error('Release toolchain fields are not the exact canonical set');
  }
  for (const [name, value] of Object.entries(expected)) {
    if (toolchain[name] !== value) throw new Error(`Release toolchain ${name} must be ${value}`);
  }
  if (!SHA256_PATTERN.test(toolchain.packageLockSha256)) {
    throw new Error('Release toolchain packageLockSha256 is invalid');
  }
  return { ...toolchain };
}

module.exports = {
  assertInstalledReleaseDependencies,
  assertReleaseDependencyContract,
  assertUnsignedNativeAddonPe,
  assertVisibleReleaseLaunchState,
  createReleaseChildEnvironment,
  createReleaseToolchain,
  normalizeReleaseToolchain,
  readPeHeader,
  readPeSectionRanges,
  readRegularNonLinkFile,
  readReleaseVersion,
  RELEASE_BUILD_POLICY_VERSION,
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
  SHA256_PATTERN,
  sha256,
  validateReleaseNodeExecutable,
  validateReleaseSdkInputs,
};
