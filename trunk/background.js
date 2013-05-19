/*
Copyright (C) 2011  Paul Marks  http://www.pmarks.net/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
Lifecycle documentation:

The purpose of requestMap is to copy tabInfo from wR.onBeforeRequest to
wR.onResponseStarted (where the IP address is available.)  A map entry
normally begins/ends with these two calls, but it could also be deleted
in wR.onCompleted or wR.onErrorOccurred if something bad happens.

An entry in tabMap tries to approximate one "page view".  It begins in
wR.onBeforeRequest(main_frame), and goes away either when another page
begins, or when the tab ceases to exist (see pollForTabDeath for details.)

UI updates begin in wN.onCommitted, which (hopefully) comes after
wR.onResponseStarted(main_frame).  Updates continue as new requests are made,
and stop in wR.onBeforeRequest(main_frame), i.e. the next page load.

Notes:
- I considered starting the UI updates in wR.onCompleted(main_frame), but
  that sometimes fires too early, and the icon gets erased.  Thus,
  wN.onCommitted is the best "start drawing" event I could find.
*/

// requestId -> {tabInfo, isMainFrame}
requestMap = {};

// tabId -> TabInfo
tabMap = {};

// Coordinate multiplier for each icon size
spriteMults = {
  "19": 1,
  "38": 2,
};

// Images from sprites.png: [x, y, w, h]
spriteBig = {
  "4": [1,  1, 12, 16],
  "6": [14, 1, 12, 16],
  "?": [27, 1, 12, 16],
};
spriteSmall = {
  "4": [40, 1, 6, 6],
  "6": [40, 8, 6, 6],
};

// Destination coordinates: [x, y]
targetBig = [1, 2];
targetSmall1 = [13, 2];
targetSmall2 = [13, 9];

// Flags are bitwise-OR'd across all connections to a domain.
FLAG_SSL = 0x1;
FLAG_NOSSL = 0x2;
FLAG_UNCACHED = 0x4;
FLAG_CONNECTED = 0x8;

// Possible states for an instance of TabInfo.
// We begin at NEW, and only ever move forward, not backward.
TAB_NEW = 0;      // New, waiting for onCommitted().
TAB_BIRTH = 1;    // Polling for tabs.get() success.
TAB_ALIVE = 2;    // Polling for tabs.get() failure.
TAB_DELETED = 3;  // Dead.

// RequestFilter for webRequest events.
FILTER_ALL_URLS = { urls: ["<all_urls>"] };

