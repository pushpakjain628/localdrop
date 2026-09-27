/**
 * App entry point.
 *
 * Registers the root component under the name `LocalDrop`, which is what `AppRegistry` looks up.
 */

import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
