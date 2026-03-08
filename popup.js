(() => {
  const QUALITY_VALUES = ['160p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'Source'];
  const QUALITY_SET = new Set(QUALITY_VALUES);
  const MODE_VALUES = {
    LOW: 'low',
    HIGH: 'high'
  };
  const MODE_SET = new Set(Object.values(MODE_VALUES));
  const MODE_LABELS = {
    [MODE_VALUES.LOW]: 'Travel Mode / Data Saver',
    [MODE_VALUES.HIGH]: 'High Quality Mode'
  };
  const ACTION_NAMES = {
    SET_QUALITY: 'setQuality'
  };
  const STATUS_TYPES = {
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error'
  };
  const SETTINGS_KEYS = {
    LOW: 'fastToggleLow',
    HIGH: 'fastToggleHigh',
    ACTIVE_MODE: 'activeMode',
    QUICK_RESOLUTION_VISIBLE: 'quickResolutionVisible',
    PLUGIN_ENABLED: 'pluginEnabled'
  };
  const DEFAULT_SETTINGS = {
    [SETTINGS_KEYS.LOW]: '480p',
    [SETTINGS_KEYS.HIGH]: 'Source',
    [SETTINGS_KEYS.ACTIVE_MODE]: MODE_VALUES.HIGH,
    [SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]: false,
    [SETTINGS_KEYS.PLUGIN_ENABLED]: true
  };
  const READY_STATUS_MESSAGE = 'Ready. Manage mode or switch resolutions manually.';
  const DISABLED_STATUS_MESSAGE = 'Plugin logic is disabled. Settings are saved but Twitch quality is unchanged.';

  const statusEl = document.getElementById('status');
  const popupRoot = document.querySelector('.popup');
  const modeLowButton = document.getElementById('mode-low-btn');
  const modeHighButton = document.getElementById('mode-high-btn');
  const modeSummaryEl = document.getElementById('mode-summary');
  const qualityButtons = Array.from(document.querySelectorAll('.quality-btn'));
  const fastToggleLow = document.getElementById('fastToggleLow');
  const fastToggleHigh = document.getElementById('fastToggleHigh');
  const pluginEnabledToggle = document.getElementById('plugin-enabled');
  const pluginEnabledLabel = document.getElementById('plugin-enabled-label');
  const quickResolutionToggle = document.getElementById('quick-resolution-visible');
  const quickResolutionContent = document.getElementById('quick-resolution-content');
  const actionButtons = [...qualityButtons, modeLowButton, modeHighButton].filter(
    (button) => button instanceof HTMLButtonElement
  );

  let statusResetTimer = null;
  let isActionInFlight = false;
  let currentActiveMode = DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE];
  let isQuickResolutionVisible = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
  let isPluginEnabled = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);

  console.log('[StreamSaver][popup] Popup loaded');

  /** Clears any pending status reset timer. */
  function clearStatusResetTimer() {
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
  }

  /** Sets popup status and optional auto-reset. */
  function setStatus(type, message, autoResetMs = 0) {
    clearStatusResetTimer();
    statusEl.dataset.state = type;
    statusEl.textContent = message;

    if (autoResetMs > 0) {
      statusResetTimer = setTimeout(() => {
        statusEl.dataset.state = STATUS_TYPES.SUCCESS;
        statusEl.textContent = isPluginEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE;
        statusResetTimer = null;
      }, autoResetMs);
    }
  }

  /** Toggles all popup action buttons. */
  function setActionButtonsDisabled(disabled) {
    actionButtons.forEach((button) => {
      button.disabled = Boolean(disabled);
    });
  }

  /** Starts an action; returns false when busy. */
  function beginAction(loadingMessage) {
    if (isActionInFlight) {
      setStatus(STATUS_TYPES.LOADING, 'Another action is still running...');
      return false;
    }

    isActionInFlight = true;
    setActionButtonsDisabled(true);
    setStatus(STATUS_TYPES.LOADING, loadingMessage);
    return true;
  }

  /** Completes the current popup action and restores button interactivity. */
  function endAction() {
    isActionInFlight = false;
    setActionButtonsDisabled(false);
    syncModeButtonsState();
  }

  /** Accepts only supported quality values and falls back otherwise. */
  function sanitizeQualityValue(value, fallback) {
    return QUALITY_SET.has(value) ? value : fallback;
  }

  /** Normalizes mode values with fallback. */
  function sanitizeModeValue(value, fallback) {
    return MODE_SET.has(value) ? value : fallback;
  }

  /** Quick membership check for quality button and select input values. */
  function isSupportedQuality(value) {
    return QUALITY_SET.has(value);
  }

  /** Syncs Quick Resolution visibility and ARIA state. */
  function setQuickResolutionVisibility(visible) {
    const nextVisible = Boolean(visible);
    isQuickResolutionVisible = nextVisible;

    if (quickResolutionContent instanceof HTMLElement) {
      quickResolutionContent.hidden = !nextVisible;
    }

    if (quickResolutionToggle instanceof HTMLInputElement) {
      quickResolutionToggle.checked = nextVisible;
      quickResolutionToggle.setAttribute('aria-expanded', String(nextVisible));
    }
  }

  /** Syncs plugin enable/disable switch state and related visual cues. */
  function setPluginEnabledState(enabled) {
    const nextEnabled = Boolean(enabled);
    isPluginEnabled = nextEnabled;

    if (popupRoot instanceof HTMLElement) {
      popupRoot.dataset.pluginEnabled = String(nextEnabled);
    }

    if (pluginEnabledToggle instanceof HTMLInputElement) {
      pluginEnabledToggle.checked = nextEnabled;
      pluginEnabledToggle.setAttribute('aria-checked', String(nextEnabled));
    }

    if (pluginEnabledLabel instanceof HTMLElement) {
      pluginEnabledLabel.textContent = nextEnabled ? 'Enabled' : 'Disabled';
    }
  }

  /** Returns the display label for a mode key. */
  function getModeLabel(mode) {
    return MODE_LABELS[mode] || MODE_LABELS[MODE_VALUES.HIGH];
  }

  /** True when a URL points to any Twitch page/subdomain. */
  function isTwitchUrl(url) {
    return typeof url === 'string' && /^https:\/\/([a-z0-9-]+\.)?twitch\.tv\//i.test(url);
  }

  /** Reads the currently focused browser tab in the current window. */
  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!tabs || tabs.length === 0 || !tabs[0].id) {
          reject(new Error('No active browser tab found.'));
          return;
        }

        resolve(tabs[0]);
      });
    });
  }

  /** Sends a tab message and rejects runtime errors. */
  function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || typeof response !== 'object') {
          reject(new Error('No valid response from page script.'));
          return;
        }

        resolve(response);
      });
    });
  }

  /** Maps low-level extension transport errors to user-facing messages. */
  function mapDispatchErrorToUserMessage(errorMessage) {
    const normalized = String(errorMessage || '').toLowerCase();

    if (normalized.includes('receiving end does not exist')) {
      return 'Open a Twitch tab and try again.';
    }

    if (normalized.includes('cannot access contents of url')) {
      return 'This page is not supported. Open a Twitch tab and try again.';
    }

    if (normalized.includes('cannot access a chrome:// url')) {
      return 'This tab cannot run StreamSaver. Open a Twitch stream tab.';
    }

    if (normalized.includes('active tab is not twitch.tv')) {
      return 'Active tab is not Twitch. Open a Twitch stream tab.';
    }

    return `Request failed: ${errorMessage}`;
  }

  /** Dispatches one message to the active Twitch tab only. */
  async function dispatchToActiveTab(message) {
    const activeTab = await getActiveTab();

    if (activeTab.url && !isTwitchUrl(activeTab.url)) {
      throw new Error('Active tab is not twitch.tv.');
    }

    return sendMessageToTab(activeTab.id, message);
  }

  /** Ensures content script replies use the expected structured response envelope. */
  function isStructuredActionResponse(response, expectedAction) {
    if (!response || typeof response !== 'object') {
      return false;
    }
    if (typeof response.ok !== 'boolean' || typeof response.action !== 'string' || typeof response.message !== 'string') {
      return false;
    }
    return response.action === expectedAction;
  }

  /** Builds a concise popup success label from structured response details. */
  function buildSuccessStatusMessage(request, response) {
    const details = response && typeof response.details === 'object' ? response.details : {};
    const requestedQuality = sanitizeQualityValue(details.requestedQuality, '');
    const appliedQuality = sanitizeQualityValue(details.appliedQuality || details.targetQuality, '');
    const adjustment = details && typeof details.resolutionAdjustment === 'object' ? details.resolutionAdjustment : null;
    const direction = adjustment && adjustment.direction === 'up' ? 'up' : adjustment && adjustment.direction === 'down' ? 'down' : '';

    if (requestedQuality && appliedQuality && requestedQuality !== appliedQuality) {
      if (direction === 'down') {
        return `Requested ${requestedQuality} unavailable. Using highest available: ${appliedQuality}.`;
      }
      if (direction === 'up') {
        return `Requested ${requestedQuality} unavailable. Using lowest available: ${appliedQuality}.`;
      }
      return `Requested ${requestedQuality} unavailable. Applied ${appliedQuality}.`;
    }

    if (request.action === ACTION_NAMES.SET_QUALITY) {
      const targetQuality = sanitizeQualityValue(details.appliedQuality || details.targetQuality, '');
      if (targetQuality) {
        return `Applied ${targetQuality}.`;
      }
    }

    return response.message || 'Action completed.';
  }

  /** Runs one action and updates popup status. */
  async function runActionWithStatus(request, loadingMessage) {
    if (!isPluginEnabled) {
      setStatus(STATUS_TYPES.ERROR, 'Plugin logic is disabled. Turn it on to apply quality changes.');
      return;
    }

    if (!beginAction(loadingMessage)) {
      return;
    }

    try {
      const response = await dispatchToActiveTab(request);
      console.log('[StreamSaver][popup] Response from content script:', response);

      if (!isStructuredActionResponse(response, request.action)) {
        setStatus(STATUS_TYPES.ERROR, 'Invalid response from content script.');
        return;
      }

      if (!response.ok) {
        setStatus(STATUS_TYPES.ERROR, response.message || 'Action failed.');
        return;
      }

      setStatus(STATUS_TYPES.SUCCESS, buildSuccessStatusMessage(request, response), 1500);
    } catch (error) {
      console.error('[StreamSaver][popup] Message dispatch failed:', error);
      setStatus(STATUS_TYPES.ERROR, mapDispatchErrorToUserMessage(error.message));
    } finally {
      endAction();
    }
  }

  /** Creates the normalized payload used for direct quality-set actions. */
  function buildSetQualityRequest(quality) {
    return {
      action: ACTION_NAMES.SET_QUALITY,
      targetQuality: quality
    };
  }

  /** Reads and sanitizes the configured low/high mode resolutions from dropdowns. */
  function readModeResolutions() {
    return {
      lowValue: sanitizeQualityValue(fastToggleLow.value, DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]),
      highValue: sanitizeQualityValue(fastToggleHigh.value, DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH])
    };
  }

  /** Updates mode button state and summary text. */
  function syncModeButtonsState() {
    const activeMode = sanitizeModeValue(currentActiveMode, MODE_VALUES.HIGH);
    const lowIsActive = activeMode === MODE_VALUES.LOW;
    const highIsActive = activeMode === MODE_VALUES.HIGH;

    if (popupRoot instanceof HTMLElement) {
      popupRoot.dataset.activeMode = activeMode;
    }
    modeLowButton.dataset.active = String(lowIsActive);
    modeHighButton.dataset.active = String(highIsActive);
    modeLowButton.setAttribute('aria-pressed', String(lowIsActive));
    modeHighButton.setAttribute('aria-pressed', String(highIsActive));
    modeSummaryEl.textContent = `Current mode: ${getModeLabel(activeMode)}`;
  }

  /** Handles one quick-resolution button click and dispatches setQuality. */
  function handleQualityButtonClick(button) {
    const quality = sanitizeQualityValue(button.dataset.quality, 'Unknown');
    console.log(`[StreamSaver][popup] Quality click: ${quality}`);

    if (!isSupportedQuality(quality)) {
      setStatus(STATUS_TYPES.ERROR, 'Unsupported quality button value.');
      return;
    }

    runActionWithStatus(buildSetQualityRequest(quality), `Applying ${quality}...`);
  }

  /** Saves mode change, then applies its target quality. */
  async function handleModeButtonClick(mode) {
    const normalizedMode = sanitizeModeValue(mode, MODE_VALUES.HIGH);

    if (normalizedMode === currentActiveMode) {
      setStatus(STATUS_TYPES.SUCCESS, `Mode already set: ${getModeLabel(normalizedMode)}.`, 1000);
      return;
    }

    const previousMode = currentActiveMode;
    currentActiveMode = normalizedMode;
    syncModeButtonsState();
    const didSave = await saveSetting(SETTINGS_KEYS.ACTIVE_MODE, normalizedMode, `Mode set: ${getModeLabel(normalizedMode)}.`);
    if (!didSave) {
      currentActiveMode = previousMode;
      syncModeButtonsState();
      return;
    }

    if (!isPluginEnabled) {
      setStatus(STATUS_TYPES.SUCCESS, 'Mode saved. Plugin logic is disabled, so no player changes were applied.', 1400);
      return;
    }

    const { lowValue, highValue } = readModeResolutions();
    const targetQuality = normalizedMode === MODE_VALUES.LOW ? lowValue : highValue;
    runActionWithStatus(buildSetQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(normalizedMode)}...`);
  }

  /** Binds click handlers for quality and mode controls. */
  function bindActionHandlers() {
    qualityButtons.forEach((button) => {
      button.addEventListener('click', () => {
        handleQualityButtonClick(button);
      });
    });

    modeLowButton.addEventListener('click', () => {
      handleModeButtonClick(MODE_VALUES.LOW);
    });

    modeHighButton.addEventListener('click', () => {
      handleModeButtonClick(MODE_VALUES.HIGH);
    });
  }

  /** Loads persisted settings and hydrates popup controls. */
  async function loadSettings() {
    setActionButtonsDisabled(true);
    setStatus(STATUS_TYPES.LOADING, 'Loading settings...');

    try {
      const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
      const lowValue = sanitizeQualityValue(stored[SETTINGS_KEYS.LOW], DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]);
      const highValue = sanitizeQualityValue(stored[SETTINGS_KEYS.HIGH], DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH]);
      const activeMode = sanitizeModeValue(stored[SETTINGS_KEYS.ACTIVE_MODE], DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE]);
      const quickResolutionVisible = stored[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE] === true;
      const pluginEnabled = stored[SETTINGS_KEYS.PLUGIN_ENABLED] !== false;

      fastToggleLow.value = lowValue;
      fastToggleHigh.value = highValue;
      currentActiveMode = activeMode;
      setQuickResolutionVisibility(quickResolutionVisible);
      setPluginEnabledState(pluginEnabled);
      syncModeButtonsState();

      console.log('[StreamSaver][popup] Settings loaded:', {
        lowValue,
        highValue,
        activeMode,
        quickResolutionVisible,
        pluginEnabled
      });
      setStatus(STATUS_TYPES.SUCCESS, isPluginEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE);
    } catch (error) {
      console.error('[StreamSaver][popup] Failed to load settings:', error);
      fastToggleLow.value = DEFAULT_SETTINGS[SETTINGS_KEYS.LOW];
      fastToggleHigh.value = DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH];
      currentActiveMode = DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE];
      setQuickResolutionVisibility(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
      setPluginEnabledState(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);
      syncModeButtonsState();
      setStatus(STATUS_TYPES.ERROR, 'Failed to load settings. Using defaults.');
    } finally {
      if (!isActionInFlight) {
        setActionButtonsDisabled(false);
      }
      syncModeButtonsState();
    }
  }

  /** Persists one settings key immediately in local extension storage. */
  async function saveSetting(key, value, successMessage = '') {
    try {
      await chrome.storage.local.set({ [key]: value });
      console.log(`[StreamSaver][popup] Saved setting ${key}: ${value}`);
      setStatus(STATUS_TYPES.SUCCESS, successMessage || `Saved ${key}: ${value}`, 1200);
      return true;
    } catch (error) {
      console.error(`[StreamSaver][popup] Failed to save setting ${key}:`, error);
      setStatus(STATUS_TYPES.ERROR, `Failed to save ${key}.`);
      return false;
    }
  }

  /** Validates and saves a dropdown change for either mode resolution endpoint. */
  function handleSelectChange(settingKey, selectEl) {
    const selectedValue = sanitizeQualityValue(selectEl.value, DEFAULT_SETTINGS[settingKey]);

    if (selectedValue !== selectEl.value) {
      selectEl.value = selectedValue;
      setStatus(STATUS_TYPES.ERROR, 'Invalid quality value selected.');
      return;
    }

    console.log(`[StreamSaver][popup] ${settingKey} set to: ${selectedValue}`);
    saveSetting(settingKey, selectedValue);
  }

  fastToggleLow.addEventListener('change', () => {
    handleSelectChange(SETTINGS_KEYS.LOW, fastToggleLow);
  });

  fastToggleHigh.addEventListener('change', () => {
    handleSelectChange(SETTINGS_KEYS.HIGH, fastToggleHigh);
  });

  if (pluginEnabledToggle instanceof HTMLInputElement) {
    pluginEnabledToggle.addEventListener('change', async () => {
      const nextEnabled = pluginEnabledToggle.checked;
      const previousEnabled = isPluginEnabled;

      setPluginEnabledState(nextEnabled);
      const didSave = await saveSetting(
        SETTINGS_KEYS.PLUGIN_ENABLED,
        nextEnabled,
        nextEnabled ? 'Plugin logic enabled.' : 'Plugin logic disabled.'
      );

      if (!didSave) {
        setPluginEnabledState(previousEnabled);
        return;
      }

      if (!nextEnabled) {
        return;
      }

      const { lowValue, highValue } = readModeResolutions();
      const targetQuality = currentActiveMode === MODE_VALUES.LOW ? lowValue : highValue;
      runActionWithStatus(buildSetQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(currentActiveMode)}...`);
    });
  }

  if (quickResolutionToggle instanceof HTMLInputElement) {
    quickResolutionToggle.addEventListener('change', () => {
      const visible = quickResolutionToggle.checked;
      setQuickResolutionVisibility(visible);
      saveSetting(
        SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE,
        visible,
        visible ? 'Quick Resolution shown.' : 'Quick Resolution hidden.'
      );
    });
  }

  bindActionHandlers();
  syncModeButtonsState();
  setPluginEnabledState(isPluginEnabled);
  setQuickResolutionVisibility(isQuickResolutionVisible);
  loadSettings();
})();
