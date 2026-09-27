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
    // A single copy of React and React Native: two copies break hooks and the bridge.
    extraNodeModules: {
      react: path.resolve(projectRoot, 'node_modules/react'),
      'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
