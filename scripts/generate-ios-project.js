#!/usr/bin/env node
/**
 * Generates `apps/ios/ios/LocalDrop.xcodeproj` from the official React Native template.
 *
 * Why generate rather than commit a hand-written project file:
 *
 * * A `.pbxproj` is a graph of cross-referenced 24-hex-digit object IDs. Hand-editing one
 *   reliably produces a file Xcode refuses to open, and the failure only shows up on a machine
 *   with Xcode - the worst possible place to discover it.
 * * Starting from React Native's own template means the project inherits the exact build
 *   settings, header search paths and script phases that the installed React Native version
 *   expects. That is what `@react-native-community/cli init` does for the same reason.
 * * It is verifiable here, on any platform: this script re-parses its own output with the same
 *   `xcode` library and asserts that every LocalDrop source is compiled by the app target, that
 *   the bridge header and Info.plist are wired up, and that nothing from the template is left
 *   behind. A broken project fails immediately rather than on a contributor's Mac.
 *
 * Run from the repository root:
 *
 *   node scripts/generate-ios-project.js
 *
 * Then, on a Mac:
 *
 *   cd apps/ios/ios && pod install && open LocalDrop.xcworkspace
 *
 * `pod install` merges in React Native's pods and their build phases. It needs CocoaPods and a
 * Mac, so it is deliberately not attempted here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const xcode = require('xcode');

const ROOT = path.resolve(__dirname, '..');
const IOS_DIR = path.join(ROOT, 'apps', 'ios', 'ios');
const TEMPLATE_IOS = path.join(
  ROOT,
  'node_modules',
  '@react-native-community',
  'template',
  'template',
  'ios',
);
const TEMPLATE_NAME = 'HelloWorld';
const TEMPLATE_PBXPROJ = path.join(TEMPLATE_IOS, `${TEMPLATE_NAME}.xcodeproj`, 'project.pbxproj');

const TARGET_NAME = 'LocalDrop';
const TEST_TARGET_NAME = `${TEMPLATE_NAME}Tests`;
const BUNDLE_ID = 'com.localdrop.ios';
const DEPLOYMENT_TARGET = '15.1';
const SWIFT_VERSION = '5.0';

/** Compiled by the app target. */
const SOURCES = [
  'LocalDrop/AppDelegate.swift',
  'LocalDrop/Native/LocalDropPhotos.swift',
  'LocalDrop/Native/LocalDropTransfer.swift',
  'LocalDrop/Native/LocalDropDiscovery.swift',
  'LocalDrop/Native/LocalDropSecureStore.swift',
  'LocalDrop/Native/AssetFileWriter.swift',
  'LocalDrop/Native/FileUploader.swift',
];

/** Part of the target but not compiled. */
const NON_COMPILED = [
  // The Objective-C half of the bridge. `RCT_EXTERN_MODULE` lives here; the implementations
  // are the Swift files above.
  'LocalDrop/Native/LocalDropNativeModules.h',
  'LocalDrop/LocalDrop-Bridging-Header.h',
  'LocalDrop/Info.plist',
];

/** Copied into the bundle. */
const RESOURCES = ['LocalDrop/Assets.xcassets', 'LocalDrop/LaunchScreen.storyboard'];

/**
 * Template files this project replaces. The template's Objective-C `AppDelegate` and `main.m`
 * are removed because LocalDrop uses the Swift `RCTAppDelegate` entry point, and leaving them
 * would give the target two `main` functions.
 */
const REPLACED_TEMPLATE_FILES = [
  `${TEMPLATE_NAME}/AppDelegate.mm`,
  `${TEMPLATE_NAME}/AppDelegate.h`,
  `${TEMPLATE_NAME}/main.m`,
  `${TEMPLATE_NAME}/Images.xcassets`,
  `${TEMPLATE_NAME}/LaunchScreen.storyboard`,
  `${TEMPLATE_NAME}/Info.plist`,
  `${TEMPLATE_NAME}/PrivacyInfo.xcprivacy`,
];

/* ------------------------------------------------------------------ output */

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function info(message) {
  console.log(`  ${message}`);
}

/* ------------------------------------------------------------------ lookups */

