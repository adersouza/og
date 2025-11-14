/**
 * Firebase Configuration
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to Firebase Console (https://console.firebase.google.com)
 * 2. Select your project
 * 3. Go to Project Settings > General
 * 4. Scroll to "Your apps" and click "Web" (</>) icon
 * 5. Copy the firebaseConfig object and replace FIREBASE_CONFIG below
 * 6. Go to Project Settings > Service Accounts
 * 7. Copy the "Project ID" and replace FIREBASE_PROJECT_ID below
 * 8. The Cloud Functions URL will be: https://YOUR_REGION-YOUR_PROJECT_ID.cloudfunctions.net
 *    (e.g., https://us-central1-va-threads-bot.cloudfunctions.net)
 */

// Firebase project ID (configured automatically)
const FIREBASE_PROJECT_ID = 'va-threads-bot';

// Firebase region (Cloud Functions deployed in us-central1)
const FIREBASE_REGION = 'us-central1';

// Cloud Functions base URL
const CLOUD_FUNCTIONS_URL = `https://${FIREBASE_REGION}-${FIREBASE_PROJECT_ID}.cloudfunctions.net`;

// API endpoints - Complete server-side logic
const API = {
  // License Management
  VERIFY_LICENSE: `${CLOUD_FUNCTIONS_URL}/verifyLicense`,
  ACTIVATE_LICENSE: `${CLOUD_FUNCTIONS_URL}/activateLicense`,
  RENEW_SESSION: `${CLOUD_FUNCTIONS_URL}/renewSession`, // ✨ NEW

  // AutoPost (Server-controlled)
  GET_NEXT_AUTOPOST_ACTION: `${CLOUD_FUNCTIONS_URL}/getNextAutoPostAction`,

  // Activity (Hybrid: server profile + client FSM)
  CREATE_DAILY_ACTIVITY_PLAN: `${CLOUD_FUNCTIONS_URL}/createDailyActivityPlan`,
  GET_BEHAVIOR_PROFILE: `${CLOUD_FUNCTIONS_URL}/getBehaviorProfile`,
  GET_NEXT_ACTIVITY_ACTION: `${CLOUD_FUNCTIONS_URL}/getNextActivityAction`,
  GET_ACTIVITY_SESSION_STATUS: `${CLOUD_FUNCTIONS_URL}/getActivitySessionStatus`,

  // Settings & Validation
  VALIDATE_SETTINGS: `${CLOUD_FUNCTIONS_URL}/validateSettings`,

  // Configuration (Auto-update without extension reload)
  GET_SELECTORS: `${CLOUD_FUNCTIONS_URL}/getSelectors`,
  CHECK_VERSION: `${CLOUD_FUNCTIONS_URL}/checkVersion`
};

/**
 * ✨ Fetch with Retry - Handles network instability (proxies, micro-cuts)
 * Retries 3 times with exponential backoff: 2s, 5s, 10s
 */
async function fetchWithRetry(url, options, infiniteRetry = false) {
  const initialRetryDelays = [2000, 5000, 10000]; // 2s, 5s, 10s
  const continuousRetryDelay = 10000; // Then 10s infinitely

  let attempt = 0;

  while (true) {
    try {
      const response = await fetch(url, options);

      // ✅ Log recovery if this was after retries
      if (attempt > 0) {
        console.log(`✅ API recovered after ${attempt} retries`);
      }

      return response; // Success
    } catch (error) {
      const isNetworkError = (error.message.includes('fetch') ||
                              error.message.includes('Failed to fetch') ||
                              error.message.includes('NetworkError') ||
                              error.name === 'TypeError');

      // If network error with infinite retry enabled - retry forever
      if (isNetworkError && infiniteRetry) {
        const delay = attempt < initialRetryDelays.length
          ? initialRetryDelays[attempt]
          : continuousRetryDelay;

        console.warn(`🔄 Network error, retry ${attempt + 1} in ${delay/1000}s...`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
        continue; // Retry forever
      }

      // Finite retry mode (backward compatible) - max 3 attempts
      if (isNetworkError && !infiniteRetry && attempt < 3) {
        const delay = initialRetryDelays[attempt] || 10000;
        console.warn(`🔄 Network error, retry ${attempt + 1}/3 in ${delay/1000}s...`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
        continue;
      }

      // Non-network error OR max retries reached - throw
      console.error('❌ API error:', error.message);
      throw error;
    }
  }
}

// ✅ REMOVED: secureApiCall - No longer using HMAC
// All API calls now use secureTokenCall with session tokens

/**
 * ✨ NEW: Secure API Call with Session Token
 * Uses session token instead of HMAC signature
 * Much simpler and more secure
 */
async function secureTokenCall(endpoint, body, licenseManager) {
  // Get valid session token (auto-renews if needed)
  const sessionToken = await licenseManager.getSessionToken();

  // Make request with session token header + RETRY on network errors
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': sessionToken
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error?.message || 'API call failed';

    // ✅ ONLY notify if it's a license error (401), NOT network errors
    if (response.status === 401 || errorData.error?.code === 'unauthenticated') {
      // Notify background to clear license and redirect popup
      chrome.runtime.sendMessage({
        type: 'LICENSE_EXPIRED',
        message: 'Your license has expired or is invalid. Please reactivate.'
      }).catch(() => {
        // Ignore if background doesn't respond
      });

      // ✅ Mark error so client can detect license vs network errors
      const error = new Error(errorMessage);
      error.isLicenseError = true;
      throw error;
    }

    throw new Error(errorMessage);
  }

  const data = await response.json();
  return data;
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FIREBASE_PROJECT_ID, FIREBASE_REGION, CLOUD_FUNCTIONS_URL, API, secureTokenCall, fetchWithRetry };
}
