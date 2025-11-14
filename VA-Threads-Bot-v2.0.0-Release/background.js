// Import security utilities, Firebase config, License Manager, and Client Executors
importScripts('extension-config.js', 'firebase-config.js', 'license-manager.js', 'client-executor.js');

// Constants - Threads URLs
const THREADS_URL_PATTERNS = [
  'https://www.threads.net/*',
  'https://threads.net/*',
  'https://www.threads.com/*',
  'https://threads.com/*'
];

// Alarm names
const ALARM = {
  AUTOPOST_TICK: 'autopost-tick',
  ACTIVITY_TICK: 'activity-tick',
  DAILY_RESET: 'daily-reset',
  HEARTBEAT: 'heartbeat-ping',
};

// Error codes
const ERROR_CODE = {
  NO_TAB: 'NO_THREADS_TAB',
  POST_TOO_LONG: 'POST_TOO_LONG',
  LICENSE_INVALID: 'LICENSE_INVALID'
};

// Timing constants
const TIMING = {
  TAB_RETRY_DELAY: 2000,
  CONTENT_READY_WAIT: 500,
  POST_SUCCESS_WAIT: 1000,
  API_RETRY_DELAY: 5 * 60 * 1000, // 5 minutes on error
  HEARTBEAT_INTERVAL: 2 * 60 * 1000, // 2 minutes
  DAILY_RESET_HOUR: 0, // Midnight
  MAX_LOGS: 500 // Maximum log entries
};

// Debug mode (set to false for production)
const DEBUG_MODE = false;

// Debug logger (only logs in debug mode)
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log(...args);
  }
}

// Jitter function - adds natural variance to timings
function jitter(baseMs, variance = 0.1) {
  const min = baseMs * (1 - variance);
  const max = baseMs * (1 + variance);
  return Math.floor(min + Math.random() * (max - min));
}

// ============================================
// STORAGE WRAPPER
// ============================================

class StorageService {
  async getSettings() {
    const result = await chrome.storage.sync.get(null);

    // Load defaults if first time (no settings exist)
    if (Object.keys(result).length === 0 || !result.timezone) {
      console.log('📥 Loading default settings (first time)...');
      const defaults = await this.loadDefaults();
      await chrome.storage.sync.set(defaults);
      return defaults;
    }

    // ✅ FIX: Load postsRaw from local storage (no 8KB limit)
    const localData = await chrome.storage.local.get('postsRaw');
    if (localData.postsRaw !== undefined) {
      result.postsRaw = localData.postsRaw;
    } else if (!result.postsRaw) {
      result.postsRaw = ''; // Default value
    }

    return result;
  }

