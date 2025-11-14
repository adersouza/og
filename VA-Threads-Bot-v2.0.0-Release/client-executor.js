/**
 * Client Executor
 * Simple "dumb" executor that receives instructions from server
 * Contains NO business logic - only DOM execution
 */

// Jitter function - adds natural variance to timings
function jitter(baseMs, variance = 0.1) {
  const min = baseMs * (1 - variance);
  const max = baseMs * (1 + variance);
  return Math.floor(min + Math.random() * (max - min));
}

// Constants
const API_RETRY_DELAY = 5 * 60 * 1000; // 5 minutes

// ============================================
// REFRACTORY REGISTRY (Anti-spam for actions)
// ============================================

class RefractoryRegistry {
  constructor(settings) {
    this.lastActions = new Map();
    this.settings = settings;
  }

  note(actionType) {
    this.lastActions.set(actionType, Date.now());
  }

  can(actionType) {
    const lastTime = this.lastActions.get(actionType);
    if (!lastTime) return true;

    const now = Date.now();
    const minGap = this.getRefractoryWindow(actionType);
    return (now - lastTime) >= minGap;
  }

  getRefractoryWindow(actionType) {
    if (actionType.includes('SCROLL') || actionType === 'CONTINUE_READING_COMMENTS') {
      return 0;
    }

    const windows = this.settings?.refractoryWindows || {};
    const [min = 30, max = 60] = windows[actionType] || [];

    const moodFactor = 0.5 + Math.random() * 1.5;
    const seconds = (min + Math.random() * (max - min)) * moodFactor;

    return seconds * 1000;
  }
}

// ============================================
// SESSION STATE (Track position and counters)
// ============================================

class SessionState {
  constructor() {
    this.position = 'timeline';
    this.history = [];
    this.counters = {
      scrolls: 0,
      tweetsOpened: 0,
      profilesVisited: 0,
      notificationChecks: 0,
      commentsScrollCount: 0,
      dmChecks: 0,
      refreshes: 0
    };
    this.lastRefreshTime = null;
    this.flags = {
      hasReadCurrentTweet: false,
      isInComments: false
    };
    this.visitedTweetIds = new Set();

    // States for pending actions
    this.pendingTweetOpen = false;
    this.pendingProfileOpen = false;
    this.pendingTimelineLike = false;
  }

  canOpenTweet(config) {
    return true;
  }

  canCheckNotifications(config) {
    return this.counters.notificationChecks < config.maxNotificationChecks;
  }

  moveTo(newPosition) {
    this.history.push(this.position);
    this.position = newPosition;
    console.log(`STATE: ${this.history[this.history.length-1]} → ${newPosition}`);
  }

  isAt(position) {
    return this.position === position;
  }
}

// ============================================
// POSITION DETECTOR (URL pattern detection)
// ============================================

class PositionDetector {
  constructor() {
    this.patterns = {
      tweet: [
        /\/@[^\/]+\/post\/[A-Za-z0-9_-]+/,
        /\/post\/[A-Za-z0-9]+$/
      ],
      profile: [
        /\/@[^\/]+$/
      ],
      notifications: [
        /\/notifications/,
        /\/activity/
      ],
      dm: [
        /\/direct/,
        /\/messages/
      ]
    };
  }

  detect(url) {
    for (const [position, patterns] of Object.entries(this.patterns)) {
      if (patterns.some(pattern => pattern.test(url))) {
        return position;
      }
    }
    return 'timeline';
  }
}

// ============================================
// CONTENT SCRIPT MANAGER (Reconnection utility)
// ============================================

class ContentScriptManager {
  constructor(log) {
    this.log = log;
  }

  async reconnectContentScript(tabId, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        // Try ping first
        const pingResponse = await chrome.tabs.sendMessage(tabId, {
          type: 'PING'
        }, { frameId: 0 }).catch(() => null);

        if (pingResponse) {
          return true; // Already connected
        }

        // Try to inject script without reload
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        });

        // Wait for initialization
        await new Promise(r => setTimeout(r, 500));

        // Verify it works
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'PING'
        }, { frameId: 0 });

        if (response) {
          await this.log.info('CONTENT_RECONNECTED',
            'Content script reconnected without reload',
            { module: 'EXECUTOR' }
          );
          return true;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }

    // Last resort
    await this.log.warn('CONTENT_RELOAD',
      'Forced to reload tab for content script',
      { module: 'EXECUTOR' }
    );
    return chrome.tabs.reload(tabId);
  }
}

// ============================================
// AUTOPOST EXECUTOR (Server-controlled)
// ============================================

