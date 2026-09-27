/** @type {import('jest').Config} */
module.exports = {
  preset: 'react-native',
  // The app's own tests are pure logic: no component rendering, no native modules. Anything that
  // needs a simulator belongs in the Xcode test target, not here.
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@localdrop/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|@react-native-community)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/__tests__/**'],
};
