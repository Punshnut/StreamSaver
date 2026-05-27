# Building StreamSaver

## Requirements

| Tool | Minimum version | Notes |
|------|----------------|-------|
| [Node.js](https://nodejs.org) | 18 | Provides `node` and `npm` |
| `zip` | any | Pre-installed on macOS and most Linux distros |
| `git` | any | To clone the repo |

> **Windows:** use [Git Bash](https://git-scm.com/downloads) or WSL to run the `.sh` scripts.

---

## Quick start

```bash
git clone https://github.com/Punshnut/StreamSaver.git
cd StreamSaver
bash build-extension.sh
```

On the first run `build-extension.sh` automatically installs the one dev dependency ([esbuild](https://esbuild.github.io)) via `npm install`. A platform argument is optional — see [Build options](#build-options) below.

---

## Output

| File | Platform |
|------|----------|
| `dist/streamsaver-chrome-vX.X.X.zip` | Chrome, Edge, Brave, Opera, Vivaldi, Arc, Zen |
| `dist/streamsaver-firefox-vX.X.X.xpi` | Firefox |

The staging directories `build/chrome/` and `build/firefox/` are also kept after the build — you can load either directly as an unpacked extension for testing.

---

## Build options

```bash
bash build-extension.sh           # build both platforms (default)
bash build-extension.sh chrome    # Chrome/Chromium only
bash build-extension.sh firefox   # Firefox only
```

---

## How the build works

Source lives in `src/` as ES modules. [esbuild](https://esbuild.github.io) bundles them into two flat files the browser loads:

```
src/content/main.js  ──esbuild──▶  build/{platform}/content.js
src/popup/main.js    ──esbuild──▶  build/{platform}/popup.js
```

Static assets (`popup.html`, `styles.css`, `icons/`) are copied as-is. The correct manifest is placed at the root of each platform's staging directory before zipping.

### Source layout

```
src/
  shared/
    constants.js          # QUALITY_VALUES, MODE_VALUES — shared by content and popup
  content/                # injected into Twitch pages
    main.js               # entry point
    constants.js          # content-script constants and timing values
    utils.js              # debug, wait, visibility helpers, click safety
    geometry.js           # rect math (serializeRect, isRectInside, isRectNear)
    quality-matching.js   # label normalisation and target matching
    player.js             # player root detection, control scopes
    menu-hider.js         # CSS hider injected during menu automation
    menu-find.js          # findVisibleMenuRoots, text-fallback finder
    settings-menu.js      # open/validate the Twitch settings overlay
    quality-menu.js       # quality submenu: open, collect options, detect selection
    quality-apply.js      # attemptSetQuality, verifyQualitySelection
    menu-close.js         # multi-strategy menu dismissal
    ad-detection.js       # isAdCurrentlyPlaying
    fullscreen.js         # fullscreen detection and restoration
    page-support.js       # page validation, input sanitisers
    storage.js            # chrome.storage read helpers
    automation.js         # executeSetQualityAutomation, request orchestration
    enforcement.js        # automatic mode enforcement loop
    setup.js              # message handler, event hooks, SPA navigation watcher
  popup/
    main.js               # entry point
    constants.js          # popup-only constants and status strings
    ui.js                 # DOM refs, status display, button locking
    messaging.js          # chrome.tabs messaging, runActionWithStatus
    idle-status.js        # tab readiness probe, idle status mapping
    mode-quality.js       # mode/quality state, button handlers
    settings.js           # loadSettings, saveSetting, select change handler
    popup.html            # popup markup
    styles.css            # popup styles
```

---

## Versioning

`manifest.json` is the single source of truth for the version number. Every run of `build-extension.sh` automatically syncs the version to `manifest.firefox.json` and `package.json` — you only need to update it in one place.
