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
try {
  const args = windows
    ? ['/nologo', '/EHsc', '/std:c++17', '/W4', '/WX', source, `/Fe:${executable}`]
    : ['-std=c++11', '-Wall', '-Wextra', '-Werror', source, '-o', executable];
  execFileSync(compiler, args, { cwd: output, stdio: 'inherit' });
  execFileSync(executable, [], { cwd: output, stdio: 'inherit' });
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
