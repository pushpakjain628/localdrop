/**
 * App entry point.
 *
 * Registers the root component under the name `LocalDrop`, which is what `AppRegistry` looks up.
 */

import { AppRegistry } from 'react-native';
import React from 'react';
import { App } from './src/App';
import { ErrorBoundary } from './src/ErrorBoundary';
import { installErrorHandler } from './src/native/errorReporting';
import { name as appName } from './app.json';

// Before anything renders. A Release build otherwise ends an unhandled error in `RCTFatal`, which
// terminates the process, so an error thrown from a text input looked like the app closing with no
// explanation. See `src/native/errorReporting.ts`.
installErrorHandler();

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

AppRegistry.registerComponent(appName, () => Root);
