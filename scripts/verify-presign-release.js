'use strict';

const path = require('node:path');

const { validatePreSignRelease } = require('../release-provenance');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const manifest = validatePreSignRelease({ repoRoot });
  process.stdout.write(
    `Verified unsigned node_printer.node release ${manifest.buildId}; signing remains forbidden.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
