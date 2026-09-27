# LocalDrop

Wirelessly back up photos and videos from an iPhone to a Windows PC over your own Wi-Fi.
No iCloud, no iTunes, no Apple desktop software, and nothing leaves your network.

```
iPhone (React Native + Photos framework)  ──HTTP──▶  Windows PC (Tauri + Rust + SQLite)
```

---

## What it does

Open the app, grant Photos access, and the PC running LocalDrop appears automatically.
Enter the six-digit code it shows, choose what to send, and the original files stream
straight to your PC. Every received file is verified with SHA-256 before it is filed
into the library, and a file is only ever reported as backed up once the PC has
recomputed the same hash over the bytes it actually received.

**Supported in this version:** HEIC, HEIF, JPEG, PNG, MOV, MP4, including Live Photos
(both halves, kept together), large files, progress, retries, verification, history.

**This version never deletes anything** — not from your iPhone, not from the backup
folder. A safe cleanup feature is planned but not implemented.

---

## Layout

```
packages/shared/          wire protocol, folder/naming rules, media + pairing helpers
apps/ios/                 React Native app
  ios/LocalDrop/Native/   the Swift/ObjC bridge (Photos, mDNS, Keychain, uploads)
apps/windows/             Tauri app
  src/                    React dashboard
  src-tauri/src/          the backup server: axum + SQLite
scripts/                  project generation, icon generation, verification
```

### Where the code is allowed to touch the network

| Layer | Transport | Why |
|---|---|---|
| `ServerClient` (phone) | `fetch` | Small JSON control-plane calls only. |
| `FileUploader` (Swift) | `URLSession` from a file URL | Streams bytes from disk. A 4 GB video costs one socket buffer of memory, not 4 GB. |
| `LocalDropTransfer` (Swift) | `PHAssetResourceManager` | Exports originals to a staging file in 1 MiB blocks. |

React Native's `fetch` is never given a file body, and no image data is ever base64'd
across the bridge: thumbnails are written to disk by the native module and rendered from
a `file://` URL.

---

## Requirements

| | |
|---|---|
| Windows | Rust 1.77+, Node 20+, `cargo`, and MSVC build tools (`rustup` + VS Build Tools) |
| macOS (to build the iOS app) | Xcode 15+, CocoaPods, Node 20+ |
| Network | iPhone and PC on the same Wi-Fi. mDNS must not be blocked; there is a manual IP fallback if it is. |

---

## Running it

### 1. Install

```bash
npm install
```

### 2. Windows companion

```bash
npm run tauri:dev          # dashboard + server, with hot reload
# or a distributable build:
npm run tauri:build        # produces an .msi / NSIS installer
```

The server listens on `0.0.0.0:47821` and advertises itself as `_localdrop._tcp`
so the iPhone finds it without being told an address. The dashboard shows the
pairing code, the live transfer, the library totals and the full history.

The library defaults to `D:\iPhone Backup` when that drive exists, otherwise a folder
in your profile. Both are changeable from the dashboard.

### 3. iPhone app (macOS only)

The Xcode project is generated from React Native's own template and verified by script,
so there is no hand-edited `.pbxproj` to drift out of sync:

```bash
node scripts/generate-ios-project.js     # optional; the output is committed
cd apps/ios/ios
pod install
open LocalDrop.xcworkspace
```

Then run the `LocalDrop` scheme. Start Metro first with `npm start` in `apps/ios`.

**After changing anything under `ios/LocalDrop/Native/`, rebuild the app in Xcode.**
Those are compiled Swift/Objective-C files; reloading JavaScript is not enough.

### If the iPhone cannot see the PC

In order of likelihood:

