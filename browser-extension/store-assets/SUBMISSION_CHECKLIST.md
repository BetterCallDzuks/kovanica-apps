# Store Submission Checklist — Chrome Web Store & Firefox AMO

Use this end-to-end checklist when preparing and uploading a new release of **Kovanica Wallet** (`@kovanica/browser-extension`).

---

## Phase 1: Pre-Submission Local Verification

Run all checks from `kovanica-apps/browser-extension/`:

- [ ] Confirm version matches across `package.json`, `public/manifest.json`, `public/manifest.firefox.json`, and `src/inpage/index.ts`.
- [ ] Run typecheck and unit tests:
  ```bash
  npm run typecheck
  npm test
  ```
- [ ] Build & package all store bundles reproducibly into `dist/` (gitignored):
  ```bash
  npm run package
  ```
- [ ] Verify generated archives and checksums exist in `dist/`:
  - `dist/kovanica-wallet-chrome-v<version>.zip` (+ `.sha256`)
  - `dist/kovanica-wallet-firefox-v<version>.zip` (+ `.sha256`)
  - `dist/kovanica-wallet-firefox-source-v<version>.zip` (+ `.sha256`)
- [ ] Smoke-test unpacked Chrome bundle (`dist/chrome/`) in Chrome/Brave (`chrome://extensions` -> Developer mode -> Load unpacked):
  - Create wallet, switch to Testnet, verify PRO-21 validation, lock/unlock, test `await window.kovanica.connect()` approval popup.
- [ ] Smoke-test unpacked Firefox bundle (`dist/firefox/`) in Firefox 128+ (`about:debugging#/runtime/this-firefox` -> Load Temporary Add-on -> `dist/firefox/manifest.json`):
  - Verify popup, background event page, Testnet RPC, and `window.kovanica.connect()` approval popup.
- [ ] Confirm `https://kovanica.online/privacy` is live and matches `store-assets/PRIVACY_POLICY.md`.

---

## Phase 2: Chrome Web Store Developer Dashboard

Portal: `https://chrome.google.com/webstore/devconsole`

- [ ] **Package Upload**:
  - Upload `dist/kovanica-wallet-chrome-v<version>.zip`.
  - Verify manifest parses cleanly with zero errors (MV3, `minimum_chrome_version: "120"`, `description <= 132 chars`).
- [ ] **Store Listing Tab**:
  - Paste Name, Short Summary, Full Description, Category (`Productivity`), and Language (`English`) from [CHROME_WEB_STORE.md](./CHROME_WEB_STORE.md).
  - Upload Store Icon: `store-assets/icons/icon-128.png` (128x128).
  - Upload Small Promo Tile: `store-assets/images/promo-small-440x280.png` (440x280).
  - Upload Screenshots:
    - `store-assets/images/screenshot-wallet-1280x800.png` (1280x800)
    - `store-assets/images/screenshot-approval-1280x800.png` (1280x800)
  - Set Official URL (`https://kovanica.online`) and Support URL (`https://github.com/BetterCallDzuks/kovanica-apps/issues`).
- [ ] **Privacy Practices Tab**:
  - Paste Single-Purpose Statement from [CHROME_WEB_STORE.md](./CHROME_WEB_STORE.md).
  - Paste exact permission justifications for `storage`, `alarms`, `host_permissions` (all 3 RPC origins), and `content_scripts`.
  - Select **No** for remote code usage.
  - Set Data Usage: **No user data collected** and check all 3 compliance certifications.
  - Set Privacy Policy URL (`https://kovanica.online/privacy`).
- [ ] **Distribution & Test Instructions**:
  - Paste Reviewer Test Instructions from [CHROME_WEB_STORE.md](./CHROME_WEB_STORE.md).
  - Select Public visibility and target regions.
  - Click **Submit for review**.

---

## Phase 3: Firefox Add-on Developer Hub (AMO)

Portal: `https://addons.mozilla.org/developers/`

- [ ] **Submit New Add-on / New Version**:
  - Choose **On this site** (listed distribution).
  - Upload `dist/kovanica-wallet-firefox-v<version>.zip`.
  - Verify AMO automated validator passes with `wallet@kovanica.online`, `strict_min_version: "128.0"`, and `background.scripts`.
- [ ] **Source Code Submission**:
  - Select **Yes** when asked whether the extension uses minified/bundled code.
  - Upload `dist/kovanica-wallet-firefox-source-v<version>.zip`.
  - Paste the **Notes to Reviewer & Reproducible Build Instructions** from [FIREFOX_AMO.md](./FIREFOX_AMO.md).
- [ ] **Version & Listing Metadata**:
  - Paste Name, Summary, Full Description, Categories (`Privacy & Security`, `Other`), Tags, Homepage, Support Site, and License from [FIREFOX_AMO.md](./FIREFOX_AMO.md).
  - Upload Icon (`store-assets/icons/icon-128.png`) and Screenshots (`screenshot-wallet-1280x800.png`, `screenshot-approval-1280x800.png`).
  - Paste/link Privacy Policy (`https://kovanica.online/privacy` / [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)).
  - Confirm Data Collection Declaration matches `data_collection_permissions.required: ["none"]`.
- [ ] Click **Submit Version** for Mozilla review.

---

## Phase 4: Post-Approval Release Hygiene

- [ ] Record published Chrome Web Store ID and AMO slug in `browser-extension/README.md`.
- [ ] Tag the corresponding git commit in `kovanica-apps` and attach SHA-256 checksums to the GitHub Release.
- [ ] Never commit generated `.zip` or `.sha256` files from `dist/` or `release/` to git.
