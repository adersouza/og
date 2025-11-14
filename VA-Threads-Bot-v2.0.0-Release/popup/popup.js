// Constants
const MSG = {
  START: 'START_BOT',
  STOP: 'STOP_BOT',
  GET_STATUS: 'GET_STATUS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  VALIDATE_POSTS: 'VALIDATE_POSTS',
  EXPORT_SETTINGS: 'EXPORT_SETTINGS',
  IMPORT_SETTINGS: 'IMPORT_SETTINGS',
  EXPORT_POSTS_TXT: 'EXPORT_POSTS_TXT',
  IMPORT_POSTS_TXT: 'IMPORT_POSTS_TXT',
  STATUS_UPDATE: 'STATUS_UPDATE',
  NOTICE: 'NOTICE',
  RESET_ALL: 'RESET_ALL'
};

const RUN_STATE = {
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED_BY_SCHEDULE: 'PAUSED_BY_SCHEDULE',
  AWAITING_LOGIN: 'AWAITING_LOGIN',
  COOLING_DOWN: 'COOLING_DOWN'
  
};

// Protection against re-initializations
let eventsAlreadyBound = false;

// Posts input auto-save timer (used in bindEvents and onShuffleOnce)
let postsInputTimer = null;
let postsInputPending = false;

// Flag to prevent renderAutoPost from overwriting user changes
let mediaProfileChanging = false;

// Helper function to populate profile dropdown
function populateProfileDropdown(dropdown, profiles, selectedValue = null) {
  if (!dropdown) return;

  dropdown.innerHTML = '';

  Object.entries(profiles).forEach(([id, name]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    dropdown.appendChild(option);
  });

  if (selectedValue && profiles[selectedValue]) {
    dropdown.value = selectedValue;
  }
}


const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland'
];

// UI State
const ui = {
  settings: null,
  runtime: null,
  validation: {
    tooLong: [],
    empty: []
  },
  activeTab: 'dashboard',
  statusUpdateInterval: null
};

// DOM References (memoized)
const dom = {};

function initDOMRefs() {
  // Header elements
  dom.app = document.getElementById('app');
  dom.statusChip = document.getElementById('statusChip');
  dom.btnStartStop = document.getElementById('btnStartStop');
  dom.timerPost = document.querySelector('#timerPost .value');
  dom.timerActivity = document.querySelector('#timerActivity .value');
  
  // Tab buttons
  dom.tabs = {
    dashboard: document.getElementById('tabDashboard'),
    autopost: document.getElementById('tabAutopost'),
    activity: document.getElementById('tabActivity'),
    media: document.getElementById('tabMedia'),  // ← AJOUTÉ
    settings: document.getElementById('tabSettings')
  };
  
  // Panels
  dom.panels = {
    dashboard: document.getElementById('panelDashboard'),
    autopost: document.getElementById('panelAutopost'),
    activity: document.getElementById('panelActivity'),
    media: document.getElementById('panelMedia'),  // ← AJOUTÉ
    settings: document.getElementById('panelSettings')
  };
  
  // Dashboard elements
  dom.postsToday = document.getElementById('postsToday');
  dom.totalPostsLifetime = document.getElementById('totalPostsLifetime');
  dom.activityTimeToday = document.getElementById('activityTimeToday');
  dom.sessionsToday = document.getElementById('sessionsToday');
  dom.likesToday = document.getElementById('likesToday');
  dom.commentLikesToday = document.getElementById('commentLikesToday');
  dom.tweetsOpenedToday = document.getElementById('tweetsOpenedToday');
  dom.profilesVisitedToday = document.getElementById('profilesVisitedToday');
  dom.scrollsToday = document.getElementById('scrollsToday');
  dom.refreshesToday = document.getElementById('refreshesToday');

  dom.activityList = document.getElementById('activityList');
  dom.postsList = document.getElementById('postsList');

  // Settings panel elements
  dom.timezoneSelect = document.getElementById('timezoneSelect');
  dom.darkToggle = document.getElementById('darkToggle');
  dom.btnExportConfig = document.getElementById('btnExportConfig');
  dom.btnImportConfig = document.getElementById('btnImportConfig');
  dom.fileImportConfig = document.getElementById('fileImportConfig');



  dom.btnResetMedia = document.getElementById('btnResetMedia');
  dom.btnResetAll = document.getElementById('btnResetAll');
  dom.modalConfirmReset = document.getElementById('modalConfirmReset');
  dom.resetConfirmInput = document.getElementById('resetConfirmInput');
  dom.btnConfirmReset = document.getElementById('btnConfirmReset');
  dom.btnCancelReset = document.getElementById('btnCancelReset');
  
  // Auto-post panel elements
  dom.autopostToggle = document.getElementById('autopostToggle');
  dom.postsCountN = document.getElementById('postsCountN');
  dom.postsProgressI = document.getElementById('postsProgressI');
  dom.postsProgressN = document.getElementById('postsProgressN');
  dom.btnShuffleOnce = document.getElementById('btnShuffleOnce');
  dom.postsInput = document.getElementById('postsInput');
  dom.intervalMin = document.getElementById('intervalMin');
  dom.intervalMax = document.getElementById('intervalMax');
  dom.autopostPauseList = document.getElementById('autopostPauseList');
  dom.btnAutopostPauseAdd = document.getElementById('btnAutopostPauseAdd');
  dom.autopostValidationSummary = document.getElementById('autopostValidationSummary');
  
  // ✅ Activity panel elements - FIXED with correct IDs
  dom.activityToggle = document.getElementById('activityToggle');

  // Activity stats
  dom.activityTimeActive = document.getElementById('activityTimeActive');
  dom.sessionsProgress = document.getElementById('sessionsProgress');
  dom.likesActivity = document.getElementById('likesActivity');
  dom.commentLikesActivity = document.getElementById('commentLikesActivity');
  dom.tweetsOpenedActivity = document.getElementById('tweetsOpenedActivity');
  dom.profilesActivity = document.getElementById('profilesActivity');
  dom.scrollsActivity = document.getElementById('scrollsActivity');
  dom.notificationsActivity = document.getElementById('notificationsActivity');

  // Mood display
  dom.moodLowDisplay = document.getElementById('moodLowDisplay');
  dom.moodNormalDisplay = document.getElementById('moodNormalDisplay');
  dom.moodHighDisplay = document.getElementById('moodHighDisplay');
  dom.todayMoodBadge = document.getElementById('todayMoodBadge');
  
  // Pause schedule
  dom.activityPauseList = document.getElementById('activityPauseList');
  dom.btnActivityPauseAdd = document.getElementById('btnActivityPauseAdd');
}

// Messaging
async function send(msg, payload = {}) {
  return chrome.runtime.sendMessage({ type: msg, ...payload });
}

