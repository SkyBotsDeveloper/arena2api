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

  var SITEKEY = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
  var TAG = '[Arena2API]';

  // ========== Extract the model list ==========
  function extractModels() {
    try {
      // Method 1: extract from __NEXT_DATA__.
      if (window.__NEXT_DATA__) {
        var props = window.__NEXT_DATA__.props;
        if (props && props.pageProps && props.pageProps.initialModels) {
          return props.pageProps.initialModels;
        }
      }

      // Method 2: extract from self.__next_f.
      if (window.__next_f) {
        for (var i = 0; i < window.__next_f.length; i++) {
          var entry = window.__next_f[i];
          if (!entry || !entry[1]) continue;
          var str = typeof entry[1] === 'string' ? entry[1] : '';
          if (str.indexOf('initialModels') >= 0) {
            // Find the JSON section.
            var jsonStart = str.indexOf('{"initialModels"');
            if (jsonStart < 0) jsonStart = str.indexOf('"initialModels"');
            if (jsonStart >= 0) {
              // Find the start of the object that contains it.
              var braceStart = str.lastIndexOf('{', jsonStart);
              if (braceStart >= 0) {
                // Try parsing it.
                var depth = 0;
                for (var j = braceStart; j < str.length; j++) {
                  if (str[j] === '{') depth++;
                  else if (str[j] === '}') depth--;
                  if (depth === 0) {
                    try {
                      var obj = JSON.parse(str.substring(braceStart, j + 1));
                      if (obj.initialModels) return obj.initialModels;
                    } catch(e) {}
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // Method 3: extract from HTML script tags.
      var scripts = document.querySelectorAll('script');
      for (var k = 0; k < scripts.length; k++) {
        var text = scripts[k].textContent || '';
        if (text.indexOf('initialModels') >= 0 && text.indexOf('self.__next_f.push') >= 0) {
          var match = text.match(/initialModels":\s*(\[[\s\S]*?\])\s*,\s*"/);
          if (match) {
            try {
              return JSON.parse(match[1]);
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
  function getRecaptchaToken(action) {
    return new Promise(function(resolve, reject) {
      var g = window.grecaptcha && window.grecaptcha.enterprise
        ? window.grecaptcha.enterprise
        : window.grecaptcha;

      if (!g || typeof g.execute !== 'function') {
        reject(new Error('grecaptcha not available'));
        return;
      }

      g.ready(function() {
        g.execute(SITEKEY, { action: action || 'chat_submit' })
          .then(resolve)
          .catch(reject);
      });
    });
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