class AutoPostEngine {
  constructor(storage, log, alarms, lock, licenseManager, mediaManager) {
    this.storage = storage;
    this.log = log;
    this.alarms = alarms;
    this.lock = lock;
    this.licenseManager = licenseManager;
    this.mediaManager = mediaManager;
    this.isPosting = false;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async onStart() {
    const settings = await this.storage.getSettings();

    if (!settings.autopostEnabled) {
      await this.log.info('AUTOPOST_DISABLED', 'Auto-post is disabled', { module: 'AUTOPOST' });
      return;
    }

    // Clear all existing alarms
    await this.alarms.clear(ALARM.AUTOPOST_TICK);

    // ✅ FIX: Post in 3-5 seconds on start (like old version)
    const delay = 3000 + Math.random() * 2000;
    const nextPostAt = Date.now() + delay;

    await this.alarms.schedule(ALARM.AUTOPOST_TICK, nextPostAt);

    // ✅ Set nextPostAt in runtime so UI shows countdown
    await this.storage.mutateRuntime((runtime) => {
      runtime.nextPostAt = nextPostAt;
      return runtime;
    });

    await this.log.info('AUTOPOST_STARTING', `First post in ${Math.round(delay/1000)}s`, { module: 'AUTOPOST' });
  }

  async onStop() {
    await this.alarms.clear(ALARM.AUTOPOST_TICK);
    this.isPosting = false;

    // Clear nextPostAt from runtime so UI shows "Disabled"
    await this.storage.mutateRuntime((runtime) => {
      delete runtime.nextPostAt;
      return runtime;
    });
  }


  /**
   * Alarm tick - ask server what to do
   */
  async tick() {
    if (this.isPosting) {
      await this.log.warn('TICK_SKIPPED', 'Post already in progress', { module: 'AUTOPOST' });
      return;
    }


    this.isPosting = true;

    try {
      await this.lock.withLock('AUTOPOST', async () => {
        await this.executeServerAction();
      }, { priority: 10 });
    } catch (error) {
      await this.log.error('TICK_FAIL', error.message, { module: 'AUTOPOST' });
    } finally {
      this.isPosting = false;
    }
  }


  /**
   * Ask server for action and execute it
   */
  async executeServerAction() {
    try {
      const settings = await this.storage.getSettings();
      const runtime = await this.storage.getRuntime();

      if (!runtime.running) {
        await this.log.info('BOT_STOPPED', 'Bot stopped, cancelling post', { module: 'AUTOPOST' });
        return;
      }

      if (!settings.licenseKey) {
        throw new Error('No license key found');
      }

      // Get device fingerprint
      const deviceFingerprint = await this.licenseManager.generateDeviceFingerprint();

      // Get media profiles
      const mediaProfiles = settings.mediaProfiles || {};

      // Ask server: what should I do? (secured with Session Token)
      let data, action;

      try {
        data = await secureTokenCall(API.GET_NEXT_AUTOPOST_ACTION, {
          deviceFingerprint: deviceFingerprint,
          extensionVersion: chrome.runtime.getManifest().version,
          settings: {
            autopostInterval: settings.autopostInterval,
            autopostPauses: settings.autopostPauses,
            timezone: settings.timezone,
            postsRaw: settings.postsRaw,
            mediaDefaultProfile: settings.mediaDefaultProfile,
            // Convert percentage (0-100) to probability (0-1)
            mediaAttachChance: (settings.mediaAttachChance || 0) / 100
          },
          runtime: {
            nextPostIndex: runtime.nextPostIndex || 0,
            postsToday: runtime.postsToday || 0,
            lastTickWasInPause: runtime.lastTickWasInPause || false  // ✅ FIX: Send pause state to server
          },
          mediaProfiles: mediaProfiles
        }, this.licenseManager);

        action = data.result;

      } catch (error) {
        await this.log.error('API_ERROR', `Failed to get action from server: ${error.message}`, { module: 'AUTOPOST' });

        // ✨ Retry after 1 minute (instead of 5) for faster recovery from network issues
        const FAST_RETRY_DELAY = 60 * 1000; // 1 minute
        await this.alarms.schedule(ALARM.AUTOPOST_TICK, Date.now() + FAST_RETRY_DELAY);
        return;
      }

      // Execute action based on server response
      if (action.action === 'WAIT') {
        await this.log.info('ACTION_WAIT', `Waiting: ${action.reason}`, { module: 'AUTOPOST' });

        // ✅ Update runtime with pause state tracking
        await this.storage.mutateRuntime((runtime) => {
          runtime.nextPostAt = action.waitUntil;
          // Track that we're in pause for next calculation
          if (action.updateRuntime) {
            Object.assign(runtime, action.updateRuntime);
          }
          return runtime;
        });

        await this.alarms.schedule(ALARM.AUTOPOST_TICK, action.waitUntil);
        return;
      }

      if (action.action === 'POST') {
        try {
          // ✅ CRITICAL: Re-check if bot is still running before posting
          // This prevents posting if STOP was called during server request
          const currentRuntime = await this.storage.getRuntime();
          if (!currentRuntime.running) {
            await this.log.info('POST_CANCELLED', 'Bot stopped during server request', { module: 'AUTOPOST' });
            return;
          }

          // ✅ Update runtime with pause state tracking (we're NOT in pause anymore)
          if (action.updateRuntime) {
            await this.storage.mutateRuntime((runtime) => {
              Object.assign(runtime, action.updateRuntime);
              return runtime;
            });
          }

          // Resolve media tags from post text using BackgroundApp
          console.log(`[CLIENT-EXECUTOR] About to resolve media for post: "${action.postText}", profile: "${settings.mediaDefaultProfile}"`);
          const { text, media } = await this.app.resolveMediaTags(action.postText, settings.mediaDefaultProfile);
          console.log(`[CLIENT-EXECUTOR] Media resolved: text="${text}", media count=${media.length}`);

          // Execute post with resolved media
          await this.executePost(text, media);

          // ✅ Success - reset retry counter
          this.retryCount = 0;

          // ✅ Update index (counter already incremented in executePost)
          await this.storage.mutateRuntime((runtime) => {
            runtime.nextPostIndex = action.nextIndex;
            return runtime;
          });

          // Schedule next using timing from server action
          if (action.nextPostAt) {
            await this.alarms.schedule(ALARM.AUTOPOST_TICK, action.nextPostAt);

            await this.storage.mutateRuntime((runtime) => {
              runtime.nextPostAt = action.nextPostAt;
              return runtime;
            });

            await this.log.info('AUTOPOST_SCHEDULED', `Next post at ${new Date(action.nextPostAt).toLocaleString()}`, {
              module: 'AUTOPOST',
              nextPostAt: action.nextPostAt
            });
          }

        } catch (postError) {
          // ✅ Post execution failed - apply retry logic
          await this.log.error('POST_FAIL', postError.message, {
            module: 'AUTOPOST',
            retry: this.retryCount,
            maxRetries: this.maxRetries
          });

          if (this.retryCount < this.maxRetries) {
            // Retry with exponential backoff
            this.retryCount++;
            const retryDelay = this.retryCount === 1 ? 10000 : 25000;

            await this.log.info('POST_RETRY', `Retry ${this.retryCount}/${this.maxRetries} in ${retryDelay/1000}s`, {
              module: 'AUTOPOST'
            });

            await this.alarms.schedule(ALARM.AUTOPOST_TICK, Date.now() + retryDelay);
          } else {
            // Max retries reached - skip to next post
            await this.log.warn('POST_SKIP', 'Max retries reached, skipping to next post', {
              module: 'AUTOPOST'
            });

            this.retryCount = 0;

            // Update index to skip failed post
            await this.storage.mutateRuntime((runtime) => {
              runtime.nextPostIndex = action.nextIndex;
              return runtime;
            });

            // Schedule next immediately using timing from server action
            if (action.nextPostAt) {
              await this.alarms.schedule(ALARM.AUTOPOST_TICK, action.nextPostAt);

              await this.storage.mutateRuntime((runtime) => {
                runtime.nextPostAt = action.nextPostAt;
                return runtime;
              });

              await this.log.info('AUTOPOST_SCHEDULED', `Next post at ${new Date(action.nextPostAt).toLocaleString()}`, {
                module: 'AUTOPOST',
                nextPostAt: action.nextPostAt
              });
            }
          }
        }
      }
    } catch (error) {
      await this.log.error('SERVER_ACTION_FAIL', error.message, { module: 'AUTOPOST' });

      // API error - retry in 5 minutes
      await this.alarms.schedule(ALARM.AUTOPOST_TICK, Date.now() + 5 * 60 * 1000);
    }
  }

  /**
   * Execute DOM post action (only execution, no logic)
   */
  async executePost(postText, mediaFiles) {
    try {
      // Find Threads tab
      const [tab] = await chrome.tabs.query({ url: THREADS_URL_PATTERNS });

      if (!tab) {
        throw new Error('No Threads tab found');
      }

      // Activate tab if needed
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // CRITICAL: Check if content script is ready (PING)
      let contentReady = false;
      let pingAttempts = 0;
      const maxPingAttempts = 5;

      while (!contentReady && pingAttempts < maxPingAttempts) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'PING' }, { frameId: 0 });
          contentReady = true;
          await this.log.info('CONTENT_READY', 'Content script is ready', { module: 'AUTOPOST' });
        } catch (e) {
          pingAttempts++;
          if (pingAttempts < maxPingAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500));
          } else {
            // Last resort: try to reconnect
            await this.log.warn('CONTENT_PING_TIMEOUT', 'Content script not responding, attempting reconnection', { module: 'AUTOPOST' });
            const contentManager = new ContentScriptManager(this.log);
            await contentManager.reconnectContentScript(tab.id);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      // Step 1: Open composer
      const composerResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_ACTION',
        actionType: 'OPEN_COMPOSER'
      }, { frameId: 0 });

      if (!composerResult || !composerResult.ok) {
        throw new Error('Failed to open composer');
      }

      // Wait for composer to be ready
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 2: Type and post
      const postResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_ACTION',
        actionType: 'TYPE_AND_POST',
        payload: {
          text: postText,
          media: mediaFiles || []
        }
      }, { frameId: 0 });

      if (!postResult || !postResult.ok) {
        throw new Error(postResult?.errorCode || 'Post failed');
      }

      await this.log.info('POST_SUCCESS', 'Post created successfully', { module: 'AUTOPOST' });

      // Increment postsToday and totalPostsLifetime counters
      await this.storage.mutateRuntime((runtime) => {
        if (!runtime.counters) runtime.counters = {};
        if (!runtime.counters.postsToday) runtime.counters.postsToday = 0;
        if (!runtime.counters.totalPostsLifetime) runtime.counters.totalPostsLifetime = 0;

        runtime.counters.postsToday++;
        runtime.counters.totalPostsLifetime++;
        return runtime;
      });

      // Broadcast to update UI
      if (this.app && this.app.broadcastStatusUpdate) {
        await this.app.broadcastStatusUpdate();
      }
    } catch (error) {
      await this.log.error('POST_EXECUTION_FAIL', error.message, { module: 'AUTOPOST' });
      throw error;
    }
  }

  parsePosts(raw) {
    if (!raw) return [];
    // Split on two or more blank lines (one blank line stays in-post)
    return raw.split(/\n\n+/)
      .map(post => post.trim())
      .filter(post => post.length > 0);
  }

  validatePosts(posts, limit = 500) {
    const tooLong = [];
    const empty = [];

    posts.forEach((post, index) => {
      if (post.length === 0) {
        empty.push(index);
      } else if (post.length > limit) {
        tooLong.push({ index, length: post.length, preview: post.substring(0, 50) + '...' });
      }
    });

    return { tooLong, empty };
  }
}

