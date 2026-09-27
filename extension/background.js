/**
 * Arena2API - Background Service Worker
 * 
 * Manages the token pool and cookies, and periodically pushes them to the local proxy server.
 */
(function() {
  'use strict';

  var TAG = '[Arena2API]';

  // ========== State ==========
  var state = {
    proxyUrl: 'http://127.0.0.1:9090',
    connected: false,
    lastError: '',
    lastPush: 0,

    // tokens
    v3Tokens: [],   // [{token, action, ts}]
    v2Token: null,

    // cookies
    cookies: {},
    authToken: '',
    cfClearance: '',

    // models
    models: null,

    // tab
    tabId: null,
  };

  // Inject the page script only after the isolated content script is ready.
  // This avoids a race where the page script posts its response before the
  // content script has registered its message listener.
  function injectMainWorld(tabId) {
    if (!tabId) return Promise.resolve();
    return chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      files: ['injector.js'],
      world: 'MAIN',
      injectImmediately: true,
    }).then(function() {
      console.log(TAG, 'Main-world injector loaded:', tabId);
    }).catch(function(error) {
      console.error(TAG, 'Could not load main-world injector:', error);
    });
  }

  // A service worker may wake on a background/guest Arena tab. Prefer the
  // active tab so model data, reCAPTCHA, and cookies come from one session.
  async function selectArenaTab() {
    try {
      var tabs = await chrome.tabs.query({
        url: ['https://arena.ai/*', 'https://*.arena.ai/*'],
      });
      if (!tabs.length) return state.tabId;
      var active = tabs.find(function(tab) { return tab.active; });
      var newest = tabs.slice().sort(function(a, b) {
        return (b.lastAccessed || 0) - (a.lastAccessed || 0);
      })[0];
      state.tabId = (active || newest).id;
    } catch(e) {}
    return state.tabId;
  }

  // ========== Get cookies from the page ==========
  async function requestPageCookies() {
    await selectArenaTab();
    if (!state.tabId) return null;
    try {
      return await new Promise(function(resolve) {
        chrome.tabs.sendMessage(state.tabId, { type: 'NEED_COOKIES' }, function(resp) {
          if (chrome.runtime.lastError || !resp || !resp.cookies) {
            resolve(null);
          } else {
            resolve(resp.cookies);
          }
        });
      });
    } catch(e) {
      return null;
    }
  }

  // ========== Refresh cookies ==========
  async function getArenaCookies() {
    await selectArenaTab();
    var tabIds = state.tabId ? [state.tabId] : [];
    try {
      var arenaTabs = await chrome.tabs.query({
        url: ['https://arena.ai/*', 'https://*.arena.ai/*'],
      });
      arenaTabs.forEach(function(tab) {
        if (tab.id && tabIds.indexOf(tab.id) < 0) tabIds.push(tab.id);
      });
    } catch(e) {}

    var stores = [];
    try {
      var allStores = await chrome.cookies.getAllCookieStores();
      tabIds.forEach(function(tabId) {
        var store = allStores.find(function(item) {
          return item.tabIds && item.tabIds.indexOf(tabId) >= 0;
        });
        if (store && !stores.some(function(item) { return item.id === store.id; })) {
          stores.push(store);
        }
      });
    } catch(e) {}
    if (!stores.length) stores.push({ id: undefined });

    var groups = [];
    for (var s = 0; s < stores.length; s++) {
      var baseDetails = stores[s].id ? { storeId: stores[s].id } : {};
      groups.push(await chrome.cookies.getAll(Object.assign({ domain: 'arena.ai' }, baseDetails)));
      groups.push(await chrome.cookies.getAll(Object.assign({ url: 'https://arena.ai/' }, baseDetails)));
      try {
        var accessible = await chrome.cookies.getAll(baseDetails);
        groups.push(accessible.filter(function(cookie) {
          var domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
          return domain === 'arena.ai' || domain.endsWith('.arena.ai');
        }));
      } catch(e) {}
    }

    // Chrome 119+ keeps partitioned cookies out of ordinary queries.
    if (typeof chrome.cookies.getPartitionKey === 'function') {
      for (var t = 0; t < tabIds.length; t++) {
        try {
          var partition = await chrome.cookies.getPartitionKey({ tabId: tabIds[t], frameId: 0 });
          if (partition && partition.partitionKey) {
            groups.push(await chrome.cookies.getAll({
              url: 'https://arena.ai/',
              partitionKey: partition.partitionKey,
            }));
          }
        } catch(e) {}
      }
    }

    var unique = {};
    groups.forEach(function(group) {
      group.forEach(function(cookie) {
        var partitionKey = cookie.partitionKey
          ? JSON.stringify(cookie.partitionKey)
          : '';
        var key = [cookie.name, cookie.domain, cookie.path, cookie.storeId, partitionKey].join('|');
        if (!unique[key]) unique[key] = cookie;
      });
    });
    return Object.keys(unique).map(function(key) { return unique[key]; });
  }

  async function refreshCookies() {
    try {
      var browserCookies = await getArenaCookies();

      console.log(TAG, 'Arena cookies:', browserCookies.length, 'cookies:', browserCookies.map(function(c) { return c.name; }).join(', '));

      // Some Chrome refreshes expose only a partial cookie snapshot. Merge it
      // into the last complete snapshot so a valid Arena session is not lost
      // between periodic pushes.
      var freshCookies = {};
      browserCookies.forEach(function(c) {
        // getAll() sorts longer, more specific paths first.
        if (!freshCookies[c.name]) freshCookies[c.name] = c.value;
      });

      // Try document.cookie from the page (it can read non-HttpOnly cookies).
      var pageCookies = await requestPageCookies();
      if (pageCookies) {
        console.log(TAG, 'Page cookies:', Object.keys(pageCookies).join(', '));
        // Merge page cookies.
        for (var k in pageCookies) {
          if (!freshCookies[k]) {
            freshCookies[k] = pageCookies[k];
          }
        }
      }
      state.cookies = Object.assign({}, state.cookies, freshCookies);

      console.log(TAG, 'All cookies:', Object.keys(state.cookies).join(', '));

      state.cfClearance = state.cookies['cf_clearance'] || '';

      // The auth token may be stored in fragments.
      var auth = state.cookies['arena-auth-prod-v1'] || '';
      if (!auth) {
        var p0 = state.cookies['arena-auth-prod-v1.0'] || '';
        var p1 = state.cookies['arena-auth-prod-v1.1'] || '';
        console.log(TAG, 'Checking fragmented auth cookies - p0:', !!p0, 'p1:', !!p1);
        if (p0) {
          auth = p0 + (p1 || '');
          console.log(TAG, 'Combined auth token length:', auth.length);
        }
      }
      if (!auth) {
        // Current Arena deployments may use a provisional or differently
        // named session cookie. This value is only a presence marker; the
        // proxy authenticates with the complete Cookie header.
        var sessionName = Object.keys(state.cookies).find(function(name) {
          return name === 'provisional_user_id' || /(?:auth|session)[-_\.]/i.test(name);
        });
        if (sessionName) auth = state.cookies[sessionName];
      }
      state.authToken = auth;

      if (auth) {
        console.log(TAG, 'Auth Cookie found! Length:', auth.length, 'Preview:', auth.substring(0, 50) + '...');
      } else {
        console.log(TAG, 'Auth Cookie NOT found. Available cookies:', Object.keys(state.cookies));
      }
    } catch(e) {
      console.error(TAG, 'Cookie error:', e);
    }
  }

  // ========== Token management ==========
  function addToken(token, action) {
    if (!token || token.length < 20) return;
    if (state.v3Tokens.some(function(t) { return t.token === token; })) return;
    state.v3Tokens.push({ token: token, action: action || 'chat_submit', ts: Date.now() });
    while (state.v3Tokens.length > 10) state.v3Tokens.shift();
    console.log(TAG, 'Token added, pool:', state.v3Tokens.length);
  }

  function addV2Token(token) {
    if (!token || token.length < 20) return;
    state.v2Token = { token: token, ts: Date.now() };
    console.log(TAG, 'V2 token added');
  }

  function isModelList(models) {
    return Array.isArray(models) && models.length > 0 && models.some(function(model) {
      return model && typeof model === 'object' &&
        typeof model.id === 'string' && typeof model.publicName === 'string';
    });
  }

  function requestModels() {
    if (!state.tabId) return;
    chrome.tabs.sendMessage(state.tabId, { type: 'NEED_MODELS' }, function(resp) {
      if (chrome.runtime.lastError || !resp || !isModelList(resp.models)) return;
      state.models = resp.models;
      console.log(TAG, 'Models refreshed:', state.models.length);
      pushToServer();
    });
  }

  // Remove expired tokens.
  function cleanTokens() {
    var now = Date.now();
    state.v3Tokens = state.v3Tokens.filter(function(t) { return now - t.ts < 110000; });
  }

  // ========== Request a token from the content script ==========
  async function requestToken() {
    await selectArenaTab();
    if (!state.tabId) {
      try {
        var tabs = await chrome.tabs.query({ url: 'https://arena.ai/*' });
        if (tabs.length > 0) state.tabId = tabs[0].id;
        else return;
      } catch(e) { return; }
    }
    try {
      chrome.tabs.sendMessage(state.tabId, {
        type: 'NEED_TOKEN',
        action: 'chat_submit',
      }, function(resp) {
        if (chrome.runtime.lastError) {
          state.tabId = null;
          return;
        }
        if (resp && resp.token) {
          addToken(resp.token, resp.action);
          pushToServer();
        }
      });
    } catch(e) {
      state.tabId = null;
    }
  }

  async function requestV2Token() {
    await selectArenaTab();
    if (!state.tabId) return;
    try {
      chrome.tabs.sendMessage(state.tabId, { type: 'NEED_V2_TOKEN' }, function(resp) {
        if (chrome.runtime.lastError || !resp || !resp.token) return;
        addV2Token(resp.token);
        pushToServer();
      });
    } catch(e) {}
  }

  // ========== Push to the server ==========
  async function pushToServer() {
    if (!state.proxyUrl) return;
    try {
      await refreshCookies();
      cleanTokens();

      var data = {
        cookies: state.cookies,
        auth_token: state.authToken,
        cf_clearance: state.cfClearance,
        v3_tokens: state.v3Tokens.map(function(t) {
          return { token: t.token, action: t.action, age_ms: Date.now() - t.ts };
        }),
        v2_token: state.v2Token ? {
          token: state.v2Token.token,
          age_ms: Date.now() - state.v2Token.ts,
        } : null,
        models: state.models,
      };

      var url = state.proxyUrl.replace(/\/+$/, '') + '/v1/extension/push';
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (resp.ok) {
        state.connected = true;
        state.lastError = '';
        state.lastPush = Date.now();
        var result = await resp.json();
        if (result.need_tokens) {
          requestToken();
        }
      } else {
        state.connected = false;
        state.lastError = 'HTTP ' + resp.status;
      }
    } catch(e) {
      state.connected = false;
      state.lastError = e.message || 'Connection failed';
    }
  }

  // ========== Message handling ==========
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    switch (msg.type) {
      case 'TAB_READY':
        state.tabId = sender.tab ? sender.tab.id : null;
        console.log(TAG, 'Tab ready:', state.tabId);
        injectMainWorld(state.tabId).then(function() {
          return refreshCookies();
        }).then(function() {
          pushToServer();
          setTimeout(requestModels, 1500);
        });
        sendResponse({ ok: true });
        break;

      case 'PAGE_INIT':
        if (isModelList(msg.models)) {
          state.models = msg.models;
          console.log(TAG, 'Models received:', msg.models.length);
        }
        if (msg.pageCookies) {
          console.log(TAG, 'Page cookies received:', Object.keys(msg.pageCookies).join(', '));
          // Merge page cookies.
          for (var k in msg.pageCookies) {
            if (!state.cookies[k]) {
              state.cookies[k] = msg.pageCookies[k];
            }
          }
          // Recheck the auth token.
          var auth = state.cookies['arena-auth-prod-v1'] || '';
          if (!auth) {
            var p0 = state.cookies['arena-auth-prod-v1.0'] || '';
            var p1 = state.cookies['arena-auth-prod-v1.1'] || '';
            if (p0) {
              auth = p0 + (p1 || '');
              state.authToken = auth;
              console.log(TAG, 'Auth token updated from page cookies! Length:', auth.length);
            }
          }
        }
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'NEW_TOKEN':
        addToken(msg.token, msg.action);
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        cleanTokens();
        refreshCookies().then(function() {
          sendResponse({
            connected: state.connected,
            proxyUrl: state.proxyUrl,
            lastError: state.lastError,
            lastPush: state.lastPush,
            v3Count: state.v3Tokens.length,
            hasV2: !!state.v2Token,
            hasAuth: !!state.authToken,
            hasCf: !!state.cfClearance,
            hasModels: !!(state.models && state.models.length),
            modelCount: state.models ? state.models.length : 0,
            tabId: state.tabId,
          });
        });
        return true;

      case 'SET_PROXY_URL':
        state.proxyUrl = msg.url;
        chrome.storage.local.set({ proxyUrl: msg.url });
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'FORCE_PUSH':
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'FORCE_TOKEN':
        requestV2Token();
        requestToken();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'unknown' });
    }
  });

  // ========== Scheduled tasks ==========
  // Request a new token every 80 seconds (tokens are valid for about 2 minutes).
  setInterval(function() {
    cleanTokens();
    if (state.v3Tokens.length < 5) {
      requestToken();
    }
    if (!isModelList(state.models)) {
      requestModels();
    }
  }, 80000);

  // Push once every 30 seconds.
  setInterval(function() {
    pushToServer();
  }, 30000);

  // ========== Initialization ==========
  chrome.storage.local.get(['proxyUrl'], function(result) {
    if (result.proxyUrl) state.proxyUrl = result.proxyUrl;
    console.log(TAG, 'Proxy URL:', state.proxyUrl);
    // Push immediately after startup.
    refreshCookies().then(function() { pushToServer(); });
  });

  // Listen for tab closures.
  chrome.tabs.onRemoved.addListener(function(tabId) {
    if (tabId === state.tabId) state.tabId = null;
  });

  // Listen for cookie changes.
  chrome.cookies.onChanged.addListener(function(info) {
    if (info.cookie.domain.indexOf('arena.ai') >= 0) {
      refreshCookies();
    }
  });

  console.log(TAG, 'Background started');
})();
