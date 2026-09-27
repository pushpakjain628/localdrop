import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // `RCTAppDelegate` sets up the bridge, the module registry and the root view. The
    // `ReactNativeDelegate` subclass below is where the initial props are supplied, which is
    // also where a future feature flag would come from `NSUserDefaults`.
    self.reactNativeDelegate = ReactNativeDelegate()
    self.reactNativeDelegate?.dependencyProvider = RCTAppDependencyProvider()

    self.window = UIWindow(frame: UIScreen.main.bounds)
    self.reactNativeDelegate?.factory = RCTReactNativeFactory(delegate: self.reactNativeDelegate!)
    self.reactNativeDelegate?.factory?.startReactNative(
      withModuleName: "LocalDrop",
      in: self.window,
      launchOptions: launchOptions
    )
    return true
  }
}

class ReactNativeDelegate: RCTAppDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    // Metro serves the bundle in development. A physical device needs the Mac's LAN address
    // here, which is why the README says to run `npm start` on the same machine.
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    // Release builds load the bundle compiled into the app by the Xcode build phase.
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
