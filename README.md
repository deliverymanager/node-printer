node-printer
============
Native bind printers on POSIX and Windows OS from Node.js, iojs and node-webkit.
<table>
  <thead>
    <tr>
      <th>Linux</th>
      <th>Windows</th>
      <th>Dependencies</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center">
        <a href="https://travis-ci.org/tojocky/node-printer"><img src="https://travis-ci.org/tojocky/node-printer.svg?branch=master"></a>
      </td>
      <td align="center">
        <a href="https://ci.appveyor.com/project/tojocky/node-printer"><img src="https://ci.appveyor.com/api/projects/status/9y800f36wla35ee7?svg=true"></a>
      </td>
      <td align="center">
        <a href="https://david-dm.org/tojocky/node-printer"><img src="https://david-dm.org/tojocky/node-printer.svg"></a>
      </td>
    </tr>
  </tbody>
</table>

If you have a problem, ask question to [![Gitter](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/tojocky/node-printer?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge) or find/create a new [Github issue](https://github.com/tojocky/node-printer/issues)

### Reason:

I was involved in a project where I need to print from Node.JS. This is the reason why I created this project and I want to share my code with others.


### Features:

* no dependecies;
* native method wrappers from Windows  and POSIX (which uses [CUPS 1.4/MAC OS X 10.6](http://cups.org/)) APIs;
* compatible with node v0.8.x, 0.9.x and v0.11.x (with 0.11.9 and 0.11.13);
* compatible with node-webkit v0.8.x and 0.9.2;
* `getPrinters()` to enumerate all installed printers with current jobs and statuses;
* `getPrinter(printerName)` to get a specific/default printer info with current jobs and statuses;
* `getPrinterDriverOptions(printerName)` ([POSIX](http://en.wikipedia.org/wiki/POSIX) only) to get a specific/default printer driver options such as supported paper size and other info
* `getSelectedPaperSize(printerName)` ([POSIX](http://en.wikipedia.org/wiki/POSIX) only) to get a specific/default printer default paper size from its driver options
* `getDefaultPrinterName()` return the default printer name;
* `printDirect(options)` to send a job to a specific/default printer, now supports [CUPS options](http://www.cups.org/documentation.php/options.html) passed in the form of a JS object (see `cancelJob.js` example). To print a PDF from windows it is possible by using [node-pdfium module](https://github.com/tojocky/node-pdfium) to convert a PDF format into EMF and after to send to printer as EMF;
* `printFile(options)`  ([POSIX](http://en.wikipedia.org/wiki/POSIX) only) to print a file;
* `getSupportedPrintFormats()` to get all possible print formats for printDirect method which depends on OS. `RAW` and `TEXT` are supported from all OS-es;
* `getJob(printerName, jobId)` to get a specific job info including job status;
* `setJob(printerName, jobId, command)` to send a command to a job (e.g. `'CANCEL'` to cancel the job);
* `getSupportedJobCommands()` to get supported job commands for setJob() depends on OS. `'CANCEL'` command is supported from all OS-es.


### How to install:
Make sure you have Python 2.x installed on your system. Windows users will also require Visual Studio (2013 Express is a good fit)

from [npmjs.org](https://www.npmjs.org/package/printer)

#### Prebuilt node builds
```
npm install printer --target_arch=ia32
npm install printer --target_arch=x64
```

#### Prebuilt electron builds
Say you are installing 1.4.5 electron. Please check the [Releases](https://github.com/tojocky/node-printer/releases) for supported Electron versions
```
npm install printer --runtime=electron --target=1.4.5 --target_arch=x64
npm install printer --runtime=electron --target=1.4.5 --target_arch=ia32
```

#### For building after install
```
npm install -g node-gyp
npm install printer --msvs_version=2013  --build-from-source=node_printer
```

#### Building from source with Node LTS (Node 24)

Ordinary development builds can still use `npm run build-node-lts`. They are not DM Kiosk
release artifacts and do not produce a release receipt.

The canonical DM Kiosk `node_printer.node` build is a separate, fail-closed Windows x64
lane. Its tracked contract is:

- repository `deliverymanager/node-printer` at the exact clean HEAD commit;
- Node.js `24.19.0`, `win32/x64`, modules ABI `137`, with Node executable SHA-256
  `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`,
  and its adjacent npm `11.17.0`;
- the tracked lockfile and exact `nan 2.24.0`, `node-gyp 9.4.1`, and
  `node-pre-gyp 0.14.0` direct dependencies, plus `tar 6.2.1` for guarded SDK
  materialization;
- the official `node-v24.19.0-headers.tar.gz` SHA-256
  `54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c` and
  `win-x64/node.lib` SHA-256
  `63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9`;
- MSVC platform toolset `v143`; and
- an unsigned AMD64 PE32+ native DLL. Authenticode signing this addon is forbidden.

Run the exact tracked release scripts with the pinned npm adjacent to the pinned Node
executable, from a clean, non-Developer-Prompt process. Do not use `npm install`, a global
`node-gyp`, or ambient compiler/Python/GYP/npm target overrides. The npm release launcher
checks its exact lifecycle name/script and Node/npm paths, removes npm/Git/GYP channels and
the npm-injected `node_modules/.bin` entries, then starts the real script with the same pinned
Node executable. The build installs the exact lock with lifecycle scripts disabled and invokes
the repository-local `node-gyp` itself:

The build fetches those two files only from their fixed `nodejs.org` v24.19.0 HTTPS URLs and
accepts the response only when its exact hash matches. It does not trust or reuse a local
`node-gyp` cache. Their values are pinned from the official
[Node.js v24.19.0 SHASUMS256](https://nodejs.org/download/release/v24.19.0/SHASUMS256.txt).
After validating both responses, it rejects archive traversal/links/case collisions,
materializes a fresh private SDK below `build/release/`, and passes its absolute path through
explicit `--nodedir`; `node-gyp` is never allowed to choose cached or downloaded headers
implicitly.

```text
npm run release:build
npm run release:verify
```

`build-release.js` will not proceed unless the fixed origin, HEAD tree, index, and every
tracked worktree file agree byte-for-byte. It ignores no source path merely because a Git
exclude rule or stat cache hides it. Before building, it validates and removes only the owned
canonical `build/`, `lib/node_printer.node`, and `lib/node_printer.release.json` outputs; links,
junctions, reparse paths, hardlink aliases, or concurrent swaps fail closed. The compilation
then runs inside a random fresh detached worktree at the approved commit, with source, output
tree, and SDK checks immediately around both node-gyp phases. Only the verified identity,
header, pinned SDK inputs, addon, and receipt are staged back into fresh canonical output
paths. It does not sign, upload, publish, copy into an installer, or replace a retained binary.

The schema-v1 receipt has fixed role `kiosk-printer-native-addon`, repository
`deliverymanager/node-printer`, target `win-x64-node-addon`, and architecture `x64`. It binds
the package version, 32-hex build id, source commit, tracked-tree SHA-256, exact toolchain and
lock identity, artifact path/size/SHA-256, embedded marker, and the exact
`unsigned-node-addon` signature policy. The verifier requires the marker exactly once inside
a PE raw section (and therefore inside the Authenticode-hashed image), and rejects x86, PE32,
non-DLL, CLR, certificate-table, overlay-only, duplicate, or conflicting-marker payloads.

`trackedTreeSha256` is SHA-256 over the ordered HEAD/index records
`mode NUL blob-id NUL path NUL`, after independently recomputing every Git blob id from the
actual non-symlink worktree bytes. This makes the fingerprint reproducible without trusting
Git's working-tree stat cache.

Source tests are dependency-free and safe on macOS:

```text
node scripts/test-release-provenance.js
```

A green source checkpoint is not release authorization. A real release still requires the
pinned Windows build host, successful load under the exact Node 24.19.0/ABI-137 runtime,
installer-side receipt and hash binding for the copied
`build-artifacts/native-modules/node_printer.node`, and a separately approved kiosk canary.
The receipt pins the intended `v143` platform toolset; the Windows gate must still ensure the
trusted host's compiler and Python discovery are not substituted through `PATH`.

or [direct from git](https://www.npmjs.org/doc/cli/npm-install.html):

    npm install git+https://github.com/tojocky/node-printer.git
if you want to to run in [nwjs](http://nwjs.io/) then rebuild the module with [nw-gyp](https://github.com/nwjs/nw-gyp):
```
npm install -g nw-gyp
cd node_modules/printer
nw-gyp rebuild
```
For specific distribution `--dist-url` node-gyp parameter should be used. Example for electron:
```
node-gyp rebuild --target=0.37.4 --arch=x64 --dist-url=https://atom.io/download/atom-shell
```

Ubuntu User :
You need to install libcups2-dev package
`sudo apt-get install libcups2-dev`


### How to use:

See [examples](https://github.com/tojocky/node-printer/tree/master/examples)

### Author(s):

* Ion Lupascu, ionlupascu@gmail.com

### Contibutors:

Feel free to download, test and propose new futures

### License:
 [The MIT License (MIT)](http://opensource.org/licenses/MIT)
