const fs = require('node:fs');
const path = require('node:path');

// node-pre-gyp only calls rimraf(path, callback) and rimraf.sync(path) on
// literal module/build directories. Preserve those APIs without pulling in
// the obsolete glob 7 / minimatch 3 implementation. Never interpret patterns.
function targetPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[*?\x00]/.test(value)) {
    throw new TypeError('Cleanup requires a nonempty literal path; glob patterns are not supported');
  }
  const target = path.resolve(value);
  if (target === path.parse(target).root || target === path.resolve('.')) {
    throw new Error('Refusing to remove the filesystem root or current working directory');
  }
  return target;
}

function rimraf(value, options, callback) {
  if (typeof options === 'function') callback = options;
  if (typeof callback !== 'function') throw new TypeError('Cleanup callback is required');
  let target;
  try { target = targetPath(value); } catch (error) { queueMicrotask(() => callback(error)); return; }
  fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }, callback);
}

rimraf.sync = value => fs.rmSync(targetPath(value), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
module.exports = rimraf;