/**
 * Finds an object's key in a section by a field.
 *
 * `xcode`'s higher-level helpers look things up by object key (the 24-hex-digit UUID) even
 * where their argument is documented as a name, so the keys have to be resolved explicitly.
 * Getting this wrong fails deep inside the library with a message that points at the wrong
 * thing entirely.
 */
function findKeyByField(section, field, value) {
  for (const [key, object] of Object.entries(section)) {
    if (object && object[field] === value) {
      return key;
    }
  }
  return undefined;
}

/**
 * Pulls the object key out of a reference.
 *
 * Depending on where it appears in a `.pbxproj`, a reference is either a bare UUID string or a
 * `{ value, comment }` pair. Reading `.value` off a string yields `undefined`, so both shapes
 * have to be handled.
 */
function refKey(reference) {
  if (typeof reference === 'string') {
    return reference;
  }
  if (reference && typeof reference.value === 'string') {
    return reference.value;
  }
  return undefined;
}

function appGroupKey(project) {
  const groups = project.hash.project.objects['PBXGroup'] ?? {};
  const key = findKeyByField(groups, 'name', TEMPLATE_NAME);
  if (!key) {
    fail(
      `could not find the "${TEMPLATE_NAME}" group in the React Native template.\n` +
        `      The installed @react-native-community/template may be a different major version.`,
    );
  }
  return key;
}

function appTargetKey(project) {
  const targets = project.hash.project.objects['PBXNativeTarget'] ?? {};
  for (const [key, target] of Object.entries(targets)) {
    if (target?.name === TEMPLATE_NAME) {
      return key;
    }
  }
  return fail(`could not find the "${TEMPLATE_NAME}" application target in the template.`);
}

/* ------------------------------------------------------------------ mutations */

/**
 * Removes the template's unit-test target.
 *
 * LocalDrop has no XCTest sources, and the template's `HelloWorldTests.m` is not part of this
 * repository. Leaving the target in place means Xcode opens with a permanently red test target
 * and `xcodebuild -scheme LocalDrop test` fails for a reason that has nothing to do with the
 * app. The removal is done at the object level because the `xcode` library has no helper for
 * deleting a target.
 */
function removeTestTarget(project) {
  const objects = project.hash.project.objects;
  const targets = objects['PBXNativeTarget'] ?? {};
  const configs = objects['XCBuildConfiguration'] ?? {};
  const configLists = objects['XCConfigurationList'] ?? {};
  const groups = objects['PBXGroup'] ?? {};
  const references = objects['PBXFileReference'] ?? {};

  let removed = 0;
  for (const [key, target] of Object.entries(targets)) {
    if (target?.name !== TEST_TARGET_NAME) {
      continue;
    }

    // Drop the target's build phases. Leaving them behind produces orphaned sections that are
    // no longer referenced by any target but still list their files, which is exactly how a
    // deleted test file ends up looking like it is still compiled.
    const phaseTypes = [
      'PBXSourcesBuildPhase',
      'PBXResourcesBuildPhase',
      'PBXFrameworksBuildPhase',
      'PBXHeadersBuildPhase',
    ];
    for (const phaseKey of target.buildPhases ?? []) {
      const phaseUuid = refKey(phaseKey);
      for (const phaseType of phaseTypes) {
        const section = objects[phaseType];
        const phase = section?.[phaseUuid];
        if (phase) {
          for (const entry of phase.files ?? []) {
            const buildFileKey = refKey(entry);
            if (buildFileKey) {
              delete objects['PBXBuildFile'][buildFileKey];
              delete objects['PBXBuildFile'][`${buildFileKey}_comment`];
            }
          }
          delete section[phaseUuid];
        }
      }
    }

    // Drop the target's build configurations and the list that owns them.
    const listKey = refKey(target.buildConfigurationList);
    const list = configLists[listKey];
    if (list?.buildConfigurations) {
      for (const entry of list.buildConfigurations) {
        const configKey = refKey(entry);
        if (configKey) {
          delete configs[configKey];
        }
      }
    }
    delete configLists[listKey];

    // Drop the `.app` product reference and the group holding its sources.
    for (const [fileKey, file] of Object.entries(references)) {
      if (file?.path === `${TEST_TARGET_NAME}.app`) {
        delete references[fileKey];
      }
    }
    for (const [groupKey, group] of Object.entries(groups)) {
      if (group?.name === TEST_TARGET_NAME) {
        delete groups[groupKey];
      }
    }

    delete targets[key];
    removed += 1;
  }

  // Unhook the target from the project's `targets` list.
  const projectSection = project.pbxProjectSection();
  const projectObjects = projectSection[Object.keys(projectSection)[0]];
  if (projectObjects?.targets) {
    const liveTargetKeys = new Set(Object.keys(targets));
    projectObjects.targets = projectObjects.targets
      .map(refKey)
      .filter((key) => key !== undefined && liveTargetKeys.has(key));
  }

  // The Podfile only declares the app target, so CocoaPods would otherwise leave this target's
  // stale `[CP] Check Pods Manifest.lock` phase behind.
  if (removed > 0) {
    info(`removed the template's ${TEST_TARGET_NAME} target`);
  }
  return removed;
}

