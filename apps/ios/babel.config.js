const path = require('path');
const child_process = require('child_process');

/**
 * Replaces the `__LOCALDROP_BUILD__` identifier with a string literal at build time.
 *
 * Why a plugin rather than a bundler option: `define` is a *Vite* feature, and this app is bundled
 * by Metro, which has no equivalent - `transform.define` in `metro.config.js` is not a real key
 * and is silently ignored. A plugin is the one mechanism that works for Metro, for Jest, and for
 * any future bundler, with no new dependency.
 *
 * What it is for: the app shows this on its Settings screen, because a Release build has no
 * console and no dev menu, so "is the phone running the build I just made?" has no other answer.
 * An out-of-date build's symptoms - a blank screen, or an address that will not connect - are
 * indistinguishable from a fresh one's.
 *
 * `GITHUB_SHA` is set by the Actions runner, so a downloaded `.ipa` reports the exact commit.
 * Locally there is no SHA, so the checked-out commit is used rather than a placeholder.
 */
function buildId() {
  const fromEnv = process.env.GITHUB_SHA;
  if (fromEnv) {
    return fromEnv.slice(0, 7);
  }
  try {
    return child_process
      .execSync('git rev-parse --short HEAD', {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/** The build identity plugin. */
function inlineBuildId({ types: t }) {
  return {
    name: 'localdrop-inline-build-id',
    visitor: {
      // `ReferencedIdentifier`, not `Identifier`: it matches only identifiers in a *referenced*
      // position, so `something.__LOCALDROP_BUILD__` is left alone while both
      // `__LOCALDROP_BUILD__` and `something[__LOCALDROP_BUILD__]` are replaced. Doing that test
      // by hand on the parent node is not reliable - Babel does not always give an identifier's
      // `path.parent` the node you would inspect by hand.
      ReferencedIdentifier(path) {
        if (path.node.name !== '__LOCALDROP_BUILD__') {
          return;
        }
        path.replaceWith(t.stringLiteral(buildId()));
      },
    },
  };
}

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [inlineBuildId],
};