// Initialize
async function init() {
  initDOMRefs();

  // Check license status first
  try {
    const settings = await chrome.storage.sync.get('licenseKey');

    if (!settings.licenseKey) {
      // No license key, redirect to activation screen
      window.location.href = 'license-activation.html';
      return;
    }

    // Request background to verify license (updates UI storage)
    chrome.runtime.sendMessage({ type: 'VERIFY_LICENSE' }).then(() => {
      // Refresh user info after verification
      setTimeout(() => updateUserInfo(), 500);
    }).catch(() => {
      // Ignore if background script not ready
    });

    // Load and display user info in header (will show cached data initially)
    updateUserInfo();
  } catch (error) {
    console.error('Failed to check license status:', error);
  }

  // ========== LICENSE & NETWORK LISTENERS ==========
  // Listen for license expiration and network error messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'LICENSE_EXPIRED') {
      console.log('🔑 License expired, redirecting to activation...');
      toast(message.message || 'License expired', 'error');
      setTimeout(() => {
        window.location.href = 'license-activation.html';
      }, 3000);
    }

    if (message.type === 'NETWORK_ERROR') {
      console.warn('🌐 Network error detected after retries');
      toast(message.message || 'Network connection issue', 'error');
    }
  });
  // ========== END LISTENERS ==========

  // ========== KEEP-ALIVE ==========
  // Keep the service worker awake while popup is open
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }, () => {
      // Ignore errors if background doesn't respond
      if (chrome.runtime.lastError) {
        console.log('Background sleeping, will wake up on next message');
      }
    });
  }, 25000); // Every 25 seconds (before the 30 second limit)

  // Stop keep-alive when popup closes
  window.addEventListener('beforeunload', () => {
    clearInterval(keepAliveInterval);

    // ✅ Save posts if there are pending changes
    if (postsInputPending && dom.postsInput) {
      const value = dom.postsInput.value;
      chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        settings.postsRaw = value;
        chrome.storage.local.set({ settings });
      });
    }
  });
  // ========== END OF KEEP-ALIVE ==========

  // Get initial status with improved error handling
  let retries = 0;
  const maxRetries = 3;
  let connected = false;

  while (retries < maxRetries && !connected) {
    try {
      // First send a keep-alive to wake up the background
      if (retries > 0) {
        try {
          await chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' });
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          // Ignore keep-alive error
        }
      }
      
      // Try to retrieve the status
      const response = await send(MSG.GET_STATUS);
      ui.settings = response.settings;
      ui.runtime = response.runtime;
      connected = true;
      
      // Apply theme
      if (ui.settings?.darkMode) {
        dom.app.classList.add('theme-dark');
      }

      // ========== INITIALISATION MEDIA ==========
      // Initialize Media immediately if panel exists
      if (document.getElementById('panelMedia')) {
        try {
          window.media = new Media();
          await window.media.init();
          window.media.initialized = true;
          console.log('✅ Media manager initialized at startup');
        } catch (error) {
          console.error('Failed to initialize media manager:', error);
          // Fallback
          window.media = {
            profiles: { default: 'Default' },
            initialized: false
          };
        }
      }
      // ========== FIN INITIALISATION MEDIA ==========

      // Set up event listeners
      bindEvents();

      // Initial render (after media initialization)
      renderAll();

      // Start status polling
      startStatusPolling();

      // Listen for status updates from background
      chrome.runtime.onMessage.addListener((message) => {
        if (message.type === MSG.STATUS_UPDATE) {
          // ✅ FIX: Update both runtime AND settings to prevent stale data
          ui.runtime = message.runtime;
          if (message.settings) {
            // Merge settings instead of replacing to preserve local updates
            ui.settings = { ...ui.settings, ...message.settings };
          }
          renderHeader();
          renderDashboard();
          renderAutoPost();
          renderActivity();
        } else if (message.type === MSG.NOTICE) {
          handleNotice(message);
        }
      });
      
    } catch (error) {
      retries++;
      console.log(`Connection attempt ${retries}/${maxRetries} failed:`, error.message);
      
      if (retries >= maxRetries) {
        console.error('Failed to connect after all retries:', error);

        // Display an error state in the UI
        if (dom && dom.statusChip) {
          dom.statusChip.textContent = 'Disconnected';
          dom.statusChip.setAttribute('data-status', 'ERROR');
        }

        // Show toast if available
        if (typeof toast === 'function') {
          toast('Failed to connect to background service', 'error');
        }
        return;
      }

      // Wait before retrying (progressive delay)
      await new Promise(resolve => setTimeout(resolve, retries * 500));
    }
  }
}

// Event Binding
function bindEvents() {
  if (eventsAlreadyBound) {
    console.log('Events already bound, skipping re-bind');
    return;
  }
  eventsAlreadyBound = true;
  
  // Start/Stop button
  dom.btnStartStop.addEventListener('click', onStartStopClick);
  
  // Tab navigation
Object.entries(dom.tabs).forEach(([key, tab]) => {
  tab.addEventListener('click', async () => {
    // Switch tab
    switchTab(key);

    // Synchronize profiles when going to Auto-Post
    if (key === 'autopost') {
      await syncMediaProfilesToAutoPost();
    }
  });
});
  
  // Settings tab events
  dom.timezoneSelect.addEventListener('change', async (e) => {
    // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
    const newValue = e.target.value;
    ui.settings.timezone = newValue;

    // Save to storage in background
    try {
      await send(MSG.UPDATE_SETTINGS, { patch: { timezone: newValue } });
    } catch (error) {
      console.error('Failed to update timezone:', error);
      toast('Failed to update setting', 'error');
    }
  });

  dom.darkToggle.addEventListener('change', async (e) => {
    // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
    const newValue = e.target.checked;
    ui.settings.darkMode = newValue;

    // Apply theme immediately
    if (newValue) {
      dom.app.classList.add('theme-dark');
    } else {
      dom.app.classList.remove('theme-dark');
    }

    // Save to storage in background
    try {
      await send(MSG.UPDATE_SETTINGS, { patch: { darkMode: newValue } });
    } catch (error) {
      console.error('Failed to update darkMode:', error);
      toast('Failed to update setting', 'error');
    }
  });

  dom.btnExportConfig.addEventListener('click', onExportConfig);
  dom.btnImportConfig.addEventListener('click', () => {
    dom.fileImportConfig.click();
  });
  dom.fileImportConfig.addEventListener('change', onImportConfig);

  dom.btnResetMedia.addEventListener('click', async () => {
    if (confirm('Delete corrupted media database and restart fresh?\n\nThis will delete all media profiles and images.')) {
      try {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase('ThreadsBotMedia');
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        // Reset media object to allow re-initialization
        window.media = {
          profiles: { default: 'Default' },
          initialized: false
        };

        toast('Media database deleted successfully!', 'success');
        dom.btnResetMedia.textContent = 'Reset Media Database ✓';

        // Re-enable after 2 seconds
        setTimeout(() => {
          dom.btnResetMedia.textContent = 'Reset Media Database';
        }, 2000);
      } catch (error) {
        console.error('Failed to delete media database:', error);
        toast('Failed to delete media database', 'error');
      }
    }
  });

  dom.btnResetAll.addEventListener('click', () => {
    dom.modalConfirmReset.style.display = 'flex';
    dom.resetConfirmInput.value = '';
    dom.resetConfirmInput.focus();
  });

  dom.btnConfirmReset.addEventListener('click', onConfirmReset);
  dom.btnCancelReset.addEventListener('click', () => {
    dom.modalConfirmReset.style.display = 'none';
  });

  dom.resetConfirmInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' && e.target.value === 'RESET') {
      onConfirmReset();
    }
  });
  
  // Auto-Post tab events
  document.getElementById('autopostSaveNew').addEventListener('click', () => onSaveNewPause('autopost'));
  document.getElementById('autopostCancelNew').addEventListener('click', () => onCancelNewPause('autopost'));
  
  dom.autopostToggle.addEventListener('change', async (e) => {
    // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
    const newValue = e.target.checked;
    ui.settings.autopostEnabled = newValue;

    // Save to storage in background
    try {
      await send(MSG.UPDATE_SETTINGS, { patch: { autopostEnabled: newValue } });
    } catch (error) {
      console.error('Failed to update autopostEnabled:', error);
      // Revert on error
      ui.settings.autopostEnabled = !newValue;
      dom.autopostToggle.checked = !newValue;
      toast('Failed to update setting', 'error');
    }
  });
  
  dom.btnShuffleOnce.addEventListener('click', onShuffleOnce);

  // Update counter in real-time as user types
  dom.postsInput.addEventListener('input', (e) => {
    // ✅ Update post count in real-time
    const currentPosts = parsePosts(e.target.value);
    dom.postsCountN.textContent = currentPosts.length;

    // Mark as pending for blur save
    postsInputPending = true;
  });

  // Save IMMEDIATELY when user pastes content
  dom.postsInput.addEventListener('paste', async (e) => {
    // Wait for paste to complete
    setTimeout(async () => {
      const value = dom.postsInput.value;
      console.log('🔴 PASTE EVENT: Saving posts...', value.substring(0, 100));
      const currentPosts = parsePosts(value);
      console.log('🔴 PASTE EVENT: Parsed posts count:', currentPosts.length);
      dom.postsCountN.textContent = currentPosts.length;

      try {
        await saveSettingImmediate('postsRaw', value);
        console.log('🔴 PASTE EVENT: Save successful!');
        postsInputPending = false;
      } catch (error) {
        console.error('🔴 PASTE EVENT: Save failed:', error);
      }
    }, 100);
  });

  // Save when leaving the field
  dom.postsInput.addEventListener('blur', async (e) => {
    if (postsInputPending) {
      console.log('🔵 BLUR EVENT: Saving posts...');
      postsInputPending = false;
      try {
        await saveSettingImmediate('postsRaw', e.target.value);
        console.log('🔵 BLUR EVENT: Save successful!');
      } catch (error) {
        console.error('🔵 BLUR EVENT: Save failed:', error);
      }
    }
  });
  
  dom.intervalMin.addEventListener('change', async (e) => {
    // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
    const value = parseInt(e.target.value);
    if (value > 0) {
      const newInterval = { ...ui.settings.autopostInterval, min: value };
      ui.settings.autopostInterval = newInterval;

      // Save to storage in background
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { autopostInterval: newInterval } });
      } catch (error) {
        console.error('Failed to update autopostInterval.min:', error);
        toast('Failed to update setting', 'error');
      }
    }
  });

  dom.intervalMax.addEventListener('change', async (e) => {
    // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
    const value = parseInt(e.target.value);
    if (value > 0) {
      const newInterval = { ...ui.settings.autopostInterval, max: value };
      ui.settings.autopostInterval = newInterval;

      // Save to storage in background
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { autopostInterval: newInterval } });
      } catch (error) {
        console.error('Failed to update autopostInterval.max:', error);
        toast('Failed to update setting', 'error');
      }
    }
  });
  
  dom.btnAutopostPauseAdd.addEventListener('click', () => onAddPause('autopost'));

  // 🆕 MEDIA ATTACHMENT EVENTS - FIXED VERSION
  const mediaAutoAttach = document.getElementById('mediaAutoAttach');
  const mediaAttachChance = document.getElementById('mediaAttachChance');
  const mediaChanceValue = document.getElementById('mediaChanceValue');
  const mediaDefaultProfile = document.getElementById('mediaDefaultProfile');
  const mediaChanceRow = document.getElementById('mediaChanceRow');
  
  if (mediaAutoAttach) {
    mediaAutoAttach.addEventListener('change', async (e) => {
      // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
      const newValue = e.target.checked;
      ui.settings.mediaAutoAttach = newValue;

      // Show/hide the chance slider
      if (mediaChanceRow) {
        mediaChanceRow.style.display = newValue ? 'flex' : 'none';
      }

      // Save to storage in background
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { mediaAutoAttach: newValue } });
      } catch (error) {
        console.error('Failed to update mediaAutoAttach:', error);
        toast('Failed to update setting', 'error');
      }
    });
  }
  
  if (mediaAttachChance && mediaChanceValue) {
    mediaAttachChance.addEventListener('input', async (e) => {
      // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
      const value = parseInt(e.target.value);
      mediaChanceValue.textContent = value + '%';
      ui.settings.mediaAttachChance = value;

      // Save to storage in background (no debounce for sliders!)
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { mediaAttachChance: value } });
      } catch (error) {
        console.error('Failed to update mediaAttachChance:', error);
      }
    });
  }

  if (mediaDefaultProfile) {
    mediaDefaultProfile.addEventListener('change', async (e) => {
      // Block renderAutoPost from overwriting the change
      mediaProfileChanging = true;

      // Update UI state IMMEDIATELY
      const newValue = e.target.value;
      ui.settings.mediaDefaultProfile = newValue;

      // Remove focus from dropdown
      e.target.blur();

      // Save to storage in background
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { mediaDefaultProfile: newValue } });

        // Unblock and force dropdown to show new value
        mediaProfileChanging = false;
        mediaDefaultProfile.value = ui.settings.mediaDefaultProfile;
      } catch (error) {
        console.error('Failed to update media profile:', error);
        // Revert on error
        ui.settings.mediaDefaultProfile = e.target.options[e.target.selectedIndex - 1]?.value || 'default';
        mediaDefaultProfile.value = ui.settings.mediaDefaultProfile;
        toast('Failed to update media profile', 'error');
        mediaProfileChanging = false;
      }
    });
  }
  
  // Activity tab events - SIMPLIFIED VERSION
  const activitySaveNew = document.getElementById('activitySaveNew');
  const activityCancelNew = document.getElementById('activityCancelNew');
  
  if (activitySaveNew) {
    activitySaveNew.addEventListener('click', () => onSaveNewPause('activity'));
  }
  if (activityCancelNew) {
    activityCancelNew.addEventListener('click', () => onCancelNewPause('activity'));
  }
  
  if (dom.activityToggle) {
    dom.activityToggle.addEventListener('change', async (e) => {
      // ✅ CRITICAL FIX: Update UI state IMMEDIATELY to prevent visual glitch
      const newValue = e.target.checked;
      ui.settings.activityEnabled = newValue;

      // Save to storage in background
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { activityEnabled: newValue } });
      } catch (error) {
        console.error('Failed to update activityEnabled:', error);
        // Revert on error
        ui.settings.activityEnabled = !newValue;
        dom.activityToggle.checked = !newValue;
        toast('Failed to update setting', 'error');
      }
    });
  }
  
  if (dom.btnActivityPauseAdd) {
    dom.btnActivityPauseAdd.addEventListener('click', () => onAddPause('activity'));
  }
}

