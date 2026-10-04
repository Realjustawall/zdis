(function () {
  var recovering = false;

  function recoveryUrl() {
    var url = new URL(window.location.href);
    url.searchParams.set('client-recovery', String(Date.now()));
    return url.toString();
  }

  function showFallback() {
    if (document.documentElement.dataset.appBooted === 'true') return;
    var render = function () {
      var root = document.getElementById('root');
      if (!root || root.childNodes.length) return;
      var main = document.createElement('main');
      main.className = 'fatal-error-screen';
      main.setAttribute('role', 'alert');
      var card = document.createElement('div');
      card.className = 'fatal-error-card';
      var heading = document.createElement('h1');
      heading.textContent = 'The interface could not load';
      var message = document.createElement('p');
      message.textContent = 'Clear the cached application shell and load the latest version.';
      var button = document.createElement('button');
      button.className = 'btn primary';
      button.textContent = 'Try again';
      button.addEventListener('click', recover);
      card.appendChild(heading);
      card.appendChild(message);
      card.appendChild(button);
      main.appendChild(card);
      root.appendChild(main);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
    else render();
  }

  function recover() {
    if (recovering) return;
    recovering = true;
    var tasks = [];
    if ('caches' in window) {
      tasks.push(window.caches.keys().then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name.indexOf('zdis-pwa-') === 0;
        }).map(function (name) { return window.caches.delete(name); }));
      }));
    }
    if ('serviceWorker' in navigator) {
      tasks.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
        return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
      }));
    }
    Promise.all(tasks).catch(function () {}).then(function () {
      window.location.replace(recoveryUrl());
    });
  }

  window.addEventListener('error', function (event) {
    if (document.documentElement.dataset.appBooted === 'true') return;
    var target = event.target;
    var resourceFailure = target && (target.tagName === 'SCRIPT'
      || (target.tagName === 'LINK' && target.rel === 'stylesheet'));
    if (!resourceFailure || new URL(window.location.href).searchParams.has('client-recovery')) {
      if (resourceFailure) showFallback();
      return;
    }
    recover();
  }, true);

  window.setTimeout(showFallback, 12000);
}());
