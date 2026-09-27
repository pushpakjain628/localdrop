//
//  Bridging header for the LocalDrop iOS app.
//
//  The React Native app delegate and the `RCT_EXTERN_MODULE` macros come from Objective-C
//  React headers, while the LocalDrop modules themselves are Swift. This header is what lets
//  the Swift files see the Objective-C side.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridge.h>
#import <React/RCTUtils.h>
// `AppDelegate.swift` hosts the bridge with `RCTRootViewController`, which is not reachable
// through the Swift `React` module on its own ("cannot find 'RCTRootViewController' in scope"),
// so its umbrella header is imported here for the bridging header to expose.
#import <React/RCTRootView.h>
