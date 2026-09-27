/**
 * Arena2API - Popup (Firefox)
 */
(function() {
  var $ = function(id) { return document.getElementById(id); };
  var api = typeof browser !== 'undefined' ? browser : chrome;

  function update(s) {
    if (!s) return;
    // Server
    if (s.connected) {
      $('srv').innerHTML = '<span class="dot dot-g"></span>Connected';
      $('srv').className = 'val ok';
    } else {
      $('srv').innerHTML = '<span class="dot dot-r"></span>Disconnected';
      $('srv').className = 'val err';
    }
    // Tab
    if (s.tabId) {
      $('tab').innerHTML = '<span class="dot dot-g"></span>Active';
      $('tab').className = 'val ok';
    } else {
      $('tab').innerHTML = '<span class="dot dot-y"></span>No Tab';
      $('tab').className = 'val warn';
    }
    // Error
    $('err').textContent = s.lastError || 'None';
    $('err').className = 'val ' + (s.lastError ? 'err' : 'ok');
    // V3
    $('v3').textContent = s.v3Count || 0;
    $('v3').className = 'val ' + (s.v3Count > 0 ? 'ok' : 'warn');
    // Auth
    if (s.hasAuth) {
      $('auth').innerHTML = '<span class="dot dot-g"></span>Yes';
      $('auth').className = 'val ok';
    } else {
      $('auth').innerHTML = '<span class="dot dot-r"></span>No';
      $('auth').className = 'val err';
    }
    // Models
    $('mdl').textContent = s.modelCount || 0;
    $('mdl').className = 'val ' + (s.modelCount > 0 ? 'ok' : 'warn');
  }

  function refresh() {
    api.runtime.sendMessage({ type: 'GET_STATUS' }, function(s) {
      if (!api.runtime.lastError && s) update(s);
    });
  }

  $('save').onclick = function() {
    var url = $('url').value.trim();
    if (url) {
      api.runtime.sendMessage({ type: 'SET_PROXY_URL', url: url }, function() {
        $('save').textContent = 'OK!';
        setTimeout(function() { $('save').textContent = 'Save'; }, 1000);
      });
    }
  };

  $('open').onclick = function() {
    api.tabs.create({ url: 'https://arena.ai/?mode=direct' });
    window.close();
  };

  $('token').onclick = function() {
    api.runtime.sendMessage({ type: 'FORCE_TOKEN' }, function() {
      $('token').textContent = 'Sent!';
      setTimeout(function() { $('token').textContent = 'Get Token'; refresh(); }, 1500);
    });
  };

  $('push').onclick = function() {
    api.runtime.sendMessage({ type: 'FORCE_PUSH' }, function() {
      $('push').textContent = 'OK!';
      setTimeout(function() { $('push').textContent = 'Push'; refresh(); }, 1000);
    });
  };

  // Init
  api.storage.local.get(['proxyUrl'], function(r) {
    $('url').value = r.proxyUrl || 'http://127.0.0.1:9090';
  });
  refresh();
  setInterval(refresh, 2000);
})();
