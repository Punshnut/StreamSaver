# StreamSaver

Lightweight, persistent Twitch quality control: lock resolutions, toggle presets, auto-reapply. No more manual resets - across Chrome, Edge, Brave, Opera, Vivaldi, Arc, Zen, and Firefox

<p align="center">
  <img src="media/StreamSaverLogo.png" alt="StreamSaver logo" width="260">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/browser%20extension-8A2BE2" alt="Browser extension">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT">
</p>

<p align="center">
    <a href="https://github.com/Punshnut/StreamSaver/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest-blueviolet?style=for-the-badge" alt="Download Latest">
  </a>
</p>

## Install (Chrome-Based Browsers)

No coding is required. You are just loading the extension folder into your browser.

1. Download the latest release ZIP from the button above.
2. Open your Downloads folder and **extract / unzip** the ZIP file.
3. Open the extracted `StreamSaver` folder and make sure it contains `manifest.json`.
4. Open your browser's extensions page:
   - `chrome://extensions` for Chrome, Brave, Opera, Vivaldi, and Arc
   - `edge://extensions` for Edge
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the **extracted `StreamSaver` folder** from step 2.

Important: do not select the ZIP file itself. You must extract it first, then import the folder created from that ZIP.

## Install (Firefox/Zen Browser)

Firefox requires a signed extension file (`.xpi`). Download the latest `streamsaver-firefox-vX.X.xpi` from the releases page and open it - Firefox will prompt you to install it directly.

## What It Does

- One-click quality switching from the popup
- Two persistent modes: `High Quality` and `Travel / Data Saver`
- Auto re-apply of your selected mode on Twitch live pages without interrupting your viewing
- Settings are saved in `chrome.storage.local`

## Real-World Use Case: Two-Speed Streaming

Use StreamSaver like a two-speed mode for Twitch:

- `High Quality` (`1080p`/`Source`) for home and work
- `Travel / Data Saver` (`360p`/`480p`) for hotspot, background streams, gaming, or second-monitor use

Switch with one click as your network changes, and StreamSaver keeps your preference consistent across live pages.

All available resolutions are selectable, so you can shape the setup exactly how you want. Happy viewing!

## Limits

- Twitch only: `https://www.twitch.tv/*`
- Twitch UI changes can require updates
- Some quality levels may be unavailable per stream/transcoder conditions

## A Quick Note on the Settings Menu

StreamSaver works by briefly opening and closing Twitch's player settings menu in the background to check or set your resolution. The menu is hidden while this happens, so you won't see it flicker - but if you try to open the settings menu yourself right as the extension is doing its thing, you may have to wait about a second before it responds again.

**The good news:** you probably won't need to touch it at all. StreamSaver handles everything for you. 🎉

And don't worry about chat - the extension is smart enough to detect when you're typing and keeps its hands off. Everything comes with a cost, but I am working on making it even snappier. 😄

## Privacy

StreamSaver only activates on Twitch pages. Its content script runs exclusively on `https://www.twitch.tv/*` - other websites cannot detect the extension is installed. No data is collected or transmitted; all settings are stored locally in your browser.

## Resources

<table>
  <tr><td>📦 <strong>Download</strong></td><td><a href="https://github.com/Punshnut/StreamSaver/releases/latest">Latest release</a></td></tr>
  <tr><td>☕ <strong>Support</strong></td><td><a href="https://ko-fi.com/janfeuerbacher">Ko-Fi</a></td></tr>
  <tr><td>🔧 <strong>Build</strong></td><td><a href="docs/building.md">docs/building.md</a></td></tr>
</table>

## Disclaimer

StreamSaver is an independent project and is not affiliated with Twitch.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Punshnut/StreamSaver&type=Date)](https://www.star-history.com/#Punshnut/StreamSaver&Date)
