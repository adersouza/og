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
   */
  async activateLicense(licenseKey, email) {
    console.log('🔑 Activating license...');

    try {
      // ✅ Generate device fingerprint before activation
      const deviceFingerprint = await this.generateDeviceFingerprint();
      console.log('🔑 Device fingerprint:', deviceFingerprint.substring(0, 16) + '...');

      const response = await fetchWithRetry(API.ACTIVATE_LICENSE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: licenseKey,
          email: email,
          deviceFingerprint: deviceFingerprint,  // ✅ CRITICAL: Send device fingerprint
          extensionVersion: chrome.runtime.getManifest().version
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || 'Activation failed');
      }

      const data = await response.json();

      this.licenseData = {
        plan: data.result.plan,
        limits: data.result.limits
      };
      this.sessionToken = data.result.sessionToken;
      this.tokenExpiresAt = data.result.expiresAt;

      // Save to storage
      await chrome.storage.local.set({
        sessionToken: this.sessionToken,
        tokenExpiresAt: this.tokenExpiresAt,
        licenseData: this.licenseData
      });

      await chrome.storage.sync.set({
        licenseKey: licenseKey,
        licenseEmail: email,
        licenseUsername: data.result.username,
        licensePlan: data.result.plan,
        licenseExpires: data.result.licenseExpiresAt
      });

      console.log('🔑 License activated successfully:', data.result.plan);
      console.log('🔑 Session token expires:', new Date(this.tokenExpiresAt).toLocaleString());

      return this.licenseData;
    } catch (error) {
      console.error('🔑 License activation failed:', error);
      throw error;
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
   */
  async getSessionToken() {
    // Check if token exists
    if (!this.sessionToken || !this.tokenExpiresAt) {
      // Try to load from storage
      const result = await chrome.storage.local.get(['sessionToken', 'tokenExpiresAt']);
      if (result.sessionToken && result.tokenExpiresAt) {
        this.sessionToken = result.sessionToken;
        this.tokenExpiresAt = result.tokenExpiresAt;
      } else {
        throw new Error('No session token available. Please activate license.');
      }
    }

    // Check if token needs renewal (expires in less than 15 minutes)
    const timeUntilExpiry = this.tokenExpiresAt - Date.now();

    // If token already expired (bot was stopped > 1 hour), need reactivation
    if (timeUntilExpiry < 0) {
      console.log('🔑 Session token expired (bot was stopped too long), reactivating...');
      const settings = await this.storage.getSettings();
      if (!settings.licenseKey) {
        throw new Error('No license key available. Please activate license.');
      }
      await this.activateLicense(settings.licenseKey, settings.licenseEmail || '');
      return this.sessionToken;
    }

    // Token still valid but expires soon (< 15min) - renew it
    if (timeUntilExpiry < 15 * 60 * 1000) {
      console.log('🔑 Session token expiring in less than 15min, renewing...');
      await this.renewSessionToken();
    }

    return this.sessionToken;
  }

  /**
   * Renew session token
   */
  async renewSessionToken() {
    try {
      // Retry logic for network instability
      let response;
      const maxRetries = 3;
      const retryDelays = [2000, 5000, 10000]; // 2s, 5s, 10s

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          response = await fetch(API.RENEW_SESSION, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-Token': this.sessionToken
            }
          });
          break; // Success - exit retry loop
        } catch (fetchError) {
          const isLastAttempt = (attempt === maxRetries);
          const isNetworkError = (fetchError.message.includes('fetch') ||
                                  fetchError.message.includes('Failed to fetch') ||
                                  fetchError.name === 'TypeError');

          if (isNetworkError && !isLastAttempt) {
            const delay = retryDelays[attempt];
            console.warn(`🔄 Token renewal retry ${attempt + 1}/${maxRetries} in ${delay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue; // Retry
          }

          // Last attempt failed - notify user
          if (isNetworkError && isLastAttempt) {
            console.error('❌ Token renewal failed after all retries - Network issue');
            chrome.runtime.sendMessage({
              type: 'NETWORK_ERROR',
              message: 'Network connection issue'
            }).catch(() => {
              // Ignore if no popup is open
            });
          }

          // Last attempt or non-network error
          throw fetchError;
        }
      }

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
        // Update with new token
        this.sessionToken = data.result.sessionToken;
        this.tokenExpiresAt = data.result.expiresAt;
        this.licenseData = {
          plan: data.result.plan,
          limits: data.result.limits
        };

        // Save to storage
        await chrome.storage.local.set({
          sessionToken: this.sessionToken,
          tokenExpiresAt: this.tokenExpiresAt,
          licenseData: this.licenseData
        });

        // Update stored license info for UI display
        await chrome.storage.sync.set({
          licenseUsername: data.result.username,
          licensePlan: data.result.plan,
          licenseExpires: data.result.expiresAt
        });

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
    }
  }

  // ✅ REMOVED: startPeriodicVerification() - Dead code, never called
  // Token renewal is now handled by getSessionToken() before each API call
  // and by heartbeat in background.js
}

/**
 * Fetch with retry logic (for API calls)
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  const retryDelays = [2000, 5000, 10000]; // 2s, 5s, 10s

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      const isLastAttempt = (attempt === maxRetries);
      const isNetworkError = (error.message.includes('fetch') ||
                              error.message.includes('Failed to fetch') ||
                              error.name === 'TypeError');

      if (isNetworkError && !isLastAttempt) {
        const delay = retryDelays[attempt];
        console.warn(`🔄 API retry ${attempt + 1}/${maxRetries} in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Retry
      }

      // Last attempt or non-network error
      throw error;
    }
  }
}