// Function to synchronize media profiles to Auto-Post
async function syncMediaProfilesToAutoPost() {
  const release = await mediaProfileLock.acquire();
  try {
    // If media manager exists, use its profiles
    if (window.media && window.media.profiles) {
      const dropdown = document.getElementById('mediaDefaultProfile');
      const currentSelection = dropdown?.value;

      // Use helper function
      populateProfileDropdown(dropdown, window.media.profiles, currentSelection);
    } else {
      // Otherwise, load directly from IndexedDB
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ThreadsBotMedia', 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const tx = db.transaction(['profiles'], 'readonly');
      const profiles = await new Promise((resolve) => {
        const request = tx.objectStore('profiles').getAll();
        request.onsuccess = () => resolve(request.result);
      });

      const dropdown = document.getElementById('mediaDefaultProfile');
      if (dropdown) {
        dropdown.innerHTML = '';
        profiles.forEach(profile => {
          const option = document.createElement('option');
          option.value = profile.id;
          option.textContent = profile.name;
          dropdown.appendChild(option);
        });

        // Set the selected value from settings
        if (ui.settings.mediaDefaultProfile) {
          const optionExists = Array.from(dropdown.options).some(
            opt => opt.value === ui.settings.mediaDefaultProfile
          );
          if (optionExists) {
            dropdown.value = ui.settings.mediaDefaultProfile;
          } else {
            dropdown.value = profiles.length > 0 ? profiles[0].id : 'default';
          }
        }
      }

      db.close();
    }
  } catch (error) {
    console.error("Error syncing profiles:", error);
  } finally {
    release();
  }
}

// Tab Switching
function switchTab(tabName) {
  // Update active tab state
  ui.activeTab = tabName;
  
  // Update tab buttons
  Object.entries(dom.tabs).forEach(([key, tab]) => {
    tab.setAttribute('aria-selected', key === tabName ? 'true' : 'false');
  });
  
  // Show/hide panels
  Object.entries(dom.panels).forEach(([key, panel]) => {
    panel.hidden = key !== tabName;
  });
}

// Rendering Functions
function renderAll() {
  renderHeader();
  renderDashboard();
  renderAutoPost();
  renderActivity();
  renderSettings();
}

function renderHeader() {
  if (!ui.runtime) return;
  
  // Status chip
  dom.statusChip.textContent = ui.runtime.status.replace('_', ' ');
  dom.statusChip.setAttribute('data-status', ui.runtime.status);
  
  // Start/Stop button
  const isRunning = ui.runtime.running;
  dom.btnStartStop.textContent = isRunning ? 'Stop Bot' : 'Start Bot';
  dom.btnStartStop.setAttribute('aria-pressed', isRunning ? 'true' : 'false');
  
  // Timers
  updateTimers();
}

function renderDashboard() {
  if (!ui.runtime) return;
  
  const counters = ui.runtime.counters;

  // Today's stats
  dom.postsToday.textContent = counters.postsToday;
  dom.totalPostsLifetime.textContent = counters.totalPostsLifetime || 0;

  // ✅ CORRECTION: Use activityTimeTodaySec for actual active time
  dom.activityTimeToday.textContent = formatDuration(counters.activityTimeTodaySec);

  // Sessions with limit
  const totalSessions = ui.runtime.sessionPlanToday?.length || 0;
  if (totalSessions > 0) {
    dom.sessionsToday.textContent = `${counters.sessionsStartedToday}/${totalSessions}`;
  } else {
    dom.sessionsToday.textContent = counters.sessionsStartedToday;
  }
  
  // Activity stats
  dom.likesToday.textContent = counters.likesToday || 0;
  dom.commentLikesToday.textContent = counters.commentLikesToday || 0;
  dom.tweetsOpenedToday.textContent = counters.tweetsOpenedToday || 0;
  dom.profilesVisitedToday.textContent = counters.profilesVisitedToday || 0;
  dom.scrollsToday.textContent = counters.scrollsToday || 0;
  dom.refreshesToday.textContent = counters.refreshesToday || 0;

  // Recent activity (user-friendly messages only)
  renderRecentActivity();
}

