angular
.module('webui.services.rpc', [
  'webui.services.rpc.syscall', 'webui.services.configuration', 'webui.services.alerts',
  'webui.services.utils'
])
.factory('$rpc', [
  '$syscall', '$globalTimeout', '$alerts', '$utils',
  '$rootScope', '$location', '$authconf',
function(syscall, time, alerts, utils, rootScope, uri, authconf) {

  var subscriptions = []
    , configurations = [authconf]
    , currentConf = {}
    , currentToken
    , timeout = null
    , forceNextUpdate = false;

  var cookieConf = utils.getCookie('aria2conf');

  // try at the start, so that it is presistant even when default authconf works
  if (cookieConf) configurations.push(cookieConf);

  if (['http', 'https'].indexOf(uri.protocol()) != -1 && uri.host() != 'localhost') {
    console.log(uri.host());
    configurations.push({
      host: uri.host(),
      port: 6800,
      encrypt: false
    });
    console.log(configurations);
  }


  // update is implemented such that
  // only one syscall at max is ongoing
  // (i.e. serially) so should be private
  // to maintain that invariant
  var update = function() {

    clearTimeout(timeout);
    timeout = null;

    subscriptions = _.filter(subscriptions, function(e) {
      return !!e && e.once !== 2;
    });
    var subs = subscriptions.slice();
    if (!subs.length) {
      timeout = setTimeout(update, time);
      return;
    }

    if (configurations.length) {
      currentConf = configurations[0];
      if (currentConf && currentConf.auth && currentConf.auth.token) {
        currentToken = currentConf.auth.token;
      }
      else {
        currentToken = null;
      }
      syscall.init(currentConf);
    }

    var params = _.map(subs, function(s) {
      var p = s.params;
      if (currentToken) {
        p = ["token:" + currentToken].concat(p || []);
      }
      return {
        methodName: s.name,
        params: p && p.length ? p : undefined
      };
    });

    var error = function() {
      var ind = configurations.indexOf(currentConf);
      if (ind != -1) configurations.splice(ind, 1);

      // If some proposed configurations are still in the pipeline then retry
      if (configurations.length) {
        alerts.log("The last connection attempt was unsuccessful. Trying another configuration");
        timeout = setTimeout(update, 0);
      }
      else {
        alerts.addAlert('<strong>Oh Snap!</strong> Could not connect to the aria2 RPC server. Will retry in 10 secs. You might want to check the connection settings by going to Settings > Connection Settings', 'error');
        timeout = setTimeout(update, 10000);
      }
    };

    syscall.invoke({
      name: 'system.multicall',
      params: [params],
      success: function(data) {
        var failed = _.any(data.result, function(d) {
          return d.code && d.message === "Unauthorized";
        });

        if (failed) {
          alerts.addAlert('<strong>天呐!</strong>  Aria2 RPC 服务器连接失败. 将在 10 秒后重试. 或者你需要前往 >连接设置 配置你的 Aria2 RPC 服务器', 'error');
          timeout = setTimeout(update, 10000);
          return;
        }

        if (configurations.length) {
          // configuration worked, save it in cookie for next time and
          // delete the pipelined configurations!!
          if (currentToken)
            alerts.addAlert('成功链接Aria2 RPC 服务器 …', 'success');
          else
            alerts.addAlert('成功链接Aria2 RPC 服务器, 但没有使用安全连接,请尝试开启 secret token 验证 (使用参数 --rpc-secret)');
          configurations = [];
        }

        utils.setCookie('aria2conf', currentConf);

        var cbs = [];
        _.each(data.result, function(d, i) {
          var handle = subs[i];
          if (handle) {
            if (d.code) {
              console.error(handle, d);
              alerts.addAlert(d.message, 'error');
            }
            // run them later as the cb itself can mutate the subscriptions
            cbs.push({cb: handle.cb, data: d});
            if (handle.once) {
              handle.once = 2;
            }
          }
        });


        _.each(cbs, function(hnd) {
          hnd.cb(hnd.data);
        });

        rootScope.$digest();

        if (forceNextUpdate) {
          forceNextUpdate = false;
          timeout = setTimeout(update, 0);
        }
        else {
          timeout = setTimeout(update, time);
        }
      },
      error: error
    });
  };

  // initiate the update loop
  timeout = setTimeout(update, time);

  return {
    // conf can be configuration or array of configurations,
    // each one will be tried one after the other till success,
    // for all options for one conf read rpc/syscall.js
    configure: function(conf) {
      alerts.addAlert('尝试使用新配置连接到服务器', 'info');

      if (conf instanceof Array)
        configurations = conf;
      else
        configurations = [conf];

      if (timeout) {
        clearTimeout(timeout);
        timeout = setTimeout(update, 0);
      }
    },

    // get current configuration being used
    getConfiguration: function() { return currentConf },

    // syscall is done only once, delay is optional
    // and pass true to only dispatch it in the global timeout
    // which can be used to batch up once calls
    once: function(name, params, cb, delay) {
      cb = cb || angular.noop;
      params = params || [];

      subscriptions.unshift({
        once: true,
        name: 'aria2.' + name,
        params: params,
        cb: cb
      });

      if (!delay) {
        this.forceUpdate();
      }
    },

    // callback is called each time with updated syscall data
    // after the global timeout, delay is optional and pass it
    // true to dispatch the first syscall also on global timeout
    // which can be used to batch the subscribe calls
    subscribe: function(name, params, cb, delay) {
      cb = cb || angular.noop;
      params = params || [];

      var handle = {
        once: false,
        name: 'aria2.' + name,
        params: params,
        cb: cb
      };
      subscriptions.push(handle);

      if (!delay) this.forceUpdate();
      return handle;
    },

    // remove the subscribed callback by passing
    // the returned handle bysubscribe
    unsubscribe: function(handle) {
      var ind = subscriptions.indexOf(handle);
      subscriptions[ind] = null;
    },

    // force the global syscall update
    forceUpdate: function() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = setTimeout(update, 0);
      }
      else {
        // a batch call is already in progress,
        // wait till it returns and force the next one
        forceNextUpdate = true;
      }
    }
  };
}]);
