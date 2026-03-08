# StreamSaver

StreamSaver is a lightweight Chrome extension for quickly managing stream quality on `twitch.tv`.

It provides quick controls, a persistent low/high mode, and automatic re-application of your preferred quality on supported live pages.

## Why It Feels Fast

- One-click quality actions from the popup
- No account/login setup
- No build tools, no framework overhead
- Smart automation guards (lock + debounce + cooldown) to avoid UI spam and keep actions reliable

## Core Features

- Quick Resolution buttons: `160p`, `360p`, `480p`, `720p`, `1080p`, `1440p`, `2160p`, `Source`
- Saved mode resolutions for Low/High presets
- Master plugin logic on/off switch (persisted)
- Persistent mode switch:
  - `Travel / Data Saver`
  - `High Quality`
- Auto-enforcement on Twitch live pages using your active mode
- SPA-aware URL detection (keeps working when Twitch navigates without full reload)
- Auto re-check on:
  - initial load
  - storage setting changes
  - tab visible again
  - window focus
  - pageshow
- Structured popup status (`loading`, `success`, `error`)
- Quick Resolution visibility toggle (and persistence)
- Guardrails for unsupported pages (home, clips, directory, non-live subpages, etc.)
- Fallback logic when current quality detection is uncertain

## Mode Behavior (Simple)

- `low` mode enforces your saved low-mode resolution (`fastToggleLow`)
- `high` mode enforces your saved high-mode resolution (`fastToggleHigh`)
- Defaults:
  - `fastToggleLow = 480p`
  - `fastToggleHigh = Source`
  - `activeMode = high`
  - `pluginEnabled = true`

All settings are stored in `chrome.storage.local`, so they survive popup close, tab reload, and browser restart.

## Install (Local Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this `StreamSaver` folder
5. Open a Twitch live stream page and use the extension popup

## What It's For

Use StreamSaver when you want simple, predictable stream quality control without opening Twitch settings every time.

- Reduce buffering quickly when your connection drops
- Save mobile/hotspot data with a lower default quality
- Return to high quality with one click when bandwidth is stable
- Keep your preferred mode active across reloads and new stream pages
- Spend less time adjusting settings manually

## Support

If StreamSaver helps you, you can support the project here:

- [Ko-Fi](https://ko-fi.com/janfeuerbacher)

## Known Limits

- Twitch only: `https://www.twitch.tv/*`
- Depends on Twitch DOM/UI structure (Twitch updates can require selector fixes)
- Some quality levels may be unavailable per stream/transcoder conditions

## Note

StreamSaver is an independent project and is not affiliated with Twitch.