function renderAutoPost() {
  if (!ui.settings) return;
  
  // Toggle state
  dom.autopostToggle.checked = ui.settings.autopostEnabled;
  
  // Parse posts for display
  const posts = parsePosts(ui.settings.postsRaw);
  dom.postsCountN.textContent = posts.length;
  
  // Progress
  const currentIndex = ui.runtime?.nextPostIndex || 0;
  dom.postsProgressI.textContent = currentIndex + 1;
  dom.postsProgressN.textContent = posts.length || 0;

  // Posts textarea - only update if user is not actively typing AND value is different
  // ✅ FIX: Don't overwrite user input while they're typing or if value is already correct
  const newPostsValue = ui.settings.postsRaw || '';
  if (document.activeElement !== dom.postsInput && dom.postsInput.value !== newPostsValue) {
    dom.postsInput.value = newPostsValue;
  }
  
  // Intervals - only update if not actively editing
  if (document.activeElement !== dom.intervalMin) {
    dom.intervalMin.value = ui.settings.autopostInterval.min;
  }
  if (document.activeElement !== dom.intervalMax) {
    dom.intervalMax.value = ui.settings.autopostInterval.max;
  }
  
  // 🆕 RENDER MEDIA ATTACHMENT SETTINGS
  const mediaAutoAttach = document.getElementById('mediaAutoAttach');
  const mediaAttachChance = document.getElementById('mediaAttachChance');
  const mediaChanceValue = document.getElementById('mediaChanceValue');
  const mediaDefaultProfile = document.getElementById('mediaDefaultProfile');
  const mediaChanceRow = document.getElementById('mediaChanceRow');
  
  // Set checkbox state
  if (mediaAutoAttach) {
    mediaAutoAttach.checked = ui.settings.mediaAutoAttach || false;
  }
  
  // Set slider value
  if (mediaAttachChance) {
    const chanceValue = ui.settings.mediaAttachChance || 20;

    // Only update slider value if user is not actively dragging it
    if (document.activeElement !== mediaAttachChance) {
      mediaAttachChance.value = chanceValue;
    }

    // Always update display value
    if (mediaChanceValue) {
      mediaChanceValue.textContent = chanceValue + '%';
    }
  }
  
  // Show/hide chance row based on checkbox
  if (mediaChanceRow) {
    mediaChanceRow.style.display = ui.settings.mediaAutoAttach ? 'flex' : 'none';
  }
  
  // Populate media profiles dropdown
  if (mediaDefaultProfile) {
    // ✅ FIX: ALWAYS rebuild dropdown from IndexedDB or window.media.profiles
    // Clear existing options first
    mediaDefaultProfile.innerHTML = '';

    // Load profiles from Media if initialized, otherwise from IndexedDB
    if (window.media && window.media.initialized && window.media.profiles) {
      // Use Media instance profiles
      Object.entries(window.media.profiles).forEach(([id, name]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        mediaDefaultProfile.appendChild(option);
      });
    } else {
      // Load from IndexedDB directly (Media not initialized yet)
      syncMediaProfilesToAutoPost().catch(err => {
        console.error('Failed to sync profiles:', err);
        // Fallback to default
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'Default';
        mediaDefaultProfile.appendChild(defaultOption);
      });
      return; // Exit early, syncMediaProfilesToAutoPost will handle setting the value
    }

    // ALWAYS set the selected value from settings
    if (ui.settings.mediaDefaultProfile) {
      // Check that option exists before selecting it
      const optionExists = Array.from(mediaDefaultProfile.options).some(
        opt => opt.value === ui.settings.mediaDefaultProfile
      );

      if (optionExists) {
        // Only update if not actively being changed by user
        if (document.activeElement !== mediaDefaultProfile && !mediaProfileChanging) {
          mediaDefaultProfile.value = ui.settings.mediaDefaultProfile;
        }
      } else {
        // Profile doesn't exist anymore - fallback to 'default' and update settings
        mediaDefaultProfile.value = 'default';
        // ✅ Update UI state immediately
        ui.settings.mediaDefaultProfile = 'default';
        // Save to storage in background
        send(MSG.UPDATE_SETTINGS, { patch: { mediaDefaultProfile: 'default' } }).catch(err => {
          console.error('Failed to save fallback mediaDefaultProfile:', err);
        });
      }
    } else {
      if (mediaDefaultProfile.options.length > 0) {
        // No profile selected - default to first option (usually 'default')
        mediaDefaultProfile.value = mediaDefaultProfile.options[0].value;
      }
    }
  }

  // Render pause schedule
  renderPauseSchedule('autopost', ui.settings.autopostPauses);

  // Clear validation summary
  dom.autopostValidationSummary.innerHTML = '';
}

function renderActivity() {
  if (!ui.settings || !ui.runtime) return;
  
  // Toggle state
  dom.activityToggle.checked = ui.settings.activityEnabled;

  // Today's activity stats
  const counters = ui.runtime.counters || {};
  
  // ✅ REAL activity time (time spent in active session)
  const activeTime = counters.activityTimeTodaySec || 0;
  dom.activityTimeActive.textContent = formatDuration(activeTime);

  // ✅ Sessions (current/total planned)
  const sessionsStarted = counters.sessionsStartedToday || 0;
  const sessionsPlanned = ui.runtime.sessionPlanToday?.length || 0;
  if (sessionsPlanned > 0) {
    dom.sessionsProgress.textContent = `${sessionsStarted}/${sessionsPlanned}`;
  } else {
    dom.sessionsProgress.textContent = `${sessionsStarted}`;
  }
  
  // ✅ Action counters
  if (dom.likesActivity) dom.likesActivity.textContent = counters.likesToday || 0;
  if (dom.commentLikesActivity) dom.commentLikesActivity.textContent = counters.commentLikesToday || 0;
  if (dom.tweetsOpenedActivity) dom.tweetsOpenedActivity.textContent = counters.tweetsOpenedToday || 0;
  if (dom.profilesActivity) dom.profilesActivity.textContent = counters.profilesVisitedToday || 0;
  if (dom.scrollsActivity) dom.scrollsActivity.textContent = counters.scrollsToday || 0;
  if (dom.notificationsActivity) dom.notificationsActivity.textContent = counters.notificationChecksToday || 0;

  // ✅ Display mood weights (non-editable)
  const moodWeights = ui.settings.moodWeights || { low: 30, normal: 45, high: 25 };
  if (dom.moodLowDisplay) dom.moodLowDisplay.textContent = `${moodWeights.low}%`;
  if (dom.moodNormalDisplay) dom.moodNormalDisplay.textContent = `${moodWeights.normal}%`;
  if (dom.moodHighDisplay) dom.moodHighDisplay.textContent = `${moodWeights.high}%`;

  // ✅ Today's mood
  const todayMood = ui.runtime.mood || '-';
  if (dom.todayMoodBadge) {
    dom.todayMoodBadge.textContent = todayMood;
    dom.todayMoodBadge.className = `badge mood-${todayMood.toLowerCase()}`;
  }
  
  // Render pause schedule
  renderPauseSchedule('activity', ui.settings.activityPauses);
}


function renderSettings() {
  if (!ui.settings) return;

  // Populate timezone select - only if not actively being changed
  console.log('🌍 Populating timezones...', TIMEZONES.length, 'timezones');
  if (document.activeElement !== dom.timezoneSelect) {
    dom.timezoneSelect.innerHTML = '';
    TIMEZONES.forEach(tz => {
      const option = document.createElement('option');
      option.value = tz;
      option.textContent = tz;
      option.selected = tz === ui.settings.timezone;
      dom.timezoneSelect.appendChild(option);
    });
    console.log('✅ Timezones populated, selected:', ui.settings.timezone);
  }
  
  // Set dark mode toggle
  dom.darkToggle.checked = ui.settings.darkMode;
  
  // Apply theme class
  if (ui.settings.darkMode) {
    dom.app.classList.add('theme-dark');
  } else {
    dom.app.classList.remove('theme-dark');
  }
}

// Removed renderUpcoming() - "Upcoming" section deleted from UI

