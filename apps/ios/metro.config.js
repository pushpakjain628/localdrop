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
 */
const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

/** @type {import('metro-config').MetroConfig} */
const config = {
  watchFolders: [sharedRoot],
  resolver: {
    // Deliberately empty. This app is an npm workspace, so `react` and `react-native` are
    // hoisted to the repository root and have no `apps/ios/node_modules` directory at all.
    // An earlier version of this file set `extraNodeModules` to
    // `apps/ios/node_modules/{react,react-native}`, which do not exist, and Metro honours
    // that mapping over its own lookup - so the bundle died with
    //   "react-native could not be found within the project or in these directories".
    // Metro's default hierarchical lookup already walks up from this project root and finds
    // the hoisted copy, and a hoisted install contains exactly one, so the "two copies break
    // hooks" problem the override was meant to prevent cannot occur here.
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
