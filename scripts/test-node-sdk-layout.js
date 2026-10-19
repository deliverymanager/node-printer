'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateMaterializedHeaderLayout } = require('./materialize-node-sdk');

test('official headers layout needs no root-level common.gypi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-node-sdk-layout-'));
  const include = path.join(root, 'include');
  const headers = path.join(include, 'node');
  const names = ['common.gypi', 'node.h', 'node_version.h'];
  try {
    fs.mkdirSync(include);
    fs.mkdirSync(headers);
    for (const name of names) fs.writeFileSync(path.join(headers, name), 'fixture\n');
    assert.equal(fs.existsSync(path.join(root, 'common.gypi')), false);
    assert.doesNotThrow(() => validateMaterializedHeaderLayout(root));
    for (const name of names) {
      fs.unlinkSync(path.join(headers, name));
      assert.throws(() => validateMaterializedHeaderLayout(root), /ENOENT/);
      fs.writeFileSync(path.join(headers, name), 'fixture\n');
    }
  } finally {
    for (const name of names) {
      const file = path.join(headers, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(headers);
    fs.rmdirSync(include);
    fs.rmdirSync(root);
  }
});
