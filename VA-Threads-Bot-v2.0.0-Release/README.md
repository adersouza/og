# V/A Threads Bot v2.0.0

Chrome MV3 extension for automated posting and human-like activity simulation on Threads.net.

**Status:** ✅ Production Ready
**Last Updated:** 2025-10-08

---

## 📚 Documentation

### **Essential Guides:**

1. **[DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md)** ⭐ **START HERE**
   - Complete deployment procedures
   - Configuration management (defaults vs selectors)
   - Cloud Functions deployment
   - Extension distribution workflow

2. **[CLAUDE.md](CLAUDE.md)** - Technical Documentation
   - Architecture overview (3-layer structure)
   - Storage schema
   - Message contracts
   - Code guidelines for AI assistants

3. **[INSTALLATION_GUIDE.txt](../INSTALLATION_GUIDE.txt)** - End User Guide
   - Step-by-step installation
   - License activation
   - Features overview

### **Audit & Reports:**

4. **[DOCUMENTATION_AUDIT_FINAL.md](../DOCUMENTATION_AUDIT_FINAL.md)** - Documentation Audit
   - Complete audit report (2025-10-08)
   - 10 errors found and corrected
   - Verification of code vs documentation

### **Old Documentation:**

5. **[old_docs/](old_docs/)** - Archived Documentation
   - Pre-v2.0.0 documentation (HMAC era)
   - Security audits (October 2025)
   - Migration guides
   - Historical context

---

## 🏗️ Architecture

**3-Layer Chrome Extension:**

```
┌─────────────────────────────────────────────────┐
│              CLIENT (Extension)                 │
│                                                 │
│  Background.js ──▶ Client-Executor ──▶ Content │
│  (Orchestrator)    (Engines + FSM)    (DOM ops)│
└───────────────────────┬─────────────────────────┘
                        │
                        ▼
          ┌─────────────────────────┐
          │   FIREBASE (Server)     │
          │                         │
          │  • 15 Cloud Functions   │
          │  • Firestore Database   │
          │  • License Management   │
          └─────────────────────────┘
```

**Key Components:**

1. **Background Service Worker** ([background.js](background.js)) - 1,296 lines
   - Central orchestrator
   - Classes: StorageService, Logger, AlarmManager, ActionCoordinator, MediaManager, LicenseManager

2. **Client Executor** ([client-executor.js](client-executor.js)) - 2,036 lines
   - AutoPost Engine (server-controlled)
   - Activity Engine (hybrid: server plan + client FSM)
   - Classes: AutoPostEngine, ActivityEngine, RefractoryRegistry, SessionState

3. **Content Script** ([content.js](content.js)) - 3,006 lines
   - 19 action executors
   - DOM manipulation
   - Human behavior simulation (scroll, click, type)

---

## 🔑 Key Features

### **AutoPost Engine**
- Server-controlled automatic posting
- Media support (images/videos via IndexedDB)
- Configurable intervals with randomization
- Timezone-aware pause windows

### **Activity Engine (FSM)**
- Human-like behavior simulation
- 4 positions: timeline, tweet, profile, notifications
- 14 action types: scroll, like, open, dwell, etc.
- Refractory periods (anti-spam)
- Session limits

### **Security & License**
- Session token authentication (SHA-256, 1h expiration)
- Heartbeat monitoring (2min interval)
- Date-based license validation
- Network retry mechanism (3x with backoff)

---

## ⚙️ Configuration System

### **Auto-Update (Server-Side):**
✅ **CSS Selectors** - Auto-update via `getSelectors` endpoint (cache 1h)
✅ **License Info** - Synced via heartbeat (expiresAt, username, plan)
✅ **Version Check** - Force updates for critical fixes

### **Local (Requires Distribution):**
⚠️ **Defaults** (timings, probabilities) - Embedded in extension at `/config/defaults.json`
⚠️ **JavaScript Code** - All .js files embedded
⚠️ **Manifest** - Permissions and version

**Important:** Only CSS selectors auto-update! To change defaults or code, you must distribute a new extension version.

---

## 🚀 Quick Start

### **Development:**
```bash
# 1. Load extension in Chrome
# chrome://extensions/ > Developer mode ON > Load unpacked

# 2. Select folder: "Ultim Threads bot"

# 3. Test with environment switching
npm run env:local    # Use Firebase emulators
npm run env:staging  # Use staging project
npm run env:prod     # Use production
```

### **Testing:**
```bash
# Start emulators
cd firebase
firebase emulators:start

# Seed test data
node seed-test-data.js --local

# Test licenses:
# - TEST-ACTIVE-001 (active)
# - TEST-EXPIRED-001 (expired)
```

### **Deployment:**
```bash
# Deploy Cloud Functions
cd firebase
firebase deploy --only functions

# Create client package
cd ..
python create-zip-python.py
# → VA-Threads-Bot-v2.0.0-Release.zip

# Distribute to users
```