// pattern is 0..3 characters, each '4', '6', or '?'.
// size is either "19" or "38".
function buildIcon(pattern, size) {
  var canvas = document.getElementById("canvas" + size);
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (pattern.length >= 1) {
    drawSprite(ctx, size, targetBig, spriteBig[pattern.charAt(0)]);
  }
  if (pattern.length >= 2) {
    drawSprite(ctx, size, targetSmall1, spriteSmall[pattern.charAt(1)]);
  }
  if (pattern.length >= 3) {
    drawSprite(ctx, size, targetSmall2, spriteSmall[pattern.charAt(2)]);
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function drawSprite(ctx, size, target, source) {
  var m = spriteMults[size];
  // (image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
  ctx.drawImage(document.getElementById("sprites" + size),
                m*source[0], m*source[1], m*source[2], m*source[3],
                m*target[0], m*target[1], m*source[2], m*source[3]);
}

// In theory, we should be using a full-blown subnet parser/matcher here,
// but let's keep it simple and stick with text for now.
function addrToVersion(addr) {
  if (addr) {
    if (addr.match(/^64:ff9b::/)) return "4";  // RFC6052
    if (addr.indexOf(".") >= 0) return "4";
    if (addr.indexOf(":") >= 0) return "6";
  }
  return "?";
}

function parseUrl(url) {
  var domain = null;
  var ssl = false;

  var a = document.createElement("a");
  a.href = url;
  if (a.protocol == 'file:') {
    domain = "file://";
  } else if (a.protocol == 'chrome:') {
    domain = "chrome://";
  } else {
    domain = a.hostname;
    if (a.protocol == 'https:') {
      ssl = true;
    }
  }
  return { domain: domain, ssl: ssl, origin: a.origin };
}

// -- TabInfo --

function pokeTabInfo(tabId, mustBeNew) {
  var oldTabInfo = tabMap[tabId];
  if (oldTabInfo) {
    if (!mustBeNew) {
      return oldTabInfo;
    }
    oldTabInfo.deleteMe();
  }
  return new TabInfo(tabId);
}

TabInfo = function(tabId) {
  this.tabId = tabId;
  this.state = TAB_NEW;       // See the TAB_* constants above.
  this.mainDomain = "";       // Set by wN.onCommitted()
  this.domains = {};          // Updated whenever we get some IPs.
  this.lastPattern = "";      // To avoid redundant icon redraws.
  this.birthPollCount = 15;   // Max number of times to poll for tab birth.
  this.reqOrigin = "";        // Origin of the latest main_frame request.
  this.accessDenied = false;  // webRequest events aren't permitted.

  if (tabMap[tabId]) throw "Duplicate entry in tabMap";
  tabMap[tabId] = this;
};

TabInfo.prototype.setCommitted = function(mainDomain, origin) {
  this.mainDomain = mainDomain;

  if (origin != this.reqOrigin) {
    // We never saw a main_frame webRequest for this page, so it must've
    // been blocked by some policy.  Wipe all the state to avoid reporting
    // misleading information.  Known cases where this can occur:
    // - chrome:// URLs
    // - file:// URLs (when "allow" is unchecked)
    // - Pages in the Chrome Web Store
    this.domains = {};
    this.accessDenied = true;
  }

  if (this.state == TAB_NEW) {
    // Start polling for the tab's existence.
    this.state = TAB_BIRTH;
    this.pollForBirth();
  }
};

// If the pageAction is supposed to be visible now, then draw it again.
TabInfo.prototype.refreshPageAction = function() {
  if (this.state == TAB_ALIVE) {
    this.lastPattern = "";
    this.updateIcon();
  }
};

TabInfo.prototype.addDomain = function(domain, addr, flags) {
  var oldDomainInfo = this.domains[domain];
  var connCount = null;
  flags |= FLAG_CONNECTED;

  if (!oldDomainInfo) {
    // Limit the number of domains per page, to avoid wasting RAM.
    if (Object.keys(this.domains).length >= 100) {
      return;
    }
    // Run this after the last connection goes away.
    var that = this;
    connCount = new ConnectionCounter(function() {
      var d = that.domains[domain];
      if (!d) return;
      d.flags &= ~FLAG_CONNECTED;
      if (that.state == TAB_ALIVE) {
        popups.pushOne(that.tabId, domain, d.addr, d.flags);
      }
    });
    connCount.up();
  } else {
    connCount = oldDomainInfo.connCount;
    connCount.up();
    // Don't allow a cached IP to overwrite an actually-connected IP.
    if (!(flags & FLAG_UNCACHED) && (oldDomainInfo.flags & FLAG_UNCACHED)) {
      addr = oldDomainInfo.addr;
    }
    // Merge in the previous flags.
    flags |= oldDomainInfo.flags;
    // Don't update if nothing has changed.
    if (oldDomainInfo.addr == addr && oldDomainInfo.flags == flags) {
      return;
    }
  }

  this.domains[domain] = {
    addr: addr,
    flags: flags,
    connCount: connCount,
  };

  if (this.state == TAB_ALIVE) {
    this.updateIcon();
    popups.pushOne(this.tabId, domain, addr, flags);
  }
};

TabInfo.prototype.disconnectDomain = function(domain) {
  var d = this.domains[domain];
  if (d) {
    d.connCount.down();
  }
}

TabInfo.prototype.updateIcon = function() {
  var domains = Object.keys(this.domains);
  var pattern = "?";
  var has4 = false;
  var has6 = false;
  for (var i = 0; i < domains.length; i++) {
    var domain = domains[i];
    var addr = this.domains[domain].addr;
    var version = addrToVersion(addr);
    if (domain == this.mainDomain) {
      pattern = version;
    } else {
      switch (version) {
        case "4": has4 = true; break;
        case "6": has6 = true; break;
      }
    }
  }
  if (has4) pattern += "4";
  if (has6) pattern += "6";

  // Don't waste time redrawing the same icon.
  if (this.lastPattern == pattern) {
    return;
  }
  this.lastPattern = pattern;

  chrome.pageAction.setIcon({
    "tabId": this.tabId,
    "imageData": {
      // Note: It might be possible to avoid redundant operations by reading
      //       window.devicePixelRatio
      "19": buildIcon(pattern, "19"),
      "38": buildIcon(pattern, "38"),
    },
  });
  chrome.pageAction.setPopup({
    "tabId": this.tabId,
    "popup": "popup.html#" + this.tabId,
  });
  chrome.pageAction.show(this.tabId);
};

// Build some [domain, addr, version, flags] tuples, for a popup.
TabInfo.prototype.getTuples = function() {
  if (this.accessDenied) {
    return [[this.mainDomain, "(access denied)", "?", FLAG_UNCACHED]];
  }
  var domains = Object.keys(this.domains).sort();
  var mainTuple = [this.mainDomain, "(error?)", "?", 0];
  var tuples = [mainTuple];
  for (var i = 0; i < domains.length; i++) {
    var domain = domains[i];
    var addr = this.domains[domain].addr;
    var version = addrToVersion(addr);
    var flags = this.domains[domain].flags;
    if (domain == mainTuple[0]) {
      mainTuple[1] = addr;
      mainTuple[2] = version;
      mainTuple[3] = flags;
    } else {
      tuples.push([domain, addr, version, flags]);
    }
  }
  return tuples;
};

// Poll a tab until it appears for the first time.  Ideally, tabs.get() would
// always succeed on the first try, but sometimes Chrome gives us a hidden tab
// which we can't manipulate until the user performs some action
// (see http://crbug.com/93646).  However, hidden tabs aren't guaranteed to
// ever appear, so we have to abandon hope after enough attempts.
TabInfo.prototype.pollForBirth = function() {
  var that = this;
  if (that.state != TAB_BIRTH) {
    return;
  }
  chrome.tabs.get(that.tabId, function(tab) {
    if (that.state != TAB_BIRTH) {
      return;
    }
    if (tab) {
      // Yay, the tab exists now; give it an icon.
      that.state = TAB_ALIVE;
      that.updateIcon();
      popups.pushAll(that.tabId);
      that.pollForDeath();
    } else if (--that.birthPollCount >= 0) {
      // This must be a hidden tab; poll again in a second.
      setTimeout(function() { that.pollForBirth() }, 1000);
    } else {
      // Tab is taking too long to appear.  Give up.
      console.log("Tab " + that.tabId + " never appeared.");
      that.deleteMe();
    }
  });
};

// Poll a tab periodically, until it ceases to exist.
//
// After the tab is closed, the following error will appear in the console:
//   "Error during tabs.get: No tab with id: 123."
//
// If http://crbug.com/93646 and http://crbug.com/124353 are ever fixed, then
// we'll be able to switch back to the less-noisy tabs.connect() approach.
TabInfo.prototype.pollForDeath = function() {
  var that = this;
  if (that.state != TAB_ALIVE) {
    return;
  }
  chrome.tabs.get(that.tabId, function(tab) {
    if (that.state != TAB_ALIVE) {
      return;
    }
    if (tab) {
      // Tab still exists.  Check again later.
      setTimeout(function() { that.pollForDeath() }, 15000);
    } else {
      // Tab no longer exists; clean up.
      that.deleteMe();
    }
  });
};

TabInfo.prototype.deleteMe = function() {
  if (this.state == TAB_DELETED) {
    return;
  }

  // Tell any in-flight requests/timeouts to ignore this instance.
  this.state = TAB_DELETED;

  delete tabMap[this.tabId];
};

// -- ConnectionCounter --
// This class counts the number of active connections to a particular domain.
// Whenever the count reaches zero, run the onZero function.  This will remove
// the highlight from the popup.  The timer enforces a minimum hold time.

ConnectionCounter = function(onZero) {
  this.onZero = onZero;
  this.count = 0;
  this.timer = null;
}

ConnectionCounter.prototype.up = function() {
  var that = this;
  if (++that.count == 1 && !that.timer) {
    that.timer = setTimeout(function() {
      that.timer = null;
      if (that.count == 0) {
        that.onZero();
      }
    }, 500);
  }
}

ConnectionCounter.prototype.down = function() {
  if (!(this.count > 0)) throw "Count went negative!";
  if (--this.count == 0 && !this.timer) {
    this.onZero();
  }
}

// -- Popups --

// This class keeps track of the visible popup windows,
// and streams changes to them as they occur.
Popups = function() {
  this.map = {};            // tabId -> popup window
  this.hasTimeout = false;  // Is the GC scheduled?
};

// Attach a new popup window, and start sending it updates.
Popups.prototype.attachWindow = function(win) {
  this.map[win.tabId] = win;
  this.pushAll(win.tabId);
  this.garbageCollect();
};

// Periodically make sure this.map is a subset of the visible popups.
Popups.prototype.garbageCollect = function() {
  if (this.hasTimeout) {
    return;
  }
  if (Object.keys(this.map).length == 0) {
    return;
  }
  this.hasTimeout = true;
  var that = this;
  setTimeout(function() {
    // Find all the tabs with active popups.
    var popupTabs = {};
    var popups = chrome.extension.getViews({type:"popup"});
    for (var i = 0; i < popups.length; i++) {
      popupTabs[popups[i].tabId] = true;
    }

    // Drop references to the inactive popups.
    var storedTabs = Object.keys(that.map);
    for (var i = 0; i < storedTabs.length; i++) {
      var tabId = storedTabs[i];
      if (!popupTabs[tabId]) {
        delete that.map[tabId];
      }
    }

    // Maybe schedule another run.
    that.hasTimeout = false;
    that.garbageCollect();
  }, 5000);
};

Popups.prototype.pushAll = function(tabId) {
  var win = this.map[tabId];
  var tabInfo = tabMap[tabId];
  if (win && tabInfo) {
    win.pushAll(tabInfo.getTuples());
  }
};

Popups.prototype.pushOne = function(tabId, domain, addr, flags) {
  var win = this.map[tabId];
  if (win) {
    win.pushOne([domain, addr, addrToVersion(addr), flags]);
  }
};

popups = new Popups();

// -- webNavigation --

chrome.webNavigation.onCommitted.addListener(
  function(details) {
    if (details.frameId != 0) {
      return;
    }
    var parsed = parseUrl(details.url);
    pokeTabInfo(details.tabId, false).setCommitted(
        parsed.domain, parsed.origin);
  }
);

// -- tabs --

// Whenever anything tab-related happens, try to refresh the pageAction.  This
// is hacky and inefficient, but the back-stabbing browser leaves me no choice.
// This seems to fix http://crbug.com/124970 and some problems on Google+.
chrome.tabs.onUpdated.addListener(
  function(tabId, changeInfo, tab) {
    var tabInfo = tabMap[tabId];
    if (tabInfo) {
      tabInfo.refreshPageAction();
    }
  }
);

// -- webRequest --

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (!details.tabId || details.tabId == -1) {
      // This request isn't related to a tab.
      return;
    }
    var isMainFrame = (details.type == "main_frame");
    if (isMainFrame) {
      pokeTabInfo(details.tabId, true);
    }
    var tabInfo = tabMap[details.tabId];
    if (!tabInfo) {
      return;
    }
    requestMap[details.requestId] = {
      tabInfo: tabInfo,
      isMainFrame: isMainFrame,
      domain: null,
    };
  },
  FILTER_ALL_URLS
);