  async updateSettings(updates) {
    // Filter out undefined values (Chrome storage doesn't accept them)
    const cleanUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        cleanUpdates[key] = value;
      }
    }

    if (Object.keys(cleanUpdates).length === 0) {
      console.warn('⚠️ No valid settings to update');
      return;
    }

    console.log('💾 Updating settings:', Object.keys(cleanUpdates));

    // ✅ FIX: Store postsRaw in local storage (no 8KB limit like sync)
    // sync storage has 8KB per item limit, posts can easily exceed this
    if (cleanUpdates.postsRaw !== undefined) {
      await chrome.storage.local.set({ postsRaw: cleanUpdates.postsRaw });
      delete cleanUpdates.postsRaw; // Don't also save to sync
      console.log('💾 Saved postsRaw to local storage');
    }

    // Save everything else to sync storage
    if (Object.keys(cleanUpdates).length > 0) {
      await chrome.storage.sync.set(cleanUpdates);
    }
  }

  async loadDefaults() {
    try {
      // ✅ LOAD from local config/defaults.json file
      console.log('📥 Loading defaults from local config file...');
      const defaultsResponse = await fetch(chrome.runtime.getURL('/config/defaults.json'));
      const defaults = await defaultsResponse.json();
      console.log('✅ Defaults loaded from local file');
      return defaults;
    } catch (error) {
      console.error('❌ Failed to load defaults.json:', error);
      throw new Error('Cannot initialize without defaults.json');
    }
  }

  async getRuntime() {
    const result = await chrome.storage.local.get('runtime');

    // If runtime doesn't exist, initialize with defaults
    if (!result.runtime) {
      const defaultRuntime = {
        running: false,
        status: 'STOPPED',
        counters: {
          postsToday: 0,
          totalPostsLifetime: 0,  // ✅ CRITICAL: Never reset, persists across reloads
          likesToday: 0,
          commentLikesToday: 0,
          profilesVisitedToday: 0,
          notificationChecksToday: 0,
          activityTimeTodaySec: 0,
          sessionsStartedToday: 0
        }
      };
      await chrome.storage.local.set({ runtime: defaultRuntime });
      return defaultRuntime;
    }

    // MIGRATION: If runtime exists but doesn't have counters, add them
    if (!result.runtime.counters) {
      console.log('⚠️ Migrating runtime: adding missing counters field');
      result.runtime.counters = {
        postsToday: 0,
        totalPostsLifetime: 0,
        likesToday: 0,
        commentLikesToday: 0,
        profilesVisitedToday: 0,
        notificationChecksToday: 0,
        activityTimeTodaySec: 0,
        sessionsStartedToday: 0
      };
      await chrome.storage.local.set({ runtime: result.runtime });
    }

    // ✅ MIGRATION: Ensure totalPostsLifetime exists (for old runtime format)
    if (typeof result.runtime.counters.totalPostsLifetime === 'undefined') {
      console.log('⚠️ Migrating runtime: adding missing totalPostsLifetime counter');
      result.runtime.counters.totalPostsLifetime = 0;
      await chrome.storage.local.set({ runtime: result.runtime });
    }

    // ✅ MIGRATION: Ensure sessionsStartedToday exists
    if (typeof result.runtime.counters.sessionsStartedToday === 'undefined') {
      result.runtime.counters.sessionsStartedToday = 0;
      await chrome.storage.local.set({ runtime: result.runtime });
    }

    return result.runtime;
  }

  async mutateRuntime(mutator) {
    const runtime = await this.getRuntime();
    const updated = mutator(runtime);
    await chrome.storage.local.set({ runtime: updated });
    return updated;
  }

  async getLogs() {
    const result = await chrome.storage.local.get('logs');
    return result.logs || [];
  }

  async addLog(entry) {
    const logs = await this.getLogs();
    logs.unshift(entry);
    // Keep last 100 logs
    if (logs.length > 100) logs.length = 100;
    await chrome.storage.local.set({ 'logs': logs });

    // Also add to runtime.lastErrors for Recent Activity/Posts sections
    await this.mutateRuntime((runtime) => {
      if (!runtime.lastErrors) runtime.lastErrors = [];
      runtime.lastErrors.push({
        ts: entry.timestamp,
        level: entry.level,
        code: entry.code,
        msg: entry.message
      });
      // Keep last 50 entries
      if (runtime.lastErrors.length > 50) {
        runtime.lastErrors = runtime.lastErrors.slice(-50);
      }
      return runtime;
    });
  }

  async patchSettings(patch) {
    const currentSettings = await this.getSettings();
    const newSettings = { ...currentSettings, ...patch };

    // Validate against schema
    if (!this.validateSettings(newSettings)) {
      throw new Error('Invalid settings format');
    }

    // FIX: Separate large data (postsRaw) to local storage
    const syncData = { ...newSettings };

    if (syncData.postsRaw !== undefined) {
      await chrome.storage.local.set({ postsRaw: syncData.postsRaw });
      delete syncData.postsRaw; // Don't save to sync (8KB limit)
    }

    // 🔍 DEBUG: Log size of each field to identify quota issues
    console.log('📊 Sync data field sizes:');
    for (const [key, value] of Object.entries(syncData)) {
      const size = JSON.stringify(value).length;
      console.log(`  ${key}: ${size} bytes ${size > 8192 ? '⚠️ EXCEEDS 8KB LIMIT' : ''}`);
    }
    const totalSize = JSON.stringify(syncData).length;
    console.log(`  TOTAL: ${totalSize} bytes`);

    await chrome.storage.sync.set(syncData);
    return newSettings;
  }

  async resetAll() {
    // Wipe all storage and reinitialize with defaults
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();

    const defaults = await this.loadDefaults();
    await chrome.storage.sync.set(defaults);

    const defaultRuntime = {
      running: false,
      status: 'STOPPED',
      counters: {
        postsToday: 0,
        likesToday: 0,
        commentLikesToday: 0,
        profilesVisitedToday: 0,
        notificationChecksToday: 0,
        activityTimeTodaySec: 0
      }
    };
    await chrome.storage.local.set({ runtime: defaultRuntime });
  }

  validateSettings(settings) {
    if (!settings.timezone || typeof settings.timezone !== 'string') return false;

    // Validate mood weights if present
    if (settings.moodWeights) {
      const moodSum = (settings.moodWeights.low || 0) +
                      (settings.moodWeights.normal || 0) +
                      (settings.moodWeights.high || 0);
      if (Math.abs(moodSum - 100) > 0.01) return false;
    }

    return true;
  }
}

// ============================================
// LOGGER
// ============================================

class Logger {
  constructor(storage) {
    this.storage = storage;
  }

  async log(level, code, message, context = {}) {
    const entry = {
      level,
      code,
      message,
      context,
      timestamp: Date.now(),
      datetime: new Date().toISOString()
    };

    await this.storage.addLog(entry);
    console.log(`[${level}] ${code}: ${message}`, context);

    // Broadcast to popup
    try {
      await chrome.runtime.sendMessage({
        type: 'LOG_UPDATE',
        log: entry
      });
    } catch (e) {
      // Popup not open
    }
  }

  async info(code, message, context) {
    return this.log('INFO', code, message, context);
  }

  async warn(code, message, context) {
    return this.log('WARN', code, message, context);
  }

  async error(code, message, context) {
    return this.log('ERROR', code, message, context);
  }
}

// ============================================
// TIMEZONE HELPERS
// ============================================

/**
 * Get today's date string (YYYY-MM-DD) in user's timezone
 */