// ✅ UX FIX: Translate technical codes to user-friendly messages
function getUserFriendlyMessage(notice) {
  const code = notice.code;
  const msg = notice.msg;

  // User-facing messages
  const translations = {
    'POST_SUCCESS': () => `✅ Post published successfully`,
    'AUTOPOST_SCHEDULED': () => {
      const match = msg.match(/Next post at (.+)/);
      return match ? `📅 Next post at ${match[1]}` : '📅 Post scheduled';
    },
    'AUTOPOST_IN_PAUSE': () => '⏸️ Auto-Post paused',
    'AUTOPOST_EXIT_PAUSE': () => '▶️ Auto-Post resumed',
    'SESSION_START': () => {
      const match = msg.match(/(\d+) min/);
      return match ? `🎭 Activity session (${match[1]} min)` : '🎭 Activity session started';
    },
    'SESSION_COMPLETE': () => '✅ Session completed',
    'SESSION_ENDED': () => '✅ Session ended',
    'SESSION_END': () => '✅ Session completed',
    'DAY_PLAN_CREATED': () => {
      const match = msg.match(/(\d+) sessions/);
      return match ? `📋 Day plan created (${match[1]} sessions)` : '📋 Day plan created';
    },
    'DAILY_PLAN_CREATED': () => {
      const match = msg.match(/Created (\d+) sessions/);
      const mood = msg.match(/\((.+) mood\)/);
      if (match && mood) {
        return `📋 ${match[1]} sessions planned (${mood[1]} mood)`;
      }
      return match ? `📋 ${match[1]} sessions planned` : '📋 Daily plan created';
    },
    'PLAN_CREATED': () => {
      const match = msg.match(/(\d+) sessions/);
      return match ? `📋 ${match[1]} sessions planned today` : '📋 Daily plan created';
    },
    'BOT_STARTED': () => '▶️ Bot started',
    'BOT_STOPPED': () => '⏹️ Bot stopped',
    'POST_CANCELLED': () => '⚠️ Post cancelled (bot stopped)',
    'POST_TOO_LONG': () => '⚠️ Post too long, skipped',
    'NO_POSTS': () => '⚠️ No posts available',
    'TAB_NOT_FOUND': () => '⚠️ Threads tab not found',
    'ACTIVITY_DAY_COMPLETE': () => '✅ All daily sessions completed',

    // ✅ Ignore technical messages (return null = don't display)
    'TAB_ACTIVATED': () => null,
    'CONTENT_READY': () => null,
    'CONTENT_NOT_READY': () => null,
    'CONTENT_PING_TIMEOUT': () => null,
    'TAB_CLOSED': () => null,
    'POST_FAIL': () => null,
    'HEALTH_CHECK_STARTED': () => null,
    'HEALTH_CHECK_FAILED': () => null,
    'RECOVERY': () => null,
    'RECOVERY_ATTEMPT': () => null,
    'RECOVERY_FAILED': () => null,
  };

  // Return translated message or null if it's a technical message to ignore
  return translations[code] ? translations[code]() : null;
}

function renderRecentActivity() {
  dom.activityList.innerHTML = '';
  dom.postsList.innerHTML = '';

  const notices = ui.runtime.lastErrors || [];
  // Take the last 8 (instead of 5) and reverse the order
  const recentNotices = notices.slice(-8).reverse();

  // Activity-related codes
  const activityCodes = ['SESSION_START', 'SESSION_COMPLETE', 'SESSION_ENDED', 'SESSION_END',
                         'DAY_PLAN_CREATED', 'DAILY_PLAN_CREATED', 'PLAN_CREATED',
                         'ACTIVITY_DAY_COMPLETE', 'BOT_STARTED', 'BOT_STOPPED'];

  // Post-related codes
  const postCodes = ['POST_SUCCESS', 'AUTOPOST_SCHEDULED', 'AUTOPOST_IN_PAUSE', 'AUTOPOST_EXIT_PAUSE',
                     'POST_CANCELLED', 'POST_TOO_LONG', 'NO_POSTS'];

  // Filter and transform messages
  const allMessages = recentNotices
    .map(notice => ({
      time: new Date(notice.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      message: getUserFriendlyMessage(notice),
      level: notice.level,
      code: notice.code
    }))
    .filter(item => item.message !== null); // Filter out technical messages

  // Separate activity and post messages
  const activityMessages = allMessages.filter(item => activityCodes.includes(item.code));
  const postMessages = allMessages.filter(item => postCodes.includes(item.code));

  // Render Activity list
  if (activityMessages.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="activity-icon">ℹ️</div>
      <div class="activity-content">
        <div class="activity-message" style="color: var(--muted); font-style: italic;">No recent activity</div>
      </div>
    `;
    dom.activityList.appendChild(li);
  } else {
    activityMessages.forEach(item => renderActivityItem(item, dom.activityList));
  }

  // Render Posts list
  if (postMessages.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="activity-icon">📝</div>
      <div class="activity-content">
        <div class="activity-message" style="color: var(--muted); font-style: italic;">No recent posts</div>
      </div>
    `;
    dom.postsList.appendChild(li);
  } else {
    postMessages.forEach(item => renderActivityItem(item, dom.postsList));
  }
}

function renderActivityItem(item, container) {
  const li = document.createElement('li');

  // Determine activity type and icon
  let activityType = 'info';
  let icon = 'ℹ️';

  if (item.level === 'error') {
    activityType = 'error';
    icon = '✗';
  } else if (item.level === 'warn') {
    activityType = 'warning';
    icon = '⚠';
  } else if (item.code.includes('SUCCESS') || item.code.includes('COMPLETE')) {
    activityType = 'success';
    icon = '✓';
  } else if (item.code.includes('START') || item.code.includes('RESUME')) {
    activityType = 'info';
    icon = '▶';
  } else if (item.code.includes('STOP') || item.code.includes('PAUSE')) {
    activityType = 'warning';
    icon = '⏸';
  }

  li.className = activityType;
  li.innerHTML = `
    <div class="activity-icon">${icon}</div>
    <div class="activity-content">
      <div class="activity-message">${item.message}</div>
      <div class="activity-time">${item.time}</div>
    </div>
  `;

  container.appendChild(li);
}

// Timer Updates
// Timer Updates
function updateTimers() {
  const now = Date.now();
  
  // Post timer
  if (ui.settings?.autopostEnabled && ui.runtime?.nextPostAt) {
    const diff = ui.runtime.nextPostAt - now;
    if (diff > 0) {
      dom.timerPost.textContent = formatCountdown(diff);
    } else if (diff > -5000) { // 5 second tolerance
      dom.timerPost.textContent = 'Now';
    } else {
      // If the timer is very late, force an update
      dom.timerPost.textContent = 'Updating...';
      // Request a status update
      send(MSG.GET_STATUS).then(response => {
        if (response) {
          ui.runtime = response.runtime;
          ui.settings = response.settings;
        }
      }).catch(() => {});
    }
  } else if (ui.settings?.autopostEnabled && ui.runtime?.status === RUN_STATE.PAUSED_BY_SCHEDULE) {
    dom.timerPost.textContent = 'Paused';
  } else {
    dom.timerPost.textContent = 'Disabled';
  }
  
  // Activity timer
  if (ui.settings?.activityEnabled && ui.runtime?.running) {
    if (ui.runtime?.nextActivityWindow) {
      const diff = ui.runtime.nextActivityWindow.start - now;
      if (diff > 0) {
        dom.timerActivity.textContent = formatCountdown(diff);
      } else if (now < ui.runtime.nextActivityWindow.end) {
        dom.timerActivity.textContent = 'Active';
      } else {
        // Session completed, request update
        dom.timerActivity.textContent = 'Updating...';
        send(MSG.GET_STATUS).then(response => {
          if (response) {
            ui.runtime = response.runtime;
            ui.settings = response.settings;
          }
        }).catch(() => {});
      }
    } else {
      // Distinguish between "loading plan" vs "all sessions completed"
      if (ui.runtime?.sessionPlanToday && ui.runtime.sessionPlanToday.length > 0) {
        // Plan exists but no next window = all sessions completed for today
        dom.timerActivity.textContent = 'Done';
      } else {
        // No plan created yet - still loading from server
        dom.timerActivity.textContent = 'Loading plan...';
      }
    }
  } else if (ui.settings?.activityEnabled && ui.runtime?.status === RUN_STATE.PAUSED_BY_SCHEDULE) {
    dom.timerActivity.textContent = 'Paused';
  } else {
    dom.timerActivity.textContent = 'Disabled';
  }
}

// Status Polling
function startStatusPolling() {
  // Update timers every second
  ui.statusUpdateInterval = setInterval(() => {
    updateTimers();
  }, 1000);
}

// Event Handlers
async function onStartStopClick() {
  try {
    const wasRunning = ui.runtime.running;

    // Add loading state
    dom.btnStartStop.classList.add('loading');

    if (wasRunning) {
      // Optimistic update
      ui.runtime.running = false;
      ui.runtime.status = 'STOPPED';
      renderHeader();

      await send(MSG.STOP);
      dom.btnStartStop.classList.remove('loading');
      toast('Bot stopped', 'info');
    } else {
      // ✅ Check license exists before attempting to start
      const licenseCheck = await chrome.storage.sync.get('licenseKey');
      if (!licenseCheck.licenseKey) {
        dom.btnStartStop.classList.remove('loading');
        toast('No license found', 'error');
        setTimeout(() => {
          window.location.href = 'license-activation.html';
        }, 3000);
        return;
      }

      // Optimistic update
      ui.runtime.running = true;
      ui.runtime.status = 'RUNNING';
      renderHeader();

      await send(MSG.START);
      dom.btnStartStop.classList.remove('loading');
      toast('Bot started', 'success');

      // Fetch updated status after 2 seconds to get schedules
      setTimeout(async () => {
        try {
          const response = await send(MSG.GET_STATUS);
          if (response && response.success) {
            ui.runtime = response.runtime;
            ui.settings = response.settings;
            renderAll();
          }
        } catch (e) {
          console.error('Failed to refresh status after start:', e);
        }
      }, 2000);
    }
  } catch (error) {
    console.error('Failed to toggle bot:', error);
    dom.btnStartStop.classList.remove('loading');

    // Check error type
    const errorMsg = error.message || error.toString();
    const isNetworkError = (errorMsg.includes('fetch') ||
                           errorMsg.includes('Failed to fetch') ||
                           errorMsg.includes('NetworkError') ||
                           errorMsg.includes('Network error'));

    const isLicenseError = (errorMsg.includes('License') || errorMsg.includes('license') ||
                           errorMsg.includes('verification failed') || errorMsg.includes('expired'));

    // ✅ Network error - just show error, don't redirect
    if (isNetworkError && !isLicenseError) {
      toast('Network error. Check your internet connection.', 'error');
    }
    // ✅ License error - redirect to activation
    else if (isLicenseError && !isNetworkError) {
      toast('License verification failed', 'error');

      setTimeout(() => {
        window.location.href = 'license-activation.html';
      }, 3000);
    }
    // ✅ Other errors
    else {
      toast('Failed to toggle bot', 'error');
    }

    // Revert optimistic update on error
    ui.runtime.running = !ui.runtime.running;
    ui.runtime.status = wasRunning ? 'RUNNING' : 'STOPPED';
    renderHeader();
  }
}

// Settings update handler with debounce
// Immediate save (no debounce) for critical operations
async function saveSettingImmediate(key, value) {
  try {
    const patch = { [key]: value };
    await send(MSG.UPDATE_SETTINGS, { patch });

    // Update local state
    ui.settings[key] = value;
  } catch (error) {
    console.error('Failed to update setting:', error);
    toast('Failed to update setting', 'error');
  }
}

const onUpdateSetting = debounce(async function(key, value) {
  try {
    const patch = { [key]: value };
    await send(MSG.UPDATE_SETTINGS, { patch });

    // Update local state
    ui.settings[key] = value;

    // Silent save - no notification
  } catch (error) {
    console.error('Failed to update setting:', error);
    toast('Failed to update setting', 'error');
  }
}, 500);

// Export/Import handlers
async function onExportConfig() {
  try {
    const response = await send(MSG.EXPORT_SETTINGS);
    
    const exportData = {
      ...response.settings,
      mediaData: response.mediaData
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xbot-complete-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast('✅ Complete configuration exported', 'success');
  } catch (error) {
    console.error('Failed to export config:', error);
    toast('Failed to export configuration', 'error');
  }
}

async function onImportConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const settings = JSON.parse(text);
    
    const response = await send(MSG.IMPORT_SETTINGS, { json: settings });
    if (response.success) {
      ui.settings = response.settings;
      renderAll();

      // Try to reload media if module is available (v2)
      if (window.media && window.media.loadProfiles && typeof window.media.loadProfiles === 'function') {
        try {
          await window.media.loadProfiles();
          await window.media.showMedia();
        } catch (error) {
          console.warn('Could not reload media after import:', error);
        }
      }

      toast('✅ Complete configuration imported', 'success');

      // Reload to apply all changes
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } else {
      toast(response.error || 'Invalid configuration format', 'error');
    }
  } catch (error) {
    console.error('Failed to import config:', error);
    toast('Failed to import configuration', 'error');
  }
  
  event.target.value = '';
}


