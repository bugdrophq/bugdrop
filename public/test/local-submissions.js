(function () {
  var DB_NAME = 'bugdrop-local-qa';
  var DB_VERSION = 1;
  var STORE_NAME = 'submissions';
  var originalFetch = window.fetch.bind(window);

  function isLocalHost() {
    return (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.endsWith('.localhost') ||
      window.location.hostname.endsWith('.local')
    );
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () {
        resolve();
      };
      transaction.onerror = function () {
        reject(transaction.error);
      };
      transaction.onabort = function () {
        reject(transaction.error);
      };
    });
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  async function withStore(mode, callback) {
    var database = await openDatabase();
    try {
      var transaction = database.transaction(STORE_NAME, mode);
      var result = await callback(transaction.objectStore(STORE_NAME));
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  async function create(payload) {
    var now = new Date().toISOString();
    return withStore('readwrite', async function (store) {
      return requestResult(
        store.add({
          createdAt: now,
          updatedAt: now,
          payload: payload,
        })
      );
    });
  }

  async function list() {
    var records = await withStore('readonly', function (store) {
      return requestResult(store.getAll());
    });
    return records.sort(function (left, right) {
      return right.id - left.id;
    });
  }

  function get(id) {
    return withStore('readonly', function (store) {
      return requestResult(store.get(Number(id)));
    });
  }

  function update(record) {
    return withStore('readwrite', function (store) {
      record.updatedAt = new Date().toISOString();
      return requestResult(store.put(record));
    });
  }

  function remove(id) {
    return withStore('readwrite', function (store) {
      return requestResult(store.delete(Number(id)));
    });
  }

  function clear() {
    return withStore('readwrite', function (store) {
      return requestResult(store.clear());
    });
  }

  async function readPayload(input, init) {
    if (init && typeof init.body === 'string') {
      return JSON.parse(init.body);
    }
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.clone().json();
    }
    return null;
  }

  function addInboxLink() {
    if (window.location.pathname.indexOf('/test/submissions') === 0) return;
    if (document.getElementById('bugdrop-local-inbox-link')) return;
    var link = document.createElement('a');
    link.id = 'bugdrop-local-inbox-link';
    link.href = '/test/submissions.html';
    link.textContent = 'Local submissions';
    link.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:2147483000;padding:9px 12px;border:1px solid #ff9e64;border-radius:8px;background:#24283b;color:#fff;text-decoration:none;font:600 14px/1.2 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(link);
  }

  function relabelLocalIssueLink(issueUrl, localUrl) {
    var observedRoots = [];
    var observer;
    var timeout;

    function rewriteLink(link) {
      if (!link || link.href !== issueUrl) return false;
      link.href = localUrl;
      Array.from(link.childNodes).forEach(function (node) {
        if (node.nodeType === Node.TEXT_NODE) node.remove();
      });
      link.appendChild(document.createTextNode(' View local submission'));
      link.setAttribute('aria-label', 'View local submission');
      return true;
    }

    function observeRoot(root) {
      if (!root || observedRoots.indexOf(root) !== -1) return;
      observedRoots.push(root);
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['href'],
        childList: true,
        subtree: true,
      });
    }

    function scan() {
      var root = document.querySelector('#bugdrop-host');
      var hosts = [root].concat(Array.from(document.querySelectorAll('[data-bugdrop-owned]')));
      var links = [];
      hosts.forEach(function (host) {
        if (!host || !host.shadowRoot) return;
        observeRoot(host.shadowRoot);
        links = links.concat(
          Array.from(host.shadowRoot.querySelectorAll('.bd-issue-link, .bdv-success-link'))
        );
      });
      if (links.some(rewriteLink)) {
        observer.disconnect();
        window.clearTimeout(timeout);
        return true;
      }
      return false;
    }

    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (scan()) return;
    timeout = window.setTimeout(function () {
      observer.disconnect();
    }, 5000);
  }

  window.BugDropLocalSubmissions = {
    create: create,
    list: list,
    get: get,
    update: update,
    remove: remove,
    clear: clear,
  };

  if (!isLocalHost() || window.__BugDropLocalQaFetchInstalled) return;
  window.__BugDropLocalQaFetchInstalled = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addInboxLink, { once: true });
  } else {
    addInboxLink();
  }

  window.fetch = async function (input, init) {
    var url =
      typeof input === 'string'
        ? input
        : typeof URL !== 'undefined' && input instanceof URL
          ? input.href
          : input.url;

    if (typeof url === 'string' && url.indexOf('/api/check/') !== -1) {
      return new Response(JSON.stringify({ installed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (typeof url === 'string' && url.endsWith('/feedback')) {
      var payload = await readPayload(input, init);
      var id = await create(payload);
      var localUrl = window.location.origin + '/test/submissions.html?id=' + id;
      var issueUrl = localUrl;
      if (payload && typeof payload.repo === 'string') {
        issueUrl = 'https://github.com/' + payload.repo + '/issues/' + id;
      }
      relabelLocalIssueLink(issueUrl, localUrl);
      return new Response(
        JSON.stringify({
          success: true,
          issueNumber: id,
          issueUrl: issueUrl,
          isPublic: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return originalFetch(input, init);
  };
})();
