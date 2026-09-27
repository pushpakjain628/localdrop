import UIKit
import React
import React_RCTAppDelegate

/// Application entry point.
///
/// The bridge is hosted explicitly, on a plain `RCTRootView`.
///
/// Two earlier attempts at this file did not compile against React Native 0.76.5, and both
/// mistakes are worth recording:
///
/// 1. It used `RCTReactNativeFactory` and `import ReactAppDependencyProvider`, which is the
///    React Native 0.77+ app-delegate shape. This project pins 0.76.5, where no
///    `ReactAppDependencyProvider.podspec` exists, so the build failed with
///    `error: Unable to find module dependency: 'ReactAppDependencyProvider'`.
/// 2. It then used `RCTRootViewController`, which does not exist anywhere in 0.76.5 - not in
///    `RCTRootView.h`, not in any other header. The compile failed with
///    `error: cannot find 'RCTRootViewController' in scope`.
///
/// In 0.76.5 the available surface is `RCTRootView` (a `UIView`) plus `RCTBridge` and
/// `RCTBundleURLProvider`, so the root view is created directly and hosted in a stock
/// `UIViewController`. Everything used here exists in this version.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {

  var window: UIWindow?

  /// Retained for the lifetime of the app. `RCTBridge` holds its delegate weakly, so without
  /// a strong reference the bridge would lose its source-URL provider.
  private var bridge: RCTBridge?
  private var bundleURLDelegate: BundleURLDelegate?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = BundleURLDelegate()
    bundleURLDelegate = delegate

    // The delegate answers `sourceURL(for:)` with the Metro or compiled-bundle URL. Passing
    // `nil` here would leave the bridge with no way to locate the JavaScript bundle.
    let bridge = RCTBridge(delegate: delegate, launchOptions: launchOptions)
    self.bridge = bridge

    let rootView = RCTRootView(bridge: bridge, moduleName: "LocalDrop", initialProperties: nil)
    rootView.backgroundColor = UIColor.systemBackground
    rootView.frame = UIScreen.main.bounds
    rootView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    // `RCTRootView` is a `UIView`, not a view controller, so it needs a host controller.
    let host = RootViewController()
    host.view.addSubview(rootView)

    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = host
    window.makeKeyAndVisible()
    self.window = window

    return true
  }
}

/// Plain container for the React root view. React Native supplies the real UI in JavaScript, so
/// this controller does nothing but own the `RCTRootView`.
final class RootViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.systemBackground
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