async function onConfirmReset() {
  if (dom.resetConfirmInput.value !== 'RESET') {
    toast('Please type RESET to confirm', 'warn');
    return;
  }
  
  try {
    await send(MSG.RESET_ALL);
    toast('All data has been reset', 'info');
    
    // Hide modal
    dom.modalConfirmReset.style.display = 'none';
    
    // Reload popup to get fresh state
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  } catch (error) {
    console.error('Failed to reset data:', error);
    toast('Failed to reset data', 'error');
  }
}

function handleNotice(message) {
  // Add to notices list
  if (!ui.runtime.lastErrors) {
    ui.runtime.lastErrors = [];
  }
  ui.runtime.lastErrors.push({
    ts: message.ts || Date.now(),
    level: message.level,
    code: message.code,
    msg: message.msg
  });
  
  // Render recent activity if on dashboard
  if (ui.activeTab === 'dashboard') {
    renderRecentActivity();
  }
  
  // Show toast for important notices
  if (message.level === 'error') {
    toast(message.msg, 'error');
  }
}

// Utility Functions
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: ui.settings?.timezone || 'UTC'
  });
}

function formatCountdown(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function parsePosts(raw) {
  if (!raw) return [];
  // Split on two blank lines (three \n), single blank line stays in-post
  return raw.split(/\n\n+/)
    .map(post => post.trim())
    .filter(post => post.length > 0);
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renderPauseSchedule(type, pauses) {
  const listElement = type === 'autopost' ? dom.autopostPauseList : dom.activityPauseList;
  listElement.innerHTML = '';
  
  if (!pauses || pauses.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No pause schedules';
    li.style.color = 'var(--muted)';
    listElement.appendChild(li);
    return;
  }
  
  pauses.forEach((pause, index) => {
    const li = document.createElement('li');
    li.className = 'pause-item';
    li.innerHTML = `
      <span class="pause-label">${pause.label}</span>
      <span class="pause-time">${pause.start} - ${pause.end}</span>
      <button class="btn-remove" data-index="${index}" data-type="${type}">Remove</button>
    `;
    listElement.appendChild(li);
  });
  
  // Add remove handlers
  listElement.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      const type = e.target.dataset.type;
      onRemovePause(type, index);
    });
  });
}

// Additional Event Handlers
async function onShuffleOnce() {
  const posts = parsePosts(dom.postsInput.value);
  if (posts.length === 0) {
    toast('No posts to shuffle', 'warn');
    return;
  }

  const shuffled = shuffleArray(posts);
  const newRaw = shuffled.join('\n\n');

  dom.postsInput.value = newRaw;

  // ✅ FIX: Cancel any pending auto-save timer to prevent rollback
  clearTimeout(postsInputTimer);
  postsInputPending = false;

  // ✅ FIX: Use immediate save to prevent debounce race condition
  // If user was typing, the debounced save could overwrite the shuffle
  await saveSettingImmediate('postsRaw', newRaw);

  toast('Posts shuffled', 'success');
}

function onAddPause(type) {
  // Display the inline form based on type
  if (type === 'autopost') {
    document.getElementById('autopostNewForm').style.display = 'block';
    document.getElementById('btnAutopostPauseAdd').style.display = 'none';
    document.getElementById('autopostNewLabel').focus();
  } else {
    document.getElementById('activityNewForm').style.display = 'block';
    document.getElementById('btnActivityPauseAdd').style.display = 'none';
    document.getElementById('activityNewLabel').focus();
  }
}

async function onRemovePause(type, index) {
  const pauseKey = type === 'autopost' ? 'autopostPauses' : 'activityPauses';
  const currentPauses = ui.settings[pauseKey] || [];

  const updatedPauses = currentPauses.filter((_, i) => i !== index);

  // ✅ FIX: Use immediate save to prevent debounce race condition
  await saveSettingImmediate(pauseKey, updatedPauses);

  // Re-render
  renderPauseSchedule(type, updatedPauses);

  toast('Pause schedule removed', 'success');
}

async function onSaveNewPause(type) {
  const prefix = type === 'autopost' ? 'autopost' : 'activity';

  const label = document.getElementById(`${prefix}NewLabel`).value.trim();
  const start = document.getElementById(`${prefix}NewStart`).value;
  const end = document.getElementById(`${prefix}NewEnd`).value;

  if (!label || !start || !end) {
    toast('All fields are required', 'warn');
    return;
  }

  const pauseKey = type === 'autopost' ? 'autopostPauses' : 'activityPauses';
  const currentPauses = ui.settings[pauseKey] || [];

  const newPause = {
    id: `pause_${Date.now()}`,
    label,
    start,
    end
  };

  const updatedPauses = [...currentPauses, newPause];

  // ✅ FIX: Use immediate save to prevent debounce race condition
  await saveSettingImmediate(pauseKey, updatedPauses);

  onCancelNewPause(type);
  renderPauseSchedule(type, updatedPauses);
  toast('Pause schedule added', 'success');
}

function onCancelNewPause(type) {
  const prefix = type === 'autopost' ? 'autopost' : 'activity';
  
  document.getElementById(`${prefix}NewForm`).style.display = 'none';
  document.getElementById(`btn${type === 'autopost' ? 'Autopost' : 'Activity'}PauseAdd`).style.display = 'block';

  // Clear the fields
  document.getElementById(`${prefix}NewLabel`).value = '';
  document.getElementById(`${prefix}NewStart`).value = '';
  document.getElementById(`${prefix}NewEnd`).value = '';
}