// ============================================
// ACTION TYPES (FSM Actions)
// ============================================

const ACTION_TYPE = {
  // Existing actions
  LIKE_TWEET: 'LIKE_TWEET',
  LIKE_COMMENT: 'LIKE_COMMENT',
  OPEN_PROFILE: 'OPEN_PROFILE',
  OPEN_NOTIFICATIONS: 'OPEN_NOTIFICATIONS',
  REFRESH_TIMELINE: 'REFRESH_TIMELINE',

  SCROLL_TIMELINE: 'SCROLL_TIMELINE',
  OPEN_TWEET: 'OPEN_TWEET',
  OPEN_COMMENTS: 'OPEN_COMMENTS',
  OPEN_COMPOSER: 'OPEN_COMPOSER',
  TYPE_AND_POST: 'TYPE_AND_POST',
  SCROLL_PROFILE: 'SCROLL_PROFILE',
  SCROLL_NOTIFICATIONS: 'SCROLL_NOTIFICATIONS',

  BACK_TO_TIMELINE: 'BACK_TO_TIMELINE',
  BACK_TO_TWEET: 'BACK_TO_TWEET',
  CONTINUE_READING_COMMENTS: 'CONTINUE_READING_COMMENTS',

  // FSM actions
  DWELL: 'DWELL',              // Reading pause
  IDLE: 'IDLE',                // Distraction
  SCROLL_COMMENTS: 'SCROLL_COMMENTS'  // Scroll in comments
};

// ============================================
// ACTIVITY EXECUTOR (Server-controlled)
// ============================================

class ActivityEngine {
  constructor(storage, log, alarms, lock, licenseManager) {
    this.storage = storage;
    this.log = log;
    this.alarms = alarms;
    this.lock = lock;
    this.licenseManager = licenseManager;
    this.currentState = 'IDLE';
    this.sessionInProgress = false;

    // Initialize helper classes
    this.sessionState = null;
    this.positionDetector = new PositionDetector();
    this.refractory = null; // Will be initialized with settings

    // FSM State Management (from old_local_files)
    this.behaviorConfig = null;
    this.dwellMedians = null;
    this.refractoryWindows = null;

    // Activity timer
    this.activityTimer = null;
    this.isInActiveSession = false;
    this.timerSessionId = null;
    this.sessionStartTime = null;
    this.currentSession = null;
  }

  async onStart() {
    const settings = await this.storage.getSettings();

    if (!settings.activityEnabled) {
      await this.log.info('ACTIVITY_DISABLED', 'Activity is disabled', { module: 'ACTIVITY' });
      return;
    }

    // Initialize refractory registry with settings (includes refractoryWindows)
    if (!this.refractory) {
      this.refractory = new RefractoryRegistry({
        refractoryWindows: settings.refractoryWindows
      });
    }

    // Load dwellMedians from settings for FSM
    if (!this.dwellMedians) {
      this.dwellMedians = settings.dwellMedians;
    }

    // ✅ FIX: Check if plan exists for today BEFORE creating new one
    const runtime = await this.storage.getRuntime();
    const todayStart = this.getTodayStart(settings.timezone);

    // ✅ CRITICAL FIX: Use >= comparison to avoid false stale detection from millisecond drift
    // Plan is valid if sessionPlanDate >= todayStart (same day or future)
    const needsNewPlan =
      !runtime.sessionPlanToday ||
      runtime.sessionPlanToday.length === 0 ||
      !runtime.sessionPlanDate ||
      runtime.sessionPlanDate < todayStart;

    if (needsNewPlan) {
      let reason = 'Unknown';
      if (!runtime.sessionPlanToday || runtime.sessionPlanToday.length === 0) {
        reason = 'No plan exists';
      } else if (!runtime.sessionPlanDate) {
        reason = 'No plan date recorded';
      } else if (runtime.sessionPlanDate < todayStart) {
        const lastPlanDate = new Date(runtime.sessionPlanDate).toLocaleDateString();
        const planMidnight = new Date(runtime.sessionPlanDate).toLocaleTimeString();
        const todayMidnight = new Date(todayStart).toLocaleTimeString();
        reason = `Plan is from ${lastPlanDate} (stale) - plan midnight: ${planMidnight}, today midnight: ${todayMidnight}`;
      }

      await this.log.info('NEW_PLAN_NEEDED', reason, { module: 'ACTIVITY' });

      // ✅ CRITICAL: Reset counters when plan is stale or corrupted (match old_local_files)
      const isStale = runtime.sessionPlanDate && runtime.sessionPlanDate < todayStart;
      const isCorrupted = !runtime.sessionPlanDate && runtime.sessionPlanToday?.length > 0;
      const isEmpty = !runtime.sessionPlanToday || runtime.sessionPlanToday.length === 0;

      if (isStale || isCorrupted || isEmpty) {
        await this.storage.mutateRuntime((runtime) => {
          runtime.counters = {
            postsToday: 0,
            likesToday: 0,
            commentLikesToday: 0,
            profilesVisitedToday: 0,
            activityTimeTodaySec: 0,
            sessionsStartedToday: 0,
            notificationChecksToday: 0,
            tweetsOpenedToday: 0,
            scrollsToday: 0,
            refreshesToday: 0
          };
          runtime.visitedTweetIds = [];
          return runtime;
        });

        const resetReason = isStale ? 'stale plan' : isCorrupted ? 'corrupted plan' : 'empty plan';
        await this.log.info('COUNTERS_RESET', `Daily counters reset due to ${resetReason}`, {
          module: 'ACTIVITY',
          isStale,
          isCorrupted,
          isEmpty
        });
      }

      await this.createDailyPlanFromServer();
    } else {
      // Plan already exists for today
      const planDate = new Date(runtime.sessionPlanDate).toLocaleDateString();
      const remainingSessions = runtime.sessionPlanToday.length - (runtime.counters?.sessionsStartedToday || 0);
      await this.log.info('PLAN_VALID',
        `Using existing plan from ${planDate} (${remainingSessions} sessions remaining)`,
        { module: 'ACTIVITY', mood: runtime.mood }
      );
    }

    // Start session check timer
    this.startSessionCheck();
  }

  /**
   * Get today's start timestamp in given timezone
   */
  getTodayStart(timezone) {
    // ✅ CRITICAL FIX: Correct method to get midnight in a timezone
    const now = Date.now();

    // Create formatter for target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Get current date/time in target timezone
    const parts = formatter.formatToParts(new Date(now));
    const get = (type) => parseInt(parts.find(p => p.type === type).value);

    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');

    // Calculate milliseconds since midnight in this timezone
    const msSinceMidnight = (hour * 3600 + minute * 60 + second) * 1000;

    // Subtract to get exact timestamp of midnight in this timezone
    const midnight = now - msSinceMidnight;

    // ✅ CRITICAL: Round down to nearest second to avoid millisecond drift issues
    // This ensures consistent comparison with server-generated planDate
    return Math.floor(midnight / 1000) * 1000;
  }

