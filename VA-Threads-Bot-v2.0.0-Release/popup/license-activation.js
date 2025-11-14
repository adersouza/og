/**
 * License Activation Screen
 * Handles license key activation for first-time users
 */

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('license-form');
  const licenseKeyInput = document.getElementById('license-key');
  const activateBtn = document.getElementById('activate-btn');
  const messageDiv = document.getElementById('license-message');

  // Simple uppercase conversion only - no auto-formatting
  licenseKeyInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // Handle form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const licenseKey = licenseKeyInput.value.trim();

    if (!licenseKey) {
      showMessage('Please enter a valid license key', 'error');
      return;
    }

    // Remove any previous error states
    licenseKeyInput.classList.remove('error', 'success');

    // Disable button during activation with spinner
    activateBtn.disabled = true;
    activateBtn.innerHTML = '<div class="spinner"></div><span>Activating...</span>';

    try {
      // Send activation request to background script with explicit Promise handling
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'ACTIVATE_LICENSE',
            licenseKey: licenseKey
            
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          }
        );
      });

      if (response && response.success) {
        licenseKeyInput.classList.add('success');
        showMessage('License activated successfully! Redirecting...', 'success');

        // Wait 1 second then close and open main popup
        setTimeout(() => {
          window.close();
        }, 1000);
      } else {
        throw new Error(response?.error || 'Activation failed');
      }
    } catch (error) {
      console.error('License activation error:', error);
      licenseKeyInput.classList.add('error');
      showMessage(error.message || 'Activation failed. Please check your license key.', 'error');
      activateBtn.disabled = false;
      activateBtn.innerHTML = 'Activate License';
    }
  });

  function showMessage(text, type) {
    const icon = type === 'error'
      ? '<svg class="icon-error" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
      : '<svg class="icon-checkmark" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';

    messageDiv.innerHTML = icon + '<span>' + text + '</span>';
    messageDiv.className = type === 'error' ? 'license-error' : 'license-success';
  }
});