function configureBuildSettings(project) {
  const settings = {
    PRODUCT_NAME: TARGET_NAME,
    PRODUCT_BUNDLE_IDENTIFIER: BUNDLE_ID,
    INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
    SWIFT_OBJC_BRIDGING_HEADER: `${TARGET_NAME}/LocalDrop-Bridging-Header.h`,
    SWIFT_VERSION,
    IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
    CURRENT_PROJECT_VERSION: '1',
    MARKETING_VERSION: '1.0.0',
    ASSETCATALOG_COMPILER_APPICON_NAME: 'AppIcon',
    // `RCT_EXTERN_MODULE` needs the Objective-C runtime, which the linker strips unused
    // categories from without this. The symptom is a runtime "module not found", not a build
    // error, which is exactly why it is set explicitly.
    OTHER_LDFLAGS: '$(inherited) -ObjC',
    CLANG_ENABLE_MODULES: 'YES',
    DEFINES_MODULE: 'YES',
    LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks',
    // Quoted because the pbxproj grammar treats a bare comma as a list separator: written
    // unquoted, `1,2` is a syntax error and the project will not open at all.
    TARGETED_DEVICE_FAMILY: '"1,2"',
    // The app talks plain HTTP to a LAN address, which this narrowly-scoped exception covers.
    // `NSAllowsArbitraryLoads` would disable ATS entirely and is deliberately not used.
    INFOPLIST_KEY_NSAppTransportSecurity_NSAllowsLocalNetworking: 'YES',
  };
  for (const [key, value] of Object.entries(settings)) {
    project.addBuildProperty(key, value);
  }
}

/**
 * Removes a file from the project completely.
 *
 * `xcode`'s `removeFile` only drops the `PBXFileReference`. It leaves the `PBXBuildFile` entry
 * and the build-phase membership behind, so a removed file stays in the Sources phase and
 * Xcode still tries to compile it - which fails, because the file is not in the repository. Every
 * dangling reference is therefore swept here: the build file, every build phase that mentions
 * it, the file reference, and any group child pointing at it.
 */
function removeFileFully(project, relativePath) {
  const objects = project.hash.project.objects;
  const references = objects['PBXFileReference'] ?? {};
  const buildFiles = objects['PBXBuildFile'] ?? {};
  const groups = objects['PBXGroup'] ?? {};

  const fileName = path.basename(relativePath);

  // 1. Find the file reference. The template stores `name` and `path` separately for files in a
  //    group that has its own path, so both are checked.
  let fileKey;
  for (const [key, file] of Object.entries(references)) {
    if (!file) {
      continue;
    }
    if (file.path === relativePath || file.path === fileName || file.name === fileName) {
      fileKey = key;
      break;
    }
  }
  if (!fileKey) {
    return false;
  }

  // 2. Drop the build-file entries that point at it, and remove them from every build phase.
  const buildFileKeys = new Set();
  for (const [key, buildFile] of Object.entries(buildFiles)) {
    if (refKey(buildFile?.fileRef) === fileKey) {
      buildFileKeys.add(key);
    }
  }
  for (const phaseType of [
    'PBXSourcesBuildPhase',
    'PBXResourcesBuildPhase',
    'PBXFrameworksBuildPhase',
    'PBXHeadersBuildPhase',
    'PBXCopyFilesBuildPhase',
  ]) {
    const phaseSection = objects[phaseType];
    if (!phaseSection) {
      continue;
    }
    for (const phase of Object.values(phaseSection)) {
      if (!phase || !Array.isArray(phase.files)) {
        continue;
      }
      phase.files = phase.files.filter((entry) => !buildFileKeys.has(refKey(entry)));
    }
  }
  for (const key of buildFileKeys) {
    delete buildFiles[key];
    delete buildFiles[`${key}_comment`];
  }

  // 3. Unhook the file reference from its groups.
  for (const group of Object.values(groups)) {
    if (group && Array.isArray(group.children)) {
      group.children = group.children.filter((child) => refKey(child) !== fileKey);
    }
  }

  // 4. Drop the file reference itself.
  delete references[fileKey];
  delete references[`${fileKey}_comment`];
  return true;
}