function toast(message, type = 'info') {
  // Simple toast implementation
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Update user info in header
async function updateUserInfo() {
  try {
    const userInfoElement = document.getElementById('userInfo');
    if (!userInfoElement) return;

    // Get license info from storage
    const result = await chrome.storage.sync.get(['licenseUsername', 'licensePlan', 'licenseExpires']);

    // Use username from license data (set by admin)
    const username = result.licenseUsername;

    if (!username) {
      userInfoElement.textContent = '';
      return;
    }

    // Format display based on plan
    let displayText = '';
    if (result.licensePlan === 'lifetime') {
      displayText = `${username} - lifetime`;
    } else if (result.licenseExpires) {
      // Format expiration date
      const expiryDate = new Date(result.licenseExpires);
      const formattedDate = expiryDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      displayText = `${username} - ${formattedDate}`;
    } else {
      displayText = `${username} - ${result.licensePlan || 'active'}`;
    }

    userInfoElement.textContent = displayText;
  } catch (error) {
    console.error('Failed to update user info:', error);
  }
}

// Debounce helper
function debounce(fn, ms) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), ms);
  };
}

// AsyncLock for preventing race conditions
class AsyncLock {
  constructor() {
    this.queue = Promise.resolve();
  }

  async acquire() {
    let release;
    const nextLock = new Promise(r => release = r);
    const currentLock = this.queue;
    this.queue = nextLock;
    await currentLock;
    return release;
  }
}

// Create lock for media profile operations
const mediaProfileLock = new AsyncLock();

// ============= MEDIA PROFILES MANAGER =============
// Add to the end of popup.js, before the last line document.addEventListener('DOMContentLoaded', init)

class Media {
  constructor() {
    this.db = null;
    this.currentProfile = 'default';
    this.profiles = {};
  }

  async init() {
    console.log('🔷 Media.init() started');
    console.log('🔷 Calling openDB...');
    await this.openDB();
    console.log('🔷 openDB completed, calling loadProfiles...');
    await this.loadProfiles();
    console.log('🔷 loadProfiles completed, calling setupEvents...');

    this.setupEvents();
    console.log('🔷 setupEvents completed, calling showMedia...');
    await this.showMedia();
    console.log('🔷 Media.init() completed successfully!');
  }

  // Helper to execute DB operations with auto-close
  async withDB(callback) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ThreadsBotMedia', 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database blocked'));
    });

    try {
      return await callback(db);
    } finally {
      db.close();
    }
  }
  
  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ThreadsBotMedia', 3);

      request.onblocked = () => {
        console.warn('⚠️ IndexedDB upgrade blocked - close all Threads tabs');
        reject(new Error('Database upgrade blocked. Please close all other Threads Bot tabs and try again.'));
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;

        console.log(`Upgrading IndexedDB from version ${oldVersion} to 3`);

        // NEVER delete stores if they already exist - only create missing ones
        if (oldVersion < 3) {
          // Delete old stores only if upgrading from v1/v2
          if (oldVersion > 0) {
            const storeNames = Array.from(db.objectStoreNames);
            storeNames.forEach(name => {
              console.log(`Deleting old object store: ${name}`);
              db.deleteObjectStore(name);
            });
          }

          // Create fresh stores
          console.log('Creating new object stores...');
          db.createObjectStore('profiles', { keyPath: 'id' });
          const store = db.createObjectStore('media', {
            keyPath: 'id',
            autoIncrement: true
          });
          store.createIndex('profile', 'profile');
          console.log('Object stores created successfully');
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('IndexedDB opened successfully, version:', this.db.version);
        resolve();
      };

      request.onerror = () => {
        console.error('IndexedDB open error:', request.error);

        // Handle version conflict
        if (request.error && request.error.name === 'VersionError') {
          console.log('Version conflict detected, retrying in 1s...');
          setTimeout(() => {
            this.openDB().then(resolve).catch(reject);
          }, 1000);
        } else {
          reject(request.error);
        }
      };
    });
  }
  
async loadProfiles() {
  const tx = this.db.transaction(['profiles'], 'readonly');
  const store = tx.objectStore('profiles');
  const request = store.getAll();
  
  return new Promise((resolve) => {
    request.onsuccess = async () => {
      const profiles = request.result;

      // Create default if it doesn't exist
      if (profiles.length === 0) {
        const tx2 = this.db.transaction(['profiles'], 'readwrite');
        await tx2.objectStore('profiles').put({ id: 'default', name: 'Default' });
        this.profiles['default'] = 'Default';
      } else {
        profiles.forEach(p => {
          this.profiles[p.id] = p.name;
        });
      }
      
      this.updateProfileSelect();

      // Restore the last used profile
      const saved = localStorage.getItem('lastMediaProfile');
      if (saved && this.profiles[saved]) {
        this.currentProfile = saved;
        document.getElementById('mediaProfileSelect').value = saved;
        document.querySelector('#profileIndicator strong').textContent = this.profiles[saved];
      }
      
      resolve();
    };
  });
}
  
async createProfile(id, name) {
  const tx = this.db.transaction(['profiles'], 'readwrite');
  const store = tx.objectStore('profiles');
  await store.put({ id, name });
  
  this.profiles[id] = name;
  this.updateProfileSelect();
  this.selectProfile(id);
  
  // ✅ CORRECT: Call global function
  if (typeof syncMediaProfilesToAutoPost === 'function') {
    await syncMediaProfilesToAutoPost();
  }
}

async renameProfile(id, newName) {
  // Allow renaming default
  const tx = this.db.transaction(['profiles'], 'readwrite');
  const store = tx.objectStore('profiles');
  await store.put({ id, name: newName });

  this.profiles[id] = newName;
  this.updateProfileSelect();
  toast('Profile renamed', 'success');

  // ✅ CORRECT: Call global function
  if (typeof syncMediaProfilesToAutoPost === 'function') {
    await syncMediaProfilesToAutoPost();
  }
}

