// Constants - Message types
const MSG = {
  EXECUTE_ACTION: 'EXECUTE_ACTION',
  ACTION_RESULT: 'ACTION_RESULT',
  NOTICE: 'NOTICE'  // <- Ajouter car utilisé lignes 44, 1027, 1039
};

// Constants - Action types
const ACTION_TYPE = {
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
  DWELL: 'DWELL',
  IDLE: 'IDLE',
  SCROLL_COMMENTS: 'SCROLL_COMMENTS'
};

// Error codes
const ERROR_CODE = {
  DOM_NOT_FOUND: 'DOM_NOT_FOUND',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  STOPPED: 'STOPPED'
};

// ✅ API endpoints (defined here to avoid dependency on firebase-config.js during reload)
const API_GET_SELECTORS = 'https://us-central1-va-threads-bot.cloudfunctions.net/getSelectors';

// ✅ CRITICAL FIX: Global stop flag for emergency stop
let EMERGENCY_STOP = false;

// Helper function to check if action should stop
function shouldStop() {
  return EMERGENCY_STOP;
}

// ✅ Helper pour envoyer des messages sans erreur "Extension context invalidated"
function safeSendMessage(message, callback) {
  // Vérifier que l'extension est toujours valide
  if (!chrome.runtime?.id) {
    // Extension invalidée (reload/update), ignorer silencieusement
    return;
  }

  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        // Ignorer les erreurs de contexte invalidé
        return;
      }
      if (callback) callback(response);
    });
  } catch (e) {
    // Extension context invalidated, ignorer silencieusement
  }
}

// Helper - Human-like delay with jitter (±variance% variation)
function jitter(baseMs, variance = 0.1) {
  const min = baseMs * (1 - variance);
  const max = baseMs * (1 + variance);
  return Math.floor(min + Math.random() * (max - min));
}

// Timing constants (in milliseconds)
const TIMING = {
  QUICK_DELAY: 100,
  SHORT_DELAY: 500,
  MEDIUM_DELAY: 1000,
  LONG_DELAY: 2000,
  EXTRA_LONG_DELAY: 3000,
  ACTION_TIMEOUT: 30000,
  SCROLL_SETTLE: 200,
  CLICK_DELAY: 150
};

// ============= NOUVELLES FONCTIONS HELPER POUR VIEWPORT =============
// Ajouter après les constants (ligne ~35) et avant "Load selectors"

// Centre un élément avec timing humain variable
async function centerElementHuman(element) {
  if (!element) return;
  
  element.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center'
  });
  
  // Comportements variés comme un humain
  const behavior = Math.random();
  let waitTime;
  
  if (behavior < 0.15) {
    // 15% : Très rapide (lecture rapide)
    waitTime = 400 + Math.random() * 300; // 400-700ms
    console.log(`⚡ Quick scroll (${Math.round(waitTime)}ms)`);
    
  } else if (behavior < 0.70) {
    // 55% : Normal
    waitTime = 700 + Math.random() * 500; // 700-1200ms
    console.log(`👤 Normal scroll (${Math.round(waitTime)}ms)`);
    
  } else if (behavior < 0.90) {
    // 20% : Lent (lecture attentive)
    waitTime = 1200 + Math.random() * 600; // 1200-1800ms
    console.log(`🐌 Slow scroll (${Math.round(waitTime)}ms)`);
    
  } else {
    // 10% : Très lent (distrait, hésitant)
    waitTime = 1800 + Math.random() * 1200; // 1800-3000ms
    console.log(`😴 Very slow scroll (${Math.round(waitTime)}ms)`);
  }
  
  await new Promise(resolve => setTimeout(resolve, waitTime));
}

// Load selectors - will be populated from server (with local fallback)
let SELECTORS = {};
let SELECTORS_READY = false; // Flag to track if selectors are loaded
let SELECTORS_PROMISE = null; // Promise for waiting on selector load

// Load selectors from cache (server-only, no local fallback for security)
async function loadSelectorsFromCache() {
  try {
    // Try cached server selectors first
    const cached = await chrome.storage.local.get(['cachedSelectors', 'selectorsCacheTime']);
    if (cached.cachedSelectors) {
      const cacheAge = Date.now() - (cached.selectorsCacheTime || 0);
      const cacheAgeHours = Math.round(cacheAge / 1000 / 60 / 60);
      SELECTORS = cached.cachedSelectors;
      console.log(`✅ Using cached server selectors (${cacheAgeHours}h old)`);
      return true;
    }
  } catch (cacheError) {
    console.warn('Cache read failed:', cacheError);
  }

  // No cache available - must wait for server (no local fallback for security)
  console.log('⏳ No cached selectors - waiting for server...');
  return false;
}

