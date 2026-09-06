# StreamSaver Launch Page Copy

## Hero Section

### H1
Twitch Quality Control That Actually Sticks

### Subheadline
StreamSaver is a lightweight extension that gives you instant Twitch quality switching, two persistent viewing modes, and automatic re-apply logic built for real live-stream browsing.

### Primary CTA
Install StreamSaver

### Secondary CTA
View on GitHub

### Social Proof Line
Built for Chrome, Edge, Brave, Opera, Vivaldi, Arc, Zen, and Firefox.

---

## Core Value Props

### One Click. Eight Resolutions. Plus Source.
Switch quality from `160p` to `2160p` or `Source` directly in the popup.

### Two-Speed Streaming Modes
Set **High Quality** and **Data Saver** presets once, then toggle between them anytime.

### Smart Auto Re-Apply
StreamSaver keeps your selected mode aligned on Twitch live pages when navigation or tab state changes.

### Manual Control When You Need It
Use quick one-off quality changes without losing your saved mode setup.

---

## Reliability Section Copy

### H2
Built for Twitch UI Reality, Not Ideal Conditions

- Defensive click and visibility checks before every UI interaction
- Structured retries for quality option detection and selection
- Out-of-range fallback logic to highest/lowest available resolution
- Localized menu matching for common English and German Twitch labels
- Busy-lock protection to prevent overlapping automation requests
- Automatic menu close flow after quality changes

---

## How It Works

1. Open StreamSaver from your browser toolbar.
2. Choose your **Low** and **High** target resolutions.
3. Toggle between **Data Saver** and **High Quality** modes.
4. StreamSaver applies your target and keeps it in sync on supported Twitch live pages.

---

## Real-World Use Cases

- **Home or Office Setup:** lock in `1080p` or `Source` for maximum clarity.
- **Train, Hotel, Hotspot:** switch to `360p` or `480p` to reduce buffering and data use.
- **Background Streams:** lower quality to keep CPU, network, and fan noise under control.
- **Multitasking Sessions:** use mode switching as a fast "quality throttle" throughout the day.

---

## Feature Highlights

- One-click Twitch quality switching from popup buttons
- Persistent Low and High mode presets
- Quick Resolution section that can be shown/hidden
- Plugin logic master switch for temporary disable
- Settings persisted with `chrome.storage.local`
- Automatic enforcement with debounce and cooldown protection
- Helpful status feedback for unsupported tabs/pages
- Zero footprint on non-Twitch sites — other websites cannot detect the extension is installed. No data collected or transmitted; all settings stored locally in your browser.

---

## Supported Scope Copy

### H2
Where StreamSaver Works Best

- Supports Twitch live pages on `https://www.twitch.tv/*`
- Works across all major desktop browsers
- Best when a visible live player is present

### H3
Current Known Limits

- Non-live areas such as directory, clips, videos, and some channel subpages are not targeted for quality automation
- Available resolutions depend on stream/transcoder availability
- Twitch UI updates may occasionally require extension updates
- The Twitch settings menu can briefly open/close while applying quality

---

## Installation Section Copy

### H2
Install StreamSaver in Under a Minute

**Chrome, Edge, Brave, Opera, Vivaldi, and Arc:**

1. Open your extensions page:
   - `chrome://extensions` (Chrome, Brave, Opera, Vivaldi, Arc)
   - `edge://extensions` (Microsoft Edge)
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `StreamSaver` folder.

**Firefox & Zen:**

1. Download the latest `streamsaver-firefox-vX.X.xpi` from the releases page.
2. Open the file - Firefox will prompt you to install it directly.

---

## FAQ (SEO-Friendly)

### Does StreamSaver auto-apply quality after navigation?
Yes. StreamSaver can re-check and re-apply your selected mode on supported Twitch live pages when state changes occur.

### What if my requested quality is not available?
StreamSaver can fall back to the closest boundary resolution (highest or lowest available) when your exact target is unavailable.

### Can I temporarily turn automation off?
Yes. Use the **Plugin logic** toggle in the popup to disable automated quality changes while keeping your saved settings.

### Which Twitch pages are unsupported?
Live-player automation is focused on supported live stream views on `www.twitch.tv`; non-live sections are not the primary target.

### Which browsers support StreamSaver?
StreamSaver supports Chrome, Edge, Brave, Opera, Vivaldi, Arc, Zen, and Firefox.

### Is StreamSaver affiliated with Twitch?
No. StreamSaver is an independent project and is not affiliated with Twitch.

### Can other websites detect that StreamSaver is installed?
No. StreamSaver's content script only activates on `www.twitch.tv`. Other websites have no way to detect the extension is installed. All settings are stored locally in your browser — nothing is sent to external servers.

---

## CTA Block Copy

### Headline
Stop Re-Opening Twitch Menus Every Time

### Body
Set your viewing modes once and switch quality in one click, with practical automation designed for how Twitch actually behaves.

### Buttons
- Install StreamSaver
- View Source on GitHub
- Support on Ko-fi

---

## Footer Copy

Made for Twitch viewers who want fast, practical quality control.

Support the project on Ko-fi: https://ko-fi.com/janfeuerbacher

License: MIT