  async onStop() {
    console.log('🛑 Stopping Activity Engine...');

    // Mark immediately as stopped
    this.isInActiveSession = false;
    this.sessionInProgress = false;

    // Stop activity timer
    this.stopActivityTimer();

    // Clear alarms
    await this.alarms.clear(ALARM.ACTIVITY_TICK);

    // Clear nextActivityWindow from runtime so UI shows "Disabled"
    await this.storage.mutateRuntime((runtime) => {
      delete runtime.nextActivityWindow;
      return runtime;
    });
  }

  startActivityTimer() {
    // Prevent multiple timers
    if (this._startingTimer) {
      console.log('⚠️ Timer already starting, skipping');
      return;
    }

    this._startingTimer = true;

    try {
      // Stop any existing timer first
      if (this.activityTimer) {
        clearInterval(this.activityTimer);
        this.activityTimer = null;
      }

      // Generate unique session ID
      const currentSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.timerSessionId = currentSessionId;

      console.log('⏱️ Starting activity timer with ID:', currentSessionId);

      // Mark in storage to prevent duplicates
      this.storage.mutateRuntime((runtime) => {
        runtime._activityTimerActive = true;
        runtime._activityTimerStartedAt = currentSessionId;
        runtime._lastActivityTick = Date.now();
        return runtime;
      });

      // Start the timer immediately
      this.activityTimer = setInterval(async () => {
        try {
          // Verify it's still the correct session
          if (this.timerSessionId !== currentSessionId) {
            console.log('Timer ID mismatch, stopping');
            clearInterval(this.activityTimer);
            return;
          }

          // Increment the counter
          await this.storage.mutateRuntime((runtime) => {
            if (!runtime.counters) {
              runtime.counters = {};
            }

            // Initialize if necessary
            if (typeof runtime.counters.activityTimeTodaySec !== 'number') {
              runtime.counters.activityTimeTodaySec = 0;
            }

            runtime.counters.activityTimeTodaySec++;
            runtime._lastActivityTick = Date.now();

            // Log for debug
            if (runtime.counters.activityTimeTodaySec % 10 === 0) {
              console.log(`⏱️ Activity time: ${runtime.counters.activityTimeTodaySec}s`);
            }

            return runtime;
          });
        } catch (error) {
          console.error('Error in activity timer:', error);
        }
      }, 1000);

      console.log('✅ Activity timer started successfully');

    } finally {
      // Always release the starting lock
      this._startingTimer = false;
    }
  }

  stopActivityTimer() {
    // Clear the timer JavaScript
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }

    // Clear the session ID
    this.timerSessionId = null;
    this.isInActiveSession = false;

    // Clear the flag in storage
    this.storage.mutateRuntime((runtime) => {
      delete runtime._activityTimerActive;
      delete runtime._activityTimerStartedAt;
      return runtime;
    });

