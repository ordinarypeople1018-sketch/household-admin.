# Build Household Admin for Android with GitHub Actions

This adds a lightweight Android WebView wrapper around the live app at:
`https://household-admin.onrender.com`

The Node.js backend remains hosted on Render. The APK is a mobile client; it does not contain or run the Node server or database locally.

## Build the APK

1. Upload/commit all files and folders in this project to the root of your GitHub repository (merge them with your existing project; do not delete `server.js`, `app.js`, `styles.css`, `index.html`, or `privacy.html`).
2. In GitHub, open **Actions**.
3. Select **Build Household Admin APK**.
4. Tap **Run workflow** and confirm.
5. When the run finishes successfully, open that run and scroll to **Artifacts**.
6. Download **Household-Admin-apk**. Extract the ZIP and install `Household-Admin-debug.apk` on Android.
7. If Android asks, allow your browser/file manager to install unknown apps.

The workflow also runs automatically when Android wrapper/workflow files change on `main` or `master`.

## Important

- This is a debug APK for personal testing/sideloading, not a Play Store release.
- The app requires internet access and the Render service to be available.
- Login/session cookies are stored by Android WebView. If you clear app data, you may need to sign in again.
- Confirm the Render URL is live before building. If the domain changes, update `APP_URL` and the allowed host in `MainActivity.java`.
- Before public release, add a proper launcher icon, signing configuration, privacy disclosures, and test on multiple Android versions.
