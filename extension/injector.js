/**
 * Arena2API - Injector (MAIN world)
 * 
 * Runs in the page's main world and can directly access:
 * - window.grecaptcha.enterprise
 * - window.__next_f (Next.js data)
 * - All page global variables
 * 
 * Communicates with content.js through window.postMessage.
 */
(function() {
  'use strict';

  var DEFAULT_SITEKEY = '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0';
  var TAG = '[Arena2API]';

  function isModelList(value) {
    return Array.isArray(value) && value.length > 0 && value.some(function(model) {
      return model && typeof model === 'object' &&
        typeof model.id === 'string' && typeof model.publicName === 'string';
    });
  }

  function extractJsonArrayAfterKey(text, key) {
    var keyIndex = text.indexOf('"' + key + '"');
    if (keyIndex < 0) return null;
    var start = text.indexOf('[', keyIndex);
    if (start < 0) return null;

    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.substring(start, i + 1));
          } catch(e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function extractModelsFromFlightData(text) {
    if (!text || text.indexOf('initialModels') < 0) return null;
    var models = extractJsonArrayAfterKey(text, 'initialModels');
    return isModelList(models) ? models : null;
  }

  // ========== Extract the model list ==========
  function extractModels() {
    try {
      // Method 1: extract from __NEXT_DATA__.
      if (window.__NEXT_DATA__) {
        var props = window.__NEXT_DATA__.props;
        if (props && props.pageProps && isModelList(props.pageProps.initialModels)) {
          return props.pageProps.initialModels;
        }
      }

      // Method 2: extract from self.__next_f.
      if (window.__next_f) {
        for (var i = 0; i < window.__next_f.length; i++) {
          var entry = window.__next_f[i];
          if (!entry || !entry[1]) continue;
          var str = typeof entry[1] === 'string' ? entry[1] : '';
          var flightModels = extractModelsFromFlightData(str);
          if (flightModels) return flightModels;
        }
      }

      // Method 3: extract from HTML script tags.
      var scripts = document.querySelectorAll('script');
      for (var k = 0; k < scripts.length; k++) {
        var text = scripts[k].textContent || '';
        if (text.indexOf('initialModels') >= 0 && text.indexOf('self.__next_f.push') >= 0) {
          var match = text.match(/self\.__next_f\.push\(([\s\S]+)\)\s*;?\s*$/);
          if (match) {
            try {
              var payload = JSON.parse(match[1]);
              var payloadText = payload && typeof payload[1] === 'string' ? payload[1] : '';
              var scriptModels = extractModelsFromFlightData(payloadText);
              if (scriptModels) return scriptModels;
            } catch(e) {}
          }
        }
      }
    } catch(e) {
      console.error(TAG, 'extractModels error:', e);
    }
    return null;
  }

  // ========== Extract Next.js server action hashes ==========
  function extractNextActions() {
    // These hashes are used by Next.js server actions (such as generateUploadUrl).
    // They are not needed yet; add them when image uploads are supported.
    return {};
  }

  // ========== Get a reCAPTCHA token ==========
  function getRecaptchaSiteKey() {
    var elements = document.querySelectorAll(
      'script[src*="recaptcha/enterprise.js?render="], link[href*="recaptcha/enterprise.js?render="]'
    );
    for (var i = 0; i < elements.length; i++) {
      var source = elements[i].src || elements[i].href || '';
      try {
        var key = new URL(source, window.location.href).searchParams.get('render');
        if (key && key !== 'explicit') return key;
      } catch(e) {}
    }
    return DEFAULT_SITEKEY;
  }

  function getRecaptchaToken(action) {
    return new Promise(function(resolve, reject) {
      var g = window.grecaptcha && window.grecaptcha.enterprise
        ? window.grecaptcha.enterprise
        : window.grecaptcha;

      if (!g || typeof g.execute !== 'function') {
        reject(new Error('grecaptcha not available'));
        return;
      }

      try {
        g.ready(function() {
          try {
            Promise.resolve(g.execute(getRecaptchaSiteKey(), { action: action || 'chat_submit' }))
              .then(resolve, reject);
          } catch(error) {
            reject(error);
          }
        });
      } catch(error) {
        reject(error);
      }
    });
  }

  // A V2 response is created only after the user completes Arena's visible
  // challenge. This function never renders or solves a CAPTCHA; it only reads
  // the response already present in the page.
  function getRecaptchaV2Token() {
    try {
      var textarea = document.querySelector('textarea[name^="g-recaptcha-response"]');
      if (textarea && textarea.value) return textarea.value;
    } catch(e) {}
    try {
      var g = window.grecaptcha && window.grecaptcha.enterprise
        ? window.grecaptcha.enterprise
        : window.grecaptcha;
      if (g && typeof g.getResponse === 'function') {
        return g.getResponse() || '';
      }
    } catch(e) {}
    return '';
  }

  // ========== Extract cookies ==========
  function extractCookies() {
    var cookies = {};
    try {
      var cookieStr = document.cookie;
      if (cookieStr) {
        cookieStr.split(';').forEach(function(pair) {
          var parts = pair.trim().split('=');
          if (parts.length >= 2) {
            cookies[parts[0]] = parts.slice(1).join('=');
          }
        });
      }
    } catch(e) {
      console.error(TAG, 'extractCookies error:', e);
    }
    return cookies;
  }

  // ========== Message handling ==========
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.from !== 'arena2api-content') return;

    var msg = event.data;
    var rid = msg.rid;

    switch (msg.type) {
      case 'GET_TOKEN':
        getRecaptchaToken(msg.action).then(function(token) {
          window.postMessage({
            from: 'arena2api-injector',
            type: 'TOKEN_OK',
            rid: rid,
            token: token,
            action: msg.action || 'chat_submit',
          }, '*');
        }).catch(function(err) {
          window.postMessage({
            from: 'arena2api-injector',
            type: 'TOKEN_ERR',
            rid: rid,
            error: err.message || String(err),
          }, '*');
        });
        break;

      case 'GET_V2_TOKEN':
        window.postMessage({
          from: 'arena2api-injector',
          type: 'V2_TOKEN_OK',
          rid: rid,
          token: getRecaptchaV2Token(),
        }, '*');
        break;

      case 'GET_MODELS':
        var models = extractModels();
        window.postMessage({
          from: 'arena2api-injector',
          type: 'MODELS_OK',
          rid: rid,
          models: models,
        }, '*');
        break;

      case 'GET_COOKIES':
        var cookies = extractCookies();
        window.postMessage({
          from: 'arena2api-injector',
          type: 'COOKIES_OK',
          rid: rid,
          cookies: cookies,
        }, '*');
        break;

      case 'CHECK':
        var g = window.grecaptcha && window.grecaptcha.enterprise
          ? window.grecaptcha.enterprise
          : window.grecaptcha;
        window.postMessage({
          from: 'arena2api-injector',
          type: 'CHECK_OK',
          rid: rid,
          recaptcha: !!(g && typeof g.execute === 'function'),
          enterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
        }, '*');
        break;
    }
  });

  // ========== Initialization notification ==========
  // Delay briefly to ensure content.js is listening.
  setTimeout(function() {
    var models = extractModels();
    var cookies = extractCookies();
    window.postMessage({
      from: 'arena2api-injector',
      type: 'INIT',
      models: models,
      cookies: cookies,
    }, '*');
    console.log(TAG, 'Injector ready, models:', models ? models.length : 0, 'cookies:', Object.keys(cookies).join(', '));
  }, 1000);

})();
