(function () {
  function loadScript(src) {
    return new Promise(resolve => {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        resolve();
      };
      document.head.appendChild(script);
    });
  }

  function loadRequiredScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error('Failed to load required script: ' + src));
      };
      document.head.appendChild(script);
    });
  }

  function loadOptionalScript(src) {
    return fetch(src)
      .then(function (response) {
        if (!response.ok) {
          return '';
        }
        return response.text();
      })
      .then(function (source) {
        if (!source) {
          return;
        }
        var script = document.createElement('script');
        script.text = source;
        document.head.appendChild(script);
      })
      .catch(function () {
        // Local config is optional; missing or unreadable config should not block fixtures.
      });
  }

  function getRepo(explicitRepo) {
    var config = window.BugDropTestConfig || {};
    return explicitRepo || config.repo || config.defaultRepo || 'mean-weasel/bugdrop-widget-test';
  }

  function applyDataset(script, dataset) {
    Object.keys(dataset || {}).forEach(function (key) {
      var value = dataset[key];
      if (value !== undefined && value !== null) {
        script.dataset[key] = String(value);
      }
    });
  }

  function setDataValue(script, target, value) {
    if (target.indexOf('data-') === 0) {
      script.setAttribute(target, value);
    } else {
      script.dataset[target] = value;
    }
  }

  function applyQueryDataset(script, queryDataset) {
    var params = new URLSearchParams(window.location.search);
    Object.keys(queryDataset || {}).forEach(function (queryKey) {
      var value = params.get(queryKey);
      if (value !== null) {
        setDataValue(script, queryDataset[queryKey], value);
      }
    });
  }

  function loadLocalQaStore() {
    var params = new URLSearchParams(window.location.search);
    var isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.endsWith('.localhost') ||
      window.location.hostname.endsWith('.local');

    if (params.get('localQa') !== '1' || !isLocalHost) {
      return Promise.resolve();
    }

    return loadRequiredScript('/test/local-submissions.js');
  }

  window.loadBugDropTestWidget = function loadBugDropTestWidget(options) {
    var opts = options || {};
    return loadLocalQaStore()
      .then(function () {
        return loadScript('/test/config.js');
      })
      .then(function () {
        return loadOptionalScript('/test/local-config.js');
      })
      .then(function () {
        var script = document.createElement('script');
        if (opts.id) {
          script.id = opts.id;
        }
        script.src = opts.src || '/widget.js';
        script.dataset.repo = getRepo(opts.repo);
        applyDataset(script, opts.dataset);
        applyQueryDataset(script, opts.queryDataset);

        document.body.appendChild(script);
      });
  };
})();
