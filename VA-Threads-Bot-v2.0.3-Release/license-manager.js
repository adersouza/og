/**
 * License Manager - CLIENT VERSION
 * Simplified version for client extension
 * All verification is done server-side via Firebase Functions
 */

class LicenseManager {
  constructor(storage) {
    this.storage = storage;
    this.sessionToken = null;
    this.tokenExpiresAt = null;
    this.licenseData = null;
    this.deviceFingerprint = null;
    // ✅ Lock flags to prevent multiple simultaneous operations
    this.isRenewing = false;
    this.isActivating = false;
  }

  /**
   * Generate device fingerprint
   * Simplified version - uses install ID only
   */
  async generateDeviceFingerprint() {
    if (this.deviceFingerprint) {
      return this.deviceFingerprint;
    }

    // Get or create install ID
    const result = await chrome.storage.local.get('installId');
    let installId = result.installId;

    if (!installId) {
      // Generate new install ID
      installId = 'client-' + Date.now() + '-' + Math.random().toString(36).substring(2, 15);
      await chrome.storage.local.set({ installId });
    }

    // Simple fingerprint based on install ID
    const fingerprint = await this.hashString(installId);
    this.deviceFingerprint = fingerprint;
    return fingerprint;
  }

  /**
   * Hash a string using SHA-256
   */
  async hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Initialize license system
   * Called on extension startup
   */
  async initialize() {
    console.log('🔑 Initializing License Manager...');

    // Check if license exists in storage
    const settings = await this.storage.getSettings();

    if (!settings.licenseKey) {
      console.log('🔑 No license key found - activation required');
      return { needsActivation: true };
    }

    // Try to load existing session token
    const result = await chrome.storage.local.get(['sessionToken', 'tokenExpiresAt', 'licenseData']);
    if (result.sessionToken && result.tokenExpiresAt) {
      this.sessionToken = result.sessionToken;
      this.tokenExpiresAt = result.tokenExpiresAt;
      this.licenseData = result.licenseData;

      // Check if token is still valid
      if (this.tokenExpiresAt > Date.now()) {
        console.log('🔑 Session token loaded from storage');
        return { needsActivation: false, licenseData: this.licenseData };
      }
    }

    // No valid token - need to activate
    console.log('🔑 No valid session token - activation required');
    return { needsActivation: true };
  }

