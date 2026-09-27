const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration.
 *
 * Two things matter here beyond the defaults:
 *
 * 1. The shared contract package is outside this app's directory, so Metro's default
 *    `watchFolders` would refuse to serve it. It is added explicitly.
 * 2. The iOS native sources are inside the project, so they are watched too - editing a Swift
 *    file should invalidate the bundle rather than silently serve a stale one.
 *
 * The build identity is *not* configured here. `transform.define` is a Vite option; Metro has no
 * equivalent and ignores it, so the constant is inlined by the Babel plugin in `babel.config.js`
 * instead, which works for Metro and for Jest alike.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

/** @type {import('metro-config').MetroConfig} */
const config = {
  // The workspace root, not just `packages/shared`. This app is an npm workspace, so
  // `react`, `react-native` and every other dependency is hoisted into
  // `<workspaceRoot>/node_modules`, which lives *outside* this project root. Metro builds an
  // indexed file map from `projectRoot` + `watchFolders` and resolves modules through that
  // index, so a directory that is not indexed is treated as absent no matter that it exists on
  // disk. Watching only the shared package therefore left the hoisted dependencies invisible
  // and every bundle failed with
  //   "react-native could not be found within the project or in these directories".
  // Watching the workspace root covers the shared package, the hoisted `node_modules` and the
  // sibling apps in one entry.
  watchFolders: [workspaceRoot],
  resolver: {
    // Deliberately empty. An earlier version pointed `extraNodeModules` at
    // `apps/ios/node_modules/{react,react-native}`, which do not exist in a hoisted
    // workspace, and Metro honours that mapping over its own lookup. With the workspace root
    // watched, Metro's default hierarchical lookup finds the single hoisted copy on its own,
    // and a hoisted install contains exactly one - so the duplicate-copy problem that override
    // was guarding against cannot occur here.
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