function getTodayDateString(timezone) {
  const nowInUserTZ = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  return nowInUserTZ.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Get tomorrow at midnight in user's timezone, converted to UTC timestamp
 */
function getTomorrowMidnightTimestamp(timezone) {
  const tomorrow = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const tomorrowUTC = new Date(tomorrow.toLocaleString('en-US', { timeZone: 'UTC' }));
  return tomorrowUTC.getTime();
}

// ============================================
// ALARM MANAGER
// ============================================

class AlarmManager {
  async schedule(name, when) {
    await chrome.alarms.create(name, { when });
  }

  async clear(name) {
    await chrome.alarms.clear(name);
  }

  async clearAll() {
    await chrome.alarms.clearAll();
  }
}

// ============================================
// LOCK MANAGER
// ============================================

class ActionCoordinator {
  constructor() {
    this.lock = null;
    this.queue = [];
  }

  tryLock(owner, ttlMs = 15000, priority = 0) {
    const now = Date.now();

    // Check if lock is expired
    if (this.lock && this.lock.expiresAt < now) {
      this.lock = null;
    }

    // If no lock, acquire it
    if (!this.lock) {
      this.lock = {
        owner,
        acquiredAt: now,
        expiresAt: now + ttlMs,
        priority
      };
      return true;
    }

    // If same owner, extend lock
    if (this.lock.owner === owner) {
      this.lock.expiresAt = now + ttlMs;
      return true;
    }

    // Higher priority can preempt (for Auto-Post near deadline)
    if (priority > this.lock.priority) {
      this.lock = {
        owner,
        acquiredAt: now,
        expiresAt: now + ttlMs,
        priority
      };
      return true;
    }

    return false;
  }

  release(owner) {
    if (this.lock && this.lock.owner === owner) {
      this.lock = null;
    }
  }

  async withLock(owner, fn, options = {}) {
    const { ttlMs = 15000, priority = 0 } = options;
    const maxRetries = 10;
    let retries = 0;

    while (retries < maxRetries) {
      if (this.tryLock(owner, ttlMs, priority)) {
        try {
          const result = await fn();
          return result;
        } finally {
          this.release(owner);
        }
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries++;
    }

    throw new Error(`LOCK_TIMEOUT: Failed to acquire lock for ${owner}`);
  }
}

// ============================================
// MEDIA MANAGER
// ============================================

class MediaManager {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return; // Already initialized

    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ThreadsBotMedia', 3);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  // Parse media tag: [[media:...]]
  parseMediaTag(tag) {
    // [[media:random]] or [[media:random:3]]
    // [[media:1,2,5]] → specific files
    // [[media:1-10]] → range

    const content = tag.replace(/\[\[media:|]]/g, '');

    // Random with count
    if (content.startsWith('random')) {
      const match = content.match(/random:?(\d+)?/);
      return {
        type: 'random',
        count: match[1] ? parseInt(match[1]) : 1
      };
    }

    // Ranges and/or specific
    const parts = content.split(',');
    const ranges = [];
    const specific = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [from, to] = part.split('-');
        ranges.push({ from, to });
      } else {
        specific.push(part.trim());
      }
    }

    if (ranges.length > 0) {
      return { type: 'range', ranges, specific };
    } else {
      return { type: 'specific', items: specific };
    }
  }

  // Resolve media tag to actual media files from IndexedDB
  async resolveMediaTag(tag, profileId = 'default') {
    if (!this.db) await this.init();

    const parsed = this.parseMediaTag(tag);

    // Get all media from profile
    const tx = this.db.transaction(['media'], 'readonly');
    const store = tx.objectStore('media');
    const index = store.index('profile');
    const allMedia = await new Promise((resolve) => {
      const request = index.getAll(profileId);
      request.onsuccess = () => resolve(request.result);
    });

    let selectedMedia = [];

    switch (parsed.type) {
      case 'random':
        // Random selection
        const shuffled = [...allMedia].sort(() => Math.random() - 0.5);
        selectedMedia = shuffled.slice(0, Math.min(parsed.count, allMedia.length));
        break;

      case 'specific':
        // Specific media by name
        for (const name of parsed.items) {
          const media = allMedia.find(m => {
            return m.name === name || m.name.startsWith(name + '.');
          });
          if (media) {
            selectedMedia.push(media);
          }
        }
        break;

      case 'range':
        // For each range, select ONE random media
        for (const range of parsed.ranges) {
          const candidates = allMedia.filter(m => {
            const nameNum = parseInt(m.name);
            return nameNum >= parseInt(range.from) &&
                   nameNum <= parseInt(range.to);
          });

          if (candidates.length > 0) {
            const random = candidates[Math.floor(Math.random() * candidates.length)];
            selectedMedia.push(random);
          }
        }

        // Add specific if any
        for (const name of parsed.specific || []) {
          const media = allMedia.find(m =>
            m.name === name ||
            m.name.startsWith(name + '.')
          );
          if (media) selectedMedia.push(media);
        }
        break;
    }

    return selectedMedia;
  }

  // Check if should attach random media
  shouldAttachRandom(settings) {
    if (!settings.mediaAutoAttach) return false;
    const chance = settings.mediaAttachChance || 20;
    return Math.random() * 100 < chance;
  }
}

// ============================================
// MAIN APPLICATION
// ============================================