function removeTemplateFiles(project, groupKey) {
  for (const relative of REPLACED_TEMPLATE_FILES) {
    if (removeFileFully(project, relative)) {
      info(`removed the template's ${path.basename(relative)}`);
    } else {
      info(`note: ${relative} was not present in the template`);
    }
  }
  void groupKey;
}

/**
 * Adds a file to the Resources build phase.
 *
 * The library's `addResourceFile` is unusable here: `correctForResourcesPath` calls
 * `pbxGroupByName(group)`, and that function only ever matches Xcode's special group literally
 * named "Resources" - a group this project does not have - so it throws. Rather than fight it,
 * the file is added with `addSourceFile`, moved out of the Sources phase, and pushed into the
 * Resources phase with the same primitive `addResourceFile` would have used.
 */
function addResource(project, relative, groupKey, targetKey) {
  const file = project.addSourceFile(relative, { target: targetKey }, groupKey);
  if (!file) {
    return fail(`could not add the resource ${relative} to the project`);
  }

  const sources = project.pbxSourcesBuildPhaseObj(targetKey);
  const index = sources.files.findIndex((entry) => refKey(entry) === file.uuid);
  if (index >= 0) {
    sources.files.splice(index, 1);
  }

  project.addToPbxResourcesBuildPhase(file);
}

function addLocalDropFiles(project, groupKey, targetKey) {
  for (const relative of SOURCES) {
    project.addSourceFile(relative, { target: targetKey }, groupKey);
  }
  // Resources belong in the Resources build phase. Left in the Sources phase, a storyboard or
  // an asset catalog fails the build with a confusing error.
  for (const relative of RESOURCES) {
    addResource(project, relative, groupKey, targetKey);
  }
  for (const relative of NON_COMPILED) {
    if (relative.endsWith('.h')) {
      project.addHeaderFile(relative, { target: targetKey }, groupKey);
    }
  }
}

/**
 * Renames the app throughout the generated project file.
 *
 * A single pass over the text is used rather than mutating individual objects because the name
 * appears in the target, the product, the `.app` reference, the group and the build settings at
 * once; a partial rename produces a project that opens but behaves oddly.
 */
function renameAppInProject(pbxprojPath) {
  const original = fs.readFileSync(pbxprojPath, 'utf8');
  const renamed = original.split(TEMPLATE_NAME).join(TARGET_NAME);
  fs.writeFileSync(pbxprojPath, renamed, 'utf8');
  return original !== renamed;
}

/* ------------------------------------------------------------------ verification */

/**
 * Re-parses the generated project and asserts it is coherent.
 *
 * This is the reason generating the project is worth the trouble: a mistake shows up here, on
 * any platform, instead of in Xcode on someone else's Mac.
 */