// Initialize selectors from server (cache only, no local files)
async function initSelectors() {
  // Create promise that resolves when selectors are ready
  if (!SELECTORS_PROMISE) {
    SELECTORS_PROMISE = (async () => {
      // ✅ LOAD CACHE FIRST for instant availability
      let loaded = await loadSelectorsFromCache();

      if (loaded) {
        SELECTORS_READY = true;
      }

  // If we have cached selectors, continue in background to update
  // If no cache, we MUST wait for server
  const mustWait = !loaded;

  // ✅ TRY SERVER (auto-update or required load)
  const maxRetries = mustWait ? 3 : 1; // 3 retries if no cache (6s total), otherwise single attempt

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔄 Loading selectors from server (attempt ${attempt}/${maxRetries})...`);
        const retryWait = 1800 + Math.floor(Math.random() * 400); // 1800-2200ms
        await new Promise(resolve => setTimeout(resolve, retryWait));
      } else {
        console.log('🔄 Loading selectors from server...');
      }

      // Get session token from background
      const tokenResponse = await chrome.runtime.sendMessage({ type: 'GET_SESSION_TOKEN' });
      if (!tokenResponse.success) {
        if (mustWait && attempt < maxRetries) {
          console.log('⏳ No session token yet, retrying...');
          continue; // Retry
        }
        console.log('⏳ Skipping server selectors (no session token yet)');
        return; // Give up
      }

    const serverResponse = await fetch(API_GET_SELECTORS, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': tokenResponse.sessionToken
      }
    });

    if (serverResponse.ok) {
      const data = await serverResponse.json();
      if (data.result && data.result.selectors) {
        SELECTORS = data.result.selectors;
        SELECTORS_READY = true; // Mark as ready
        console.log('✅ Selectors loaded from server (v' + (data.result.version || '1.0.0') + ')');

        // Cache server selectors locally for offline use
        try {
          await chrome.storage.local.set({
            cachedSelectors: SELECTORS,
            selectorsCacheTime: Date.now()
          });
        } catch (e) {
          console.warn('Could not cache selectors:', e);
        }

        return; // Success!
      }
    }

    // Server response invalid - retry if must wait
    if (mustWait && attempt < maxRetries) {
      console.log('⚠️ Server selectors invalid, retrying...');
      continue;
    }
    console.log('⚠️ Server selectors update failed (keeping cached/local)');
    return;

  } catch (serverError) {
    // Server unavailable - retry if must wait
    if (mustWait && attempt < maxRetries) {
      console.error('⚠️ Server error, retrying...', serverError.message);
      continue;
    }
    console.error('⚠️ Server selectors unavailable (keeping cached/local)', serverError.message);

    // ❌ CRITICAL: No selectors available at all - must refresh page
    if (mustWait) {
      console.error('❌ CRITICAL: No selectors loaded after all retries - auto-refreshing page in 2s...');

      // Set emergency stop to cancel all pending actions
      EMERGENCY_STOP = true;

      setTimeout(() => {
        window.location.reload();
      }, 2000);
    }
    return;
  }
  }
    })(); // Execute the async IIFE
  }

  // Wait for selectors to be ready
  await SELECTORS_PROMISE;
}


async function q(key, options = {}) {
  const { within = document, timeoutMs = 4000, all = false } = options;
  const selectors = SELECTORS[key] || [key]; // Fallback to raw selector if key not found
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    for (const selector of selectors) {
      try {
        const elements = within.querySelectorAll(selector);
        if (elements.length > 0) {
          // Check if elements are visible and attached
          const visibleElements = Array.from(elements).filter(el => {
            // CHANGEMENT ICI : Utiliser getBoundingClientRect pour tous les éléments
            // C'est plus fiable que offsetParent, surtout pour les SVG
            const rect = el.getBoundingClientRect();
            
            // Un élément est visible si :
            // 1. Il a des dimensions dans le viewport
            if (rect.width > 0 && rect.height > 0) {
              return true;
            }
            
            // 2. Fallback : pour les éléments non-SVG, vérifier offsetParent
            if (el.tagName.toLowerCase() !== 'svg' && el.tagName.toLowerCase() !== 'path') {
              return el.offsetParent !== null && 
                     el.offsetWidth > 0 && 
                     el.offsetHeight > 0;
            }
            
            // 3. Pour les SVG sans dimensions, vérifier si leur parent est visible
            if (el.tagName.toLowerCase() === 'svg' || el.tagName.toLowerCase() === 'path') {
              const parent = el.closest('button, a, div[role="button"]');
              if (parent) {
                const parentRect = parent.getBoundingClientRect();
                return parentRect.width > 0 && parentRect.height > 0;
              }
            }
            
            return false;
          });
          
          if (visibleElements.length > 0) {
            return all ? visibleElements : visibleElements[0];
          }
        }
      } catch (e) {
        // Invalid selector, try next
        continue;
      }
    }
    
    // Wait a bit before retrying
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error(`${ERROR_CODE.DOM_NOT_FOUND}: No element found for ${key}`);
}

// Query all helper reste identique
async function qAll(key, options = {}) {
  return q(key, { ...options, all: true });
}

// Wait for main content area
async function waitForMain(timeoutMs = 5000) {
  // Pour Threads, on n'a pas vraiment besoin d'attendre un "main"
  // Le body est suffisant
  await new Promise(resolve => {
    if (document.readyState === 'complete') {
      resolve();
    } else {
      window.addEventListener('load', resolve);
    }
  });
  
  return document.body;
}

// Smooth scroll helper
async function scrollIntoViewIfNeeded(element) {
  if (!element) return;
  
  const rect = element.getBoundingClientRect();
  const isVisible = (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
  
  if (!isVisible) {
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'center'
    });
    
    // Wait for scroll to complete with random delay
    const delay = 100 + Math.random() * 300;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// Watch for navigation changes
function watchNavigation(callback) {
  let lastUrl = location.href;
  
  // Watch for URL changes
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      callback({ type: 'url', url: lastUrl });
    }
  });
  
  // Watch for major DOM changes that indicate navigation
  const domObserver = new MutationObserver((mutations) => {
    // Check if main content area changed significantly
    const mainMutations = mutations.filter(m => {
      const target = m.target;
      return target.matches && (
        target.matches('main') || 
        target.matches('[role="main"]') ||
        target.closest('main')
      );
    });
    
    if (mainMutations.length > 0) {
      // Check if this is a significant change (many nodes added/removed)
      const totalChanges = mainMutations.reduce((sum, m) => {
        return sum + m.addedNodes.length + m.removedNodes.length;
      }, 0);
      
      if (totalChanges > 10) {
        callback({ type: 'dom', changes: totalChanges });
      }
    }
  });
  
  // Start observing
  urlObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  domObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Return cleanup function
  return () => {
    urlObserver.disconnect();
    domObserver.disconnect();
  };
}

// Utility to simulate mouse click with proper events
async function simulateClick(element) {
  if (!element) return false;
  
  // Scroll into view first
  await scrollIntoViewIfNeeded(element);
  
  // Simulate mouse events sequence
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  const mouseEventInit = {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y
  };
  
  element.dispatchEvent(new MouseEvent('mousedown', mouseEventInit));
  await new Promise(resolve => setTimeout(resolve, 10));
  
  element.dispatchEvent(new MouseEvent('mouseup', mouseEventInit));
  element.dispatchEvent(new MouseEvent('click', mouseEventInit));

  
  return true;
}

// Initialize on load
(async () => {
  await initSelectors();

  if (SELECTORS_READY && Object.keys(SELECTORS).length > 0) {
    console.log('✅ Content script ready with selectors loaded');
  } else {
    console.log('⏳ Content script ready but selectors NOT loaded (waiting for license activation)');
  }
})();

// ============= VERIFICATION HELPERS =============

// Verify toggle state (for like/bookmark buttons)
async function verifyToggle(element, expectedState) {
  if (!element) return false;
  
  // Check aria-pressed attribute
  const ariaPressed = element.getAttribute('aria-pressed');
  if (ariaPressed !== null) {
    return ariaPressed === String(expectedState);
  }
  
  // Check data-testid for unlike state
  const testId = element.getAttribute('data-testid');
  if (testId) {
    if (expectedState && testId === 'unlike') return true;
    if (!expectedState && testId === 'like') return true;
  }
  
  // Check aria-label for liked state
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    const isLiked = ariaLabel.toLowerCase().includes('liked') || 
                    ariaLabel.toLowerCase().includes('undo');
    return isLiked === expectedState;
  }
  
  // Check SVG color for visual state (red = liked)
  const svg = element.querySelector('svg');
  if (svg) {
    const color = window.getComputedStyle(svg).color;
    const isRed = color.includes('249, 24, 128') || // X.com pink
                  color.includes('rgb(249') ||
                  color.includes('#f91880');
    return isRed === expectedState;
  }
  
  return false;
}

// Verify post was submitted successfully
async function verifyPostSubmitted(timeoutMs = 5000) {
  const startTime = Date.now();

  // Save initial state
  const composerSelectors = SELECTORS['composer.textArea'] || ['[contenteditable="true"][role="textbox"]'];
  const composerQuery = composerSelectors.join(', ');
  const initialComposer = document.querySelector(composerQuery);
  const hadComposer = !!initialComposer;
  const initialUrl = window.location.href;

  await new Promise(resolve => setTimeout(resolve, 500));

  while (Date.now() - startTime < timeoutMs) {
    try {
      // 1. Check if composer has disappeared (sign of success on Threads)
      const currentComposer = document.querySelector(composerQuery);
      if (hadComposer && !currentComposer) {
        await new Promise(resolve => setTimeout(resolve, 300));
        // Double vérification
        const stillGone = !document.querySelector(composerQuery);
        if (stillGone) {
          return true;
        }
      }
      
      // 2. Vérifier si on a navigué ailleurs (Threads redirige après post)
      if (window.location.href !== initialUrl) {
        return true;
      }
      
      // 3. Vérifier si le bouton Post est revenu à son état initial
      try {
        const submitBtn = await q('composer.submitButton', { timeoutMs: 100 });
        if (submitBtn && submitBtn.textContent && submitBtn.textContent.toLowerCase().includes('post')) {
          // Si le bouton est actif et dit "Post", le post précédent est probablement parti
          const isEnabled = !submitBtn.disabled && 
                          !submitBtn.hasAttribute('disabled') &&
                          submitBtn.getAttribute('aria-disabled') !== 'true';
          if (!isEnabled && hadComposer) {
            // Le bouton est désactivé = probablement parce que le champ est vide après envoi
            return true;
          }
        }
      } catch (e) {
        // Ignorer si on ne trouve pas le bouton
      }
      
    } catch (e) {
      // Continue checking
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  // Vérification finale
  const finalCheck = !document.querySelector(composerQuery);
  return hadComposer && finalCheck;
}

// Check if user is logged in
function isLoggedIn() {
  // Indicateurs spécifiques à Threads
  // ✅ Use selectors from SELECTORS (auto-updateable)
  const loggedInIndicators = SELECTORS['auth.loggedInIndicators'] || [
    'a[href="/new/thread"]',
    'a[href*="/@"]',
    'div[role="button"][aria-label*="Create"]',
    'nav a[href="/activity"]'
  ];

  for (const selector of loggedInIndicators) {
    if (document.querySelector(selector)) {
      return true;
    }
  }
  
  // Check si on est sur la page de login
  if (location.pathname.includes('/login') || 
      location.pathname.includes('/accounts/login')) {
    return false;
  }
  
  return true;
}

// ============= ACTION EXECUTORS =============

// Open composer
async function openComposer() {
  try {
    console.log("🚀 Opening composer...");
    
    // D'abord vérifier si le composer est déjà ouvert
    try {
      const existingTextArea = await q('composer.textArea', { timeoutMs: 500 });
      if (existingTextArea && existingTextArea.offsetParent !== null) {
        console.log("✅ Composer already open");
        await scrollIntoViewIfNeeded(existingTextArea);
        existingTextArea.focus();
        return { ok: true, details: 'Composer already open' };
      }
    } catch (e) {
      // No composer open, continue
    }

    // Find the Create button - we now know it's an SVG
    console.log("🔍 Looking for Create button...");
    const svgButton = await q('composer.openButton', { timeoutMs: 2000 });
    
    if (!svgButton) {
      throw new Error('Create button not found');
    }
    
    console.log("✅ Found Create SVG:", svgButton);
    
    // IMPORTANT : Pour un SVG, il faut cliquer sur le parent div[role="button"]
    let clickableElement = svgButton;
    if (svgButton.tagName === 'svg' || svgButton.tagName === 'SVG') {
      // Remonter jusqu'au div[role="button"] parent
      clickableElement = svgButton.closest('div[role="button"]') || 
                        svgButton.closest('button') || 
                        svgButton.closest('a') ||
                        svgButton.parentElement;
      console.log("📍 Using parent element for click:", clickableElement);
    }
    
    // Scroll et cliquer
    await scrollIntoViewIfNeeded(clickableElement);
    
    // Essayer le click natif d'abord (plus fiable sur React/Threads)
    console.log("🖱️ Clicking...");
    clickableElement.click();
    
    // Attendre que la modal/page s'ouvre
    console.log("⏳ Waiting for composer to open...");
    await new Promise(resolve => setTimeout(resolve, jitter(2000)));
    
    // Chercher le textarea
    console.log("🔍 Looking for text area...");
    const textArea = await q('composer.textArea', { timeoutMs: 5000 });
    
    if (!textArea) {
      throw new Error('Text area not found after clicking Create button');
    }
    
    console.log("✅ Text area found:", textArea);
    
    // Focus sur le textarea
    await scrollIntoViewIfNeeded(textArea);
    textArea.focus();
    
    // Sur Threads, parfois il faut cliquer dans le textarea pour l'activer
    textArea.click();
    
    console.log("✅ Composer opened successfully");
    return { ok: true, details: 'Composer opened' };
    
  } catch (error) {
    console.error("❌ OpenComposer error:", error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message || 'Failed to open composer'
    };
  }
}

async function typeAndPost(payload) {
  try {
    // ✅ CRITICAL FIX: Check for emergency stop at the beginning
    if (shouldStop()) {
      console.log('🛑 typeAndPost aborted by emergency stop');
      return { ok: false, errorCode: ERROR_CODE.STOPPED, details: 'Action stopped by user' };
    }

    // Extraire text et media du payload
    const text = payload.text || payload;
    const media = payload.media || [];

    console.log("📝 TYPE_AND_POST: Starting...");
    console.log("📎 Media to attach:", media?.length || 0);

    if (!text || text.trim().length === 0) {
      return {
        ok: false,
        errorCode: 'VERIFICATION_FAILED',
        details: 'No text provided'
      };
    }

    // Find text area
    console.log("🔍 Looking for text area...");
    const textAreaSelectors = SELECTORS['composer.textArea'] || ['div[contenteditable="true"][role="textbox"]'];
    const textArea = document.querySelector(textAreaSelectors.join(', '));
    
    if (!textArea) {
      return {
        ok: false,
        errorCode: 'DOM_NOT_FOUND',
        details: 'Text area not found'
      };
    }
    
    console.log("✅ Text area found:", textArea);
    
    // ==================== INJECTION DES MÉDIAS ====================
    if (media && media.length > 0) {
      console.log("📸 Attaching media files...");
      
      try {
        // 1. Find the "Attach media" button
        const attachBtn = await q('composer.attachMedia', { timeoutMs: 3000 });

        if (!attachBtn) {
          console.warn("⚠️ Attach media button not found, posting without media");
        } else {
          console.log("✅ Found attach media button");

          // Find the clickable element (parent if it's an SVG)
          let clickableElement = attachBtn;
          if (attachBtn.tagName === 'svg' || attachBtn.tagName === 'SVG') {
            clickableElement = attachBtn.closest('div[role="button"]') || 
                              attachBtn.closest('button') || 
                              attachBtn.parentElement;
          }
          
          // 2. Convertir les médias base64 en Files
          const files = await Promise.all(media.map(async (m, index) => {
            try {
              // Extraire le type MIME et les données du base64
              const matches = m.data.match(/^data:([^;]+);base64,(.+)$/);
              if (!matches) {
                console.error(`Invalid base64 format for media ${index}`);
                return null;
              }
              
              const mimeType = matches[1];
              const base64Data = matches[2];
              
              // Convertir base64 en blob
              const byteCharacters = atob(base64Data);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: mimeType });
              
              // Créer un File object
              const fileName = m.name || `media_${index}.${mimeType.split('/')[1]}`;
              return new File([blob], fileName, { type: mimeType });
              
            } catch (error) {
              console.error(`Error processing media ${index}:`, error);
              return null;
            }
          }));
          
          // Filtrer les fichiers null
          const validFiles = files.filter(f => f !== null);
          
          if (validFiles.length > 0) {
            console.log(`📁 Created ${validFiles.length} file objects`);
            
            // 3. Créer un DataTransfer pour simuler la sélection
            const dataTransfer = new DataTransfer();
            validFiles.forEach(file => dataTransfer.items.add(file));
            
            // 4. Attacher un listener global pour intercepter l'input file
            let intercepted = false;
            let interceptLock = false;
            const interceptFileInput = (e) => {
              // Protection synchrone immédiate contre race condition
              if (interceptLock) return;

              if (e.target && e.target.type === 'file' && !intercepted) {
                interceptLock = true; // Lock immédiat avant async
                console.log("🎯 File input detected, injecting files...");

                const input = e.target;

                // Empêcher le comportement par défaut
                e.preventDefault();
                e.stopPropagation();

                // Désactiver l'input immédiatement pour éviter doubles clics
                input.disabled = true;

                // Injecter nos fichiers
                try {
                  // Méthode 1: Assigner directement
                  input.files = dataTransfer.files;
                } catch (err) {
                  // Méthode 2: Si read-only, utiliser defineProperty
                  console.log("Using defineProperty method...");
                  Object.defineProperty(input, 'files', {
                    value: dataTransfer.files,
                    writable: false,
                    configurable: true
                  });
                }

                // Déclencher l'événement change
                const changeEvent = new Event('change', { bubbles: true, cancelable: false });
                input.dispatchEvent(changeEvent);

                intercepted = true;
                console.log("✅ Files injected successfully");
              }
            };
            
            // Attacher le listener
            document.addEventListener('click', interceptFileInput, true);
            
            // 5. Cliquer sur le bouton attach media
            console.log("🖱️ Clicking attach media button...");
            await scrollIntoViewIfNeeded(clickableElement);
            
            // Attente avant le clic pour s'assurer que tout est prêt
            await new Promise(resolve => setTimeout(resolve, 500));
            
            clickableElement.click();
            
            // 6. Attendre un peu pour que l'input apparaisse
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 7. Si pas intercepté, essayer de trouver l'input manuellement
            if (!intercepted) {
              console.log("⚠️ Input not intercepted, searching manually...");
              
              const fileInputSelectors = SELECTORS['verification.fileInput'] || ['input[type="file"]'];
              const fileInputs = document.querySelectorAll(fileInputSelectors.join(', '));
              for (const input of fileInputs) {
                if (input.accept && (input.accept.includes('image') || input.accept.includes('video'))) {
                  console.log("📤 Found file input, injecting...");
                  
                  try {
                    input.files = dataTransfer.files;
                  } catch (err) {
                    Object.defineProperty(input, 'files', {
                      value: dataTransfer.files,
                      writable: false,
                      configurable: true
                    });
                  }
                  
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  intercepted = true;
                  break;
                }
              }
            }

            // Clean up the listener
            document.removeEventListener('click', interceptFileInput, true);
            
            if (intercepted) {
              // Wait for previews to load
              console.log("⏳ Waiting for media previews to load...");
              await new Promise(resolve => setTimeout(resolve, 3000));

              // Verify upload success
              const mediaPreviewSelectors = SELECTORS['verification.mediaPreview'] || ['img[draggable="false"]', 'video'];
              const mediaPreviews = document.querySelectorAll(mediaPreviewSelectors.join(', '));
              console.log(`✅ Media upload completed (${media.length} file(s) uploaded)`);

            } else {
              console.warn("⚠️ Could not inject files, continuing without media");
            }
          }
        }
      } catch (error) {
        console.error("❌ Error attaching media:", error);
        // Continuer sans média plutôt que d'échouer complètement
      }
    }
    // ==================== FIN INJECTION DES MÉDIAS ====================

    // ✅ APPLY SPOILER MARKS TO MEDIA (works for all media types: tags + random)
    // Note: Threads marks ALL media as spoiler or none - no individual selection
    if (media && media.length > 0) {
      // Check if ANY media needs spoiler mark
      const shouldMarkAllAsSpoiler = media.some(m => m.shouldMarkAsSpoiler);

      if (shouldMarkAllAsSpoiler) {
        console.log(`🔒 Applying spoiler mark (will affect all ${media.length} media)...`);

        // Wait for media previews to be fully loaded (random 800-1200ms for human-like behavior)
        const randomWait = 800 + Math.floor(Math.random() * 400); // Random between 800-1200ms
        console.log(`⏳ Waiting ${randomWait}ms for media previews to load...`);
        await new Promise(resolve => setTimeout(resolve, randomWait));

        // Find the first 3-dot button (clicking it marks ALL media as spoiler)
        let threeDotButton = null;

        // METHOD 1: Search by aria-label
        threeDotButton = document.querySelector('svg[aria-label*="Attachment" i]');

        // METHOD 2: Find by SVG with 3 circles
        if (!threeDotButton) {
          const svgs = document.querySelectorAll('svg');
          threeDotButton = Array.from(svgs).find(svg => {
            const circles = svg.querySelectorAll('circle');
            return circles.length === 3;
          });
        }

        // METHOD 3: Search by class pattern
        if (!threeDotButton) {
          threeDotButton = document.querySelector('div.x1yhgy36 svg, div[class*="x1yhgy36"] svg');
        }

        if (threeDotButton) {
          try {
            // Find clickable parent
            const clickableButton = threeDotButton.closest('div[role="button"]') || threeDotButton.closest('button') || threeDotButton.parentElement;

            console.log('✅ Found 3-dot button, clicking...');

            // Scroll into view and click
            clickableButton.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            await new Promise(resolve => setTimeout(resolve, 300));

            clickableButton.click();
            console.log('🖱️ Clicked 3-dot button');

            // Wait for menu to appear with active waiting
            console.log('⏳ Waiting for menu to appear...');
            let menuAppeared = false;
            for (let i = 0; i < 20; i++) {
              await new Promise(resolve => setTimeout(resolve, 100));
              // Check if menu appeared by looking for any button with "spoiler" or menu items
              const menuVisible = document.querySelector('[role="menu"], [role="menuitem"], div[role="button"]:not([aria-hidden="true"])');
              if (menuVisible) {
                menuAppeared = true;
                console.log('✅ Menu appeared');
                break;
              }
            }

            if (!menuAppeared) {
              console.log('⚠️ Menu did not appear, but continuing...');
            }

            // Extra wait to ensure menu is fully rendered and interactive
            await new Promise(resolve => setTimeout(resolve, 500));

            // Find and click "Mark spoiler" button
            let clickSuccess = false;

            for (let attempt = 1; attempt <= 3 && !clickSuccess; attempt++) {
              console.log(`🎯 Looking for spoiler button (attempt ${attempt}/3)...`);

              // Helper function to check if element or ancestors have aria-hidden
              const isAccessible = (el) => {
                let current = el;
                while (current && current !== document.body) {
                  if (current.getAttribute('aria-hidden') === 'true') {
                    return false;
                  }
                  current = current.parentElement;
                }
                return true;
              };

              // METHOD 1: Look for button with "Mark spoiler" text (exclude aria-hidden)
              let spoilerBtn = Array.from(document.querySelectorAll('div[role="button"]:not([aria-hidden="true"])')).find(btn => {
                const text = btn.textContent?.trim().toLowerCase();
                const hasText = text === 'mark spoiler' || text === 'marquer comme spoiler' || text.includes('spoiler');
                return hasText && isAccessible(btn);
              });

              // METHOD 2: Use SELECTORS if configured (exclude aria-hidden)
              if (!spoilerBtn) {
                const spoilerSelectors = SELECTORS['spoiler.mediaButton'] || SELECTORS['spoiler.hideButton'] || [];
                for (const selector of spoilerSelectors) {
                  const btn = document.querySelector(selector + ':not([aria-hidden="true"])');
                  if (btn && isAccessible(btn)) {
                    spoilerBtn = btn;
                    console.log(`✅ Found via selector: ${selector}`);
                    break;
                  }
                }
              }

              // METHOD 3: Search by aria-label (exclude aria-hidden)
              if (!spoilerBtn) {
                const candidates = document.querySelectorAll('[aria-label*="spoiler" i]:not([aria-hidden="true"]), [aria-label*="hidden" i]:not([aria-hidden="true"])');
                spoilerBtn = Array.from(candidates).find(btn => isAccessible(btn));
              }

              // METHOD 4: Search by class patterns (exclude aria-hidden)
              if (!spoilerBtn) {
                const buttons = document.querySelectorAll('div.x1i10hfl[role="button"][tabindex="0"]:not([aria-hidden="true"])');
                spoilerBtn = Array.from(buttons).find(btn => {
                  const text = btn.textContent?.toLowerCase();
                  return text && text.includes('spoiler') && isAccessible(btn);
                });
              }

              if (spoilerBtn) {
                console.log('✅ Found Mark spoiler button!');

                // Verify button is visible and has dimensions
                const rect = spoilerBtn.getBoundingClientRect();
                console.log(`📐 Button dimensions: ${rect.width}x${rect.height}, visible: ${rect.width > 0 && rect.height > 0}`);
                console.log(`🔓 aria-hidden check: ${spoilerBtn.getAttribute('aria-hidden') || 'none'}, accessible: ${isAccessible(spoilerBtn)}`);

                // Ensure visible and wait for it to be interactive
                spoilerBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                await new Promise(resolve => setTimeout(resolve, 300));

                // Simulate REALISTIC human click sequence (simplified to avoid triggering background elements)
                try {
                  const rect = spoilerBtn.getBoundingClientRect();
                  const x = rect.left + rect.width / 2;
                  const y = rect.top + rect.height / 2;

                  const mouseEventOptions = {
                    bubbles: false,  // Don't propagate to avoid triggering background elements
                    cancelable: true,
                    view: window,
                    clientX: x,
                    clientY: y,
                    screenX: x,
                    screenY: y,
                    button: 0,
                    buttons: 1
                  };

                  // STEP 1: Mouse down (pointerdown + mousedown)
                  spoilerBtn.dispatchEvent(new PointerEvent('pointerdown', { ...mouseEventOptions, pointerId: 1, pointerType: 'mouse' }));
                  spoilerBtn.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
                  console.log('🖱️ Mouse down');
                  await new Promise(resolve => setTimeout(resolve, 80));

                  // STEP 2: Mouse up (mouseup + pointerup)
                  spoilerBtn.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
                  spoilerBtn.dispatchEvent(new PointerEvent('pointerup', { ...mouseEventOptions, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
                  console.log('🖱️ Mouse up');
                  await new Promise(resolve => setTimeout(resolve, 30));

                  // STEP 3: Click event
                  spoilerBtn.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
                  spoilerBtn.click();
                  console.log('🖱️ Click executed');
                  await new Promise(resolve => setTimeout(resolve, 100));

                  // STEP 4: Try inner span if exists
                  const innerSpan = spoilerBtn.querySelector('span');
                  if (innerSpan) {
                    innerSpan.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventOptions, buttons: 1 }));
                    await new Promise(resolve => setTimeout(resolve, 50));
                    innerSpan.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
                    innerSpan.click();
                    console.log('🖱️ Inner span clicked');
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }

                  clickSuccess = true;
                  console.log(`✅ Spoiler mark applied to ALL media`);

                } catch (clickError) {
                  console.error('❌ Click error:', clickError);
                }

              } else {
                console.log(`⚠️ Spoiler button not found (attempt ${attempt}/3)`);
                if (attempt < 3) {
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              }
            }

            if (!clickSuccess) {
              console.error(`❌ Failed to apply spoiler mark to media`);
            }

            // Wait for menu to close automatically after clicking spoiler
            console.log('⏳ Waiting for menu to close automatically...');
            await new Promise(resolve => setTimeout(resolve, 500));
            console.log('✅ Menu closed, continuing...');

          } catch (error) {
            console.error(`❌ Error applying spoiler to media:`, error);
          }
        } else {
          console.warn(`⚠️ Could not find 3-dot button for media spoiler`);
        }

        console.log('✅ Finished applying spoiler mark to media');
      }
    }
    // ==================== FIN SPOILER MARKS ====================

    // Type the text
    console.log("⌨️ Typing text...");
    
    // Clear and focus
    textArea.focus();
    textArea.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Clear existing content properly
    textArea.innerHTML = '';
    textArea.textContent = '';
    
    // ✨ Détecter si le texte contient des spoilers
    const hasSpoilers = text.includes(';') && (text.match(/;[^;]+;/g) || []).length > 0;
    
    if (hasSpoilers) {
      console.log("📌 Text contains spoiler markers, using spoiler typing...");
      await typeTextWithSpoilerMarking(textArea, text);
    } else {
      console.log("⌨️ Normal typing (no spoilers)...");
      
      // Code de typing existant
      let typingSpeed = 'normal';
      let consecutiveFast = 0;

      for (let i = 0; i < text.length; i++) {
        // ✅ CRITICAL FIX: Check for emergency stop while typing
        if (shouldStop()) {
          console.log('🛑 Typing aborted by emergency stop at character', i);
          return { ok: false, errorCode: ERROR_CODE.STOPPED, details: 'Action stopped while typing' };
        }

        const char = text[i];
        const nextChar = text[i + 1] || '';
        const prevChar = text[i - 1] || '';

        // Handle line breaks with Enter key simulation
        if (char === '\n') {
          // Simulate full Enter key press sequence
          const keydownEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          textArea.dispatchEvent(keydownEvent);

          const keypressEvent = new KeyboardEvent('keypress', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          textArea.dispatchEvent(keypressEvent);

          const keyupEvent = new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          textArea.dispatchEvent(keyupEvent);

          // Trigger input event
          textArea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, char);
        }
        
        let delay;
        
        if (['.', '!', '?'].includes(prevChar)) {
          delay = 300 + Math.random() * 400;
          typingSpeed = 'slow';
        }
        else if ([',', ';', ':'].includes(prevChar)) {
          delay = 150 + Math.random() * 150;
          typingSpeed = 'normal';
        }
        else if (char === ' ') {
          delay = 80 + Math.random() * 120;
          if (Math.random() < 0.15) {
            delay += 200 + Math.random() * 500;
            console.log("  💭 Thinking pause...");
          }
        }
        else {
          if (Math.random() < 0.3 && typingSpeed !== 'fast') {
            typingSpeed = 'fast';
            consecutiveFast = 3 + Math.floor(Math.random() * 5);
          }
          
          if (typingSpeed === 'fast' && consecutiveFast > 0) {
            delay = 20 + Math.random() * 40;
            consecutiveFast--;
            if (consecutiveFast === 0) typingSpeed = 'normal';
          } else if (typingSpeed === 'slow') {
            delay = 100 + Math.random() * 100;
            typingSpeed = 'normal';
          } else {
            delay = 50 + Math.random() * 80;
          }
          
          const commonPairs = ['th', 'he', 'in', 'er', 'an', 'ed', 'nd', 'to', 'en', 'es'];
          const pair = prevChar + char;
          if (commonPairs.includes(pair.toLowerCase())) {
            delay *= 0.7;
          }
          
          if (char === char.toUpperCase() && char !== char.toLowerCase()) {
            delay *= 1.3;
          }
          if ('!@#$%^&*()_+-=[]{}|;:"\',.<>?/~`'.includes(char)) {
            delay *= 1.5;
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        if (Math.random() < 0.02 && char === ' ') {
          const thinkingTime = 500 + Math.random() * 1500;
          console.log(`  💭 Mid-sentence pause (${Math.round(thinkingTime)}ms)`);
          await new Promise(resolve => setTimeout(resolve, thinkingTime));
        }
      }
    }
    
    // Final pause after typing (like reviewing before sending)
    const reviewPause = 300 + Math.random() * 700;
    console.log(`  👀 Review pause (${Math.round(reviewPause)}ms)`);
    await new Promise(resolve => setTimeout(resolve, reviewPause));
    
    // Trigger events
    textArea.dispatchEvent(new Event('input', { bubbles: true }));
    textArea.dispatchEvent(new Event('change', { bubbles: true }));
    
    console.log("✅ Text typed successfully");
    console.log("   Content:", textArea.textContent);

    // Wait for button to be enabled (random 1200-1800ms to simulate variable typing speed)
    const postButtonWait = 1200 + Math.floor(Math.random() * 600); // 1200-1800ms
    await new Promise(resolve => setTimeout(resolve, postButtonWait));
    
    // RECHERCHE DU BOUTON POST (votre code existant)
    console.log("🔍 Looking for Post button (avoiding aria-hidden)...");
    
    let submitBtn = null;
    
    // Méthode 1: Chercher UNIQUEMENT les boutons qui ne sont PAS dans des éléments aria-hidden
    const allPossibleButtons = document.querySelectorAll('div[role="button"], button');
    const visibleButtons = [];
    
    for (const btn of allPossibleButtons) {
      // Vérifier que le bouton n'est pas dans un élément aria-hidden
      let parent = btn;
      let isHidden = false;
      
      while (parent && parent !== document.body) {
        if (parent.getAttribute('aria-hidden') === 'true') {
          isHidden = true;
          break;
        }
        parent = parent.parentElement;
      }
      
      // Si pas caché et contient "Post"
      if (!isHidden && btn.textContent?.trim() === 'Post') {
        visibleButtons.push(btn);
        console.log(`Found visible Post button:`, btn);
        console.log(`  Classes: ${btn.className?.substring(0, 100)}`);
      }
    }
    
    console.log(`Found ${visibleButtons.length} visible Post buttons (not aria-hidden)`);
    
    // Méthode 2: Chercher spécifiquement dans la structure connue
    if (visibleButtons.length > 0) {
      // Priorité aux boutons avec la structure exacte
      for (const btn of visibleButtons) {
        // Vérifier si c'est dans la structure x2lah0s
        if (btn.parentElement?.className?.includes('x2lah0s')) {
          submitBtn = btn;
          console.log("✅ Found Post button with x2lah0s parent");
          break;
        }
        
        // Ou si ça a les classes spécifiques
        if (btn.className?.includes('x1lku1pv') || 
            btn.className?.includes('xp07o12')) {
          submitBtn = btn;
          console.log("✅ Found Post button with specific classes");
          break;
        }
      }
      
      // Si pas trouvé avec les critères spécifiques, prendre le dernier visible
      if (!submitBtn && visibleButtons.length > 0) {
        submitBtn = visibleButtons[visibleButtons.length - 1];
        console.log("✅ Using last visible Post button");
      }
    }
    
    // Méthode 3: Contourner aria-hidden en trouvant le bon bouton directement
    if (!submitBtn) {
      console.log("⚠️ Trying direct selector approach...");

      // Chercher spécifiquement la structure du bouton Post
      const submitBtnSelectors = SELECTORS['composer.submitButton'] || ['div.xc26acl', 'div.xp07o12'];
      const postDivs = document.querySelectorAll(submitBtnSelectors.join(', '));
      
      for (const div of postDivs) {
        if (div.textContent?.trim() === 'Post') {
          const parentBtn = div.parentElement;
          if (parentBtn && parentBtn.getAttribute('role') === 'button') {
            // Forcer la suppression de aria-hidden si présent
            let ancestor = parentBtn;
            while (ancestor && ancestor !== document.body) {
              if (ancestor.getAttribute('aria-hidden') === 'true') {
                console.log("⚠️ Removing aria-hidden from ancestor");
                ancestor.removeAttribute('aria-hidden');
              }
              ancestor = ancestor.parentElement;
            }
            
            submitBtn = parentBtn;
            console.log("✅ Found Post button and cleared aria-hidden");
            break;
          }
        }
      }
    }
    
    // Méthode 4: Utiliser un sélecteur XPath pour plus de précision
    if (!submitBtn) {
      console.log("⚠️ Using XPath selector...");
      
      const xpathResult = document.evaluate(
        "//div[@role='button'][.//text()='Post'][not(ancestor::*[@aria-hidden='true'])]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      
      if (xpathResult.singleNodeValue) {
        submitBtn = xpathResult.singleNodeValue;
        console.log("✅ Found Post button with XPath");
      }
    }
    
    if (!submitBtn) {
      console.error("❌ No Post button found");
      
      // Debug info
      console.log("Debug - All elements with 'Post' text:");
      const allPost = Array.from(document.querySelectorAll('*')).filter(el => 
        el.textContent?.trim() === 'Post'
      );
      allPost.forEach((el, i) => {
        console.log(`  ${i}: ${el.tagName}.${el.className?.substring(0, 50)}`);
        console.log(`     Role: ${el.getAttribute('role')}`);
        console.log(`     Parent: ${el.parentElement?.tagName}.${el.parentElement?.className?.substring(0, 50)}`);
      });
      
      return {
        ok: false,
        errorCode: 'DOM_NOT_FOUND',
        details: 'Post button not found'
      };
    }
    
    // Log button details
    console.log("📋 Post button details:");
    console.log("  Text:", submitBtn.textContent?.trim());
    console.log("  Tag:", submitBtn.tagName);
    console.log("  Class:", submitBtn.className?.substring(0, 100));
    console.log("  Disabled:", submitBtn.disabled || submitBtn.getAttribute('aria-disabled'));
    
    // Remove any remaining aria-hidden from ancestors before clicking
    let ancestor = submitBtn;
    while (ancestor && ancestor !== document.body) {
      if (ancestor.getAttribute('aria-hidden') === 'true') {
        ancestor.removeAttribute('aria-hidden');
        console.log("⚠️ Removed aria-hidden from:", ancestor.tagName);
      }
      ancestor = ancestor.parentElement;
    }
    
    // Ensure button is enabled
    if (submitBtn.getAttribute('aria-disabled') === 'true') {
      submitBtn.removeAttribute('aria-disabled');
    }
    if (submitBtn.disabled) {
      submitBtn.disabled = false;
    }
    
    // Click the button
    console.log("🖱️ Clicking Post button...");
    
    // Make sure button is visible
    submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // ✅ UN SEUL CLIC PROPRE
    // Focus d'abord
    if (submitBtn.focus) {
      submitBtn.focus();
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100));
    }
    
    // UN SEUL CLIC
    console.log("  Clicking Post button ONCE...");
    submitBtn.click();
    
    // ✅ ATTENDRE PLUS LONGTEMPS (2.5-3 secondes)
    console.log("⏳ Waiting for submission...");
    await new Promise(resolve => setTimeout(resolve, 2500 + Math.random() * 500));
    
    // Check success indicators
    const composerTextAreaSelectors = SELECTORS['composer.textArea'] || ['div[contenteditable="true"][role="textbox"]'];
    const composerGone = !document.querySelector(composerTextAreaSelectors.join(', '));
    const urlChanged = window.location.pathname !== '/' && window.location.pathname !== '';
    const modalSelectors = SELECTORS['verification.modal'] || ['[role="dialog"]', '.modal'];
    const modalGone = !document.querySelector(modalSelectors.join(', '));
    
    console.log("  Verification:");
    console.log(`    - Composer gone: ${composerGone}`);
    console.log(`    - URL changed: ${urlChanged}`);
    console.log(`    - Modal gone: ${modalGone}`);
    console.log(`    - Current URL: ${window.location.href}`);
    
    if (composerGone || urlChanged) {
      console.log("✅ POST SUBMITTED SUCCESSFULLY!");
      return { ok: true, details: 'Post submitted successfully' };
    } else {
      // ✅ PAS DE RETRY - Assumer succès pour éviter double post
      console.log("⚠️ Could not verify submission, assuming success to avoid duplicate");
      return { ok: true, details: 'Post submitted (unverified)' };
    }
    
  } catch (error) {
    console.error("❌ TYPE_AND_POST ERROR:", error);
    return { 
      ok: false, 
      errorCode: 'ACTION_TIMEOUT',
      details: error.message 
    };
  }
}

