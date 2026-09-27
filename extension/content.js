/**
 * Arena2API - Content Script (ISOLATED world)
 * 
 * Message bridge: injector.js <-> content.js <-> background.js
 */
(function() {
  'use strict';

  var TAG = '[Arena2API]';
  var rid = 0;
  var pending = {};  // rid -> {resolve, reject, timer}

  // ========== Send messages to injector.js ==========
  function callInjector(type, data) {
    var id = 'r' + (++rid) + '_' + Date.now();
    return new Promise(function(resolve, reject) {
    var timeout = type === 'PAGE_REQUEST' ? 330000 : 20000;
    var timer = setTimeout(function() {
        delete pending[id];
        reject(new Error('Injector timeout'));
    }, timeout);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { from: 'arena2api-content', type: type, rid: id };
      if (data) {
        for (var k in data) msg[k] = data[k];
      }
      window.postMessage(msg, '*');
    });
  }

  // ========== Listen for injector.js responses ==========
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.from !== 'arena2api-injector') return;

    var msg = event.data;

    // Response with a rid.
    if (msg.rid && pending[msg.rid]) {
      var p = pending[msg.rid];
      clearTimeout(p.timer);
      delete pending[msg.rid];
      if (msg.type.endsWith('_ERR')) {
        p.reject(new Error(msg.error || 'Unknown error'));
      } else {
        p.resolve(msg);
      }
      return;
    }

    // INIT message (without a rid).
    if (msg.type === 'INIT') {
      console.log(TAG, 'Injector initialized, models:', msg.models ? msg.models.length : 0, 'cookies:', msg.cookies ? Object.keys(msg.cookies).join(', ') : 'none');
      // Notify the background script.
      chrome.runtime.sendMessage({
        type: 'PAGE_INIT',
        models: msg.models,
        pageCookies: msg.cookies,
      });
      // Try to get the initial token.
      setTimeout(function() { fetchAndPushToken(); }, 2000);
    }
  });

  // ========== Get a token and push it to the background script ==========
  function fetchAndPushToken() {
    callInjector('GET_TOKEN', { action: 'chat_submit' }).then(function(result) {
      if (result.token) {
        console.log(TAG, 'Got V3 token:', result.token.length, 'chars');
        chrome.runtime.sendMessage({
          type: 'NEW_TOKEN',
          token: result.token,
          action: result.action || 'chat_submit',
        });
      }
    }).catch(function(err) {
      console.warn(TAG, 'Token error:', err.message);
    });
  }

  // ========== Listen for background-script requests ==========
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.type === 'NEED_TOKEN') {
      callInjector('GET_TOKEN', { action: msg.action || 'chat_submit' }).then(function(result) {
        sendResponse({ token: result.token, action: result.action });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

  if (msg.type === 'NEED_V2_TOKEN') {
    callInjector('GET_V2_TOKEN').then(function(result) {
      sendResponse({ token: result.token });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (msg.type === 'RUN_ARENA_REQUEST') {
    callInjector('PAGE_REQUEST', { payload: msg.payload }).then(function(result) {
      sendResponse({ status: result.status, body: result.body });
    }).catch(function(err) {
      sendResponse({ status: 0, error: err.message });
    });
    return true;
  }

    if (msg.type === 'NEED_MODELS') {
      callInjector('GET_MODELS').then(function(result) {
        sendResponse({ models: result.models });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

    if (msg.type === 'NEED_COOKIES') {
      callInjector('GET_COOKIES').then(function(result) {
        sendResponse({ cookies: result.cookies });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

    if (msg.type === 'CHECK_PAGE') {
      callInjector('CHECK').then(function(result) {
        sendResponse(result);
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }
  });

  // ========== Initialization ==========
  console.log(TAG, 'Content script loaded');
  chrome.runtime.sendMessage({ type: 'TAB_READY' });

  // Periodically check whether reCAPTCHA is available and obtain a token.
  var checkCount = 0;
  var checker = setInterval(function() {
    checkCount++;
    if (checkCount > 30) {  // Stop after 60 seconds.
      clearInterval(checker);
      return;
    }
    callInjector('CHECK').then(function(result) {
      if (result.recaptcha) {
        clearInterval(checker);
        console.log(TAG, 'reCAPTCHA ready, fetching token');
        fetchAndPushToken();
      }
    }).catch(function() {});
  }, 2000);

})();