class BackgroundApp {
  constructor() {
    this.storage = new StorageService();
    this.log = new Logger(this.storage);
    this.alarms = new AlarmManager();
    this.lock = new ActionCoordinator();

    // Initialize license manager immediately (will be fully initialized in init())
    this.license = new LicenseManager(this.storage);

    // Media manager (for resolving media tags in posts)
    this.media = new MediaManager();

    // Initialize engines immediately so they're available even during init()
    this.auto = new AutoPostEngine(
      this.storage, this.log, this.alarms, this.lock, this.license, this.media
    );

    this.activity = new ActivityEngine(
      this.storage, this.log, this.alarms, this.lock, this.license
    );

    // Set app reference in engines for coordination
    this.auto.app = this;
    this.activity.app = this;
    
    // Heartbeat failure tracking (network error tolerance)
    this.heartbeatFailures = 0;
  }

  async init() {
    // ⚡ CRITICAL: Setup message listeners FIRST before any async operations
    // This ensures popup can connect even if initialization fails
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep channel open for async response
    });

    // Setup alarm listeners
    chrome.alarms.onAlarm.addListener((alarm) => this.handleAlarm(alarm));

    console.log('✅ Message listeners registered');

    await this.log.info('APP_INIT', 'Initializing V/A Threads Bot', { module: 'APP' });

    // Media manager is handled by popup only (needs DOM access)
    // Background doesn't need media manager

    // Fully initialize license manager (already created in constructor)
    const licenseStatus = await this.license.initialize();

    if (licenseStatus.needsActivation) {
      await this.log.warn('LICENSE_REQUIRED', 'License activation required', { module: 'APP' });
    } else {
      await this.log.info('LICENSE_VERIFIED', `License verified: ${licenseStatus.licenseData?.plan}`, { module: 'APP' });
    }

    await this.log.info('APP_READY', 'Application initialized successfully', { module: 'APP' });
  }

  async handleAlarm(alarm) {
    // ✅ FIX: Keep service worker alive during alarm processing
    const keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {
        // This keeps the service worker alive
      });
    }, 20000); // Every 20 seconds

    try {
      switch (alarm.name) {
        case ALARM.AUTOPOST_TICK:
          await this.auto.tick();
          break;

        case ALARM.ACTIVITY_TICK:
          await this.activity.tick();
          break;

        case ALARM.DAILY_RESET:
          await this.handleDailyReset();
          break;

        case ALARM.HEARTBEAT:
          await this.handleHeartbeat();
          break;

        default:
          await this.log.warn('UNKNOWN_ALARM', `Unknown alarm: ${alarm.name}`, { module: 'APP' });
      }
    } catch (error) {
      await this.log.error('ALARM_FAIL', error.message, {
        module: 'APP',
        alarm: alarm.name,
        stack: error.stack
      });
    } finally {
      // ✅ Stop keep-alive timer
      clearInterval(keepAliveTimer);
    }
  }

  async handleMessage(message, sender, sendResponse) {
    try {
      let response;

      switch (message.type) {
        case 'START_BOT':
          response = await this.handleStart();
          break;

        case 'STOP_BOT':
          response = await this.handleStop();
          break;

        case 'GET_STATUS':
          response = await this.handleGetStatus();
          break;

        case 'UPDATE_SETTINGS':
          response = await this.handleUpdateSettings(message.patch || message.settings);
          break;

        case 'ACTIVATE_LICENSE':
          response = await this.handleActivateLicense(message.licenseKey, message.email);
          break;

        case 'VERIFY_LICENSE':
          response = await this.handleVerifyLicense();
          break;

        case 'GET_SESSION_TOKEN':
          response = await this.handleGetSessionToken();
          break;

        case 'GET_LOGS':
          response = await this.handleGetLogs();
          break;

        case 'CLEAR_LOGS':
          response = await this.handleClearLogs();
          break;

        case 'VALIDATE_POSTS':
          response = await this.handleValidatePosts(message.raw);
          break;

        case 'EXPORT_SETTINGS':
          response = await this.handleExportSettings();
          break;

        case 'IMPORT_SETTINGS':
          response = await this.handleImportSettings(message.json);
          break;

        case 'RESET_ALL':
          response = await this.handleResetAll();
          break;

        // ✅ FIX: Add missing handlers from old version
        case 'NOTICE':
          await this.log.info(message.code, message.message, message.context || {});
          response = { success: true };
          break;

        case 'LICENSE_EXPIRED':
          // License or token expired/invalid - force stop everything
          await this.log.error('LICENSE_EXPIRED', message.message || 'License expired or invalid', { module: 'APP' });

          // Force stop the bot immediately
          await this.handleStop();

          // Clear license data
          await this.storage.updateSettings({ licenseKey: null });
          await chrome.storage.local.remove(['sessionToken', 'tokenExpiresAt', 'licenseData']);

          // Notify popup to show license screen
          await this.broadcastStatusUpdate();

          response = { success: true };
          break;

        case 'ACTION_RESULT':
          response = { success: true };
          break;

        case 'KEEP_ALIVE':
        case 'PING':
          response = { alive: true, timestamp: Date.now() };
          break;

        case 'FORCE_ACTIVITY_SESSION':
          response = await this.handleForceActivitySession();
          break;

        case 'FORCE_POST_NOW':
          response = await this.handleForcePostNow();
          break;

        default:
          response = { success: false, error: 'Unknown message type' };
      }

      // Use setTimeout to ensure response is sent even if async
      setTimeout(() => sendResponse(response), 0);
    } catch (error) {
      await this.log.error('MESSAGE_FAIL', error.message, {
        module: 'APP',
        messageType: message.type,
        stack: error.stack
      });
      setTimeout(() => sendResponse({ success: false, error: error.message }), 0);
    }
  }

  async handleStart() {
    const settings = await this.storage.getSettings();

    if (!settings.licenseKey) {
      throw new Error('License key required. Please activate your license.');
    }

    // ✅ FIX: Check if it's a new day and reset stats if needed
    const runtime = await this.storage.getRuntime();
    const userTimezone = settings.timezone || 'UTC';
    const todayStr = getTodayDateString(userTimezone);

    // Check if last reset date is different from today
    if (runtime.lastResetDate !== todayStr) {
      await this.log.info('NEW_DAY_DETECTED', `New day detected (${todayStr}), resetting daily stats`, { module: 'APP' });
      await this.handleDailyReset();
    }

    await this.storage.mutateRuntime((runtime) => {
      runtime.running = true;
      runtime.status = 'RUNNING';
      runtime.lastResetDate = todayStr; // Track last reset date
      return runtime;
    });

    // Start AutoPost if enabled
    if (settings.autopostEnabled) {
      await this.auto.onStart();
      await this.log.info('AUTOPOST_STARTED', 'AutoPost started', { module: 'APP' });
    }

    // Start Activity if enabled
    if (settings.activityEnabled) {
      await this.activity.onStart();
      await this.log.info('ACTIVITY_STARTED', 'Activity started', { module: 'APP' });
    }

    // Start heartbeat ping
    await this.startHeartbeat();

    await this.broadcastStatusUpdate();

    return { success: true };
  }

  async handleStop() {
    // ✅ CRITICAL: Reset flags IMMEDIATELY before any async operations
    // This is the emergency stop - kill everything NOW
    this.auto.isPosting = false;
    this.activity.sessionInProgress = false;
    this.activity.isInActiveSession = false;

    // ✅ Update runtime status immediately
    await this.storage.mutateRuntime((runtime) => {
      runtime.running = false;
      runtime.status = 'STOPPED';
      runtime.nextPostAt = null;
      runtime.nextActivityWindow = null;
      return runtime;
    });

    // ✅ Stop engines
    await this.auto.onStop();
    await this.activity.onStop();

    // ✅ Send STOP signal to content script
    try {
      const [tab] = await chrome.tabs.query({ url: THREADS_URL_PATTERNS });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_ALL_ACTIONS' });
        console.log('✅ Sent STOP signal to content script');
      }
    } catch (e) {
      console.log('No active tab to stop');
    }

    // ✅ NUCLEAR OPTION: Clear ALL alarms
    await chrome.alarms.clearAll();
    console.log('✅ All alarms cleared on STOP');

    // ✅ Release all locks
    this.lock.release('AUTOPOST');
    this.lock.release('ACTIVITY');

    // Stop heartbeat
    await this.stopHeartbeat();

    await this.log.info('BOT_STOPPED', 'Bot stopped (emergency stop)', { module: 'APP' });
    await this.broadcastStatusUpdate();

    return { success: true };
  }

  async handleGetStatus() {
    const settings = await this.storage.getSettings();
    const runtime = await this.storage.getRuntime();

    return {
      success: true,
      running: runtime.running || false,
      settings,
      runtime
    };
  }

  async handleUpdateSettings(updates) {
    await this.storage.updateSettings(updates);
    await this.log.info('SETTINGS_UPDATED', 'Settings updated', { module: 'APP' });

    // ✅ If Auto-Post is disabled, clear the nextPostAt timer
    if (updates.autopostEnabled === false) {
      await this.storage.mutateRuntime((runtime) => {
        delete runtime.nextPostAt;
        return runtime;
      });
    }

    await this.broadcastStatusUpdate();

    return { success: true };
  }

  async handleActivateLicense(licenseKey, email) {
    try {
      const result = await this.license.activateLicense(licenseKey, email);

      await this.log.info('LICENSE_ACTIVATED', `License activated: ${result.plan}`, {
        module: 'APP',
        plan: result.plan
      });


      // ✅ RELOAD selectors in all content scripts now that we have a token
      try {
        const tabs = await chrome.tabs.query({ url: THREADS_URL_PATTERNS });
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_SELECTORS' }).catch(() => {
            // Ignore if content script not loaded yet
          });
        }
        console.log('✅ Requested selector reload in all Threads tabs');
      } catch (error) {
        console.warn('⚠️ Could not request selector reload:', error.message);
      }

      return { success: true, ...result };
    } catch (error) {
      await this.log.error('LICENSE_ACTIVATION_FAILED', error.message, { module: 'APP' });
      return { success: false, error: error.message };
    }
  }

  async handleVerifyLicense() {
    try {
      const settings = await this.storage.getSettings();
      if (!settings.licenseKey) {
        return { success: false, error: 'No license key found' };
      }

      const result = await this.license.verifyLicense(settings.licenseKey);

      await this.log.info('LICENSE_VERIFIED', `License verified: ${result.plan}`, {
        module: 'APP',
        plan: result.plan
      });

      return { success: true, ...result };
    } catch (error) {
      await this.log.error('LICENSE_VERIFICATION_FAILED', error.message, { module: 'APP' });
      return { success: false, error: error.message };
    }
  }

  async handleGetSessionToken() {
    try {
      const sessionToken = await this.license.getSessionToken();
      return { success: true, sessionToken };
    } catch (error) {
      await this.log.error('GET_SESSION_TOKEN_FAILED', error.message, { module: 'APP' });
      return { success: false, error: error.message };
    }
  }

  async handleGetLogs() {
    const logs = await this.storage.getLogs();
    return { success: true, logs };
  }

  async handleClearLogs() {
    await chrome.storage.local.set({ logs: [] });
    await this.log.info('LOGS_CLEARED', 'Logs cleared', { module: 'APP' });
    return { success: true };
  }

  async handleValidatePosts(raw) {
    const posts = this.auto.parsePosts(raw);
    const validation = this.auto.validatePosts(posts, 500);
    return {
      posts,
      tooLong: validation.tooLong,
      empty: validation.empty
    };
  }

  async handleExportSettings() {
    const settings = await this.storage.getSettings();

    // Get media data from IndexedDB
    let mediaData = null;
    try {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ThreadsBotMedia', 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const profilesTx = db.transaction(['profiles'], 'readonly');
      const profiles = await new Promise((resolve, reject) => {
        const request = profilesTx.objectStore('profiles').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const mediaTx = db.transaction(['media'], 'readonly');
      const media = await new Promise((resolve, reject) => {
        const request = mediaTx.objectStore('media').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      mediaData = { profiles, media };
      db.close();
    } catch (error) {
      console.warn('Could not export media data:', error);
    }

    return {
      success: true,
      settings: settings,
      mediaData: mediaData
    };
  }

  async handleImportSettings(json) {
    try {
      // ✅ FIX: Extract mediaData before importing settings (it's too large for sync storage)
      const mediaData = json.mediaData;
      const settingsOnly = { ...json };
      delete settingsOnly.mediaData; // Remove mediaData from settings object

      // Import settings
      if (!this.storage.validateSettings(settingsOnly)) {
        return { success: false, error: 'Invalid settings format' };
      }

      const newSettings = await this.storage.patchSettings(settingsOnly);

      // Import media if present
      if (mediaData) {
        try {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('ThreadsBotMedia', 3);
            request.onupgradeneeded = (e) => {
              const db = e.target.result;
              if (!db.objectStoreNames.contains('profiles')) {
                db.createObjectStore('profiles', { keyPath: 'id' });
              }
              if (!db.objectStoreNames.contains('media')) {
                const store = db.createObjectStore('media', {
                  keyPath: 'id',
                  autoIncrement: true
                });
                store.createIndex('profile', 'profile');
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          // Clear existing data
          const clearProfilesTx = db.transaction(['profiles'], 'readwrite');
          await new Promise((resolve) => {
            clearProfilesTx.objectStore('profiles').clear();
            clearProfilesTx.oncomplete = resolve;
          });

          const clearMediaTx = db.transaction(['media'], 'readwrite');
          await new Promise((resolve) => {
            clearMediaTx.objectStore('media').clear();
            clearMediaTx.oncomplete = resolve;
          });

          // Import profiles
          if (mediaData.profiles) {
            const profilesTx = db.transaction(['profiles'], 'readwrite');
            const profilesStore = profilesTx.objectStore('profiles');
            for (const profile of mediaData.profiles) {
              profilesStore.put(profile);
            }
            await new Promise((resolve) => { profilesTx.oncomplete = resolve; });
          }

          // Import media
          if (mediaData.media) {
            const mediaTx = db.transaction(['media'], 'readwrite');
            const mediaStore = mediaTx.objectStore('media');
            for (const media of mediaData.media) {
              mediaStore.put(media);
            }
            await new Promise((resolve) => { mediaTx.oncomplete = resolve; });
          }

          db.close();
        } catch (error) {
          console.error('Failed to import media data:', error);
        }
      }

      await this.broadcastStatusUpdate();
      return { success: true, settings: newSettings };
    } catch (error) {
      await this.log.error('SETTINGS_IMPORT_FAIL', error.message, { module: 'SYSTEM' });
      return { success: false, error: error.message };
    }
  }

  async handleResetAll() {
    try {
      // Stop all operations first
      await this.handleStop();

      // Reset storage
      await this.storage.resetAll();

      // Broadcast update
      await this.broadcastStatusUpdate();

      return { success: true };
    } catch (error) {
      await this.log.error('RESET_FAIL', error.message, { module: 'SYSTEM' });
      return { success: false, error: error.message };
    }
  }

  async handleForceActivitySession() {
    try {
      const runtime = await this.storage.getRuntime();

      if (!runtime.running) {
        return { success: false, error: 'Bot is not running. Start the bot first.' };
      }

      await this.log.info('FORCE_ACTIVITY', 'Forcing Activity session start from console', { module: 'ACTIVITY' });

      // ✅ Force start a session immediately (not just tick)
      const result = await this.activity.forceStartSession();

      if (result.success) {
        return { success: true, message: 'Activity session started immediately' };
      } else {
        return result;
      }
    } catch (error) {
      await this.log.error('FORCE_ACTIVITY_FAIL', error.message, { module: 'ACTIVITY' });
      return { success: false, error: error.message };
    }
  }

  async handleForcePostNow() {
    try {
      const runtime = await this.storage.getRuntime();

      if (!runtime.running) {
        return { success: false, error: 'Bot is not running. Start the bot first.' };
      }

      await this.log.info('FORCE_POST', 'Forcing post from console', { module: 'AUTOPOST' });

      // Force trigger the autopost tick immediately
      await this.auto.tick();

      return { success: true, message: 'Post triggered' };
    } catch (error) {
      await this.log.error('FORCE_POST_FAIL', error.message, { module: 'AUTOPOST' });
      return { success: false, error: error.message };
    }
  }

  async startHeartbeat() {
    // Reset failure counter when starting
    this.heartbeatFailures = 0;

    // Clear any existing heartbeat alarm
    await chrome.alarms.clear(ALARM.HEARTBEAT);

    // Create recurring alarm every 2 minutes
    await chrome.alarms.create(ALARM.HEARTBEAT, {
      delayInMinutes: 2,
      periodInMinutes: 2
    });

    console.log('💓 Heartbeat started (ping every 2 minutes)');
  }

  async stopHeartbeat() {
    await chrome.alarms.clear(ALARM.HEARTBEAT);
    console.log('💓 Heartbeat stopped');
  }

  async handleHeartbeat() {
    try {
      // Send lightweight ping to server (verifies session token)
      const sessionToken = await this.license.getSessionToken();

      if (!sessionToken) {
        console.log('💓 Heartbeat: No session token, stopping bot');
        await this.handleStop();
        return;
      }

      // Just verify the token is valid (this will fail if license is revoked/expired)
      const response = await fetch(API.VERIFY_LICENSE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': sessionToken
        },
        body: JSON.stringify({ action: 'heartbeat' })
      });

      // ✅ Check if it's a license error (401/403) or network error
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Real license problem - stop immediately
          console.log('💓 Heartbeat: License revoked/expired (HTTP ' + response.status + '), stopping bot');
          await this.handleStop();
          return;
        }

        // Other HTTP errors (400, 500, 503, etc.) - treat as network issues, don't stop
        this.heartbeatFailures++;
        console.warn(`💓 Heartbeat: HTTP ${response.status} error (${this.heartbeatFailures} consecutive) - Continuing bot (network issue)`);
        return;
      }

      // ✅ Success - reset failure counter
      this.heartbeatFailures = 0;

      // Update license info from heartbeat response
      const data = await response.json();
      if (data.licenseExpiresAt || data.username || data.plan) {
        const updates = {};
        if (data.licenseExpiresAt) updates.licenseExpires = data.licenseExpiresAt;
        if (data.username) updates.licenseUsername = data.username;
        if (data.plan) updates.licensePlan = data.plan;

        await chrome.storage.sync.set(updates);
        console.log('💓 Heartbeat: OK (license info updated)');
      } else {
        console.log('💓 Heartbeat: OK');
      }

    } catch (error) {
      // ✅ Network error tolerance: NEVER stop bot for network issues
      // If network is really down, bot will fail naturally on next action requests
      this.heartbeatFailures++;
      console.warn(`💓 Heartbeat: Network error (${this.heartbeatFailures} consecutive) - ${error.message}`);
      console.log(`💓 Heartbeat: Continuing bot (if network returns, bot will resume normally)`);
    }
  }

  /**
   * Resolve media tags from post text
   * Called by AutoPostEngine before posting
   */
  async resolveMediaTags(postText, profileId = 'default') {
    console.log(`[RESOLVE_MEDIA] Called with postText: "${postText}", profileId: "${profileId}"`);

    const mediaTagRegex = /\[\[media:[^\]]+\]\]/g;
    const tags = postText.match(mediaTagRegex);

    console.log(`[RESOLVE_MEDIA] Found tags:`, tags);

    let resolvedMedia = [];
    let finalText = postText;

    if (tags && tags.length > 0) {
      // Resolve each tag
      for (const tag of tags) {
        console.log(`[RESOLVE_MEDIA] Resolving tag: ${tag}`);
        const media = await this.media.resolveMediaTag(tag, profileId);
        console.log(`[RESOLVE_MEDIA] Resolved media:`, media);
        resolvedMedia = resolvedMedia.concat(media);
      }

      // Remove all tags from text
      finalText = postText.replace(mediaTagRegex, '').trim();
    }

    console.log(`[RESOLVE_MEDIA] Final result: text="${finalText}", media count=${resolvedMedia.length}`);

    return {
      text: finalText,
      media: resolvedMedia
    };
  }

  async handleDailyReset() {
    const settings = await this.storage.getSettings();
    const userTimezone = settings.timezone || 'UTC';
    const todayStr = getTodayDateString(userTimezone);

    await this.storage.mutateRuntime((runtime) => {
      // ✅ Preserve totalPostsLifetime before reset
      const lifetimeCount = runtime.counters?.totalPostsLifetime || 0;

      // ✅ FIX: Reset ALL counters like old version
      runtime.counters = {
        postsToday: 0,
        totalPostsLifetime: lifetimeCount,  // ✅ Preserved, never reset
        likesToday: 0,
        commentLikesToday: 0,
        profilesVisitedToday: 0,
        activityTimeTodaySec: 0,
        sessionsStartedToday: 0,
        notificationChecksToday: 0
      };

      // ✅ FIX: Clear old plan to force new plan generation
      runtime.sessionPlanToday = [];
      runtime.sessionPlanDate = null;
      runtime.mood = null;
      runtime.nextActivityWindow = null;

      // ✅ Track last reset date
      runtime.lastResetDate = todayStr;

      return runtime;
    });

    await this.log.info('DAILY_RESET', 'Daily counters and plan cleared', { module: 'APP' });

    // ✅ FIX: Restart Activity if it was running to generate new plan
    const runtime = await this.storage.getRuntime();
    // settings already loaded at line 1164, reuse it

    if (runtime.running && settings.activityEnabled && this.activity) {
      await this.log.info('ACTIVITY_RESTART', 'Restarting Activity after daily reset', { module: 'APP' });
      await this.activity.onStop();
      await this.activity.onStart();
    }

    // Schedule next daily reset (tomorrow at midnight in user's timezone)
    const tomorrowTimestamp = getTomorrowMidnightTimestamp(userTimezone);
    await this.alarms.schedule(ALARM.DAILY_RESET, tomorrowTimestamp);
    await this.log.info('DAILY_RESET_SCHEDULED', `Next reset at ${new Date(tomorrowTimestamp).toISOString()} (${userTimezone})`, { module: 'APP' });
  }

  async broadcastStatusUpdate() {
    const settings = await this.storage.getSettings();
    const runtime = await this.storage.getRuntime();

    try {
      await chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        running: runtime.running || false,
        settings,
        runtime
      });
    } catch (e) {
      // Popup not open, ignore
    }
  }
}

