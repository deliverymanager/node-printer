'use strict';

const path = require('node:path');

const { prepareReleaseBuild } = require('../release-provenance');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const prepared = prepareReleaseBuild({ repoRoot });
  process.stdout.write(
    `Prepared unsigned node_printer.node release identity ${prepared.identity.buildId}.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
