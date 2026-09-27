#!/usr/bin/env node
/**
 * Runs every check in the repository and prints one summary.
 *
 * Deliberately plain Node with no dependencies: this has to work on a fresh clone before
 * anything is installed, so it can report what is missing rather than failing obscurely.
 *
 *   node scripts/verify.js
 *
 * Exit code is 0 only when every check passed, so it is usable in CI as-is.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CARGO_BIN = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.cargo',
  'bin',
  'cargo.exe',
);

const results = [];

function run(name, command, args, options = {}) {
  const started = Date.now();
  // `shell: true` is required on Windows to run `npm.cmd` and `.cmd` shims, but Node does not
  // quote the arguments it joins - and this repository's path contains a space. Anything with a
  // space is therefore quoted here, or the shell splits it into two arguments.
  const quoted = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg));
  const result = spawnSync(command, quoted, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PATH: `${path.dirname(CARGO_BIN)};${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const passed = result.status === 0;
  results.push({ name, passed, ms: Date.now() - started, output });
  return passed;
}

function cargo(args, options) {
  const cargo = fs.existsSync(CARGO_BIN) ? CARGO_BIN : 'cargo';
  return run(options?.name ?? `cargo ${args[0]}`, cargo, args, {
    cwd: path.join(ROOT, 'apps', 'windows', 'src-tauri'),
    ...options,
  });
}

console.log('\nLocalDrop verification\n');

/* ------------------------------------------------------------------ shared */

run('shared: typecheck', 'npm.cmd', ['run', 'typecheck', '--workspace', '@localdrop/shared']);
run('shared: tests', 'npm.cmd', ['run', 'test', '--workspace', '@localdrop/shared']);

/* ------------------------------------------------------------------ iOS (TypeScript) */

run('ios: typecheck', 'npm.cmd', ['run', 'typecheck', '--workspace', '@localdrop/ios']);
run('ios: tests', 'npm.cmd', ['run', 'test', '--workspace', '@localdrop/ios']);

/* ------------------------------------------------------------------ Windows */

cargo(['test'], { name: 'windows: cargo test' });
cargo(['clippy', '--all-targets', '--', '-D', 'warnings'], {
  name: 'windows: clippy (warnings are errors)',
});
cargo(['fmt', '--check'], { name: 'windows: cargo fmt --check' });
run('windows: dashboard typecheck + build', 'npm.cmd', [
  'run',
  'build',
  '--workspace',
  '@localdrop/windows',
]);

/* ------------------------------------------------------------------ iOS project */

run('ios: generate + verify Xcode project', process.execPath, [
  path.join(ROOT, 'scripts', 'generate-ios-project.js'),
]);
/* ------------------------------------------------------------------ report */

const padding = Math.max(...results.map((r) => r.name.length), 10);
let failures = 0;

for (const result of results) {
  const status = result.passed ? 'PASS' : 'FAIL';
  const timing = `${(result.ms / 1000).toFixed(1)}s`;
  console.log(`  ${status}  ${result.name.padEnd(padding)}  ${timing}`);
  if (!result.passed) {
    failures += 1;
    // Show just the tail; a full cargo log buries the actual error.
    const lines = result.output.trim().split('\n');
    for (const line of lines.slice(-25)) {
      console.log(`        ${line}`);
    }
  }
}

console.log('');
if (failures === 0) {
  console.log(`All ${results.length} checks passed.\n`);
  console.log('Not covered here - these need a Mac:');
  console.log('  * xcodebuild / pod install / running on a device or simulator');
  console.log('  * the Swift sources in apps/ios/ios/LocalDrop/Native are not compiled by any');
  console.log('    check available on Windows, so they are unverified beyond review.\n');
  process.exit(0);
} else {
  console.log(`${failures} of ${results.length} checks failed.\n`);
  process.exit(1);
}