// ============================================
// INITIALIZATION
// ============================================

const app = new BackgroundApp();

// Initialize immediately (when service worker starts)
console.log('🚀 Background script loaded, starting initialization...');

// Ensure init only runs once
let initPromise = null;

async function ensureInit() {
  if (!initPromise) {
    console.log('⏳ Calling app.init() for the first time...');
    initPromise = app.init();
  }
  return initPromise;
}

// Initialize immediately on script load
(async () => {
  try {
    await ensureInit();
    console.log('✅ Background service worker initialized');
  } catch (error) {
    console.error('❌ Background initialization failed:', error);
    console.error('Error details:', error.stack);
  }
})();

// On install/reload/update, ensure init completes then schedule daily reset
chrome.runtime.onInstalled.addListener(async () => {
  await ensureInit();
  // Generate installId if not exists (for device tracking)
  const result = await chrome.storage.local.get('installId');
  if (!result.installId) {
    const installId = 'client-' + Date.now() + '-' + Math.random().toString(36).substring(2, 15);
    await chrome.storage.local.set({ installId });
    console.log('✅ Generated new installId:', installId);
  }


  // Check version compatibility
  await checkVersionCompatibility();

  // Schedule daily reset in user's timezone
  const settings = await app.storage.getSettings();
  const userTimezone = settings.timezone || 'UTC';
  const tomorrowTimestamp = getTomorrowMidnightTimestamp(userTimezone);

  await app.alarms.schedule(ALARM.DAILY_RESET, tomorrowTimestamp);
  console.log(`✅ Daily reset scheduled for ${new Date(tomorrowTimestamp).toISOString()} (${userTimezone})`);
});