async deleteProfile(id) {
  if (id === 'default') {
    toast('Cannot delete default profile', 'warn');
    return;
  }
  
  if (!confirm(`Delete profile "${this.profiles[id]}" and all its media?`)) {
    return;
  }
  
  const tx1 = this.db.transaction(['profiles'], 'readwrite');
  await tx1.objectStore('profiles').delete(id);

  // Delete all media for this profile - await completion
  const tx2 = this.db.transaction(['media'], 'readwrite');
  const store = tx2.objectStore('media');
  const index = store.index('profile');
  const range = IDBKeyRange.only(id);
  const request = index.openCursor(range);

  await new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = () => reject(request.error);
    tx2.onerror = () => reject(tx2.error);
  });

  delete this.profiles[id];
  this.updateProfileSelect();

  if (this.currentProfile === id) {
    this.selectProfile('default');
  }

  toast('Profile deleted', 'info');

  // ✅ CORRECT: Call global function
  if (typeof syncMediaProfilesToAutoPost === 'function') {
    await syncMediaProfilesToAutoPost();
  }
}
  
  selectProfile(id) {
    this.currentProfile = id;
    localStorage.setItem('lastMediaProfile', id);
    
    const select = document.getElementById('mediaProfileSelect');
    if (select) select.value = id;
    
    const indicator = document.querySelector('#profileIndicator strong');
    if (indicator) indicator.textContent = this.profiles[id];
    
    this.showMedia();
  }
  
  updateProfileSelect() {
    const select = document.getElementById('mediaProfileSelect');
    if (!select) return;
    
    // Use helper function
    populateProfileDropdown(select, this.profiles, this.currentProfile);
  }
  
  async uploadFiles(files) {
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
    const MAX_TOTAL_STORAGE = 100 * 1024 * 1024; // 100MB total

    let successCount = 0;
    let skippedLarge = [];
    let skippedType = [];

    // Check storage quota
    try {
      const estimate = await navigator.storage.estimate();
      const usedBytes = estimate.usage || 0;
      const quotaBytes = estimate.quota || 0;

      if (usedBytes > quotaBytes * 0.8) {
        toast('⚠️ Storage almost full (80%). Delete old media.', 'warn');
      }
    } catch (err) {
      console.warn('Could not check storage quota:', err);
    }

    for (const file of files) {
      // Validate file type
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        skippedType.push(file.name);
        continue;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        skippedLarge.push(file.name);
        continue;
      }

      const reader = new FileReader();
      const base64 = await new Promise((resolve) => {
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });

      const media = {
        profile: this.currentProfile,
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64,
        uploadedAt: Date.now()
      };

      const tx = this.db.transaction(['media'], 'readwrite');
      await tx.objectStore('media').add(media);
      successCount++;
    }

    // Show results
    if (skippedLarge.length > 0) {
      toast(`⚠️ Skipped ${skippedLarge.length} file(s) over 10MB limit`, 'warn');
    }
    if (skippedType.length > 0) {
      toast(`⚠️ Skipped ${skippedType.length} non-media file(s)`, 'warn');
    }
    if (successCount > 0) {
      toast(`✅ ${successCount} file(s) added to "${this.profiles[this.currentProfile]}"`, 'success');
      this.showMedia();
    } else if (skippedLarge.length === 0 && skippedType.length === 0) {
      toast('No files to upload', 'info');
    }
  }
  
  async showMedia() {
    const grid = document.getElementById('mediaGrid');
    if (!grid) return;

    const tx = this.db.transaction(['media'], 'readonly');
    const store = tx.objectStore('media');
    const index = store.index('profile');
    const request = index.getAll(this.currentProfile);
    
    request.onsuccess = () => {
      const media = request.result;
      const countElem = document.getElementById('mediaCount');
      if (countElem) countElem.textContent = `(${media.length} items)`;
      
      grid.innerHTML = '';
      
      if (media.length === 0) {
        grid.innerHTML = '<p style="text-align:center; color:var(--muted)">No media in this profile</p>';
        return;
      }
      
      media.forEach(item => {
        const div = document.createElement('div');
        div.className = 'media-item';
        div.dataset.id = item.id;
        
        div.innerHTML = `
          <div class="media-preview">
            ${item.type.startsWith('image/')
              ? `<img src="${item.data}" alt="${item.name}"/>`
              : `<video src="${item.data}"></video>`
            }
          </div>
          <div class="media-info">
            <span class="media-name" title="${item.name}" data-id="${item.id}">${item.name}</span>
            <div class="media-actions">
              <button class="btn-rename-media" data-id="${item.id}" title="Rename">✏️</button>
              <button class="btn-delete-media" data-id="${item.id}" title="Delete">🗑️</button>
            </div>
          </div>
        `;
        
        grid.appendChild(div);
      });
      
      // Rename media button listeners
      grid.querySelectorAll('.btn-rename-media').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = parseInt(e.target.dataset.id, 10);
          if (!isNaN(id)) {
            this.renameMedia(id);
          }
        });
      });

      // Delete media button listeners
      grid.querySelectorAll('.btn-delete-media').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = parseInt(e.target.dataset.id, 10);
          if (!isNaN(id)) {
            this.deleteMedia(id);
          } else {
            console.error('Invalid media ID:', e.target.dataset.id);
          }
        });
      });
    };
  }
  
  async renameMedia(id) {
    // Get current media data
    const tx = this.db.transaction(['media'], 'readonly');
    const store = tx.objectStore('media');

    const media = await new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!media) {
      toast('Media not found', 'error');
      return;
    }

    const currentName = media.name || 'unnamed';

    // Extract name without extension
    const lastDot = currentName.lastIndexOf('.');
    const nameWithoutExt = lastDot > 0 ? currentName.substring(0, lastDot) : currentName;
    const extension = lastDot > 0 ? currentName.substring(lastDot) : '';

    // Show modal instead of inline edit
    const modal = document.getElementById('mediaRenameModal');
    const input = document.getElementById('mediaNameInput');

    if (!modal || !input) return;

    input.value = nameWithoutExt;
    input.dataset.mediaId = id;
    input.dataset.extension = extension;
    modal.style.display = 'flex';
    input.focus();
    input.select();
  }

  async saveMediaRename() {
    const modal = document.getElementById('mediaRenameModal');
    const input = document.getElementById('mediaNameInput');
    const id = parseInt(input.dataset.mediaId);
    const extension = input.dataset.extension || '';
    const newName = input.value.trim();

    if (!newName) {
      toast('Media name cannot be empty', 'error');
      return;
    }

    // Reconstruct full name with original extension
    const fullName = newName + extension;

    // Get current media data
    const tx = this.db.transaction(['media'], 'readonly');
    const store = tx.objectStore('media');

    const media = await new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!media) {
      toast('Media not found', 'error');
      modal.style.display = 'none';
      return;
    }

    // Update media name in IndexedDB
    try {
      const updateTx = this.db.transaction(['media'], 'readwrite');
      const updateStore = updateTx.objectStore('media');

      const updatedMedia = {
        id: media.id,
        profile: media.profile,
        name: fullName,
        type: media.type,
        size: media.size,
        data: media.data,
        uploadedAt: media.uploadedAt
      };

      await new Promise((resolve, reject) => {
        const request = updateStore.put(updatedMedia);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      toast('Media renamed', 'success');
      modal.style.display = 'none';

      // Refresh media gallery
      await this.loadMediaGallery();
    } catch (error) {
      console.error('Failed to rename media:', error);
      toast('Failed to rename media', 'error');
    }
  }

  cancelMediaRename() {
    const modal = document.getElementById('mediaRenameModal');
    modal.style.display = 'none';
  }

  async deleteMedia(id) {
    if (!confirm('Delete this media?')) return;

    const tx = this.db.transaction(['media'], 'readwrite');
    await tx.objectStore('media').delete(id);

    toast('Media deleted', 'info');
    this.showMedia();
  }
  
  setupEvents() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    
    if (!dropZone || !fileInput) return;
    
    // Upload events
    dropZone.addEventListener('click', () => fileInput.click());
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
      const files = Array.from(e.dataTransfer.files);
      this.uploadFiles(files);
    });
    
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    });
    
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragging');
    });
    
    fileInput.addEventListener('change', (e) => {
      this.uploadFiles(Array.from(e.target.files));
      fileInput.value = '';
    });
    
    // Profile management events
    const profileSelect = document.getElementById('mediaProfileSelect');
    if (profileSelect) {
      profileSelect.addEventListener('change', (e) => {
        this.selectProfile(e.target.value);
      });
    }
    
    const btnNewProfile = document.getElementById('btnNewProfile');
    if (btnNewProfile) {
      btnNewProfile.addEventListener('click', () => {
        const modal = document.getElementById('profileModal');
        const title = document.getElementById('modalTitle');
        const input = document.getElementById('profileNameInput');
        
        if (modal && title && input) {
          title.textContent = 'New Profile';
          input.value = '';
          modal.style.display = 'flex';
          input.focus();
        }
      });
    }
    
    const btnRenameProfile = document.getElementById('btnRenameProfile');
    if (btnRenameProfile) {
      btnRenameProfile.addEventListener('click', () => {
        const modal = document.getElementById('profileModal');
        const title = document.getElementById('modalTitle');
        const input = document.getElementById('profileNameInput');
        
        if (modal && title && input) {
          title.textContent = 'Rename Profile';
          input.value = this.profiles[this.currentProfile];
          modal.style.display = 'flex';
          input.focus();
        }
      });
    }
    
    const btnDeleteProfile = document.getElementById('btnDeleteProfile');
    if (btnDeleteProfile) {
      btnDeleteProfile.addEventListener('click', () => {
        this.deleteProfile(this.currentProfile);
      });
    }
    
    const btnSaveProfile = document.getElementById('btnSaveProfile');
    if (btnSaveProfile) {
      btnSaveProfile.addEventListener('click', () => {
        const input = document.getElementById('profileNameInput');
        const modal = document.getElementById('profileModal');
        const title = document.getElementById('modalTitle');
        
        if (!input || !modal || !title) return;
        
        const name = input.value.trim();
        if (!name) {
          toast('Please enter a profile name', 'warn');
          return;
        }
        
        const isRename = title.textContent === 'Rename Profile';
        
        if (isRename) {
          this.renameProfile(this.currentProfile, name);
        } else {
          const id = 'profile_' + Date.now();
          this.createProfile(id, name);
        }
        
        modal.style.display = 'none';
      });
    }
    
    const btnCancelProfile = document.getElementById('btnCancelProfile');
    if (btnCancelProfile) {
      btnCancelProfile.addEventListener('click', () => {
        const modal = document.getElementById('profileModal');
        if (modal) modal.style.display = 'none';
      });
    }

    // Media rename modal events
    const btnSaveMediaRename = document.getElementById('btnSaveMediaRename');
    if (btnSaveMediaRename) {
      btnSaveMediaRename.addEventListener('click', () => {
        this.saveMediaRename();
      });
    }

    const btnCancelMediaRename = document.getElementById('btnCancelMediaRename');
    if (btnCancelMediaRename) {
      btnCancelMediaRename.addEventListener('click', () => {
        this.cancelMediaRename();
      });
    }

    // Close media rename modal on Escape key
    const mediaNameInput = document.getElementById('mediaNameInput');
    if (mediaNameInput) {
      mediaNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.cancelMediaRename();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.saveMediaRename();
        }
      });
    }
  }
}

// Global instance
let media = null;

// ========================================
// CONSOLE DEBUG COMMANDS
// ========================================

// Debug commands removed for production security

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);