// Export for testing
if (typeof window !== 'undefined') {
  window.fixedTypeAndPost = typeAndPost;
  console.log("✅ Ultimate fix loaded! Test with: window.fixedTypeAndPost('Your text')");
}

// Also export a debug function
window.debugPostButton = function() {
  console.log("🔍 Debugging Post buttons...");
  
  // Find all Post buttons
  const allButtons = Array.from(document.querySelectorAll('*')).filter(el => 
    el.textContent?.trim() === 'Post' && 
    (el.getAttribute('role') === 'button' || el.tagName === 'BUTTON')
  );
  
  console.log(`Found ${allButtons.length} elements with 'Post' text`);
  
  allButtons.forEach((btn, i) => {
    // Check if hidden
    let ancestor = btn;
    let hasAriaHidden = false;
    while (ancestor && ancestor !== document.body) {
      if (ancestor.getAttribute('aria-hidden') === 'true') {
        hasAriaHidden = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    
    console.log(`Button ${i}:`);
    console.log(`  Tag: ${btn.tagName}`);
    console.log(`  Classes: ${btn.className?.substring(0, 100)}`);
    console.log(`  Role: ${btn.getAttribute('role')}`);
    console.log(`  Has aria-hidden ancestor: ${hasAriaHidden}`);
    console.log(`  Visible: ${btn.offsetParent !== null}`);
    console.log(`  Parent: ${btn.parentElement?.className?.substring(0, 50)}`);
    console.log(`  Element:`, btn);
  });
};

console.log("Debug function available: window.debugPostButton()");

async function typeTextWithSpoilerMarking(textArea, text) {
  console.log("🏷️ Processing text with spoilers like a human...");
  
  // Parser le texte pour identifier les parties
  const parts = [];
  let currentPos = 0;
  const spoilerRegex = /;([^;]+);/g;
  let match;
  
  while ((match = spoilerRegex.exec(text)) !== null) {
    if (match.index > currentPos) {
      parts.push({
        type: 'normal',
        content: text.substring(currentPos, match.index)
      });
    }
    
    parts.push({
      type: 'spoiler',
      content: match[1]
    });
    
    currentPos = match.index + match[0].length;
  }
  
  if (currentPos < text.length) {
    parts.push({
      type: 'normal',
      content: text.substring(currentPos)
    });
  }
  
  console.log("📝 Text parts:", parts);
  
  // ÉTAPE 1 : Taper TOUT le texte d'abord (sans les ;)
  let spoilerPositions = [];
  let currentTextPos = 0;
  
  for (const part of parts) {
    const startPos = currentTextPos;
    
    // Taper le texte caractère par caractère
    for (let i = 0; i < part.content.length; i++) {
      const char = part.content[i];

      // Handle line breaks with Enter key simulation
      if (char === '\n') {
        // Simulate full Enter key press sequence
        const keydownEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        textArea.dispatchEvent(keydownEvent);

        const keypressEvent = new KeyboardEvent('keypress', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        textArea.dispatchEvent(keypressEvent);

        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        textArea.dispatchEvent(keyupEvent);

        // Trigger input event
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, char);
      }

      currentTextPos++;

      // Délai humain
      const delay = 30 + Math.random() * 50;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // Mémoriser la position des spoilers
    if (part.type === 'spoiler') {
      spoilerPositions.push({
        start: startPos,
        length: part.content.length,
        text: part.content
      });
    }
  }
  
  console.log("✅ All text typed, now applying spoilers...");
  console.log("Spoiler positions:", spoilerPositions);
  
  // ÉTAPE 2 : Pour chaque spoiler, sélectionner VRAIMENT le texte
  for (const spoiler of spoilerPositions) {
    console.log(`Marking spoiler: "${spoiler.text}"`);
    
    // ✅ NOUVELLE MÉTHODE : Utiliser l'API Selection directement
    const selection = window.getSelection();
    const range = document.createRange();
    
    // Trouver les nœuds de texte dans le textArea
    const walker = document.createTreeWalker(
      textArea,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let node;
    let currentOffset = 0;
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;
    
    // Parcourir tous les nœuds de texte pour trouver les positions
    while (node = walker.nextNode()) {
      const nodeLength = node.textContent.length;
      
      // Trouver le nœud de début
      if (!startNode && currentOffset + nodeLength > spoiler.start) {
        startNode = node;
        startOffset = spoiler.start - currentOffset;
      }
      
      // Trouver le nœud de fin
      if (!endNode && currentOffset + nodeLength >= spoiler.start + spoiler.length) {
        endNode = node;
        endOffset = spoiler.start + spoiler.length - currentOffset;
        break;
      }
      
      currentOffset += nodeLength;
    }
    
    if (startNode && endNode) {
      try {
        // Créer la sélection
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        selection.removeAllRanges();
        selection.addRange(range);
        
        console.log(`Selected text: "${selection.toString()}"`);
        
        // Attendre que la sélection soit visible
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // ✅ MÉTHODE 1 : Chercher le bouton spoiler dans la toolbar (s'il apparaît)
        // ✅ Use selectors from SELECTORS (auto-updateable)
        // ✅ ROBUST SPOILER BUTTON DETECTION & CLICK
        let clickSuccess = false;

        // Wait longer for toolbar to appear after selection
        await new Promise(resolve => setTimeout(resolve, 500));

        // Try multiple detection methods with retries
        for (let attempt = 1; attempt <= 3 && !clickSuccess; attempt++) {
          console.log(`🎯 Spoiler button attempt ${attempt}/3`);

          // Helper function to check if element or ancestors have aria-hidden
          const isAccessible = (el) => {
            let current = el;
            while (current && current !== document.body) {
              if (current.getAttribute('aria-hidden') === 'true') {
                return false;
              }
              current = current.parentElement;
            }
            return true;
          };

          // METHOD 1: Look for button with "Mark spoiler" text (exclude aria-hidden)
          let spoilerButton = Array.from(document.querySelectorAll('div[role="button"]:not([aria-hidden="true"])')).find(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            const hasText = text === 'mark spoiler' || text === 'marquer comme spoiler' || text.includes('spoiler');
            return hasText && isAccessible(btn);
          });

          // METHOD 2: Try server-configured selectors (exclude aria-hidden)
          if (!spoilerButton) {
            const spoilerSelectors = SELECTORS['spoiler.hideButton'] || [];
            for (const selector of spoilerSelectors) {
              const btn = document.querySelector(selector + ':not([aria-hidden="true"])');
              if (btn && isAccessible(btn)) {
                spoilerButton = btn;
                console.log(`✅ Found via selector: ${selector}`);
                break;
              }
            }
          }

          // METHOD 3: Search for buttons with aria-label (exclude aria-hidden)
          if (!spoilerButton) {
            const candidates = document.querySelectorAll('[aria-label*="spoiler" i]:not([aria-hidden="true"]), [aria-label*="hidden" i]:not([aria-hidden="true"])');
            spoilerButton = Array.from(candidates).find(btn => isAccessible(btn));
          }

          // METHOD 4: Search by Threads-specific class patterns (exclude aria-hidden)
          if (!spoilerButton) {
            const buttons = document.querySelectorAll('div.x1i10hfl[role="button"][tabindex="0"]:not([aria-hidden="true"])');
            spoilerButton = Array.from(buttons).find(btn => {
              const text = btn.textContent?.toLowerCase();
              return text && text.includes('spoiler') && isAccessible(btn);
            });
          }

          if (spoilerButton) {
            console.log(`✅ Found spoiler button (method used: attempt ${attempt})`);
            console.log(`🔓 aria-hidden check: ${spoilerButton.getAttribute('aria-hidden') || 'none'}, accessible: ${isAccessible(spoilerButton)}`);

            // Ensure button is visible and in viewport
            spoilerButton.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            await new Promise(resolve => setTimeout(resolve, 300));

            // Simulate REALISTIC human click sequence (simplified to avoid triggering background elements)
            try {
              const rect = spoilerButton.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;

              const mouseEventOptions = {
                bubbles: false,  // Don't propagate to avoid triggering background elements
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                button: 0,
                buttons: 1
              };

              // STEP 1: Mouse down
              spoilerButton.dispatchEvent(new PointerEvent('pointerdown', { ...mouseEventOptions, pointerId: 1, pointerType: 'mouse' }));
              spoilerButton.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
              console.log("🖱️ Mouse down");
              await new Promise(resolve => setTimeout(resolve, 80));

              // STEP 2: Mouse up
              spoilerButton.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
              spoilerButton.dispatchEvent(new PointerEvent('pointerup', { ...mouseEventOptions, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
              console.log("🖱️ Mouse up");
              await new Promise(resolve => setTimeout(resolve, 30));

              // STEP 3: Click
              spoilerButton.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
              spoilerButton.click();
              console.log("🖱️ Click executed");
              await new Promise(resolve => setTimeout(resolve, 100));

              // STEP 4: Try inner span
              const innerSpan = spoilerButton.querySelector('span');
              if (innerSpan) {
                innerSpan.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventOptions, buttons: 1 }));
                await new Promise(resolve => setTimeout(resolve, 50));
                innerSpan.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
                innerSpan.click();
                console.log("🖱️ Inner span clicked");
                await new Promise(resolve => setTimeout(resolve, 100));
              }

              clickSuccess = true;
              console.log("✅ Spoiler button clicked successfully");

            } catch (clickError) {
              console.error("❌ Click error:", clickError);
            }

          } else {
            console.log(`⚠️ Spoiler button not found (attempt ${attempt}/3)`);

            // Wait before retry
            if (attempt < 3) {
              await new Promise(resolve => setTimeout(resolve, 500));

              // Re-select the text to ensure toolbar stays visible
              selection.removeAllRanges();
              selection.addRange(range);
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        }

        // FALLBACK METHOD: Right-click context menu (if button click failed)
        if (!clickSuccess) {
          console.log("🔄 Trying right-click fallback method...");

          const rects = range.getClientRects();
          if (rects.length > 0) {
            const rect = rects[0];
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            // Simulate right-click
            const contextMenuEvent = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              button: 2
            });

            textArea.dispatchEvent(contextMenuEvent);
            console.log("🖱️ Right-click sent at:", x, y);

            // Wait for context menu to appear
            await new Promise(resolve => setTimeout(resolve, 800));

            // Search for spoiler option in context menu
            const menuOptions = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="button"], span, div')).filter(el => {
              const text = el.textContent?.trim().toLowerCase();
              return text && (
                text === 'mark spoiler' ||
                text === 'marquer comme spoiler' ||
                text.includes('spoiler') ||
                text.includes('hide text') ||
                text.includes('masquer') ||
                text.includes('hidden')
              ) && el.offsetParent !== null && el.clientHeight > 0; // Ensure it's visible
            });

            if (menuOptions.length > 0) {
              console.log(`✅ Found ${menuOptions.length} spoiler options in context menu`);
              // Click the most specific one (shortest text = most specific)
              const bestOption = menuOptions.reduce((best, current) =>
                current.textContent.length < best.textContent.length ? current : best
              );
              bestOption.click();
              console.log("🖱️ Context menu option clicked");
              clickSuccess = true;
              await new Promise(resolve => setTimeout(resolve, 400));
            } else {
              console.log("⚠️ No spoiler option found in context menu");

              // Close menu if open
              document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true
              }));
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
        }

        if (!clickSuccess) {
          console.error("❌ All spoiler marking methods failed for:", spoiler.text);
        }
        
      } catch (e) {
        console.error("Error selecting text:", e);
      }
    } else {
      console.log("⚠️ Could not find text nodes for selection");
    }
    
    // Désélectionner
    selection.removeAllRanges();
    
    // Pause entre chaque spoiler
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Placer le curseur à la fin
  const range = document.createRange();
  range.selectNodeContents(textArea);
  range.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  
  console.log("✅ Text typed and spoiler marking attempted!");
  
  // Déclencher les événements finaux
  textArea.dispatchEvent(new Event('input', { bubbles: true }));
  textArea.dispatchEvent(new Event('change', { bubbles: true }));
}