/**
 * Check if extension version is compatible with server requirements
 */
async function checkVersionCompatibility() {
  try {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;

    const response = await fetch(`${API.CHECK_VERSION}?v=${currentVersion}`);
    if (!response.ok) return; // Silently fail if server unavailable

    const data = await response.json();
    const versionInfo = data.result;

    if (versionInfo && versionInfo.updateRequired) {
      console.warn('⚠️ UPDATE REQUIRED:', versionInfo.message);
      console.warn('   Current version:', currentVersion);
      console.warn('   Minimum required:', versionInfo.minVersion);
      console.warn('   Latest version:', versionInfo.latestVersion);

      // Store update requirement for popup to display
      await chrome.storage.local.set({
        updateRequired: true,
        updateMessage: versionInfo.message,
        minVersion: versionInfo.minVersion,
        latestVersion: versionInfo.latestVersion,
        downloadUrl: versionInfo.downloadUrl
      });

      // Disable bot if update is required
      await app.storage.mutateRuntime((runtime) => {
        runtime.running = false;
        runtime.status = 'UPDATE_REQUIRED';
        return runtime;
      });
    } else {
      // Clear update requirement
      await chrome.storage.local.remove(['updateRequired', 'updateMessage', 'minVersion', 'latestVersion', 'downloadUrl']);
    }
  } catch (error) {
    console.warn('Version check failed:', error.message);
    // Don't block extension if version check fails
  }
}

// On browser startup
chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
});

// Cleanup on suspend (prevent memory leaks)
chrome.runtime.onSuspend.addListener(() => {
  if (app.license) {
    app.license.stopPeriodicVerification();
  }
});

// Export for debugging
if (typeof self !== 'undefined') {
  self.app = app;
}