1. **The app is out of date.** Sideload the `.ipa` from the latest
   [successful build](https://github.com/pushpakjain628/localdrop/actions). A build from before
   the App Transport Security fix cannot make *any* request to the PC, because the app talks
   plain HTTP and iOS blocks cleartext by default. `Info.plist` now carries an
   `NSAppTransportSecurity` exception scoped to local networking.

2. **The phone and the PC are not on the same Wi-Fi.** Guest networks in particular isolate
   clients from each other, so mDNS never crosses them.

3. **Windows Firewall is blocking the port.** The server binds `0.0.0.0:47821`, and the first
   launch normally prompts to allow it. If that prompt was dismissed, allow it for **all**
   profiles — the rules Windows creates on first run are often scoped to one profile, and a
   profile change silently breaks them:

   ```powershell
   # Run PowerShell as Administrator
   New-NetFirewallRule -DisplayName "LocalDrop" `
     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47821 `
     -Profile Any
   ```

4. **Discovery is blocked but the network works.** Tap **Enter address** on the phone and type
   the address from **On this network** in the dashboard's top bar. That is the documented
   fallback and it needs nothing but the two devices being on the same subnet.

---

## Verification

```bash
node scripts/verify.js
```

Runs, and requires to pass:

| Check | Covers |
|---|---|
| `shared: typecheck` / `tests` | Protocol types, naming rules, filename safety, pairing code logic |
| `ios: typecheck` / `tests` | The app's TypeScript, plus the transfer engine, discovery and pairing |
| `windows: cargo test` | The server: 120 unit + 46 HTTP integration tests |
| `windows: clippy -D warnings` | Lints across the whole crate |
| `windows: cargo fmt --check` | Formatting |
| `windows: dashboard build` | The React dashboard typechecks and bundles |
| `ios: generate Xcode project` | Re-generates the project and asserts every source is compiled, the bridging header and `Info.plist` are wired up, and no template leftovers remain |

### What is *not* verified here

The Swift and Objective-C sources in `apps/ios/ios/LocalDrop/Native/` are **not compiled
by any check that can run on Windows**. They are complete and reviewed, but the first
real compilation happens on a Mac with Xcode. Expect to fix ordinary compile errors on
first build.

The end-to-end path — a real photo library, a real mDNS handshake, a real upload — has
also not been executed, because that needs both an iPhone and a PC on one network.

---

## Design notes

### Why three credential spaces

The server has three auth groups, and the split is deliberate
(`apps/windows/src-tauri/src/http/server.rs`):

* **public** — `/api/health`, `/api/pair`, `/api/dashboard-token`
* **phone** — the paired iPhone, authenticated with a 256-bit bearer token issued against
  a short-lived single-use code. Only SHA-256 of the token is stored, and every secret
  comparison is constant-time.
* **dashboard** — this app's own window, with a token regenerated on every launch and
  required to arrive over loopback.

The dashboard deliberately does *not* get a phone token: it must never be able to act as a
paired iPhone.

### Why uploads are three requests, not one

`begin` reserves a destination, `PUT .../content` streams bytes, `complete` verifies.
A single `POST` would have to be either fully buffered (impossible for a 4 GB video) or
unverifiable (no point at which the hash can be checked). Splitting them also means the
phone can skip a file the PC already has before sending a single byte.

### Nothing is trusted from the phone

Filenames are sanitised on the PC — path separators stripped, Windows-reserved names
escaped, trailing dots removed, length capped — and a traversal attempt is flattened
rather than obeyed. There is a test for exactly that.

### The library is organised, and collisions are handled

```
D:\iPhone Backup\
  Photos\2026\09-September\IMG_1234.HEIC
  Photos\2026\09-September\IMG_1234.MOV     ← Live Photo video half, beside its photo
  Videos\2026\09-September\IMG_5678.MOV
```

Two different assets that happen to share a name become `IMG_1.HEIC` and
`IMG_1 (2).HEIC`. A Live Photo's two halves are filed together and linked in SQLite by
`live_photo_id`, because splitting them across `Photos/` and `Videos/` would break the
relationship the user sees in Photos.

### Deduplication happens twice

By `PHAsset.localIdentifier` (the same photo, re-offered) and by SHA-256 (the same bytes
arriving under a different identifier, e.g. after a Photos re-import). Only `completed`
rows count, so a failed transfer never suppresses a retry.

---

## Security

The transport is plain HTTP, so the guarantee offered is **"an unpaired device on this
Wi-Fi cannot read or write your library"**, not confidentiality of the traffic. If you
need that, put the two devices on a VPN or use a router that supports it.

Protections that are in place:

* Pairing codes are 6 digits, expire after 5 minutes, and are single-use.
* Bearer tokens are 256-bit, stored only as SHA-256, and compared in constant time.
* Uploads are streamed to a staging file and hashed as they arrive; the file is only
  moved into the library after the hashes match.
* Filenames from the phone are never trusted.
* The Tauri webview is granted only `core:default` capabilities.
* The pairing token is in the iOS Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — never iCloud Keychain, never a
  device backup.
