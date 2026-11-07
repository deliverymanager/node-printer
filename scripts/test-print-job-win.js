'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'node-printer-print-job-'));
const source = path.join(root, 'test', 'print-job-win.cc');
const windows = process.platform === 'win32';
const executable = path.join(output, windows ? 'print-job-test.exe' : 'print-job-test');
const compiler = process.env.CXX || (windows ? 'cl.exe' : 'c++');
async function main() {
  try {
    const args = windows
      ? ['/nologo', '/EHsc', '/std:c++17', '/W4', '/WX', source,
        `/Fo:${path.join(output, 'print-job-test.obj')}`, `/Fe:${executable}`]
      : ['-std=c++11', '-Wall', '-Wextra', '-Werror', source, '-o', executable];
    // Windows child processes must not hold the directory being removed as cwd.
    const cwd = windows ? root : output;
    execFileSync(compiler, args, { cwd, stdio: 'inherit' });
    execFileSync(executable, [], { cwd, stdio: 'inherit' });
  } finally {
    // Yield while Windows releases child-process handles; retain cleanup failures.
    await fs.promises.rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
