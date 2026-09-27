import UIKit
import React
import React_RCTAppDelegate

/// Application entry point.
///
/// The bridge is hosted explicitly rather than through `RCTAppDelegate`'s Swift helpers.
///
/// An earlier version of this file used `RCTReactNativeFactory` and
/// `import ReactAppDependencyProvider`. That is the React Native 0.77+ app-delegate shape, and
/// this project pins 0.76.5, where `ReactAppDependencyProvider.podspec` does not exist and no
/// pod can provide that module. The build failed with
///
///     AppDelegate.swift:4:8: error: Unable to find module dependency: 'ReactAppDependencyProvider'
///
/// Everything used below - `RCTBridge`, `RCTRootViewController`, `RCTBundleURLProvider` and
/// `RCTBridgeDelegate` - is a long-stable React Native 0.7x API present in 0.76.5, so the file
/// compiles against the version this repository actually depends on.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {

  var window: UIWindow?

  /// Retained for the lifetime of the app: `RCTBridge` holds its delegate weakly, so without
  /// this the bridge would lose its source-URL provider on the next run loop turn.
  private var bundleURLDelegate: BundleURLDelegate?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = BundleURLDelegate()
    bundleURLDelegate = delegate

    // The bridge delegate is `BundleURLDelegate`, which answers `sourceURL(for:)` with the
    // compiled/Metro bundle URL. Passing `nil` here would leave the bridge with no way to find
    // the bundle at all.
    let bridge = RCTBridge(delegate: delegate, launchOptions: launchOptions)

    let rootViewController = RCTRootViewController(
      bridge: bridge,
      moduleName: "LocalDrop",
      initialProperties: nil
    )
    rootViewController.view.backgroundColor = UIColor.systemBackground

    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = rootViewController
    window.makeKeyAndVisible()
    self.window = window

    return true
  }
}

/// Tells the bridge where to load the JavaScript bundle from.
final class BundleURLDelegate: NSObject, RCTBridgeDelegate {
  func sourceURL(for bridge: RCTBridge) -> URL? {
    #if DEBUG
      // Metro serves the bundle in development. A physical device needs the Mac's LAN address
      // here, which is why the README says to run `npm start` on the same machine.
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      // Release builds load the bundle compiled into the app by the Xcode build phase.
      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
