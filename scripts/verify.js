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

/**
 * Runs an in-process check and records it in the summary.
 *
 * `run` spawns a command; this is for assertions that are cheaper to express here than as a
 * separate script. Returning a list of problems means empty is a pass, so a check reads as the
 * thing it asserts rather than as a pile of conditionals.
 */
function check(name, assert) {
  const started = Date.now();
  let passed = false;
  let output = '';
  try {
    const problems = assert() ?? [];
    output = problems.join('\n');
    passed = problems.length === 0;
  } catch (error) {
    output = error instanceof Error ? (error.stack ?? String(error)) : String(error);
  }
  results.push({ name, passed, ms: Date.now() - started, output });
  return passed;
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

/* ------------------------------------------------------------------ iOS native bridge */

/**
 * Balances the `@interface`/`@end` pairs in the Objective-C bridge file.
 *
 * `RCT_EXTERN_MODULE` opens an `@implementation` that the block's trailing `@end` closes, so a
 * missing `@end` is a compile error. Clang reports it against the *next* block - "missing
 * '@end'" pointing at the following `@interface` - which sends you looking at the wrong code.
 *
 * This file was a header that was never compiled and carried no `@end` at all, so the mistake
 * survived until the first real compile, at the cost of a seven-minute CI round trip. A count is
 * not a parse, but the imbalance is the only failure mode here that a Mac-only check would have
 * caught, and this runs anywhere.
 */
function stripObjCComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

check('ios: RCT_EXTERN_MODULE blocks are balanced', () => {
  const file = path.join(
    ROOT,
    'apps',
    'ios',
    'ios',
    'LocalDrop',
    'Native',
    'LocalDropNativeModules.m',
  );
  if (!fs.existsSync(file)) {
    return ['LocalDropNativeModules.m is missing, so no native module can register'];
  }
  const code = stripObjCComments(fs.readFileSync(file, 'utf8'));
  const opened = (code.match(/@interface\s+RCT_EXTERN_MODULE\b/g) ?? []).length;
  const closed = (code.match(/^[ \t]*@end[ \t]*$/gm) ?? []).length;
  if (opened === 0) {
    return ['LocalDropNativeModules.m declares no RCT_EXTERN_MODULE blocks'];
  }
  if (opened !== closed) {
    return [
      `LocalDropNativeModules.m opens ${opened} RCT_EXTERN_MODULE block(s) but closes ` +
        `${closed}. Every block needs a trailing @end.`,
    ];
  }
  return [];
});

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