    console.log('⏹️ Activity timer stopped completely');
  }

  /**
   * Ask server to create daily plan
   */
  async createDailyPlanFromServer() {
    try {
      const settings = await this.storage.getSettings();

      if (!settings.licenseKey) {
        throw new Error('No license key found');
      }

      const deviceFingerprint = await this.licenseManager.generateDeviceFingerprint();

      // Ask server: create my daily plan (secured with Session Token)
      let data, plan;

      try {
        data = await secureTokenCall(API.CREATE_DAILY_ACTIVITY_PLAN, {
          deviceFingerprint: deviceFingerprint,
          settings: {
            moodWeights: settings.moodWeights || { low: 0.2, normal: 0.5, high: 0.3 },
            sessionsByMood: settings.sessionsByMood || { low: [1, 2], normal: [2, 4], high: [4, 6] },
            sessionTypeDistribution: settings.sessionTypeDistribution,
            sessionDurations: settings.sessionDurations,
            autopostPauses: settings.autopostPauses,
            timezone: settings.timezone,
            offDayProbability: settings.offDayProbability || 0.06
          }
        }, this.licenseManager);

        plan = data.result;

      } catch (fetchError) {
        throw new Error(`Failed to create daily plan: ${fetchError.message}`);
      }

      // Save plan to runtime
      await this.storage.mutateRuntime((runtime) => {
        runtime.sessionPlanToday = plan.sessions;
        runtime.mood = plan.mood;
        runtime.sessionPlanDate = plan.planDate;
        return runtime;
      });

      await this.log.info('DAILY_PLAN_CREATED', `Created ${plan.sessionCount} sessions (${plan.mood} mood)`, {
        module: 'ACTIVITY',
        mood: plan.mood,
        totalMinutes: plan.totalMinutes
      });
    } catch (error) {
      await this.log.error('DAILY_PLAN_FAIL', error.message, { module: 'ACTIVITY' });
    }
  }

  /**
   * Schedule next activity window (precise scheduling instead of polling)
   */
  async scheduleNextWindow() {
    // Clear existing alarm
    await this.alarms.clear(ALARM.ACTIVITY_TICK);

    const runtime = await this.storage.getRuntime();
    const settings = await this.storage.getSettings();

    const now = Date.now();
    const todayStart = this.getTodayStart(settings.timezone);
    const msSinceMidnight = now - todayStart;
    const currentMinutes = Math.floor(msSinceMidnight / (60 * 1000));

    // Find next session that hasn't started yet
    const nextSession = runtime.sessionPlanToday?.find(s => {
      return s.startMinutes > currentMinutes;
    });

    if (!nextSession) {
      // No more sessions today
      await this.storage.mutateRuntime((rt) => {
        rt.nextActivityWindow = null;
        return rt;
      });

      await this.log.info('ACTIVITY_DAY_COMPLETE', 'All sessions completed for today', { module: 'ACTIVITY' });

      // Broadcast for UI update
      if (this.app?.broadcastStatusUpdate) {
        await this.app.broadcastStatusUpdate();
      }
      return;
    }

    // Calculate start and end times
    const startTime = todayStart + (nextSession.startMinutes * 60 * 1000);
    const endTime = startTime + (nextSession.durationMinutes * 60 * 1000);

    // Save to runtime for UI display
    await this.storage.mutateRuntime((rt) => {
      rt.nextActivityWindow = {
        start: startTime,
        end: endTime
      };
      return rt;
    });

    // ✅ FIX: Schedule alarm at EXACT start time (not 60s polling)
    await this.alarms.schedule(ALARM.ACTIVITY_TICK, startTime);

    const startTimeFormatted = new Date(startTime).toLocaleTimeString();
    await this.log.info('ACTIVITY_SCHEDULED',
      `Next session at ${startTimeFormatted}`,
      { module: 'ACTIVITY', sessionType: nextSession.type, durationMin: nextSession.durationMinutes }
    );

    // Broadcast for UI update
    if (this.app?.broadcastStatusUpdate) {
      await this.app.broadcastStatusUpdate();
    }
  }

  /**
   * Check if we should be in a session (called by alarm at precise time)
   */
  startSessionCheck() {
    // ✅ FIX: Call scheduleNextWindow instead of polling
    this.scheduleNextWindow();
  }

  /**
   * Tick - check if we're in activity window (called by alarm at precise time)
   */
  async tick() {
    try {
      // Check if session already in progress
      if (this.sessionInProgress) {
        console.log('⚠️ Session already in progress, skipping tick');
        return;
      }

      // CRITICAL: Check if AutoPost is posting before starting session
      if (this.app?.auto?.isPosting) {
        console.log('📮 AutoPost is posting, delaying Activity session start...');
        // Reschedule tick in 2 seconds to check again
        await this.alarms.schedule(ALARM.ACTIVITY_TICK, Date.now() + 2000);
        return;
      }

      const settings = await this.storage.getSettings();
      const runtime = await this.storage.getRuntime();
      const now = Date.now();

      if (!runtime.running || !settings.activityEnabled) {
        return;
      }

      // CRITICAL: Check if AutoPost has lock or post is imminent
      if ((this.lock.lock && this.lock.lock.owner === 'AUTOPOST') ||
          (runtime.nextPostAt && (runtime.nextPostAt - now) < 8000)) {
        console.log('📮 AutoPost active or imminent, delaying Activity session start...');
        // Reschedule tick in 2 seconds to check again
        await this.alarms.schedule(ALARM.ACTIVITY_TICK, Date.now() + 2000);
        return;
      }

      // ✅ FIX: Check window LOCALLY before calling API
      if (!runtime.nextActivityWindow ||
          now < runtime.nextActivityWindow.start ||
          now > runtime.nextActivityWindow.end) {

        if (runtime.nextActivityWindow && now > runtime.nextActivityWindow.end) {
          await this.log.info('SESSION_EXPIRED', 'Session window expired, scheduling next', { module: 'ACTIVITY' });
        }

        // Re-schedule next window
        await this.scheduleNextWindow();
        return;
      }

      // ✅ OK, we're in the window → start session
      this.sessionInProgress = true;

      // Get session details from plan
      const todayStart = this.getTodayStart(settings.timezone);
      const msSinceMidnight = now - todayStart;
      const currentMinutes = Math.floor(msSinceMidnight / (60 * 1000));

      const currentSession = runtime.sessionPlanToday?.find(s => {
        const sessionStart = s.startMinutes;
        const sessionEnd = s.startMinutes + s.durationMinutes;
        return currentMinutes >= sessionStart && currentMinutes < sessionEnd;
      });

      if (!currentSession) {
        await this.log.warn('NO_SESSION_FOUND', 'No session found for current time', { module: 'ACTIVITY' });
        this.sessionInProgress = false;
        await this.scheduleNextWindow();
        return;
      }

      // Start the session
      await this.startSession(currentSession);

    } catch (error) {
      await this.log.error('SESSION_CHECK_FAIL', error.message, { module: 'ACTIVITY' });
      this.sessionInProgress = false;
      this.isInActiveSession = false;
      this.stopActivityTimer();

      // Retry in 5 minutes
      await this.alarms.schedule(ALARM.ACTIVITY_TICK, Date.now() + 5 * 60 * 1000);
    }
  }

  /**
   * Start activity session (renamed from runSession to match old_local_files)
   */
  async startSession(session) {
    const sessionStart = Date.now();
    // ✅ Support both 'duration' and 'durationMinutes' (server vs local plan)
    const durationMs = (session.durationMinutes || session.duration || 10) * 60 * 1000;
    const sessionEnd = sessionStart + durationMs;

    // ✅ NEW: Fetch behavior profile from server (ONE TIME per session)
    if (!this.behaviorConfig) {
      await this.fetchBehaviorProfile();
    }

    // ✅ Initialize session state for FSM
    if (!this.sessionState) {
      this.sessionState = new SessionState();
    }

    // Start activity timer
    this.startActivityTimer();
    this.isInActiveSession = true;

    await this.log.info('SESSION_START', `Starting ${session.type} session`, {
      module: 'ACTIVITY',
      durationMin: Math.round(durationMs / 60000)
    });

    while (Date.now() < sessionEnd && this.sessionInProgress) {
      // CRITICAL: Check if AutoPost is actively posting (direct flag check)
      if (this.app?.auto?.isPosting) {
        console.log('📮 AutoPost is posting, activity frozen...');
        await new Promise(resolve => setTimeout(resolve, jitter(1000)));
        continue;
      }

      // Check if AutoPost has the lock
      if (this.lock.lock && this.lock.lock.owner === 'AUTOPOST') {
        console.log('📮 AutoPost has lock, activity frozen...');
        await new Promise(resolve => setTimeout(resolve, jitter(1000)));
        continue;
      }

      // If a post is coming in less than 8 seconds, freeze completely
      const runtime = await this.storage.getRuntime();
      if (runtime.nextPostAt) {
        const timeUntilPost = runtime.nextPostAt - Date.now();
        if (timeUntilPost > 0 && timeUntilPost < 8000) {
          console.log(`📮 Post in ${Math.round(timeUntilPost/1000)}s, freezing activity...`);
          await new Promise(resolve => setTimeout(resolve, jitter(1000)));
          continue;
        }
      }

      try {
        await this.executeNextAction(session.type, Date.now() - sessionStart);
      } catch (error) {
        await this.log.error('ACTION_FAIL', error.message, { module: 'ACTIVITY' });
      }

      // Variable delay 0.5-4s with ±10% jitter for natural timing
      const baseDelay = 500 + Math.random() * 3500; // 0.5-4s
      await new Promise(resolve => setTimeout(resolve, jitter(baseDelay)));
    }

    // Stop timer and mark as stopped
    this.stopActivityTimer();
    this.sessionInProgress = false;
    this.isInActiveSession = false;

    // ✅ FIX: Increment session counter
    await this.storage.mutateRuntime((rt) => {
      if (!rt.counters) rt.counters = {};
      rt.counters.sessionsStartedToday = (rt.counters.sessionsStartedToday || 0) + 1;
      return rt;
    });

    await this.log.info('SESSION_COMPLETE', 'Activity session completed', { module: 'ACTIVITY' });

    // ✅ CRITICAL: Schedule next session
    await this.scheduleNextWindow();
  }

  /**
   * Force start an activity session immediately (for console command)
   */
  async forceStartSession() {
    // Check if already in session
    if (this.sessionInProgress) {
      console.log('⚠️ Session already in progress');
      return { success: false, error: 'Session already in progress' };
    }

    // Check if AutoPost is posting
    if (this.app?.auto?.isPosting) {
      console.log('⚠️ AutoPost is posting, cannot start activity');
      return { success: false, error: 'AutoPost is posting' };
    }

    const settings = await this.storage.getSettings();
    if (!settings.activityEnabled) {
      return { success: false, error: 'Activity is disabled in settings' };
    }

    // Mark as in progress
    this.sessionInProgress = true;

    // Create a forced session (medium type, 10 minutes)
    const forcedSession = {
      type: 'medium',
      durationMinutes: 10,
      startMinutes: 0,
      window: 'forced'
    };

    await this.log.info('FORCE_SESSION_START', 'Force starting activity session from console', { module: 'ACTIVITY' });

    // Run the session
    await this.startSession(forcedSession);

    return { success: true };
  }

  /**
   * Fetch behavior profile from server (called once per session)
   * TODO: Replace executeNextAction() with local chooseNextState() using this profile
   */
  async fetchBehaviorProfile() {
    try {
      const settings = await this.storage.getSettings();
      const deviceFingerprint = await this.licenseManager.generateDeviceFingerprint();

      // Fetch behavior profile from server (secured with Session Token)
      const data = await secureTokenCall(API.GET_BEHAVIOR_PROFILE, {
        deviceFingerprint: deviceFingerprint,
        sessionType: 'medium' // Can be dynamic later
      }, this.licenseManager);

      const profile = data.result;

      // Store for local FSM use
      this.behaviorConfig = profile.humanBehavior;
      this.dwellMedians = profile.dwellMedians;
      this.refractoryWindows = profile.refractoryWindows;

      console.log('✅ Behavior profile loaded from server');
    } catch (error) {
      await this.log.error('BEHAVIOR_PROFILE_FAIL', error.message, { module: 'ACTIVITY' });
      // Fallback to default behavior if server fails
      this.behaviorConfig = null;
    }
  }

  /**
   * Detect position from URL using PositionDetector
   */
  detectPositionFromURL(url) {
    return this.positionDetector.detect(url);
  }

  /**
   * Safe state synchronization with URL position
   */
  async safeStateSync() {
    try {
      const [tab] = await chrome.tabs.query({
        url: THREADS_URL_PATTERNS
      });

      if (!tab || !tab.url) {
        // No Threads tab, reset state
        this.sessionState = new SessionState();
        await this.log.warn('NO_TAB_FOR_SYNC', 'No Threads tab found for state sync', { module: 'ACTIVITY' });
        return false;
      }

      const url = tab.url;
      const realPosition = this.detectPositionFromURL(url);

      if (!this.sessionState) {
        this.sessionState = new SessionState();
      }

      const previousPosition = this.sessionState.position;

      // If position changed
      if (realPosition !== previousPosition) {
        // Save old state before changing
        const oldTweetState = this.sessionState.tweetState;
        const oldProfileState = this.sessionState.profileState;

        // Update position
        this.sessionState.position = realPosition;

        // Handle state transitions properly
        switch(realPosition) {
          case 'timeline':
            // Reset temporary states UNLESS we have pending actions
            if (!this.sessionState.pendingTweetOpen &&
                !this.sessionState.pendingProfileOpen &&
                !this.sessionState.pendingTimelineLike) {
              this.sessionState.tweetState = null;
              this.sessionState.profileState = null;
              this.sessionState.notifState = null;
            }
            break;

          case 'tweet':
            // Initialize tweet state if arriving without state
            if (!this.sessionState.tweetState) {
              const [minSec, maxSec] = this.dwellMedians.thread;
              const duration = minSec + Math.random() * (maxSec - minSec);
              this.sessionState.tweetState = {
                hasReadTweet: false,
                hasDecidedAfterReading: false,
                startTime: Date.now(),
                targetEndTime: Date.now() + (duration * 1000),
                commentLikes: 0,
                lastActionWasLike: false,
                scrollsInComments: 0,
                commentsScrollCount: 0
              };
            }
            break;

          case 'profile':
            // Initialize profile state if arriving without state
            if (!this.sessionState.profileState) {
              const [minSec, maxSec] = this.dwellMedians.profile;
              const duration = minSec + Math.random() * (maxSec - minSec);
              this.sessionState.profileState = {
                startTime: Date.now(),
                targetEndTime: Date.now() + (duration * 1000),
                hasInitialPause: false
              };
            }
            break;
        }

        // Log only significant changes
        if (previousPosition !== 'unknown' &&
            (previousPosition !== 'timeline' || realPosition !== 'timeline')) {
          await this.log.info('STATE_SYNC_CORRECTION',
            `Position synchronized: ${previousPosition} → ${realPosition}`,
            { module: 'ACTIVITY', url: url }
          );
        }
      }

      return true;

    } catch (error) {
      console.error('Error in safeStateSync:', error);
      this.sessionState = new SessionState();
      return false;
    }
  }

  /**
   * Update position after successful action execution
   */
  async updatePositionAfterSuccess(actionType) {
    if (!this.sessionState) {
      this.sessionState = new SessionState();
    }

    const state = this.sessionState;
    const previousPosition = state.position;

    switch(actionType) {
      case ACTION_TYPE.OPEN_TWEET:
        // Only if we were on timeline
        if (previousPosition === 'timeline') {
          state.moveTo('tweet');
          state.counters.tweetsOpened++;
          this.refractory.note(ACTION_TYPE.OPEN_TWEET);
          await this.log.info('POSITION_CHANGE', 'timeline → tweet', { module: 'ACTIVITY' });
        }
        break;

      case ACTION_TYPE.OPEN_PROFILE:
        if (previousPosition === 'timeline' || previousPosition === 'tweet') {
          state.moveTo('profile');
          state.counters.profilesVisited++;
          this.refractory.note(ACTION_TYPE.OPEN_PROFILE);
          await this.log.info('POSITION_CHANGE', `${previousPosition} → profile`, { module: 'ACTIVITY' });
        }
        break;

      case ACTION_TYPE.OPEN_NOTIFICATIONS:
        state.moveTo('notifications');
        state.counters.notificationChecks++;
        this.refractory.note(ACTION_TYPE.OPEN_NOTIFICATIONS);
        await this.log.info('POSITION_CHANGE', `${previousPosition} → notifications`, { module: 'ACTIVITY' });
        break;

      case ACTION_TYPE.BACK_TO_TIMELINE:
        // Complete reset when going back
        state.position = 'timeline';
        state.tweetState = null;
        state.profileState = null;
        state.notifState = null;
        state.pendingTweetOpen = false;
        state.pendingProfileOpen = false;
        state.pendingTimelineLike = false;
        await this.log.info('POSITION_CHANGE', `${previousPosition} → timeline`, { module: 'ACTIVITY' });
        break;

      // Actions that note refractory but don't change position
      case ACTION_TYPE.LIKE_TWEET:
        this.refractory.note(ACTION_TYPE.LIKE_TWEET);
        await this.log.info('ACTION_TRACKED', 'Like tweet noted in refractory', { module: 'ACTIVITY' });
        break;

      case ACTION_TYPE.LIKE_COMMENT:
        this.refractory.note(ACTION_TYPE.LIKE_COMMENT);
        await this.log.info('ACTION_TRACKED', 'Like comment noted in refractory', { module: 'ACTIVITY' });
        break;

      // Scrolls and dwells don't change position and have no refractory
      case ACTION_TYPE.SCROLL_TIMELINE:
      case ACTION_TYPE.SCROLL_PROFILE:
      case ACTION_TYPE.SCROLL_NOTIFICATIONS:
      case ACTION_TYPE.SCROLL_COMMENTS:
      case ACTION_TYPE.CONTINUE_READING_COMMENTS:
      case ACTION_TYPE.REFRESH_TIMELINE:
      case ACTION_TYPE.DWELL:
      case ACTION_TYPE.IDLE:
        // No position change or refractory
        break;

      default:
        console.warn(`Unknown action type for position update: ${actionType}`);
    }
  }

  /**
   * Choose next FSM state based on current position (FULL FSM LOGIC)
   */
  async chooseNextState() {
    // Load config if not loaded
    if (!this.behaviorConfig) {
      const defaults = await fetch(chrome.runtime.getURL('/config/defaults.json'))
        .then(r => r.json());
      this.behaviorConfig = defaults.humanBehavior;
      this.dwellMedians = defaults.dwellMedians;
    }

    // Safe state synchronization
    const syncSuccess = await this.safeStateSync();

    if (!syncSuccess) {
      // If sync failed, do safe action
      return {
        action: ACTION_TYPE.IDLE,
        duration: 3000 + Math.random() * 2000,
        payload: {}
      };
    }

    const state = this.sessionState;
    const config = this.behaviorConfig;
    const limits = config.sessionLimits;

    // Helper for reading time
    const readingTime = (type) => {
      const [min, max] = config.readingTimes[type];
      return (min + Math.random() * (max - min)) * 1000;
    };

    // LOGIC BY POSITION
    switch(state.position) {
      case 'timeline':
        // Check pending actions
        if (state.pendingTweetOpen) {
          state.pendingTweetOpen = false;
          return {
            action: ACTION_TYPE.OPEN_TWEET,
            duration: 800 + Math.random() * 700,
            payload: {}
          };
        }

        if (state.pendingProfileOpen) {
          state.pendingProfileOpen = false;
          return {
            action: ACTION_TYPE.OPEN_PROFILE,
            duration: 800 + Math.random() * 700,
            payload: { fromTimeline: true }
          };
        }

        if (state.pendingTimelineLike) {
          state.pendingTimelineLike = false;
          this.refractory.note(ACTION_TYPE.LIKE_TWEET);
          return {
            action: ACTION_TYPE.LIKE_TWEET,
            duration: 1000 + Math.random() * 2000,
            payload: { fromTimeline: true }
          };
        }

        // Increment scrolls
        state.counters.scrolls++;

        // Use probabilities from JSON
        const rand = Math.random();
        let cumulative = 0;

        for (const [action, probability] of Object.entries(config.timelineActions)) {
          cumulative += probability;
          if (rand < cumulative) {
            switch(action) {
              case 'continueScroll':
                return {
                  action: ACTION_TYPE.SCROLL_TIMELINE,
                  duration: 0,
                  payload: {}
                };

              case 'refreshTimeline':
                // Limit refresh (not more than once every 5 minutes)
                if (!state.lastRefreshTime || (Date.now() - state.lastRefreshTime) > 300000) {
                  state.lastRefreshTime = Date.now();

                  console.log('TIMELINE_REFRESH: Refreshing timeline feed');

                  return {
                    action: ACTION_TYPE.REFRESH_TIMELINE,
                    duration: 2000 + Math.random() * 1000,
                    payload: {}
                  };
                } else {
                  // Too early for refresh, continue scrolling
                  return {
                    action: ACTION_TYPE.SCROLL_TIMELINE,
                    duration: 0,
                    payload: {}
                  };
                }

              case 'openTweet':
                if (!this.refractory.can(ACTION_TYPE.OPEN_TWEET)) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (state.counters.scrolls < 2) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (!state.pendingTweetOpen) {
                  state.pendingTweetOpen = true;
                  const [minSec, maxSec] = this.behaviorConfig.readingTimes.tweetInTimeline || [3, 8];
                  const readTime = (minSec + Math.random() * (maxSec - minSec)) * 1000;

                  return {
                    action: ACTION_TYPE.IDLE,
                    duration: readTime,
                    payload: {}
                  };
                }
                break;

              case 'likeTweetFromTimeline':
                if (!this.refractory.can(ACTION_TYPE.LIKE_TWEET)) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (!state.pendingTimelineLike) {
                  state.pendingTimelineLike = true;
                  const [minSec, maxSec] = this.behaviorConfig.readingTimes.tweetInTimeline || [3, 8];
                  const readTime = (minSec + Math.random() * (maxSec - minSec)) * 1000;

                  return {
                    action: ACTION_TYPE.IDLE,
                    duration: readTime,
                    payload: {}
                  };
                }
                break;

              case 'openProfile':
                if (state.counters.profilesVisited >= limits.maxProfiles) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (!this.refractory.can(ACTION_TYPE.OPEN_PROFILE)) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (!state.pendingProfileOpen) {
                  state.pendingProfileOpen = true;
                  const readTime = 1000 + Math.random() * 2000;

                  return {
                    action: ACTION_TYPE.IDLE,
                    duration: readTime,
                    payload: {}
                  };
                }
                break;

              case 'checkNotifications':
                if (!state.canCheckNotifications(limits)) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                if (!this.refractory.can(ACTION_TYPE.OPEN_NOTIFICATIONS)) {
                  return { action: ACTION_TYPE.SCROLL_TIMELINE, duration: 0, payload: {} };
                }

                return {
                  action: ACTION_TYPE.OPEN_NOTIFICATIONS,
                  duration: 1200 + Math.random() * 800,
                  payload: {}
                };
            }
          }
        }

        // Fallback: continue scrolling
        return {
          action: ACTION_TYPE.SCROLL_TIMELINE,
          duration: 0,
          payload: {}
        };

      case 'tweet':
        if (!state.tweetState) {
          const [minSec, maxSec] = this.dwellMedians.thread;
          const duration = minSec + Math.random() * (maxSec - minSec);
          state.tweetState = {
            hasReadTweet: false,
            hasDecidedAfterReading: false,
            startTime: Date.now(),
            targetEndTime: Date.now() + (duration * 1000),
            commentLikes: 0,
            lastActionWasLike: false,
            scrollsInComments: 0,
            commentsScrollCount: 0
          };
        }

        if (!state.tweetState.hasReadTweet) {
          state.tweetState.hasReadTweet = true;
          return {
            action: ACTION_TYPE.DWELL,
            duration: readingTime('tweetOpened'),
            payload: {}
          };
        }

        if (!state.tweetState.hasDecidedAfterReading) {
          state.tweetState.hasDecidedAfterReading = true;

          const afterReading = config.afterReadingTweet;
          const decision = Math.random();

          if (decision < afterReading.likeTweet && this.refractory.can(ACTION_TYPE.LIKE_TWEET)) {
            this.refractory.note(ACTION_TYPE.LIKE_TWEET);
            return {
              action: ACTION_TYPE.LIKE_TWEET,
              duration: 400 + Math.random() * 800,
              payload: {}
            };
          }

          return {
            action: ACTION_TYPE.CONTINUE_READING_COMMENTS,
            duration: 0,
            payload: {}
          };
        }

        if (Date.now() < state.tweetState.targetEndTime) {
          const commentConfig = config.commentBehavior;

          // Verify we scrolled at least 2 times
          const canLikeComment = state.tweetState.commentsScrollCount >= 2;

          const randomRoll = Math.random();
          const canRefractory = this.refractory.can(ACTION_TYPE.LIKE_COMMENT);

          const shouldLikeComment =
            canLikeComment &&
            randomRoll < commentConfig.likeChancePerScroll &&
            state.tweetState.commentLikes < commentConfig.maxLikesPerTweet &&
            canRefractory;

          // Debug log
          console.log(`[LIKE_COMMENT] scrollCount=${state.tweetState.commentsScrollCount}, canLike=${canLikeComment}, roll=${randomRoll.toFixed(3)}, chance=${commentConfig.likeChancePerScroll}, commentLikes=${state.tweetState.commentLikes}/${commentConfig.maxLikesPerTweet}, refractory=${canRefractory}, shouldLike=${shouldLikeComment}`);

          if (shouldLikeComment) {
            state.tweetState.commentLikes++;
            this.refractory.note(ACTION_TYPE.LIKE_COMMENT);

            await this.log.info('COMMENT_LIKE_ATTEMPT', `Attempting to like comment (${state.tweetState.commentLikes}/${commentConfig.maxLikesPerTweet})`, { module: 'ACTIVITY' });

            return {
              action: ACTION_TYPE.LIKE_COMMENT,
              duration: 400 + Math.random() * 800,
              payload: {}
            };
          }

          state.tweetState.commentsScrollCount++;
          return {
            action: ACTION_TYPE.CONTINUE_READING_COMMENTS,
            duration: 0,
            payload: {}
          };
        }

        state.tweetState = null;

        return {
          action: ACTION_TYPE.BACK_TO_TIMELINE,
          duration: 800 + Math.random() * 800,
          payload: {}
        };

      case 'profile':
        if (!state.profileState) {
          const [minSec, maxSec] = this.dwellMedians.profile;
          const duration = minSec + Math.random() * (maxSec - minSec);

          state.profileState = {
            startTime: Date.now(),
            targetEndTime: Date.now() + (duration * 1000),
            hasInitialPause: false
          };
        }

        if (!state.profileState.hasInitialPause) {
          state.profileState.hasInitialPause = true;
          const [min, max] = this.behaviorConfig.readingTimes.profile;
          return {
            action: ACTION_TYPE.DWELL,
            duration: (min + Math.random() * (max - min)) * 1000,
            payload: {}
          };
        }

        if (Date.now() >= state.profileState.targetEndTime) {
          state.profileState = null;

          return {
            action: ACTION_TYPE.BACK_TO_TIMELINE,
            duration: 500 + Math.random() * 1000,
            payload: {}
          };
        }

        // Like a tweet from profile (same chance as timeline: 2.5%)
        const likeTweetChance = config.timelineActions.likeTweetFromTimeline;

        if (Math.random() < likeTweetChance && this.refractory.can(ACTION_TYPE.LIKE_TWEET)) {
          this.refractory.note(ACTION_TYPE.LIKE_TWEET);
          return {
            action: ACTION_TYPE.LIKE_TWEET,
            duration: 800 + Math.random() * 1200,
            payload: { source: 'profile' }
          };
        }

        // Otherwise scroll the profile
        return {
          action: ACTION_TYPE.SCROLL_PROFILE,
          duration: 0,
          payload: {}
        };

      case 'notifications':
        if (!state.notifState) {
          const [minSec, maxSec] = this.dwellMedians.notifications;
          const duration = minSec + Math.random() * (maxSec - minSec);

          state.notifState = {
            startTime: Date.now(),
            targetEndTime: Date.now() + (duration * 1000),
            hasInitialPause: false
          };
        }

        if (!state.notifState.hasInitialPause) {
          state.notifState.hasInitialPause = true;
          const [min, max] = this.behaviorConfig.readingTimes.notifications;
          return {
            action: ACTION_TYPE.DWELL,
            duration: (min + Math.random() * (max - min)) * 1000,
            payload: {}
          };
        }

        if (Date.now() >= state.notifState.targetEndTime) {
          state.notifState = null;

          return {
            action: ACTION_TYPE.BACK_TO_TIMELINE,
            duration: 500 + Math.random() * 1000,
            payload: {}
          };
        }

        return {
          action: ACTION_TYPE.SCROLL_NOTIFICATIONS,
          duration: 0,
          payload: {}
        };

      default:
        console.error(`Unknown position: ${state.position}`);

        return {
          action: ACTION_TYPE.BACK_TO_TIMELINE,
          duration: 1200 + Math.random() * 800,
          payload: {}
        };
    }
  }

  /**
   * Execute next FSM action (LOCAL - zero latency)
   */
  async executeNextAction(sessionType, elapsedTime) {
    try {
      // ✅ CRITICAL: Check if bot is still running
      const runtime = await this.storage.getRuntime();
      if (!runtime.running) {
        console.log('🛑 Bot stopped, cancelling activity action');
        return;
      }

      // ✅ NEW: Use local FSM (chooseNextState) instead of server
      const action = await this.chooseNextState();

      // Execute DOM action
      await this.executeDOMAction(action);

      // Update position after successful execution
      await this.updatePositionAfterSuccess(action.action);

      // Update counters
      await this.updateCountersForAction(action.action);

    } catch (error) {
      await this.log.error('NEXT_ACTION_FAIL', error.message, { module: 'ACTIVITY' });
    }
  }

  /**
   * Execute DOM action (only execution, no logic)
   */
  async executeDOMAction(action) {
    const [tab] = await chrome.tabs.query({ url: THREADS_URL_PATTERNS });

    if (!tab) {
      return;
    }

    // ✅ CRITICAL FIX: Activate Threads tab if not active (match old_local_files behavior)
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await this.log.info('TAB_ACTIVATED', 'Activated Threads tab for Activity session', { module: 'ACTIVITY' });
    }

    // CRITICAL: Check if content script is ready (PING)
    let contentReady = false;
    let pingAttempts = 0;
    const maxPingAttempts = 5;

    while (!contentReady && pingAttempts < maxPingAttempts) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PING' }, { frameId: 0 });
        contentReady = true;
      } catch (e) {
        pingAttempts++;
        if (pingAttempts < maxPingAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          // Last resort: try to reconnect
          await this.log.warn('CONTENT_PING_TIMEOUT', 'Content script not responding, attempting reconnection', { module: 'ACTIVITY' });
          const contentManager = new ContentScriptManager(this.log);
          await contentManager.reconnectContentScript(tab.id);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    try {
      switch (action.action) {
        case ACTION_TYPE.SCROLL_TIMELINE:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'SCROLL_TIMELINE'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.OPEN_TWEET:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'OPEN_TWEET'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.LIKE_TWEET:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'LIKE_TWEET',
            payload: action.payload
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.LIKE_COMMENT:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'LIKE_COMMENT'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.OPEN_PROFILE:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'OPEN_PROFILE',
            payload: action.payload
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.OPEN_NOTIFICATIONS:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'OPEN_NOTIFICATIONS'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.REFRESH_TIMELINE:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'REFRESH_TIMELINE'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.BACK_TO_TIMELINE:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'BACK_TO_TIMELINE'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.CONTINUE_READING_COMMENTS:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'CONTINUE_READING_COMMENTS'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.SCROLL_PROFILE:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'SCROLL_PROFILE'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.SCROLL_NOTIFICATIONS:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'SCROLL_NOTIFICATIONS'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.SCROLL_COMMENTS:
          await chrome.tabs.sendMessage(tab.id, {
            type: 'EXECUTE_ACTION',
            actionType: 'SCROLL_COMMENTS'
          }, { frameId: 0 });
          break;

        case ACTION_TYPE.DWELL:
          // Dwell is a local wait (no DOM action needed)
          await new Promise(resolve => setTimeout(resolve, action.duration));
          break;

        case ACTION_TYPE.IDLE:
          // Idle is a local wait (no DOM action needed)
          await new Promise(resolve => setTimeout(resolve, action.duration));
          break;

        case 'END_SESSION':
          this.sessionInProgress = false;
          await this.log.info('SESSION_ENDED', 'Activity session ended', { module: 'ACTIVITY' });
          break;

        default:
          console.warn(`Unknown action type: ${action.action}`);
      }
    } catch (error) {
      await this.log.error('DOM_ACTION_FAIL', error.message, { module: 'ACTIVITY' });
    }
  }

  /**
   * Update counters after action
   */
  async updateCountersForAction(actionType) {
    await this.storage.mutateRuntime((runtime) => {
      if (!runtime.counters) runtime.counters = {};

      switch (actionType) {
        case ACTION_TYPE.LIKE_TWEET:
          runtime.counters.likesToday = (runtime.counters.likesToday || 0) + 1;
          break;
        case ACTION_TYPE.LIKE_COMMENT:
          runtime.counters.commentLikesToday = (runtime.counters.commentLikesToday || 0) + 1;
          break;
        case ACTION_TYPE.OPEN_PROFILE:
          runtime.counters.profilesVisitedToday = (runtime.counters.profilesVisitedToday || 0) + 1;
          break;
        case ACTION_TYPE.OPEN_NOTIFICATIONS:
          runtime.counters.notificationChecksToday = (runtime.counters.notificationChecksToday || 0) + 1;
          break;
        case ACTION_TYPE.OPEN_TWEET:
          runtime.counters.tweetsOpenedToday = (runtime.counters.tweetsOpenedToday || 0) + 1;
          break;
        case ACTION_TYPE.SCROLL_TIMELINE:
        case ACTION_TYPE.SCROLL_COMMENTS:
        case ACTION_TYPE.CONTINUE_READING_COMMENTS:
          runtime.counters.scrollsToday = (runtime.counters.scrollsToday || 0) + 1;
          break;
        case ACTION_TYPE.REFRESH_TIMELINE:
          runtime.counters.refreshesToday = (runtime.counters.refreshesToday || 0) + 1;
          break;
      }
      return runtime;
    });

    // Broadcast to update UI
    if (this.app && this.app.broadcastStatusUpdate) {
      await this.app.broadcastStatusUpdate();
    }
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutoPostExecutor, ActivityExecutor };
}
