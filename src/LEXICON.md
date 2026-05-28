# StreamSaver Naming Lexicon

> All gaming-style names are **for fun and developer joy only.** The behaviour is identical to what a vanilla name like `clickElementSafely` or `refreshIdleStatus` would imply. This file maps every slang term to its plain-English technical meaning so the codebase stays readable to anyone, even without Twitch lore.

## Why

StreamSaver lives inside Twitch's gaming world. The names below give the source code a little of that atmosphere without sacrificing clarity - every name still describes exactly what the function does, just with a bit more style. If you ever wonder "what does `stealthClick` actually do?", look here first.

**Rule for new entries:** the gaming name must still make the function's purpose obvious to a developer who hasn't seen this file. Obscure for the sake of obscure is not the vibe.

---

## Glossary

| Gaming name | Plain name | What it does |
|---|---|---|
| `stealthClick` | `clickElementSafely` | Defensive DOM click: validates visibility and enabled state, scrolls into view, catches errors — a click that must not be detected or cause side-effects |
| `awaitSignal` | `waitForCondition` | Polls a predicate until it returns truthy or a timeout fires — waiting for the green light |
| `isAdLive` | `isAdCurrentlyPlaying` | Returns `true` when a Twitch ad overlay is visible in the player — the ad broadcast is live |
| `scanMenuRoots` | `findVisibleMenuRoots` | Queries the DOM for all currently open menu / listbox / dialog roots — a radar sweep for active overlays |
| `huntPlayerRoot` | `findPlayerRoot` (internal) | Private impl: walks a ranked selector list to locate the Twitch player container element |
| `lockedPlayerRoot` | `cachedPlayerRoot` | Module-level lock-on cache for the player root; released automatically when the element leaves the DOM |
| `wakePlayerControls` | `triggerPlayerHover` | Dispatches synthetic hover events to make the player's control bar appear — waking dormant controls |
| `mapControlZones` | `findPlayerControlScopes` | Returns all visible player-controls containers and their bounding rects — mapping the control zones |
| `huntSettingsTriggers` | `collectSettingsButtonCandidates` | Scores and ranks settings-button candidates inside the mapped control zones — hunting the right trigger |
| `decodeDispatchError` | `mapDispatchErrorToUserMessage` | Translates low-level Chrome / Firefox extension errors into readable popup status messages — decoding the error signal |
| `craftSuccessLabel` | `buildSuccessStatusMessage` | Builds the concise "Applied 1080p60" label shown after a quality change — crafting the victory message |
| `launchActionWithStatus` | `runActionWithStatus` | Fires one popup action (dispatch → await response → update status) — launching the request sequence |
| `craftQualityRequest` | `buildSetQualityRequest` | Constructs the `{ action, targetQuality }` message payload sent to the content script — forging the item |
| `decodeProbeSignal` | `mapProbeResponseToIdleStatus` | Interprets the content-script probe reply into an idle status type and message — decoding the signal |
| `probeIdleStatus` | `refreshIdleStatus` | Sends a probe to the active tab to determine the popup's idle status message — pinging the connection |
| `evadedTargets` | `escapedTargets` | Set of DOM nodes that already received a synthetic Escape key in the current close pass — already evaded |
| `hiderRefCount` | `_menuHiderCount` | Ref-count for the CSS menu-hider overlay: incremented on `showMenuHider`, decremented on `hideMenuHider` |
| `onActionComplete` | `_onEndAction` | Callback invoked after a popup action round finishes — fires when the round ends |
| `SPAWN_DELAY_MS` | `BOOT_DELAY_MS` | Initial enforcement delay after the content script first loads — the spawn-in grace period |
| `WARP_DELAY_MS` | `SPA_NAV_DELAY_MS` | Delay after a Twitch SPA navigation is detected — cooldown after warping to a new channel |
| `AD_CLEAR_DELAY_MS` | `AD_END_DELAY_MS` | Delay after the ad scanner detects the ad has ended — waiting for the screen to clear |
| `AD_SCAN_INTERVAL_MS` | `AD_POLL_INTERVAL_MS` | Interval for the ad-presence polling loop — how fast the scanner pulses |
| `lastStrikeAtMs` | `lastRunAtMs` | Timestamp of the most recent enforcement run — when the last strike landed |
| `lockedQuality` | `lastResolvedTargetQuality` | The quality value locked in during the last enforcement pass — the current lock target |
| `adScanTimerId` | `adPollingTimerId` | `setInterval` handle for the ad-presence scanner loop |
| `deployMenuShield` | `showMenuHider` | Injects CSS that clips Twitch menus to zero while the extension interacts with them — deploying a visual shield |
| `liftMenuShield` | `hideMenuHider` | Decrements the ref-count and removes the shield CSS once menus confirm closed — lifting the shield |
| `engageQuality` | `attemptSetQuality` | Full quality-change flow: open panel → match target → click option → confirm lock — engaging the target quality |
| `confirmQualityLock` | `verifyQualitySelection` | Polls visible options after a click to confirm the correct quality is now selected — verifying the lock held |
| `runQualityMission` | `executeSetQualityAutomation` | Orchestrates the full shield→close→open→select→close automation sequence — running the mission |
| `scanQualityState` | `detectCurrentQualityState` | Opens the quality panel, reads the active selection, closes — a full scan of current quality state |
| `scanQualityOptions` | `collectVisibleQualityOptions` | Collects and parses all quality entries visible in the open submenu — scanning available options |
| `readActiveQuality` | `detectCurrentSelectedQuality` | Infers which quality option is currently selected from visible menu state — reading the active lock |
| `aimQualityOption` | `findBestMatchingQualityOption` | Scores and ranks menu options against a target quality, returns the best hit — aiming for the right target |
| `deployQualityPanel` | `openQualitySubmenu` | Opens the Twitch settings menu and navigates into the quality submenu — deploying the panel |
| `lockControls` | `beginAction` | Disables all popup buttons and sets loading status while an action is in flight — locking the controls |
| `releaseControls` | `endAction` | Re-enables popup buttons and fires the round-end callback — releasing controls after the action |
| `setReleaseCallback` | `setEndActionCallback` | Registers the function called by `releaseControls` — breaks the circular dep with mode-quality |
| `isRoundActive` | `isActionInFlight` | `true` while a popup action is dispatching — a round is in progress |
| `aimQualityForMode` | `resolveTargetQualityForMode` | Picks the quality target for the current mode (Low/High) from stored settings — aiming for the mode's quality |
| `lockQualityRun` | `runQualityRequestExclusive` | Serializes quality requests so only one automation run executes at a time — holds the lock |
| `strikeMenuCloseButton` | `tryCloseViaVisibleMenuCloseEntry` | Looks for a visible "close" / "×" button and clicks it — striking the close entry |
| `strikeSettingsToggle` | `tryCloseViaSettingsToggle` | Re-clicks the settings gear to dismiss the open settings panel — striking the toggle to close |
| `retreatFromQualityPanel` | `tryStepBackFromQualitySubmenu` | Navigates one level back from the quality submenu — retreating to the parent menu |
| `parseQualityTag` | `normalizeQualityLabel` | Maps raw Twitch quality label strings ("1080p60 (source)") to canonical keys ("Source") — parsing the tag |
| `snapQualityToRange` | `resolveOutOfRangeQualityTarget` | When the requested quality is unavailable, snaps to the nearest boundary option — snapping to range |
| `missionState` | `enforcementState` | Module-level object tracking the enforcement mission: cooldown timer, last-strike timestamp, locked quality, ad scanner handle |
| `arenaState` | `fullscreenState` | Tracks whether the user intentionally entered fullscreen (the arena) and how many restoration attempts have been made |
| `queueEnforcementRound` | `scheduleEnsureDesiredQualityForCurrentMode` | Debounces and schedules a future enforcement run with a reason tag and delay — queuing the next round |
| `runEnforcementRound` | `ensureDesiredQualityForCurrentMode` | The core enforcement pass: validates page, checks cooldown/trust TTL, detects quality, applies if needed — running the round |
| `strikeCooldownMs` | `getEnforcementCooldownRemainingMs` | Returns the remaining cooldown in ms before the next enforcement strike is allowed |
| `sweepMenus` | `closeMenusIfNeeded` | Attempts to close all visible Twitch menus via multiple strategies (close button, toggle, escape, body click) — sweeping the field |
| `deploySettingsPanel` | `openSettingsMenu` | Locates and clicks the settings gear button to open the Twitch player settings panel — deploying the panel |
| `bootEnforcementLoop` | `setupAutomaticModeEnforcement` | Registers all DOM and browser event listeners that trigger quality enforcement — booting the loop |
| `bindCommandPort` | `setupMessageHandler` | Registers the `chrome.runtime.onMessage` listener for popup-to-content commands — binding the command port |
| `forgeResponse` | `makeResponse` | Constructs the structured `{ ok, action, message, details }` response envelope sent back to the popup — forging the response |
| `refreshModeHUD` | `syncModeButtonsState` | Updates mode button aria/active states and the mode summary label to reflect current active mode — refreshing the HUD |
| `rankQualityTiers` | `collectSortedAvailableQualityLevels` | Extracts and sorts available quality options by rank order (Source > 2160p > … > 160p) — ranking the tiers |
| `probeOptionState` | `analyzeQualityOptionSelectionState` | Inspects a quality menu entry's DOM state (aria-checked, aria-selected, text cues) to determine if it is currently selected |
| `routeQualityRequest` | `handleSetQualityRequest` | Entry point for setQuality messages; validates plugin state then routes to `runQualityMission` — routing the request |

---

_Add new entries here whenever a new slang name lands in the codebase. Keep the plain-name column honest._
