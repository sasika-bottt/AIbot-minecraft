# Native voice build cleanup adapter

`@discordjs/node-pre-gyp@0.4.5` uses rimraf only for literal module and build
directories in `lib/clean.js` and `lib/util/napi.js`. Its rimraf 3 dependency
introduces glob 7, whose private minimatch API is incompatible with minimatch 11.

The MIT-licensed local `@minebot/rimraf-literal-compat` package replaces only
these cleanup calls with Node's `fs.rm`/`fs.rmSync`. It preserves callback and
synchronous forms, handles missing paths and retries Windows busy files, rejects
glob patterns, and refuses root/current-directory removal. It is not a general
drop-in replacement for all rimraf features. Opus encoding/decoding is unchanged.

Source lives in `rimraf-literal/`. The checked-in npm tarball is used by the
root runtime's rimraf override so clean installs do not create directory links.
To regenerate, run `npm pack --pack-destination ..` from `rimraf-literal/`.
Changes must pass `tests/dependency-compat-smoke.cjs` and a clean runtime install.