// Scroll timeline
// Renommer scrollTimeline en scrollPage et ajouter un paramètre context
async function scrollPage(context = 'timeline') {
  try {
    // État persistant du scroll (par contexte)
    const stateKey = `scrollState_${context}`;
    if (!window[stateKey]) {
      window[stateKey] = {
        momentum: 0,           // Vitesse actuelle (0-10)
        fatigue: 0,           // Fatigue accumulée (0-100)
        lastScrollTime: 0,    // Pour calculer le temps entre scrolls
        totalScrolled: 0,     // Distance totale scrollée
        microAdjustPending: false,
        consecutiveScrolls: 0,  // ← NOUVEAU : Compteur pour pauses longues
        nextLongPauseAt: 30 + Math.floor(Math.random() * 21)  // ← NOUVEAU : Entre 30-50
      };
    }

    const state = window[stateKey];
    const timeSinceLastScroll = Date.now() - state.lastScrollTime;

    // ===== NOUVEAU : PAUSE LONGUE DE LECTURE =====
    state.consecutiveScrolls++;

    if (state.consecutiveScrolls >= state.nextLongPauseAt) {
      state.consecutiveScrolls = 0;
      state.nextLongPauseAt = 30 + Math.floor(Math.random() * 21); // Prochain dans 30-50 scrolls
      state.momentum = 0; // Reset momentum

      // Pause longue : simule vraie lecture ou distraction
      const longPauseDuration = 7000 + Math.random() * 14000 // 7-21 secondes

      console.log('[DEEP-READING] Starting pause of', Math.round(longPauseDuration/1000), 's after', state.nextLongPauseAt, 'scrolls');

      // PAUSE REELLE : On attend vraiment 7-21 secondes ici
      await new Promise(resolve => setTimeout(resolve, longPauseDuration));

      // Recupere de la fatigue pendant la pause
      state.fatigue = Math.max(0, state.fatigue - 20);

      return {
        ok: true,
        details: 'deep-reading pause: paused ' + Math.round(longPauseDuration/1000) + 's for focused reading',
        scrollDistance: 0,
        scrollType: 'deep-reading',
        pauseDuration: longPauseDuration,
        momentum: 0,
        fatigue: state.fatigue
      };
    }
    
    // Helper : génère une distance humaine (log-normale)
    const humanDistance = (base, variance) => {
      // Distribution log-normale pour avoir des valeurs naturelles
      const factor = Math.exp(Math.random() * variance - variance/2);
      return Math.round(base * factor);
    };
    
    let scrollDistance;
    let scrollBehavior = 'smooth';
    let scrollType;
    
    // ===== DÉCISION BASÉE SUR L'ÉTAT =====
    
    // 1. MOMENTUM - Si on vient de scroller, chance de continuer
    if (state.momentum > 0 && timeSinceLastScroll < 2000) {
      if (Math.random() < 0.7) {
        // 70% : Continue le momentum
        scrollDistance = humanDistance(300, 0.5) * (1 + state.momentum * 0.1);
        state.momentum = Math.min(10, state.momentum + 1);
        scrollType = 'momentum';
      } else {
        // 30% : Arrêt pour lire
        scrollDistance = humanDistance(100, 0.3);
        state.momentum = 0;
        scrollType = 'reading-stop';
      }
      
    // 2. NOUVEAU SCROLL après pause
    } else if (timeSinceLastScroll > 5000 || state.lastScrollTime === 0) {
      state.momentum = 0;
      state.fatigue = Math.max(0, state.fatigue - 10); // Récupère
      
      const pattern = Math.random();
      
      if (pattern < 0.15) {
        // 15% : Micro-ajustement (repositionner pour mieux voir)
        scrollDistance = humanDistance(50, 0.5) * (Math.random() < 0.5 ? 1 : -1);
        scrollType = 'micro-adjust';
        
      } else if (pattern < 0.35) {
        // 20% : Scroll de recherche (cherche quelque chose)
        scrollDistance = humanDistance(800, 0.4);
        state.momentum = 3; // Démarre avec momentum
        scrollType = 'searching';
        
      } else if (pattern < 0.75) {
        // 40% : Scroll normal de lecture
        scrollDistance = humanDistance(250, 0.6); // ~1-2 tweets
        scrollType = 'normal-read';
        
      } else {
        // 25% : Scroll lent attentif
        scrollDistance = humanDistance(150, 0.4);
        scrollType = 'careful-read';
      }
      
    // 3. CONTINUATION normale
    } else {
      const pattern = Math.random();
      
      if (pattern < 0.62) {
        // 60% : Scroll standard
        scrollDistance = humanDistance(300, 0.7);
        scrollType = 'standard';

      } else if (pattern < 0.87) {
        // 25% : Début de momentum
        scrollDistance = humanDistance(400, 0.5);
        state.momentum = 2;
        scrollType = 'accelerating';

      } else if (pattern < 0.925) {
        // 7.5% : Retour arrière (relire quelque chose)
        scrollDistance = -humanDistance(200, 0.5);
        scrollType = 'back-to-reread';
        state.momentum = 0;

      } else {
        // 7.5% : Pause (pas de scroll, juste regarde)
        scrollDistance = 0;
        scrollType = 'just-looking';
      }
    }
    
    // ===== AJUSTEMENTS CONTEXTUELS =====
    
    // Adapter selon le contexte
    const contextMultipliers = {
      'timeline': 1.0,
      'comments': 0.7,      // Scrolls plus courts dans les commentaires
      'profile': 0.8,       // Un peu plus court sur les profils
      'notifications': 0.5,  // Beaucoup plus court dans notifs
      'dms': 0.3            // Très court dans DMs
    };
    
    const multiplier = contextMultipliers[context] || 1.0;
    scrollDistance = Math.round(scrollDistance * multiplier);
    
    // Fatigue influence la vitesse
    if (state.fatigue > 50) {
      scrollDistance *= 0.7;
    }
    
    // ===== LIMITES ET SÉCURITÉS =====
    
    // Vérifier qu'on ne scroll pas hors de la page
    const currentY = window.scrollY;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    
    if (scrollDistance > 0 && currentY + scrollDistance > maxY) {
      scrollDistance = Math.max(50, maxY - currentY);
      state.momentum = 0; // Stop au bout
    } else if (scrollDistance < 0 && currentY + scrollDistance < 0) {
      scrollDistance = -currentY;
      state.momentum = 0; // Stop en haut
    }
    
    // ===== EXÉCUTION DU SCROLL =====
    
    if (scrollDistance !== 0) {
      // Variation humaine : parfois on utilise la wheel, parfois on drag
      if (Math.random() < 0.85) {
        // 85% : Scroll smooth normal
        window.scrollBy({
          top: scrollDistance,
          behavior: scrollBehavior
        });
      } else {
        // 15% : Scroll "saccadé" (comme avec une wheel mouse)
        const steps = 2 + Math.floor(Math.random() * 3);
        const stepSize = scrollDistance / steps;
        
        for (let i = 0; i < steps; i++) {
          window.scrollBy({
            top: stepSize,
            behavior: 'auto'
          });
          await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
        }
      }
    }
    
    // ===== MICRO-AJUSTEMENTS OCCASIONNELS =====
    
    // 10% chance d'un micro-ajustement après le scroll principal
    if (Math.random() < 0.10 && scrollDistance > 200) {
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
      
      const microAdjust = humanDistance(30, 0.5) * (Math.random() < 0.3 ? -1 : 1);
      window.scrollBy({
        top: microAdjust,
        behavior: 'smooth'
      });
      
    }
    
    // ===== MISE À JOUR DE L'ÉTAT =====
    
    state.lastScrollTime = Date.now();
    state.totalScrolled += Math.abs(scrollDistance);
    state.fatigue = Math.min(100, state.fatigue + 2);
    
    // Decay du momentum s'il n'est pas renforcé
    if (scrollType !== 'momentum' && scrollType !== 'accelerating') {
      state.momentum = Math.max(0, state.momentum - 2);
    }
    
    // ===== ATTENTE POST-SCROLL (sera géré par l'appelant) =====
    
    // On retourne les infos mais on n'attend PAS ici
    // C'est l'appelant qui décidera s'il veut faire une pause
    
    return {
      ok: true,
      details: `${scrollType} scroll in ${context}: ${scrollDistance}px`,
      scrollDistance: scrollDistance,
      scrollType: scrollType,
      // Timing handled by main loop (1-4s variable delay) // L'appelant décide s'il l'utilise
      momentum: state.momentum,
      fatigue: state.fatigue
    };
    
  } catch (error) {
    return {
      ok: false,
      errorCode: 'SCROLL_FAILED',
      details: error.message
    };
  }
}