function verify(pbxprojPath) {
  // Re-parsing is itself the first assertion: `xcode` throws on a malformed file.
  const reloaded = xcode.project(pbxprojPath);
  reloaded.parseSync();

  const raw = fs.readFileSync(pbxprojPath, 'utf8');
  const problems = [];

  for (const relative of [...SOURCES, ...RESOURCES, ...NON_COMPILED]) {
    const name = path.basename(relative);
    if (!raw.includes(name)) {
      problems.push(`${name} is not referenced by the project`);
    }
  }

  // Every compiled source must be a member of a PBXSourcesBuildPhase, not merely mentioned:
  // a file that exists in the navigator but is not in the build phase is silently not compiled.
  const sourcesSection = raw.slice(raw.indexOf('/* Begin PBXSourcesBuildPhase section */'));
  const sourcesBlock = sourcesSection.slice(0, sourcesSection.indexOf('/* End PBXSourcesBuildPhase section */'));
  const compiledNames = sourcesBlock
    .split('\n')
    .map((line) => line.match(/\/\*\s+(.+?)\s+in Sources\s+\*\//)?.[1])
    .filter(Boolean);

  for (const relative of SOURCES) {
    const name = path.basename(relative);
    if (!compiledNames.includes(name)) {
      problems.push(`${name} is not in the Sources build phase, so it would not be compiled`);
    }
  }

  // The inverse also matters: a template file left in the Sources phase is compiled even though
  // it does not exist in the repository, which fails the build with a confusing "file not found".
  const expectedCompiled = SOURCES.map((f) => path.basename(f)).sort();
  const unexpectedCompiled = compiledNames.filter((name) => !expectedCompiled.includes(name));
  if (unexpectedCompiled.length > 0) {
    problems.push(
      `these files are still in the Sources build phase but are not part of the project: ${unexpectedCompiled.join(', ')}`,
    );
  }

  // Resources must be in the resources phase, or they are not in the app bundle.
  const resourcesSection = raw.slice(raw.indexOf('/* Begin PBXResourcesBuildPhase section */'));
  const resourcesBlock = resourcesSection.slice(
    0,
    resourcesSection.indexOf('/* End PBXResourcesBuildPhase section */'),
  );
  const resourceNames = resourcesBlock
    .split('\n')
    .map((line) => line.match(/\/\*\s+(.+?)\s+in Resources\s+\*\//)?.[1])
    .filter(Boolean);

  for (const relative of RESOURCES) {
    const name = path.basename(relative);
    if (!resourceNames.includes(name)) {
      problems.push(`${name} is not in the Resources build phase`);
    }
  }

  // A resource listed twice is copied into the bundle twice, and the build warns about it.
  const duplicatedResources = resourceNames.filter(
    (name, index) => resourceNames.indexOf(name) !== index,
  );
  if (duplicatedResources.length > 0) {
    problems.push(`these resources appear more than once: ${[...new Set(duplicatedResources)].join(', ')}`);
  }

  const unexpectedResources = resourceNames.filter(
    (name) => !RESOURCES.map((f) => path.basename(f)).includes(name),
  );
  if (unexpectedResources.length > 0) {
    problems.push(
      `these template resources were not removed: ${unexpectedResources.join(', ')}`,
    );
  }

  if (raw.includes(TEMPLATE_NAME)) {
    problems.push(`the template name "${TEMPLATE_NAME}" still appears in the project`);
  }
  if (raw.includes(TEST_TARGET_NAME)) {
    problems.push(`the template's ${TEST_TARGET_NAME} target was not removed`);
  }

  // These three are what make the native modules work at all. If any is missing the app builds
  // and then fails at runtime with a confusing "module not found".
  if (!raw.includes('LocalDrop-Bridging-Header.h')) {
    problems.push('the Swift bridging header is not configured');
  }
  if (!raw.includes('LocalDrop/Info.plist')) {
    problems.push('Info.plist is not configured');
  }
  if (!raw.includes('Bundle React Native code and images')) {
    problems.push('the React Native bundle build phase is missing');
  }
  if (!raw.includes('-ObjC')) {
    problems.push('OTHER_LDFLAGS is missing -ObjC, so RCT_EXTERN_MODULE classes would be stripped');
  }

  if (problems.length > 0) {
    fail(`the generated project is not usable:\n      ${problems.join('\n      ')}`);
  }

  info(
    `verified: ${SOURCES.length} compiled sources, ${RESOURCES.length} resources, ` +
      `bridging header, Info.plist, bundle phase, no template remnants`,
  );
}

/* ------------------------------------------------------------------ scheme */

function writeScheme(projectDir) {
  const schemeDir = path.join(projectDir, 'xcshareddata', 'xcschemes');
  fs.mkdirSync(schemeDir, { recursive: true });
  const destination = path.join(schemeDir, `${TARGET_NAME}.xcscheme`);

  // Reuse the template's scheme so its build/test/archive wiring stays correct, and just point
  // it at our target name.
  const templateScheme = path.join(
    TEMPLATE_IOS,
    `${TEMPLATE_NAME}.xcodeproj`,
    'xcshareddata',
    'xcschemes',
    `${TEMPLATE_NAME}.xcscheme`,
  );

  let contents;
  if (fs.existsSync(templateScheme)) {
    contents = fs.readFileSync(templateScheme, 'utf8').split(TEMPLATE_NAME).join(TARGET_NAME);
  } else {
    // A minimal scheme, so `xcodebuild -scheme LocalDrop` works regardless.
    contents = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
   <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
            <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="TARGET_UUID" BuildableName="${TARGET_NAME}.app" BlueprintName="${TARGET_NAME}" ReferencedContainer="container:${TARGET_NAME}.xcodeproj"/>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
      <BuildableProductRunnable runnableDebuggingMode="0">
         <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="TARGET_UUID" BuildableName="${TARGET_NAME}.app" BlueprintName="${TARGET_NAME}" ReferencedContainer="container:${TARGET_NAME}.xcodeproj"/>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
      <BuildableProductRunnable runnableDebuggingMode="0">
         <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="TARGET_UUID" BuildableName="${TARGET_NAME}.app" BlueprintName="${TARGET_NAME}" ReferencedContainer="container:${TARGET_NAME}.xcodeproj"/>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration="Debug"/>
   <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
  }

  fs.writeFileSync(destination, contents, 'utf8');
  info(`wrote ${path.relative(ROOT, destination)}`);
}

/* ------------------------------------------------------------------ main */

function main() {
  console.log('\nGenerating the LocalDrop Xcode project\n');

  if (!fs.existsSync(TEMPLATE_PBXPROJ)) {
    fail(
      `the React Native template project was not found at\n      ${TEMPLATE_PBXPROJ}\n` +
        `      Run "npm install" first.`,
    );
  }

  // 1. Every referenced file must exist before a project points at it.
  const missing = [...SOURCES, ...RESOURCES, ...NON_COMPILED].filter(
    (relative) => !fs.existsSync(path.join(IOS_DIR, relative)),
  );
  if (missing.length > 0) {
    fail(
      `these files are referenced by the project but do not exist:\n      ${missing.join('\n      ')}`,
    );
  }
  info(`found ${SOURCES.length + RESOURCES.length + NON_COMPILED.length} source files`);

  // 2. Work on a copy, so the template in node_modules is never mutated and a second run
  //    behaves identically to the first.
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localdrop-pbx-'));
  const workingPbxproj = path.join(workingDir, 'project.pbxproj');
  fs.copyFileSync(TEMPLATE_PBXPROJ, workingPbxproj);

  const project = xcode.project(workingPbxproj);
  project.parseSync();

  const groupKey = appGroupKey(project);
  const targetKey = appTargetKey(project);
  info(`found the template's "${TEMPLATE_NAME}" target`);

  removeTestTarget(project);
  configureBuildSettings(project);
  removeTemplateFiles(project, groupKey);
  addLocalDropFiles(project, groupKey, targetKey);

  // `pbxWriter.writeSync()` *returns* the serialised project as a string - it does not write
  // to disk. Ignoring the return value silently produces an unmodified project file, so the
  // result is written explicitly and its size asserted.
  const contents = project.writeSync();
  if (typeof contents !== 'string' || contents.length === 0) {
    fail('the project serialised to an empty string');
  }
  fs.writeFileSync(workingPbxproj, contents, 'utf8');
  info(`built the project graph (${contents.length} bytes)`);

  // 3. Publish, rename and verify.
  const projectDir = path.join(IOS_DIR, `${TARGET_NAME}.xcodeproj`);
  const published = path.join(projectDir, 'project.pbxproj');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(workingPbxproj, published);
  fs.rmSync(workingDir, { recursive: true, force: true });

  info(`wrote ${path.relative(ROOT, published)}`);

  if (!renameAppInProject(published)) {
    fail('the rename pass changed nothing, so the template name was never applied');
  }
  info(`renamed ${TEMPLATE_NAME} to ${TARGET_NAME} throughout the project`);

  verify(published);
  writeScheme(projectDir);

  console.log('\nDone. On a Mac, run:\n');
  console.log('    cd apps/ios/ios');
  console.log('    pod install');
  console.log('    open LocalDrop.xcworkspace\n');
}

main();
