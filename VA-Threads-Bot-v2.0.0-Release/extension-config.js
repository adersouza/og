/**
 * Extension Configuration
 * Manages extension ID for CORS validation
 */

const EXTENSION_CONFIG = {
  // Extension ID (set after first installation)
  extensionId: null,

  /**
   * Get current extension ID
   * Saved to storage for consistency
   */
  async getExtensionId() {
    if (this.extensionId) {
      return this.extensionId;
    }

    // Try to get from storage
    const result = await chrome.storage.local.get('extensionId');
    if (result.extensionId) {
      this.extensionId = result.extensionId;
      return this.extensionId;
    }

    // Save current extension ID
    this.extensionId = chrome.runtime.id;
    await chrome.storage.local.set({ extensionId: this.extensionId });

    return this.extensionId;
  },

  /**
   * Get device fingerprint
   * Delegates to LicenseManager if available
   */
  async getDeviceFingerprint() {
    // This will be used by API calls
    if (typeof licenseManager !== 'undefined' && licenseManager.deviceFingerprint) {
      return licenseManager.deviceFingerprint;
    }

    // Fallback: generate basic fingerprint
    const result = await chrome.storage.local.get('installId');
    return result.installId || 'unknown';
  }
};

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EXTENSION_CONFIG;
}