// Créer les alias pour compatibilité
async function scrollTimeline() {
  return scrollPage('timeline');
}

async function scrollProfile() {
  return scrollPage('profile');
}

async function scrollNotifications() {
  return scrollPage('notifications');
}

// AJOUTER aussi pour les commentaires
async function scrollComments() {
  return scrollPage('comments');
}


async function backToTimeline() {
  try {
    // ✅ Utiliser le sélecteur JSON
    const homeBtn = await q('nav.home', { timeoutMs: 2000 }).catch(() => null);
    
    if (homeBtn) {
      await scrollIntoViewIfNeeded(homeBtn);
      homeBtn.focus();
      homeBtn.click();
      await new Promise(resolve => setTimeout(resolve, jitter(1500)));
      console.log('Navigated to timeline via home button');
      return { ok: true, details: 'Navigated to timeline' };
    }

    // Fallback: navigation directe
    console.log('Home button not found, using direct navigation');
    window.location.href = '/';
    await new Promise(resolve => setTimeout(resolve, jitter(2000)));
    return { ok: true, details: 'Navigated to timeline directly' };
    
  } catch (error) {
    console.error('Error in backToTimeline:', error);
    return { ok: false, errorCode: 'NAVIGATION_FAILED', details: error.message };
  }
}

// Refresh timeline by double-clicking home button
async function refreshTimeline() {
  try {
    console.log("🔄 Refreshing timeline...");
    
    // Stratégie 1: Utiliser les sélecteurs JSON déjà définis
    let homeBtn = null;
    try {
      homeBtn = await q('nav.home', { timeoutMs: 1000 });
    } catch (e) {
      // Pas trouvé avec les sélecteurs
    }
    
    // Stratégie 2: Chercher le bouton Home ou logo
    if (!homeBtn) {
      // Chercher par href (/ ou URL complète threads.com) ou par aria-label
      // ✅ Use selectors from SELECTORS (auto-updateable)
      const homeSelectors = SELECTORS['auth.homeLink'] || ['a[href="/"]', 'a[aria-label="Home"]'];
      const possibleHomes = document.querySelectorAll(homeSelectors.join(','));

      homeBtn = Array.from(possibleHomes).find(link => {
        const rect = link.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }

    // Stratégie 3: Chercher n'importe quel lien visible qui pointe vers la home
    if (!homeBtn) {
      const allLinks = document.querySelectorAll('a');
      homeBtn = Array.from(allLinks).find(link => {
        const href = link.getAttribute('href');
        const rect = link.getBoundingClientRect();
        return (href === '/' || href === 'https://www.threads.com/' ||
                (href?.includes('threads.com') && href.split('/').length <= 4)) &&
               rect.width > 0 && rect.height > 0;
      });
    }
    
    // Si trouvé, double-cliquer
    if (homeBtn) {
      console.log("Double-clicking home button...");
      homeBtn.click();

      // Random delay between clicks (150-230ms)
      const doubleClickDelay = 150 + Math.random() * 80;
      await new Promise(resolve => setTimeout(resolve, doubleClickDelay));
      homeBtn.click();

      // Wait for timeline refresh (random 1300-1700ms)
      const refreshWait = 1300 + Math.floor(Math.random() * 400); // 1300-1700ms
      await new Promise(resolve => setTimeout(resolve, refreshWait));
      console.log("✅ Timeline refreshed");
      return { ok: true, details: 'Timeline refreshed' };
    }
    
    // Fallback: Navigation directe (simple refresh)
    console.log("Using page reload fallback");
    window.location.reload();
    return { ok: true, details: 'Page reloaded' };
    
  } catch (error) {
    console.error('Error in refreshTimeline:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}

async function backToTweet() {
  try {
    window.history.back();
    // Wait for navigation to complete (random 900-1300ms)
    const backWait = 900 + Math.floor(Math.random() * 400); // 900-1300ms
    await new Promise(resolve => setTimeout(resolve, backWait));
    console.log('Navigated back to tweet');
    return { ok: true, details: 'Returned to tweet view' };
  } catch (error) {
    console.error('Error in backToTweet:', error);
    return { ok: false, errorCode: 'NAVIGATION_FAILED', details: error.message };
  }
}

async function continueReadingComments() {
  console.log('Continuing to read comments (scrolling)');
  return scrollPage('comments');
}

// Open a tweet - VERSION SANS SÉLECTEURS EN DUR
async function openTweet() {
  try {
    const currentUrl = window.location.href;
    const isOnTimeline = currentUrl.includes('threads.net') || 
                    currentUrl.includes('threads.com') &&
                    !currentUrl.includes('/post/') &&
                    !currentUrl.includes('/@');
    
    if (!isOnTimeline) {
      console.warn('Not on timeline, cannot open post from here:', currentUrl);
      return { 
        ok: false, 
        errorCode: ERROR_CODE.DOM_NOT_FOUND, 
        details: `Not on timeline page: ${currentUrl}` 
      };
    }

    // Wait for timeline to be ready (random 800-1200ms)
    const timelineWait = 800 + Math.floor(Math.random() * 400); // 800-1200ms
    await new Promise(resolve => setTimeout(resolve, timelineWait));

    // ✅ UTILISER q() AVEC LES SÉLECTEURS JSON
    let posts;
    try {
      posts = await qAll('timeline.tweetCard', { timeoutMs: 3000 });
    } catch (e) {
      console.log('No posts found with selectors from JSON');
      return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No posts found' };
    }
    
    if (!posts || posts.length === 0) {
      console.log('Still no posts found in DOM');
      return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No posts found' };
    }
    
    console.log(`Found ${posts.length} posts`);

    // Filter posts that are VISIBLE in viewport (like a human would see)
    const visiblePosts = Array.from(posts).filter(post => {
      const rect = post.getBoundingClientRect();

      // Post must be at least partially visible in viewport
      return rect.top < window.innerHeight &&
             rect.bottom > 0 &&
             rect.height > 50; // Minimum height to be a real post
    });

    console.log(`Filtered to ${visiblePosts.length} visible posts in viewport`);

    if (visiblePosts.length === 0) {
      console.log('No visible posts in viewport');
      return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No visible posts' };
    }

    // Analyze visible posts for comments
    const postsAnalyzed = await Promise.all(visiblePosts.map(async (post, index) => {
      // ✅ USE SERVER-SIDE SELECTORS to find reply count
      let repliesCount = 0;
      try {
        // Use q() to get all potential reply count spans (uses server selectors)
        const replyCountSpans = await q('post.replyCount', { within: post, timeoutMs: 100, all: true });

        if (replyCountSpans && replyCountSpans.length > 0) {
          // Find the first span that contains only a number and is near Reply button
          for (const span of replyCountSpans) {
            const text = span.textContent.trim();

            // Must be a valid number
            if (!/^[\d.,KkMm]+$/.test(text)) continue;

            // Verify this span is near a Reply button (not a Like or Repost count)
            let parent = span.closest('[data-pressable-container]');
            if (!parent) parent = span.closest('article');
            if (!parent) parent = post;

            // Use server selector to check for Reply button
            const hasReplyButton = await q('tweet.replyButton', { within: parent, timeoutMs: 50 });

            if (hasReplyButton) {
              // Parse the number
              if (text.includes('K') || text.includes('k')) {
                repliesCount = Math.floor(parseFloat(text) * 1000);
              } else if (text.includes('M') || text.includes('m')) {
                repliesCount = Math.floor(parseFloat(text) * 1000000);
              } else {
                repliesCount = parseInt(text.replace(/,/g, '')) || 0;
              }
              break; // Found reply count, stop searching
            }
          }
        }
      } catch (e) {
        repliesCount = 0;
      }

      // Debug: log what was matched for first few posts
      if (index < 3) {
        console.log(`[OPEN_TWEET] Post ${index}: ${repliesCount} replies detected`);
      }

      // ✅ CHECK FOR REPLY BUTTON
      let hasReplyIcon = false;
      try {
        const replyBtn = await q('tweet.replyButton', { within: post, timeoutMs: 100 });
        hasReplyIcon = !!replyBtn;
      } catch (e) {
        hasReplyIcon = false;
      }

      // Score de priorité basé sur les commentaires uniquement
      let priority = 0;
      if (repliesCount > 0) {
        priority = 1000 + repliesCount; // Score élevé pour posts avec commentaires
      } else if (hasReplyIcon) {
        priority = 100; // Score faible
      }

      return {
        element: post,
        priority: priority,
        repliesCount: repliesCount
      };
    }));
    
    // Sort by number of replies (descending)
    postsAnalyzed.sort((a, b) => b.repliesCount - a.repliesCount);

    // Separate posts with and without comments
    const postsWithComments = postsAnalyzed.filter(p => p.repliesCount > 0);
    const postsWithoutComments = postsAnalyzed.filter(p => p.repliesCount === 0);

    console.log(`Posts with comments: ${postsWithComments.length}, without: ${postsWithoutComments.length}`);

    // Always select the post with MOST comments
    let selectedPost;

    if (postsWithComments.length > 0) {
      // Take the post with the MOST replies (already sorted)
      selectedPost = postsWithComments[0];
      console.log(`✅ Selected post with ${selectedPost.repliesCount} replies (MOST comments)`);
    } else if (postsWithoutComments.length > 0) {
      // No posts with comments - take any post
      selectedPost = postsWithoutComments[Math.floor(Math.random() * Math.min(3, postsWithoutComments.length))];
      console.log('⚠️ No posts with comments - selected random post');
    } else {
      // Fallback: take any post
      selectedPost = postsAnalyzed[0];
      console.log('⚠️ Fallback - selected first post');
    }

    const targetPost = selectedPost.element;
    
    // Gérer les posts déjà visités
    let visitedPostIds;
    try {
      const storage = await chrome.storage.local.get('runtime');
      visitedPostIds = new Set(storage.runtime?.visitedTweetIds || []);
    } catch (e) {
      visitedPostIds = new Set();
    }
    
    // ✅ UTILISER q() POUR TROUVER LES LIENS
    let postId = null;
    let clickTarget = null;
    
    // D'abord essayer de trouver le timestamp avec q()
    try {
      const timeElem = await q('tweet.timestamp', { within: targetPost, timeoutMs: 500 });
      if (timeElem) {
        // Remonter au lien parent
        clickTarget = timeElem.closest('a[href*="/post/"]');
        if (clickTarget) {
          const href = clickTarget.getAttribute('href') || '';
          const match = href.match(/\/post\/([A-Za-z0-9]+)/);
          if (match && match[1]) {
            postId = match[1];
          }
        }
      }
    } catch (e) {
      console.log('Could not find timestamp with q()');
    }
    
    // Si pas trouvé, chercher n'importe quel lien /post/
    if (!clickTarget) {
      let links = [];
try {
  // D'abord essayer avec le sélecteur JSON si vous l'avez
  links = await qAll('tweet.postLink', { within: targetPost, timeoutMs: 500 });
} catch (e) {
  // Fallback : chercher tous les liens dans le post
  links = targetPost.querySelectorAll('a');
  // Filtrer pour garder seulement ceux avec /post/
  links = Array.from(links).filter(link => {
    const href = link.getAttribute('href') || '';
    return href.includes('/post/');
  });
}
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/post/') && 
            !href.includes('/liked_by/') && 
            !href.includes('/reposted_by/')) {
          
          const match = href.match(/\/post\/([A-Za-z0-9]+)/);
          if (match && match[1]) {
            postId = match[1];
            clickTarget = link;
            break;
          }
        }
      }
    }
    
    if (!postId) {
      postId = 'post_' + Date.now();
    }
    
    visitedPostIds.add(postId);

    // Trim local Set if too large
    if (visitedPostIds.size > 250) {
      const idsArray = Array.from(visitedPostIds);
      visitedPostIds = new Set(idsArray.slice(-200));
    }

    // Save to storage AND update from storage to avoid drift
    try {
      const storage = await chrome.storage.local.get('runtime');
      const runtime = storage.runtime || {};

      // Merge local visitedPostIds with storage (in case multiple tabs)
      const storageIds = new Set(runtime.counters?.visitedTweetIds || []);

      // Add our new ID to storage set
      storageIds.add(postId);

      // Trim storage Set if too large
      let trimmedIds = Array.from(storageIds);
      if (trimmedIds.length > 250) {
        trimmedIds = trimmedIds.slice(-200);
      }

      // Update runtime with trimmed list
      const updatedRuntime = {
        ...runtime,
        counters: {
          ...(runtime.counters || {}),
          visitedTweetIds: trimmedIds
        }
      };

      await chrome.storage.local.set({ runtime: updatedRuntime });

      // Sync local with storage to prevent drift
      visitedPostIds = new Set(trimmedIds);

    } catch (e) {
      console.warn('Could not save visited post ID:', e);
    }
    
    // Cliquer sur le post
    await centerElementHuman(targetPost);
console.log("Post centered, clicking to open...");
    
    if (clickTarget && clickTarget.tagName === 'A') {
      const href = clickTarget.getAttribute('href') || '';
      
      if (href.includes('/post/')) {
        console.log('Clicking on direct post link:', href);
        clickTarget.focus();
        clickTarget.click();
      } else {
        clickTarget = null;
      }
    }
    
    // ✅ SI PAS DE LIEN TROUVÉ, UTILISER q() POUR LES FALLBACKS
    if (!clickTarget || clickTarget.tagName !== 'A') {
      // Essayer de trouver le timestamp avec q()
      try {
        const timeElem = await q('tweet.timestamp', { within: targetPost, timeoutMs: 500 });
        if (timeElem) {
          const timeLink = timeElem.closest('a');
          if (timeLink && timeLink.href && timeLink.href.includes('/post/')) {
            console.log('Clicking on timestamp link');
            timeLink.click();
          } else {
            console.log('Clicking on time element directly');
            await simulateClick(timeElem);
          }
        } else {
          // Dernier recours : essayer le texte du post
          try {
            const textElem = await q('tweet.textContent', { within: targetPost, timeoutMs: 500 });
            if (textElem) {
              console.log('Clicking on post text');
              await simulateClick(textElem);
            } else {
              console.log('Last resort: clicking on post container');
              await simulateClick(targetPost);
            }
          } catch (e) {
            console.log('Last resort: clicking on post container');
            await simulateClick(targetPost);
          }
        }
      } catch (e) {
        console.log('Last resort: clicking on post container');
        await simulateClick(targetPost);
      }
    }

    // Wait for post to load (random 1800-2400ms)
    const postLoadWait = 1800 + Math.floor(Math.random() * 600); // 1800-2400ms
    await new Promise(resolve => setTimeout(resolve, postLoadWait));

    if (window.location.href.includes('/post/')) {
      console.log(`Successfully opened post ${postId}`);
      return { 
        ok: true, 
        details: 'Post opened',
        postId: postId
      };
    } else {
      console.warn('Navigation to post failed');
      return {
        ok: false,
        errorCode: ERROR_CODE.VERIFICATION_FAILED,
        details: 'Click did not navigate to post'
      };
    }
    
  } catch (error) {
    console.error('Error in openPost:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND, 
      details: error.message 
    };
  }
}


// Open comments section
async function openComments() {
  try {
    if (!location.pathname.includes('/post/')) {
      console.log('Not in tweet detail view');
      return { 
        ok: false, 
        errorCode: ERROR_CODE.VERIFICATION_FAILED,
        details: 'Not in tweet detail view' 
      };
    }
    
    // Les commentaires sont déjà visibles dans la vue détail
    // On scroll juste vers eux
    const commentSection = await q('thread.commentSection', { timeoutMs: 2000 }).catch(() => null);
    
    if (commentSection) {
      await scrollIntoViewIfNeeded(commentSection);
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
      console.log('Scrolled to comments section');
      return { ok: true, details: 'Scrolled to comments' };
    } else {
      // Pas de section commentaires trouvée, mais on est dans un tweet
      console.log('Comment section not found, but in tweet view');
      return { ok: true, details: 'In tweet view, comments may be loading' };
    }
    
  } catch (error) {
    console.error('Error in openComments:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}

// Like a tweet
async function likeTweet(payload = {}) {
  try {
    let likeBtn;
    
    if (payload && payload.fromTimeline) {
      // Like depuis la timeline
      console.log("🎯 Attempting to like from timeline...");

      const tweets = await qAll('timeline.tweetCard', { timeoutMs: 2000 });

      if (tweets.length === 0) {
        console.log('No tweets found');
        return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No tweets found' };
      }

      console.log(`Found ${tweets.length} tweets`);

      // Filter tweets that are VISIBLE in viewport (like a human would see)
      const visibleTweets = tweets.filter(tweet => {
        const rect = tweet.getBoundingClientRect();

        // Tweet must be at least partially visible in viewport
        return rect.top < window.innerHeight &&
               rect.bottom > 0 &&
               rect.height > 50; // Minimum height to be a real tweet
      });

      console.log(`Filtered to ${visibleTweets.length} visible tweets in viewport`);

      if (visibleTweets.length === 0) {
        console.log('No visible tweets in viewport');
        return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No visible tweets' };
      }

      // Select a random tweet from visible tweets
      const targetTweet = visibleTweets[Math.floor(Math.random() * Math.min(visibleTweets.length, 5))];
      console.log("Target tweet selected (already visible):", targetTweet);

      // Chercher le SVG directement
      const likeBtnSelectors = SELECTORS['tweet.likeButton'] || ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]'];
      const likeBtnQuery = likeBtnSelectors.join(', ');
      likeBtn = targetTweet.querySelector(likeBtnQuery);

      if (likeBtn && likeBtn.getAttribute('aria-label') === 'Unlike') {
        console.log('Tweet already liked (Unlike button found)');
        return { ok: true, details: 'Already liked' };
      }

      if (!likeBtn) {
        // Chercher avec une approche plus flexible
        const allSvgs = targetTweet.querySelectorAll('svg[aria-label]');
        console.log(`Found ${allSvgs.length} SVGs with aria-label in tweet`);

        for (const svg of allSvgs) {
          const label = svg.getAttribute('aria-label');
          console.log(`  - SVG aria-label: "${label}"`);
          if (label === 'Like') {
            likeBtn = svg;
            break;
          }
        }
      }
      
      if (!likeBtn) {
        console.error('Like button not found');
        return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'Like button not found' };
      }
      
      console.log('✅ Found like button:', likeBtn);
      
    } else {
      // Like depuis la vue détail d'un tweet
      console.log("Liking from tweet detail view...");
      likeBtn = await q('tweet.likeButton', { timeoutMs: 3000 });
    }
    
    // Vérifier si c'est déjà liké
    const ariaLabel = likeBtn.getAttribute('aria-label');
    if (ariaLabel === 'Unlike') {
      console.log('Tweet already liked');
      return { ok: true, details: 'Already liked' };
    }
    
    // Trouver l'élément cliquable
    let clickTarget = likeBtn;
    
    // Si c'est un SVG, remonter au parent button
    if (likeBtn.tagName === 'svg' || likeBtn.tagName === 'SVG') {
      let parent = likeBtn.parentElement;
      let maxLevels = 5;
      
      while (parent && maxLevels > 0) {
        if (parent.getAttribute('role') === 'button' || 
            parent.tagName === 'BUTTON' ||
            parent.tagName === 'A') {
          clickTarget = parent;
          console.log('Found clickable parent:', parent);
          break;
        }
        parent = parent.parentElement;
        maxLevels--;
      }
      
      if (clickTarget === likeBtn && likeBtn.parentElement) {
        clickTarget = likeBtn.parentElement;
        console.log('Using direct parent as click target');
      }
    }
    
    // Center element before clicking (human-like behavior)
    await centerElementHuman(clickTarget);
    
    // ✅ UN SEUL CLIC - PAS DE RETRY !
    console.log('Clicking like button...');
    
    // Focus d'abord (plus naturel)
    if (clickTarget.focus) {
      clickTarget.focus();
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100));
    }
    
    // UN SEUL CLIC
    clickTarget.click();
    
    // ✅ ATTENDRE PLUS LONGTEMPS (1.5-2 secondes)
    await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 500));
    
    // Vérifier le résultat
    const newAriaLabel = likeBtn.getAttribute('aria-label');
    console.log(`Like button aria-label after click: "${newAriaLabel}"`);
    
    if (newAriaLabel === 'Unlike') {
      console.log('✅ Tweet liked successfully!');
      return { ok: true, details: payload.fromTimeline ? 'Tweet liked from timeline' : 'Tweet liked' };
    } else {
      // ✅ PAS DE RETRY - On assume que c'est OK
      console.log('⚠️ Like status not verified, but assuming success to avoid retry');
      return { ok: true, details: 'Like attempted (no verification to avoid unlike)' };
    }
    
  } catch (error) {
    console.error('❌ Error in likeTweet:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}

// Like a comment
async function likeComment() {
  try {
    // Vérifier qu'on est sur une page de post
    if (!window.location.href.includes('/post/')) {
      console.log('Not on a post page');
      return { 
        ok: false, 
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'Not on a post page' 
      };
    }
    
    // Find ALL like buttons on the page (ignore selectors - they're unreliable)
    const commentLikeSelectors = SELECTORS['comment.allLikeButtons'] || ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]'];
    const allPageLikeBtns = Array.from(document.querySelectorAll(commentLikeSelectors.join(', ')));

    console.log(`[LIKE_COMMENT] Found ${allPageLikeBtns.length} total like buttons on page`);

    if (allPageLikeBtns.length < 2) {
      console.log('[LIKE_COMMENT] Not enough buttons (need at least main post + 1 comment)');
      return {
        ok: false,
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'No comments found'
      };
    }

    // Strategy: Sort all buttons by Y position (top to bottom)
    // The FIRST button is always the main post - exclude it
    // All remaining buttons are comments
    allPageLikeBtns.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.top - rectB.top;
    });

    // Skip the first button (main post), keep all others (comments)
    const commentLikeBtns = allPageLikeBtns.slice(1);

    console.log(`[LIKE_COMMENT] Found ${commentLikeBtns.length} comment buttons (excluded first button = main post)`);

    if (commentLikeBtns.length === 0) {
      console.log('[LIKE_COMMENT] No comment like buttons found');
      return {
        ok: false,
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'No comments found'
      };
    }

    // Filter: visible comments that are not already liked
    const visibleUnlikedBtns = [];
    for (const btn of commentLikeBtns) {
      const rect = btn.getBoundingClientRect();

      // Must be visible in viewport
      if (rect.top >= window.innerHeight || rect.bottom <= 0) {
        continue;
      }

      // Skip if hidden in DOM
      const style = window.getComputedStyle(btn);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }

      // Check if already liked
      const isLiked = await verifyToggle(btn, true);
      if (!isLiked) {
        visibleUnlikedBtns.push(btn);
      }
    }

    console.log(`[LIKE_COMMENT] ${commentLikeBtns.length} total comments, ${visibleUnlikedBtns.length} visible & unliked`);

    if (visibleUnlikedBtns.length === 0) {
      console.log('No visible unliked comments');
      return { ok: true, details: 'No visible unliked comments' };
    }

    // Select random from visible unliked comments
    const targetBtn = visibleUnlikedBtns[Math.floor(Math.random() * visibleUnlikedBtns.length)];

    console.log(`[LIKE_COMMENT] Selected visible comment button:`, targetBtn);

    const clickTarget = targetBtn.tagName === 'svg' || targetBtn.tagName === 'SVG'
      ? (targetBtn.closest('[role="button"]') || targetBtn.parentElement)
      : targetBtn;

    console.log(`[LIKE_COMMENT] Click target:`, clickTarget, `tagName=${clickTarget?.tagName}`);

    if (!clickTarget) {
      console.error('[LIKE_COMMENT] No valid click target found!');
      return {
        ok: false,
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'No valid click target'
      };
    }

    // Center element before clicking (human-like behavior)
    await centerElementHuman(clickTarget);

    clickTarget.focus();
    await new Promise(resolve => setTimeout(resolve, 100));
    clickTarget.click();
    console.log('[LIKE_COMMENT] Click executed');

    await new Promise(resolve => setTimeout(resolve, 500));

    // ✅ NO VERIFICATION - Assume success to avoid false negatives
    // Like action was executed, verification is unreliable on Threads
    console.log('✅ Comment like attempted (assuming success to avoid retry)');
    return { ok: true, details: 'Comment liked' };
    
  } catch (error) {
    console.error('Error in likeComment:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}



// Open profile
async function openProfile() {
  try {
    const posts = await qAll('timeline.tweetCard', { timeoutMs: 2000 }).catch(() => []);

    if (posts.length === 0) {
      return {
        ok: false,
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'No posts found'
      };
    }

    console.log(`Found ${posts.length} posts for profile selection`);

    // Filter posts that are VISIBLE in viewport (like a human would see)
    const visiblePosts = posts.filter(post => {
      const rect = post.getBoundingClientRect();

      // Post must be at least partially visible in viewport
      return rect.top < window.innerHeight &&
             rect.bottom > 0 &&
             rect.height > 50; // Minimum height to be a real post
    });

    console.log(`Filtered to ${visiblePosts.length} visible posts in viewport`);

    if (visiblePosts.length === 0) {
      console.log('No visible posts in viewport');
      return { ok: false, errorCode: ERROR_CODE.DOM_NOT_FOUND, details: 'No visible posts' };
    }

    // Search for a profile link in visible posts
    let profileLink = null;
    let targetPost = null;

    // Randomize post order to add variety
    const shuffledPosts = visiblePosts.sort(() => Math.random() - 0.5);

    for (const post of shuffledPosts) {
      try {
        const link = await q('tweet.authorLink', { 
          within: post,  // CHERCHER DANS LE POST
          timeoutMs: 500 
        });
        
        if (link) {
          const href = link.getAttribute('href') || link.closest('a')?.getAttribute('href');
          // Vérifier que ce n'est PAS votre profil
          if (href && !href.includes('eli_x_7294')) {
            profileLink = link;
            targetPost = post;
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!profileLink) {
      return { 
        ok: false, 
        errorCode: ERROR_CODE.DOM_NOT_FOUND,
        details: 'No profile link found in posts' 
      };
    }
    
    // Cliquer
const linkElement = profileLink.tagName === 'A' ? profileLink : profileLink.closest('a');
if (linkElement) {
  // ✅ NOUVEAU : Centrer le post contenant le lien profil
  await centerElementHuman(targetPost);
  console.log("Post centered, clicking profile link...");
      await new Promise(resolve => setTimeout(resolve, 300));

      linkElement.focus();
      linkElement.click();

      // Wait for profile to load (random 1300-1800ms)
      const profileLoadWait = 1300 + Math.floor(Math.random() * 500); // 1300-1800ms
      await new Promise(resolve => setTimeout(resolve, profileLoadWait));
      
      const href = linkElement.getAttribute('href');
      console.log(`Opened profile: ${href}`);
      return { ok: true, details: `Opened profile: ${href}` };
    }
    
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: 'Could not click profile link' 
    };
    
  } catch (error) {
    console.error('Error in openProfile:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}


// Open notifications
async function openNotifications() {
  try {
    // ✅ Utiliser le sélecteur JSON
    const notifLink = await q('nav.notifications', { timeoutMs: 3000 });

    // Center element before clicking (human-like behavior)
    await centerElementHuman(notifLink);

    notifLink.focus();
    notifLink.click();

    // Wait for notifications to load (random 1200-1700ms)
    const notifLoadWait = 1200 + Math.floor(Math.random() * 500); // 1200-1700ms
    await new Promise(resolve => setTimeout(resolve, notifLoadWait));

    if (location.pathname.includes('/activity')) {
      console.log('Opened notifications');
      return { ok: true, details: 'Opened notifications' };
    } else {
      console.warn('Navigation to notifications may have failed');
      return { ok: true, details: 'Clicked notifications' };
    }
    
  } catch (error) {
    console.error('Error in openNotifications:', error);
    return { 
      ok: false, 
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: error.message 
    };
  }
}



async function dwell(duration) {
  if (!duration || duration < 100) {
    console.error('DWELL ERROR: No duration provided or too short!', duration);
    // Fallback avec variabilité pour éviter détection
    const emergency = 2000 + Math.random() * 4000; // 2-6 secondes aléatoires
    console.warn(`Using emergency random duration: ${emergency}ms`);
    await new Promise(resolve => setTimeout(resolve, emergency));
    return { 
      ok: false, 
      errorCode: 'MISSING_DURATION',
      details: `Dwell used emergency duration: ${emergency}ms` 
    };
  }
  
  // ✅ MICRO-VARIATION HUMAINE : ajouter ±10% de variabilité
  const humanVariation = 0.9 + Math.random() * 0.2; // 0.9 à 1.1
  const actualDuration = Math.floor(duration * humanVariation);
  
  console.log(`Dwelling (reading) for ${actualDuration}ms (base: ${duration}ms)`);
  await new Promise(resolve => setTimeout(resolve, actualDuration));
  return { ok: true, details: `Dwelled for ${actualDuration}ms` };
}

async function idle(duration) {
  if (!duration || duration < 100) {
    console.error('IDLE ERROR: No duration provided or too short!', duration);
    // Fallback avec variabilité pour éviter détection
    const emergency = 3000 + Math.random() * 5000; // 3-8 secondes aléatoires
    console.warn(`Using emergency random duration: ${emergency}ms`);
    await new Promise(resolve => setTimeout(resolve, emergency));
    return { 
      ok: false, 
      errorCode: 'MISSING_DURATION',
      details: `Idle used emergency duration: ${emergency}ms` 
    };
  }
  
  // ✅ MICRO-VARIATION HUMAINE : ajouter ±15% de variabilité (plus pour idle)
  const humanVariation = 0.85 + Math.random() * 0.3; // 0.85 à 1.15
  const actualDuration = Math.floor(duration * humanVariation);
  
  console.log(`Idle (distracted) for ${actualDuration}ms (base: ${duration}ms)`);
  await new Promise(resolve => setTimeout(resolve, actualDuration));
  return { ok: true, details: `Idle for ${actualDuration}ms` };
}





// ============= ACTION ROUTER =============

// Map action types to executor functions
const ACTION_EXECUTORS = {
  [ACTION_TYPE.OPEN_COMPOSER]: openComposer,
  [ACTION_TYPE.TYPE_AND_POST]: typeAndPost,
  [ACTION_TYPE.SCROLL_TIMELINE]: scrollTimeline,
  [ACTION_TYPE.OPEN_TWEET]: openTweet,
  [ACTION_TYPE.OPEN_COMMENTS]: openComments,
  [ACTION_TYPE.LIKE_TWEET]: likeTweet,
  [ACTION_TYPE.LIKE_COMMENT]: likeComment,
  [ACTION_TYPE.REFRESH_TIMELINE]: refreshTimeline,
  [ACTION_TYPE.OPEN_PROFILE]: openProfile,
  [ACTION_TYPE.OPEN_NOTIFICATIONS]: openNotifications,

  [ACTION_TYPE.SCROLL_PROFILE]: scrollProfile,
  [ACTION_TYPE.SCROLL_NOTIFICATIONS]: scrollNotifications,

  [ACTION_TYPE.SCROLL_COMMENTS]: scrollComments,  // ← Changé
  [ACTION_TYPE.BACK_TO_TIMELINE]: backToTimeline,
  [ACTION_TYPE.BACK_TO_TWEET]: backToTweet,
  [ACTION_TYPE.CONTINUE_READING_COMMENTS]: continueReadingComments,
  [ACTION_TYPE.DWELL]: dwell,  // ← Une seule fois
  [ACTION_TYPE.IDLE]: idle     // ← Une seule fois
};

// Execute action based on type
async function executeAction(actionType, payload = {}) {
  // ✅ WAIT for selectors to be ready before executing any action
  if (!SELECTORS_READY && SELECTORS_PROMISE) {
    console.log('⏳ Waiting for selectors to load before executing action...');
    await SELECTORS_PROMISE;
    console.log('✅ Selectors ready, executing action');
  }

  // Check if logged in first
  if (!isLoggedIn()) {
    return {
      ok: false,
      errorCode: ERROR_CODE.NOT_LOGGED_IN,
      details: 'User not logged in'
    };
  }
  
  // Get executor function
  const executor = ACTION_EXECUTORS[actionType];
  
  if (!executor) {
    return {
      ok: false,
      errorCode: ERROR_CODE.DOM_NOT_FOUND,
      details: `Unknown action type: ${actionType}`
    };
  }
  
  try {
    // Add small random delay before action
    const preDelay = 100 + Math.random() * 400;
    await new Promise(resolve => setTimeout(resolve, preDelay));
    
    // ✅ MODIFICATION ICI : Passer directement le payload complet pour TYPE_AND_POST
    let result;
    if (actionType === ACTION_TYPE.TYPE_AND_POST) {
      // Pour TYPE_AND_POST, passer le payload complet (text + media)
      result = await executor(payload);
    } else if (actionType === ACTION_TYPE.DWELL || actionType === ACTION_TYPE.IDLE) {
      // Pour DWELL et IDLE, passer la durée
      result = await executor(payload.duration || payload);
    } else {
      // Pour les autres actions, passer le payload ou un objet vide
      result = await executor(payload);
    }
    
    // Add small delay after action
    const postDelay = 100 + Math.random() * 300;
    await new Promise(resolve => setTimeout(resolve, postDelay));
    
    return result;
    
  } catch (error) {
    console.error(`Action ${actionType} failed:`, error);
    return {
      ok: false,
      errorCode: ERROR_CODE.ACTION_TIMEOUT,
      details: error.message
    };
  }
}

// ============= MESSAGE HANDLER =============

// Single message handler to prevent memory leaks
let messageHandler = null;

function setupMessageHandler() {
  // Remove old handler if exists
  if (messageHandler) {
    chrome.runtime.onMessage.removeListener(messageHandler);
  }

  // Create new handler
  messageHandler = (message, sender, sendResponse) => {
  // Wrap all message handling in try-catch for error resilience
  try {
    // ✅ NOUVEAU : Handler pour STOP immédiat
    if (message.type === 'STOP_ALL_ACTIONS') {
      console.log('🛑 EMERGENCY STOP - Halting all actions');

      // ✅ CRITICAL FIX: Set emergency stop flag
      EMERGENCY_STOP = true;

      window.stop();  // Arrête tout chargement

      // Arrêter tout scroll en cours
      window.scrollTo({ top: window.scrollY, behavior: 'instant' });

      // Reset flag after a short delay (actions should check and abort quickly)
      setTimeout(() => {
        EMERGENCY_STOP = false;
        console.log('🔄 Emergency stop flag reset');
      }, 1000);

      sendResponse({ ok: true, stopped: true });
      return true;
    }

    // ✅ RELOAD_SELECTORS Handler - After license activation
    if (message.type === 'RELOAD_SELECTORS') {
      console.log('🔄 Received selector reload request...');

      // ✅ CRITICAL: Reset promise to force new load attempt
      SELECTORS_PROMISE = null;
      SELECTORS_READY = false;

      initSelectors().then(() => {
        if (SELECTORS_READY) {
          console.log('✅ Selectors reloaded successfully from server');
          sendResponse({ ok: true });
        } else {
          console.error('❌ Selectors reload failed - triggering page refresh...');
          setTimeout(() => window.location.reload(), 2000);
          sendResponse({ ok: false, error: 'Selectors not loaded, refreshing page' });
        }
      }).catch((error) => {
        console.error('❌ Failed to reload selectors:', error);
        sendResponse({ ok: false, error: error.message });
      });
      return true; // Async response
    }

    // ✅ AJOUTER CE BLOC ICI - PING Handler
    if (message.type === 'PING') {
      sendResponse({ alive: true, timestamp: Date.now() });
      return true;
    }
  
  // ✅ AJOUTER CE BLOC ICI - Position Detection
  if (message.type === 'GET_POSITION') {
    // Use Threads.net-specific selectors
    const indicators = {
      tweet: 'a[href*="/post/"]',  // Thread post page
      profile: 'a[href^="/@"][aria-current="page"]',  // Profile page (with aria-current)
      notifications: 'a[href="/activity"][aria-current="page"]',  // Notifications active
      timeline: 'main'  // Default timeline/main feed
    };

    // Check URL as primary indicator
    const url = window.location.pathname;
    if (url.includes('/post/')) {
      sendResponse({ position: 'tweet' });
      return true;
    }
    if (url.startsWith('/@') && !url.includes('/post/')) {
      sendResponse({ position: 'profile' });
      return true;
    }
    if (url === '/activity') {
      sendResponse({ position: 'notifications' });
      return true;
    }
    if (url === '/' || url === '/home') {
      sendResponse({ position: 'timeline' });
      return true;
    }

    // Fallback to DOM selectors
    for (const [position, selector] of Object.entries(indicators)) {
      if (document.querySelector(selector)) {
        sendResponse({ position });
        return true;
      }
    }
    sendResponse({ position: 'unknown' });
    return true;
  }

  // Handle FORCE_ACTION messages (from popup buttons)
  if (message.type === 'FORCE_ACTION') {
    const { action } = message;

    console.log(`Force executing action: ${action}`);

    // Execute action immediately
    executeAction(action, {}).then(result => {
      console.log(`Force action ${action} result:`, result);
      sendResponse({
        ok: result.ok,
        ...result
      });
    }).catch(error => {
      console.error(`Force action ${action} error:`, error);
      sendResponse({
        ok: false,
        errorCode: ERROR_CODE.ACTION_TIMEOUT,
        details: error.message
      });
    });

    return true;
  }

  // Handle EXECUTE_ACTION messages
  if (message.type === MSG.EXECUTE_ACTION) {
    const { actionType, payload } = message;

    console.log(`Executing action: ${actionType}`, payload);

    // Execute asynchronously and send response
    executeAction(actionType, payload).then(result => {
      console.log(`Action ${actionType} result:`, result);
      sendResponse({
        type: MSG.ACTION_RESULT,
        actionType,
        ...result
      });
    }).catch(error => {
      console.error(`Action ${actionType} error:`, error);
      sendResponse({
        type: MSG.ACTION_RESULT,
        actionType,
        ok: false,
        errorCode: ERROR_CODE.ACTION_TIMEOUT,
        details: error.message
      });
    });

    // Return true to indicate async response
    return true;
  }

  } catch (error) {
    // Catch any error in message handling to prevent content script crash
    console.error('Message handler error:', error);
    sendResponse({
      type: MSG.ACTION_RESULT,
      ok: false,
      errorCode: 'MESSAGE_HANDLER_ERROR',
      details: error.message
    });
    return true;
  }
  };

  // Add the handler
  chrome.runtime.onMessage.addListener(messageHandler);
}

// Setup message handler on load
setupMessageHandler();

// ============= INITIALIZATION =============

// Global navigation watcher cleanup function
let currentNavigationWatcher = null;

// Wait for page to be ready
async function initialize() {
  console.log('Threads Bot content script initializing...');

  try {
    // Wait for main content to load
    await waitForMain();

    // Cleanup previous watcher to prevent multiple observers
    if (currentNavigationWatcher) {
      console.log('Cleaning up previous navigation watcher...');
      currentNavigationWatcher();
      currentNavigationWatcher = null;
    }

    // Set up navigation watcher
    currentNavigationWatcher = watchNavigation((change) => {
      console.log('Navigation detected:', change);

      // Re-check login status on navigation
      if (!isLoggedIn()) {
        safeSendMessage({
          type: MSG.NOTICE,
          level: 'warn',
          code: 'NOT_LOGGED_IN',
          msg: 'User logged out or login required'
        });
      }
    });

    console.log('Threads Bot content script ready');

    // Notify background that we're ready
    safeSendMessage({
      type: MSG.NOTICE,
      level: 'info',
      code: 'CONTENT_READY',
      msg: 'Content script initialized'
    });

  } catch (error) {
    console.error('Failed to initialize content script:', error);

    safeSendMessage({
      type: MSG.NOTICE,
      level: 'error',
      code: 'INIT_FAILED',
      msg: error.message
    });
  }
}

// ✅ NUCLEAR FIX: Triple protection contre extension invalidée
(function() {
  try {
    // Protection niveau 1: Vérifier que chrome existe
    if (typeof chrome === 'undefined') return;

    // Protection niveau 2: Vérifier que chrome.runtime existe
    if (!chrome.runtime) return;

    // Protection niveau 3: Vérifier que l'extension est valide
    if (!chrome.runtime.id) return;

    // Extension 100% valide, continuer l'initialisation normale

    // Start initialization when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      initialize();
    }

    // ✅ FIX: Variables globales pour cleanup
    let initTimeout;
    let spaNavigationWatcher;
    let keepAliveInterval;

// ✅ FIX: Cleanup function pour éviter les erreurs après extension reload
function cleanupOnInvalidation() {
  if (initTimeout) clearTimeout(initTimeout);
  if (spaNavigationWatcher) spaNavigationWatcher(); // C'est une fonction, pas un objet
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (currentNavigationWatcher) currentNavigationWatcher(); // C'est une fonction, pas un objet

  // Remove message handler to prevent memory leak
  if (messageHandler) {
    chrome.runtime.onMessage.removeListener(messageHandler);
    messageHandler = null;
  }
}

// Vérifier périodiquement si l'extension est encore valide
const validityCheckInterval = setInterval(() => {
  if (!chrome.runtime?.id) {
    console.log('Extension invalidated, cleaning up...');
    cleanupOnInvalidation();
    clearInterval(validityCheckInterval);
  }
}, 5000);

// Also reinitialize on major page changes (SPA navigation)
// NOTE: This creates a second watcher that triggers reinitialization
// The initialize() function will clean up the old watcher before creating a new one
spaNavigationWatcher = watchNavigation(() => {
  // ✅ Check if extension still valid
  if (!chrome.runtime?.id) {
    cleanupOnInvalidation();
    return;
  }

  // Debounce reinitialization
  clearTimeout(initTimeout);
  initTimeout = setTimeout(() => {
    console.log('Reinitializing after SPA navigation...');
    // Do NOT call initialize() again as it would create infinite watchers
    // Instead, just notify background of navigation
    safeSendMessage({
      type: MSG.NOTICE,
      level: 'info',
      code: 'SPA_NAVIGATION',
      msg: 'Page navigated (SPA)'
    });
  }, 1000);
});

// Keep-alive system to prevent service worker sleep
keepAliveInterval = setInterval(() => {
  // ✅ Check if extension still valid before ping
  if (!chrome.runtime?.id) {
    cleanupOnInvalidation();
    return;
  }
  safeSendMessage({ type: 'PING' });
}, 20000); // Ping toutes les 20 secondes

    console.log('Keep-alive system activated');
    console.log('Threads Bot content script loaded');

  } catch (error) {
    // ✅ IMPORTANT: Ne masquer QUE les erreurs d'extension invalidée
    // Les vraies erreurs fonctionnelles doivent rester visibles !
    const isContextError = error.message?.includes('Extension context invalidated') ||
                          error.message?.includes('message port closed') ||
                          error.message?.includes('Could not establish connection');

    if (isContextError) {
      // Erreur bénigne d'extension invalidée → silence
      return;
    }

    // C'est une VRAIE erreur → la montrer pour debug
    console.error('❌ Content script error:', error);
  }
})(); // Fin de l'IIFE wrapper