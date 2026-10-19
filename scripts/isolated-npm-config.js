'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// npm rejects the same file as both user and global config, including NUL on
// Windows. Distinct empty files exclude ambient credentials and configuration.
function withIsolatedNpmConfig(run) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'node-printer-npm-'));
  const files = ['user.npmrc', 'global.npmrc'].map((name) => path.join(directory, name));
  try {
    for (const file of files) fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    return run({ user: files[0], global: files[1] });
  } finally {
    for (const file of files) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.rmdirSync(directory);
  }
}

module.exports = { withIsolatedNpmConfig };
