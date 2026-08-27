'use strict';

const path = require('node:path');

const { writeReleaseManifest } = require('../release-provenance');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const manifest = writeReleaseManifest({ repoRoot });
  process.stdout.write(
    `Wrote verified unsigned node_printer.node receipt ${manifest.buildId}.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release receipt write failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