chrome.webRequest.onResponseStarted.addListener(
  function (details) {
    var requestInfo = requestMap[details.requestId];
    if (!requestInfo ||
        requestInfo.tabInfo.state == TAB_DELETED ||
        requestInfo.tabInfo.accessDenied) {
      return;
    }
    var parsed = parseUrl(details.url);
    if (requestInfo.isMainFrame) {
      requestInfo.tabInfo.reqOrigin = parsed.origin;
    }
    if (!parsed.domain) {
      return;
    }
    var addr = details.ip || "(no address)";

    var flags = parsed.ssl ? FLAG_SSL : FLAG_NOSSL;
    if (!details.fromCache) {
      flags |= FLAG_UNCACHED;
    }
    if (requestInfo.domain) throw "Duplicate onResponseStarted!";
    requestInfo.domain = parsed.domain;
    requestInfo.tabInfo.addDomain(parsed.domain, addr, flags);
  },
  FILTER_ALL_URLS
);

function forgetRequest(requestId) {
  var requestInfo = requestMap[requestId];
  delete requestMap[requestId];
  if (requestInfo && requestInfo.domain) {
    requestInfo.tabInfo.disconnectDomain(requestInfo.domain);
    requestInfo.domain = null;
  }
  return requestInfo;
};

chrome.webRequest.onCompleted.addListener(
  function(details) {
    forgetRequest(details.requestId);
  },
  FILTER_ALL_URLS
);

chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    var requestInfo = forgetRequest(details.requestId);

    // If the main_frame request failed prior to wN.onCommitted, then we'll
    // probably never get a chance to start the death poller, so just delete
    // this immediately.
    if (requestInfo && requestInfo.isMainFrame &&
        requestInfo.tabInfo.state == TAB_NEW) {
      requestInfo.tabInfo.deleteMe();
    }
  },
  FILTER_ALL_URLS
);