  /**
   * Activate license with server
   * @param {boolean} autoRetry - If true, retry infinitely (for auto-reactivation). If false, limited retries (for manual activation)
   */
  async activateLicense(licenseKey, email, autoRetry = false) {
    console.log('🔑 Activating license...');

    // ✅ Set lock flag
    this.isActivating = true;

    try {
      // ✅ Generate device fingerprint before activation
      const deviceFingerprint = await this.generateDeviceFingerprint();
      console.log('🔑 Device fingerprint:', deviceFingerprint.substring(0, 16) + '...');

      // ✅ Auto-reactivation (expired token) uses infinite retry to handle Firebase deploys
      // Manual activation uses limited retry for fast user feedback
      const response = await fetchWithRetry(API.ACTIVATE_LICENSE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: licenseKey,
          email: email,
          deviceFingerprint: deviceFingerprint,  // ✅ CRITICAL: Send device fingerprint
          extensionVersion: chrome.runtime.getManifest().version
        })
      }, autoRetry); // ✅ Infinite retry only for auto-reactivation

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.error?.message || 'Activation failed');
        error.status = response.status;
        // ✅ Mark 401/403 as license errors so bot stops instead of retrying
        error.isLicenseError = (response.status === 401 || response.status === 403 || errorData.error?.code === 'unauthenticated');
        throw error;
      }

      const data = await response.json();

      // ✅ ATOMIC UPDATE: Save to storage FIRST, then update in-memory
      const newLicenseData = {
        plan: data.result.plan,
        limits: data.result.limits
      };

      // Save to storage first (atomic operation)
      await chrome.storage.local.set({
        sessionToken: data.result.sessionToken,
        tokenExpiresAt: data.result.expiresAt,
        licenseData: newLicenseData
      });

      await chrome.storage.sync.set({
        licenseKey: licenseKey,
        licenseEmail: email,
        licenseUsername: data.result.username,
        licensePlan: data.result.plan,
        licenseExpires: data.result.licenseExpiresAt
      });

      // Only update in-memory AFTER storage is confirmed saved
      this.licenseData = newLicenseData;
      this.sessionToken = data.result.sessionToken;
      this.tokenExpiresAt = data.result.expiresAt;

      console.log('🔑 License activated successfully:', data.result.plan);
      console.log('🔑 Session token expires:', new Date(this.tokenExpiresAt).toLocaleString());

      return this.licenseData;
    } catch (error) {
      console.error('🔑 License activation failed:', error);
      throw error;
    } finally {
      // ✅ Always release lock
      this.isActivating = false;
    }
  }

  /**
   * Verify license with server (calls activation internally)
   */
  async verifyLicense(licenseKey) {
    console.log('🔑 Verifying license...');

    const settings = await this.storage.getSettings();
    const email = settings.licenseEmail || '';

    return await this.activateLicense(licenseKey, email);
  }

  /**
   * Get valid session token (renews if needed)
   * ✅ IMPROVED: Better error handling with isLicenseError flag
   */
  async getSessionToken() {
    // Check if token exists in memory
    if (!this.sessionToken || !this.tokenExpiresAt) {
      // Try to load from storage
      const result = await chrome.storage.local.get(['sessionToken', 'tokenExpiresAt']);
      if (result.sessionToken && result.tokenExpiresAt) {
        this.sessionToken = result.sessionToken;
        this.tokenExpiresAt = result.tokenExpiresAt;
      } else {
        // ✅ Storage empty - check if license key exists (distinguish storage error from no license)
        const settings = await this.storage.getSettings();
        if (settings.licenseKey) {
          // License key exists but token not in storage → probably storage error or first run
          // Try to reactivate instead of throwing license error
          console.log('🔑 Token not in storage but license key exists, attempting reactivation...');
          try {
            await this.activateLicense(settings.licenseKey, settings.licenseEmail || '', true);
            return this.sessionToken;
          } catch (activationError) {
            // If reactivation fails, it's a real license error
            throw activationError;
          }
        } else {
          // No license key at all - real license error
          const error = new Error('No license key available. Please activate license.');
          error.isLicenseError = true;
          throw error;
        }
      }
    }

    // Check if token needs renewal (expires in less than 15 minutes)
    const timeUntilExpiry = this.tokenExpiresAt - Date.now();

    // If token already expired (bot was stopped > 1 hour), need reactivation
    if (timeUntilExpiry < 0) {
      // ✅ Check if activation already in progress
      if (this.isActivating) {
        console.log('🔑 License activation already in progress, waiting...');
        // Wait for activation to complete (max 120s with infinite retry)
        for (let i = 0; i < 120; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!this.isActivating) {
            console.log('🔑 License activation completed, using new token');
            break;
          }
        }
        return this.sessionToken;
      }

      console.log('🔑 Session token expired (bot was stopped too long), reactivating...');
      const settings = await this.storage.getSettings();
      if (!settings.licenseKey) {
        const error = new Error('No license key available. Please activate license.');
        error.isLicenseError = true; // ✅ Mark as license error to stop bot
        throw error;
      }
      // ✅ Use autoRetry=true for automatic reactivation (handles Firebase deploys)
      await this.activateLicense(settings.licenseKey, settings.licenseEmail || '', true);
      return this.sessionToken;
    }

    // Token still valid but expires soon (< 15min) - renew it
    if (timeUntilExpiry < 15 * 60 * 1000) {
      // ✅ Check if renewal already in progress (prevents multiple simultaneous renewals)
      if (this.isRenewing) {
        console.log('🔑 Token renewal already in progress, waiting...');
        // Wait for renewal to complete (max 60s)
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!this.isRenewing) {
            console.log('🔑 Token renewal completed, using new token');
            break;
          }
        }
        return this.sessionToken;
      }

      console.log('🔑 Session token expiring in less than 15min, renewing...');
      await this.renewSessionToken();
    }

    return this.sessionToken;
  }

  /**
   * Renew session token
   * ✅ Uses fetchWithRetry with infinite retry for network errors
   */
  async renewSessionToken() {
    // ✅ Set lock flag
    this.isRenewing = true;

    try {
      // ✅ Use fetchWithRetry with infinite retry (2s, 5s, 10s, then 10s forever)
      // This handles Firebase deploys (30-60s) and network instability
      const response = await fetchWithRetry(API.RENEW_SESSION, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': this.sessionToken
        }
      }, true); // true = infinite retry

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error?.message || response.statusText || `HTTP ${response.status}`;
        const error = new Error(`Session renewal failed: ${errorMsg}`);
        error.status = response.status;
        error.isLicenseError = (response.status === 401 || errorData.error?.code === 'unauthenticated');
        console.error('🔑 Renewal failed - Status:', response.status, 'Data:', errorData);
        throw error;
      }

      const data = await response.json();

      if (data.result.renewed) {
        // ✅ ATOMIC UPDATE: Save to storage FIRST, then update in-memory
        // This prevents token loss if extension crashes/reloads between updates
        const newLicenseData = {
          plan: data.result.plan,
          limits: data.result.limits
        };

        // Save to storage first (atomic operation)
        await chrome.storage.local.set({
          sessionToken: data.result.sessionToken,
          tokenExpiresAt: data.result.expiresAt,
          licenseData: newLicenseData
        });

        // Update stored license info for UI display
        await chrome.storage.sync.set({
          licenseUsername: data.result.username,
          licensePlan: data.result.plan,
          licenseExpires: data.result.expiresAt
        });

        // Only update in-memory AFTER storage is confirmed saved
        this.sessionToken = data.result.sessionToken;
        this.tokenExpiresAt = data.result.expiresAt;
        this.licenseData = newLicenseData;

        console.log('🔑 Token renewed successfully, expires:', new Date(this.tokenExpiresAt).toLocaleString());
      }
    } catch (error) {
      console.error('🔑 Token renewal failed:', error);

      // If license error (401), clear session and require reactivation
      if (error.isLicenseError) {
        await chrome.storage.local.remove(['sessionToken', 'tokenExpiresAt']);
        this.sessionToken = null;
        this.tokenExpiresAt = null;
      }

      throw error;
    } finally {
      // ✅ Always release lock
      this.isRenewing = false;
    }
  }

  // ✅ REMOVED: startPeriodicVerification() - Dead code, never called
  // Token renewal is now handled by getSessionToken() before each API call
  // and by heartbeat in background.js
}

// ✅ fetchWithRetry is imported from firebase-config.js
// No need to redefine it here - uses the version with infinite retry support
