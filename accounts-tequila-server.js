/**
 * Authenticate against EPFL's Tequila system
 */
var Protocol = Npm.require("passport-tequila/lib/passport-tequila/protocol.js"),
  debug = Npm.require("debug")("accounts-tequila"),
  Future = Meteor.npmRequire('fibers/future');

function tequilaRedirectHTTP(req, res, next, protocol) {
  if (req.query && req.query.key) {
    debug("Looks like user is back from Tequila, with key=" + req.query.key);
    // Do *NOT* resolve the key with the Tequila server just yet; let the client
    // do that (we want the DDP session to be authenticated, not the HTTP
    // session which is typically powerless and will be closed soon)
    next();
  } else {
    var url = req.originalUrl;
    protocol.createrequest(req, res, function (err, results) {
      if (err) {
        next(err);
      } else {
        debug("Redirecting user to Tequila for " + url);
        protocol.requestauth(res, results);
      }
    });
  }
}

Tequila.start = function startServer() {
  var protocol = new Protocol();
  _.extend(protocol, Tequila.options);
  if (Tequila.options.fakeLocalServer) {
    setupFakeLocalServer(Tequila.options.fakeLocalServer, protocol);
  }

  var connect = Npm.require('connect')();
  connect.use(Npm.require('connect-query')());
  connect.use(function(req, res, next) {
    function matches(url, pattern) {
      if (0 != url.indexOf(pattern)) { return false; }
      if (pattern[pattern.length - 1] === "/") { return true; }
      url = url.replace(/\?.*$/,"");
      return (pattern === url);
    }
    if (_.find(Tequila.options.bypass, matches.bind({}, req.originalUrl))) {
      debug("Bypassing Tequila for request to " + req.originalUrl);
      next();
    } else if (_.find(Tequila.options.control,
        matches.bind({}, req.originalUrl))) {
      tequilaRedirectHTTP(req, res, next, protocol);
    } else {
      debug("Fall-through (no matched rule) for request to " + req.originalUrl);
      next();
    }
  });
  WebApp.rawConnectHandlers.use(connect);

  Accounts.registerLoginHandler(function(options) {
    var key = options.tequilaKey;
    if (! key) return undefined;
    debug("tequila.authenticate with key=" + key);
    var results, error;
    function fetchattributes(cb) {
      try {
        results = protocol.fetchattributes(key, cb);
      } catch (e) {
        debug("fetchattributes error:", e);
        error = e;
      }
    }
    Meteor.wrapAsync(fetchattributes)();
    if (error) {
      debug("fetchattributes RPC to Tequila server failed", error);
      return {
        error: new Meteor.Error(
          "TEQUILA_FETCHATTRIBUTES_FAILED",
          "fetchattributes RPC to Tequila server failed",
          String(error))
      };
    }
    try {
      var userId = getIdFromResults(results);
      if (! userId) {
        debug("User unknown!", results);
        return { error: new Meteor.Error("TEQUILA_USER_UNKNOWN") };
      }
      debug("tequila.authenticate successful, user ID is " + userId);
      return { userId: userId };
    } catch (e) {
      return { error: e };
    }
  });
};

function getIdFromResults(results) {
  var loggedInUser = Tequila.options.getUserId(results);
  if (! loggedInUser) {
    return undefined;
  }
  if (loggedInUser.forEach) { // Cursor
    var returned = new Future;
    loggedInUser.forEach(function (error, value) {
      if (error) {
        if (! returned.isResolved()) {
          returned.throw(error);
        }
      } else {
        if (! returned.isResolved()) {
          returned.return(value);
        }
      }
    });
    return returned.wait();
  } else if (loggedInUser._id) {
    return loggedInUser._id;
  } else {
    return loggedInUser;
  }
}

function setupFakeLocalServer(configForFake, protocol) {
  var fakes = Npm.require("passport-tequila/test/fakes.js"),
    FakeTequilaServer = fakes.TequilaServer;
  if ("port" in configForFake) {
    var https = Npm.require("https");
    var port = configForFake.port;
    console.log("Using fake Tequila server already running at port "
      + port);
    protocol.tequila_host = "localhost";
    protocol.tequila_port = port;
    protocol.agent = new https.Agent({ca: fakes.certificate});
  } else if (configForFake === true) {
    // TODO: This doesn't actually work, because the devDependencies of
    // FakeTequilaServer are not available.
    var fakeTequilaServer = Tequila.fakeLocalServer =
      new FakeTequilaServer();
    Meteor.wrapAsync(fakeTequilaServer.start)();
    console.log("Fake Tequila server listening at " +
      "https://localhost:" + Tequila.fakeTequilaServer.port + "/");
    _.extend(protocol, fakeTequilaServer.getOptions());
  } else {
    throw new Error("setupFakeLocalServer: " +
      "unable to determine what to do for config " + configForFake);
  }
}