---

## 📦 Project Structure

```
Ultim Threads bot/
├── manifest.json              # Extension manifest
├── background.js              # Service worker
├── client-executor.js         # Engines (AutoPost + Activity)
├── content.js                 # Content script
├── firebase-config.js         # API endpoints
├── license-manager.js         # License & sessions
├── extension-config.js        # Extension config
│
├── config/
│   ├── defaults.json          # Default settings (LOCAL)
│   └── selectors.json         # CSS selectors (SERVER)
│
├── popup/                     # Extension UI
│   ├── popup.html
│   ├── popup.js (2,311 lines)
│   └── popup.css
│
├── assets/                    # Icons & media
│
├── firebase/
│   ├── functions/
│   │   └── index.js           # 15 Cloud Functions
│   ├── upload-selectors.js    # Upload selectors (auto-update)
│   ├── set-version.js         # Force version update
│   ├── seed-test-data.js      # Test data seeding
│   └── firebase.json
│
├── admin-dashboard/           # License management
│   ├── server.js              # Express server
│   └── public/                # Dashboard UI
│
├── old_docs/                  # Archived documentation
│
└── CLAUDE.md                  # Technical documentation
```

---

## 📊 Firebase Cloud Functions (15 Endpoints)

### **License Management:**
- `verifyLicense` (297) - Verify license + heartbeat
- `activateLicense` (495) - Activate license
- `renewSession` (897) - Renew session token
- `getLicenseAnalytics` (649) - Analytics (admin)
- `revokeLicense` (819) - Revoke license (admin)
- `generateLicense` (1346) - Generate license (admin)

### **AutoPost & Activity:**
- `getNextAutoPostAction` (985) - Server-controlled posting
- `createDailyActivityPlan` (1051) - Daily activity plan
- `getNextActivityAction` (1101) - Next activity action
- `getBehaviorProfile` (1151) - Behavior profile
- `getActivitySessionStatus` (1224) - Session status

### **Configuration:**
- `validateSettings` (1276) - Validate settings
- `getSelectors` (1475) - CSS selectors ⭐ AUTO-UPDATE
- `getBehaviorConfig` (1523) - Behavior config (not used)
- `checkVersion` (1570) - Version check

---

## 🔧 NPM Scripts

```bash
# Environment switching
npm run env:local      # Switch to local emulators
npm run env:staging    # Switch to staging
npm run env:prod       # Switch to production

# Firebase
npm run emulators      # Start Firebase emulators
npm run deploy:staging         # Deploy to staging
npm run deploy:staging:functions
npm run deploy:prod            # Deploy to production
npm run deploy:prod:functions

# Logs
npm run logs:staging   # View staging logs
npm run logs:prod      # View production logs
```

---

## 🔐 Security Features

- ✅ **Session Tokens:** SHA-256 hashed, 1h expiration, auto-renew
- ✅ **License Validation:** Date-based (only 'revoked' + expired date block access)
- ✅ **Heartbeat:** 2min interval, stops bot on 401/403, continues on network errors
- ✅ **Network Retry:** 3x with exponential backoff (2s, 5s, 10s)
- ✅ **Rate Limiting:** 50 requests/min per session
- ✅ **CORS Protection:** Only extension can access functions
- ✅ **Firestore Rules:** Users can only read own license

---

## 📝 Version History

### **v2.0.0 (Current - 2025-10-08)**
- ✅ Session token authentication (HMAC removed)
- ✅ CSS selectors auto-update system
- ✅ Heartbeat with license info sync
- ✅ Revoke/Reactivate license functionality
- ✅ Network retry mechanism (3x with backoff)
- ✅ Improved timing (0.5-4s between actions)
- ✅ Smart license validation (date-based)
- ✅ Auto-reactivation (if date still valid)
- ✅ Documentation fully audited and corrected

---

## 🆘 Troubleshooting

### **Common Issues:**

**"Session token invalid"**
→ Check `renewSession` endpoint, verify token not expired

**"License expired" but date OK**
→ Check status vs date logic (only 'revoked' + date block)

**"Config changes not applied"**
→ Defaults require new version distribution, only selectors auto-update

**"Heartbeat HTTP 400"**
→ Verify endpoint accepts `action: 'heartbeat'` with session token

**"Network errors repeated"**
→ Check proxy/firewall, verify `fetchWithRetry` mechanism

---

## 📞 Support

For issues or questions:
1. Check **[DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md)** for procedures
2. Check **[CLAUDE.md](CLAUDE.md)** for technical details
3. Check **[old_docs/](old_docs/)** for historical context
4. Review Firebase logs: `firebase functions:log`

---

## 📄 License

Proprietary - All rights reserved

---

**Built with ❤️ using Chrome MV3 + Firebase + Session Tokens**
