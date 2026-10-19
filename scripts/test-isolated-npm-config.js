'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedNpmConfig } = require('./isolated-npm-config');

test('npm accepts distinct empty config files and cleanup follows success', () => {
  let inspected;
  const result = withIsolatedNpmConfig((config) => {
    inspected = config;
    assert.notEqual(config.user, config.global);
    assert.equal(fs.readFileSync(config.user, 'utf8'), '');
    assert.equal(fs.readFileSync(config.global, 'utf8'), '');
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const registry = execFileSync(process.execPath, [npm, 'config', 'get', 'registry',
      `--userconfig=${config.user}`, `--globalconfig=${config.global}`, '--registry=https://registry.npmjs.org/'],
    { encoding: 'utf8', windowsHide: true });
    assert.equal(registry.trim(), 'https://registry.npmjs.org/');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(path.dirname(inspected.user)), false);
});

test('a failed npm command remains a failure and its config files are removed', () => {
  let inspected;
  const failure = new Error('controlled npm failure');
  assert.throws(() => withIsolatedNpmConfig((config) => {
    inspected = config;
    throw failure;
  }), (error) => error === failure);
  assert.equal(fs.existsSync(path.dirname(inspected.user)), false);
});
