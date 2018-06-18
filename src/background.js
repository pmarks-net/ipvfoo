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
wR.onResponseStarted (where the IP address is available), and to maintain
the highlighted cell when a connection is open.  A map entry lives from
onBeforeRequest until wR.onCompleted or wR.onErrorOccurred.

An entry in tabMap tries to approximate one "page view".  It begins in
wR.onBeforeRequest(main_frame), and goes away either when another page
begins, or when the tab ceases to exist (see TabTracker for details.)

Icon updates begin once TabTracker succeeds AND (
    wR.onResponseStarted reports the first IP address OR
    wN.onCommitted fires).
Note that we'd like to avoid flashing '?' during a page load.

Popup updates begin sooner, in wR.onBeforeRequest(main_frame), because the
user can demand a popup before any IP addresses are available.
*/

// Returns an Object with no default properties.
function newMap() {
  return Object.create(null);
}

// requestId -> {tabInfo, domain}
const requestMap = newMap(); 

// tabId -> TabInfo
const tabMap = newMap();

// Images from spritesXX.png: [x, y, w, h]
const spriteBig = {
  "4": {16: [1, 1, 9, 14],
        32: [1, 1, 21, 28]},
  "6": {16: [11, 1, 9, 14],
        32: [23, 1, 21, 28]},
  "?": {16: [21, 1, 9, 14],
        32: [45, 1, 21, 28]},
};
const spriteSmall = {
  "4": {16: [31, 1, 6, 6],
        32: [67, 1, 10, 10]},
  "6": {16: [31, 8, 6, 6],
        32: [67, 12, 10, 10]},
};

// Destination coordinates: [x, y]
const targetBig = {
  16: [0, 1],
  32: [0, 2],
};
const targetSmall1 = {
  16: [10, 1],
  32: [22, 2],
};
const targetSmall2 = {
  16: [10, 8],
  32: [22, 14],
};

// Possible states for an instance of TabInfo.
// We begin at BIRTH, and only ever move forward, not backward.
const TAB_BIRTH = 0;    // Waiting for TabTracker onConnect
const TAB_ALIVE = 1;    // Waiting for TabTracker onDisconnect
const TAB_DELETED = 2;  // Dead.

// RequestFilter for webRequest events.
const FILTER_ALL_URLS = { urls: ["<all_urls>"] };

// Simple whitelist of IP address characters.
const IP_CHARS = /^[0-9A-Fa-f:.]+$/;

// Load spriteXX.png of a particular size.
// Executing this inline ensures that the images load before
// firing the onload handler.
function loadSpriteImg(size) {
  const s = document.createElement("img");
  s.src = "sprites" + size + ".png";
  return s;
}
const spriteImg = {
  16: loadSpriteImg(16),
  32: loadSpriteImg(32),
};

// Get a <canvas> element of the given size.  We could get away with just one,
// but seeing them side-by-side helps with multi-DPI debugging.
const canvasElements = newMap();
function getCanvasContext(size) {
  let c = canvasElements[size];
  if (!c) {
    c = canvasElements[size] = document.createElement("canvas");
    c.width = c.height = size;
    document.body.appendChild(c);
  }
  return c.getContext("2d");
}

// pattern is 0..3 characters, each '4', '6', or '?'.
// size is 16 or 32.
// color is "lightfg" or "darkfg".
function buildIcon(pattern, size, color) {
  const ctx = getCanvasContext(size);
  ctx.clearRect(0, 0, size, size);
  if (pattern.length >= 1) {
    drawSprite(ctx, size, targetBig, spriteBig[pattern.charAt(0)]);
  }
  if (pattern.length >= 2) {
    drawSprite(ctx, size, targetSmall1, spriteSmall[pattern.charAt(1)]);
  }
  if (pattern.length >= 3) {
    drawSprite(ctx, size, targetSmall2, spriteSmall[pattern.charAt(2)]);
  }
  const imageData = ctx.getImageData(0, 0, size, size);
  if (color == "lightfg") {
    // Apply the light foreground color.
    const px = imageData.data;
    const floor = 128;
    for (var i = 0; i < px.length; i += 4) {
      px[i+0] += floor;
      px[i+1] += floor;
      px[i+2] += floor;
    }
  }
  return imageData;
}

function drawSprite(ctx, size, targets, sources) {
  const source = sources[size];
  const target = targets[size];
  // (image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
  ctx.drawImage(spriteImg[size],
                source[0], source[1], source[2], source[3],
                target[0], target[1], source[2], source[3]);
}

// In theory, we should be using a full-blown subnet parser/matcher here,
// but let's keep it simple and stick with text for now.
function addrToVersion(addr) {
  if (addr) {
    if (/^64:ff9b::/.test(addr)) return "4";  // RFC6052
    if (addr.indexOf(".") >= 0) return "4";
    if (addr.indexOf(":") >= 0) return "6";
  }
  return "?";
}

function parseUrl(url) {
  let domain = null;
  let ssl = false;
  let ws = false;

  const a = document.createElement("a");
  a.href = url;
  if (a.protocol == "file:") {
    domain = "file://";
  } else if (a.protocol == "chrome:") {
    domain = "chrome://";
  } else {
    domain = a.hostname || "";
    switch (a.protocol) {
      case "https:":
        ssl = true;
        break;
      case "wss:":
        ssl = true;
        // fallthrough
      case "ws:":
        ws = true;
        break;
    }
  }
  return { domain: domain, ssl: ssl, ws: ws, origin: a.origin };
}

// -- TabInfo --

const TabInfo = function(tabId) {
  this.tabId = tabId;
  this.state = TAB_BIRTH;     // See the TAB_* constants above.
  this.mainDomain = "";       // Bare domain from the main_frame request.
  this.mainOrigin = "";       // Origin from the main_frame request.
  this.dataExists = false;    // True if we have data to publish.
  this.committed = false;     // True if onCommitted has fired.
  this.domains = newMap();    // Updated whenever we get some IPs.
  this.spillCount = 0;        // How many requests didn't fit in domains.
  this.lastPattern = "";      // To avoid redundant icon redraws.
  this.lastTooltip = "";      // To avoid redundant tooltip updates.
  this.accessDenied = false;  // webRequest events aren't permitted.
  this.color = "regularColorScheme";  // ... or incognitoColorScheme.

  // First, clean up the previous TabInfo, if any.
  tabTracker.disconnect(tabId);
  if (tabMap[tabId]) throw "Duplicate entry in tabMap";
  tabMap[tabId] = this;

  // Start polling for the tab's existence.
  const that = this;
  tabTracker.connect(tabId, function() {
    // onConnect: Yay, the tab exists; maybe give it an icon.
    if (that.state != TAB_BIRTH) throw "Unexpected onConnect!";
    that.state = TAB_ALIVE;
    that.updateIcon();
  }, function() {
    // onDisconnect: Tell in-flight requests/timeouts to ignore this instance.
    if (that.state == TAB_DELETED) throw "Redundant onDisconnect!";
    that.state = TAB_DELETED;
    delete tabMap[that.tabId];
  });
};

TabInfo.prototype.setInitialDomain = function(domain, origin) {
  this.mainDomain = domain;
  this.mainOrigin = origin;

  // If anyone's watching, show some preliminary state.
  popups.pushAll(this.tabId);
};

TabInfo.prototype.setCommitted = function(domain, origin) {
  if (this.state == TAB_DELETED) throw "Impossible";

  const oldState = [this.accessDenied, this.mainDomain];

  if (origin != this.mainOrigin) {
    // We never saw a main_frame webRequest for this page, so it must've
    // been blocked by some policy.  Wipe all the state to avoid reporting
    // misleading information.  Known cases where this can occur:
    // - chrome:// URLs
    // - file:// URLs (when "allow" is unchecked)
    // - Pages in the Chrome Web Store
    this.domains = newMap();
    this.spillCount = 0;
    this.accessDenied = true;
  }

  this.mainDomain = domain;
  this.dataExists = true;
  this.committed = true;

  // This is usually redundant, but lastPattern takes care of it.
  this.updateIcon();

  // If the table contents changed, then redraw it.
  const newState = [this.accessDenied, this.mainDomain];
  if (oldState.toString() != newState.toString()) {
    popups.pushAll(this.tabId);
  }
};

// If the pageAction is supposed to be visible now, then draw it again.
TabInfo.prototype.refreshPageAction = function() {
  this.lastPattern = "";
  this.lastTooltip = "";
  this.updateIcon();
};

TabInfo.prototype.addDomain = function(domain, addr, flags) {
  if (this.state == TAB_DELETED) throw "Impossible";

  const oldDomainInfo = this.domains[domain];
  let connCount = null;
  flags |= FLAG_CONNECTED;

  if (!oldDomainInfo) {
    // Limit the number of domains per page, to avoid wasting RAM.
    if (Object.keys(this.domains).length >= 256) {
      popups.pushSpillCount(this.tabId, ++this.spillCount);
      return;
    }
    // Run this after the last connection goes away.
    const that = this;
    connCount = new ConnectionCounter(function() {
      if (that.state == TAB_DELETED) {
        return;
      }
      const d = that.domains[domain];
      if (d) {
        d.flags &= ~FLAG_CONNECTED;
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
  this.dataExists = true;

  this.updateIcon();
  popups.pushOne(this.tabId, domain, addr, flags);
};

TabInfo.prototype.disconnectDomain = function(domain) {
  const d = this.domains[domain];
  if (d) {
    d.connCount.down();
  }
};

TabInfo.prototype.updateIcon = function() {
  if (!(this.state == TAB_ALIVE && this.dataExists)) {
    return;
  }
  const domains = Object.keys(this.domains);
  let pattern = "?";
  let has4 = false;
  let has6 = false;
  let tooltip = "";
  for (const domain of domains) {
    const addr = this.domains[domain].addr;
    const version = addrToVersion(addr);
    if (domain == this.mainDomain) {
      pattern = version;
      tooltip = addr + " - IPvFoo";
    } else {
      switch (version) {
        case "4": has4 = true; break;
        case "6": has6 = true; break;
      }
    }
  }
  if (has4) pattern += "4";
  if (has6) pattern += "6";

  // Don't waste time rewriting the same tooltip.
  if (this.lastTooltip != tooltip) {
    chrome.pageAction.setTitle({
      "tabId": this.tabId,
      "title": tooltip,
    });
    this.lastTooltip = tooltip;
  }

  // Don't waste time redrawing the same icon.
  if (this.lastPattern == pattern) {
    return;
  }
  this.lastPattern = pattern;

  const color = options[this.color];
  chrome.pageAction.setIcon({
    "tabId": this.tabId,
    "imageData": {
      // Note: It might be possible to avoid redundant operations by reading
      //       window.devicePixelRatio
      "16": buildIcon(pattern, 16, color),
      "32": buildIcon(pattern, 32, color),
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
  if (this.state == TAB_DELETED) throw "Impossible";

  const mainDomain = this.mainDomain || "---";
  if (this.accessDenied) {
    return [[mainDomain, "(access denied)", "?", FLAG_UNCACHED]];
  }
  const domains = Object.keys(this.domains).sort();
  const mainTuple = [mainDomain, "(no address)", "?", 0];
  const tuples = [mainTuple];
  for (const domain of domains) {
    const addr = this.domains[domain].addr;
    const version = addrToVersion(addr);
    const flags = this.domains[domain].flags;
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

// -- ConnectionCounter --
// This class counts the number of active connections to a particular domain.
// Whenever the count reaches zero, run the onZero function.  This will remove
// the highlight from the popup.  The timer enforces a minimum hold time.

const ConnectionCounter = function(onZero) {
  this.onZero = onZero;
  this.count = 0;
  this.timer = null;
};

ConnectionCounter.prototype.up = function() {
  const that = this;
  if (++that.count == 1 && !that.timer) {
    that.timer = setTimeout(function() {
      that.timer = null;
      if (that.count == 0) {
        that.onZero();
      }
    }, 500);
  }
};

ConnectionCounter.prototype.down = function() {
  if (!(this.count > 0)) throw "Count went negative!";
  if (--this.count == 0 && !this.timer) {
    this.onZero();
  }
};

// -- Popups --

// This class keeps track of the visible popup windows,
// and streams changes to them as they occur.
const Popups = function() {
  this.map = newMap();      // tabId -> popup window
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
  const that = this;
  setTimeout(function() {
    // Find all the tabs with active popups.
    const popupTabs = newMap();
    const popups = chrome.extension.getViews({type:"popup"});
    for (const popup of popups) {
      popupTabs[popup.tabId] = true;
    }

    // Drop references to the inactive popups.
    const storedTabs = Object.keys(that.map);
    for (const tabId of storedTabs) {
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
  const win = this.map[tabId];
  const tabInfo = tabMap[tabId];
  if (win && tabInfo) {
    win.pushAll(tabInfo.getTuples(), tabInfo.spillCount);
  }
};

Popups.prototype.pushOne = function(tabId, domain, addr, flags) {
  const win = this.map[tabId];
  if (win) {
    win.pushOne([domain, addr, addrToVersion(addr), flags]);
  }
};

Popups.prototype.pushSpillCount = function(tabId, count) {
  const win = this.map[tabId];
  if (win) {
    win.pushSpillCount(count);
  }
};

window.popups = new Popups();

// -- TabTracker --

// This class keeps track of every usable tabId, sending notifications when a
// tab appears or disappears.
//
// Rationale:
//
// Sometimes a webRequest event belongs to a hidden tab (e.g. for a pre-rendered
// page), and we can't set a pageAction on it until it becomes visible.
// However, hidden tabs may vanish without a trace, so the best we can really
// do is set a timer, and abandon hope if it doesn't appear.
//
// Once a tab has become visible, then hopefully we can rely on the onRemoved
// event to fire sometime in the future, when the user closes it.
const TabTracker = function() {
  this.tabSet = newMap();               // Set of all known tabIds
  this.timers = newMap();               // tabId -> clearTimeout key
  this.connectCallbacks = newMap();     // tabId -> onConnect callback
  this.disconnectCallbacks = newMap();  // tabId -> onDisconnect callback

  const that = this;
  chrome.tabs.onCreated.addListener(function(tab) {
    that.addTab_(tab.id, "onCreated");
  });
  chrome.tabs.onRemoved.addListener(function(tabId) {
    that.removeTab_(tabId, "onRemoved");
  });
  chrome.tabs.onReplaced.addListener(function(addId, removeId) {
    that.removeTab_(removeId, "onReplaced");
    that.addTab_(addId, "onReplaced");
  });
  this.pollAllTabs_();
};

// Begin watching this tabId.  If the tab exists, then onConnect fires
// immediately (or within 30 seconds), otherwise onDisconnect fires to indicate
// failure.  After a successful connection, onDisconnect fires when the tab
// finally does go away.
TabTracker.prototype.connect = function(tabId, onConnect, onDisconnect) {
  if (tabId in this.timers ||
      tabId in this.connectCallbacks ||
      tabId in this.disconnectCallbacks) {
    throw "Duplicate connection: " + tabId;
  }
  this.connectCallbacks[tabId] = onConnect;
  this.disconnectCallbacks[tabId] = onDisconnect;
  if (tabId in this.tabSet) {
    // Connect immediately.
    this.finishConnect_(tabId);
  } else {
    // Disconnect if the tab doesn't appear within 30 seconds.
    const that = this;
    this.timers[tabId] = setTimeout(function() {
      that.disconnect(tabId);
    }, 30000);
  }
};

// If a watcher is bound to this tabId, then disconnect it.
TabTracker.prototype.disconnect = function(tabId) {
  const timer = this.timers[tabId];
  const onDisconnect = this.disconnectCallbacks[tabId];
  delete this.timers[tabId];
  delete this.connectCallbacks[tabId];
  delete this.disconnectCallbacks[tabId];
  if (timer) {
    clearTimeout(timer);
  }
  if (onDisconnect) {
    onDisconnect();
  }
};

// If a watcher is waiting for this tabId, then connect it.
TabTracker.prototype.finishConnect_ = function(tabId) {
  const timer = this.timers[tabId];
  const onConnect = this.connectCallbacks[tabId];
  delete this.timers[tabId];
  delete this.connectCallbacks[tabId];
  if (timer) {
    clearTimeout(timer);
  }
  if (onConnect) {
    if (!this.disconnectCallbacks[tabId]) {
      throw "onConnect requires an onDisconnect!";
    }
    onConnect();
  }
};

// Given two set-like objects, return "a - b".
function subtractSets(a, b) {
  const out = [];
  for (x in a) if (!(x in b)) {
    out.push(x);
  }
  return out;
}

// Get the set of all known tabs, and synchronize our state by calling
// add/remove on the differences.  After the startup run, this should ideally
// become a no-op, provided that the events are all firing as expected.
// But just in case, repeat every few minutes to check for garbage.
TabTracker.prototype.pollAllTabs_ = function() {
  const that = this;
  chrome.tabs.query({}, function(result) {
    const newTabSet = newMap();
    for (const r of result) {
      newTabSet[r.id] = true;
    }
    const toAdd = subtractSets(newTabSet, that.tabSet);
    const toRemove = subtractSets(that.tabSet, newTabSet);
    for (const id of toAdd) {
      that.addTab_(id, "pollAllTabs_");
    }
    for (const id of toRemove) {
      console.log("Removing garbage tab: " + id);
      that.removeTab_(id, "pollAllTabs_");
    }
    // Check again in 5 minutes.
    setTimeout(function() { that.pollAllTabs_() }, 5 * 60000);
  });
};

// Record that this tabId now exists.
TabTracker.prototype.addTab_ = function(tabId, logText) {
  this.tabSet[tabId] = true;
  this.finishConnect_(tabId);
};

// Record that this tabId no longer exists.
TabTracker.prototype.removeTab_ = function(tabId, logText) {
  delete this.tabSet[tabId];
  this.disconnect(tabId);
};

const tabTracker = new TabTracker();

// -- webNavigation --

chrome.webNavigation.onCommitted.addListener(function(details) {
  if (details.frameId != 0) {
    return;
  }
  const parsed = parseUrl(details.url);
  const tabInfo = tabMap[details.tabId] || new TabInfo(details.tabId);
  tabInfo.setCommitted(parsed.domain, parsed.origin);
});

// -- tabs --

// Whenever anything tab-related happens, try to refresh the pageAction.  This
// is hacky and inefficient, but the back-stabbing browser leaves me no choice.
// This seems to fix http://crbug.com/124970 and some problems on Google+.
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  const tabInfo = tabMap[tabId];
  if (tabInfo) {
    tabInfo.color = tab.incognito ?
        "incognitoColorScheme" : "regularColorScheme";
    tabInfo.refreshPageAction();
  }
});

// -- webRequest --

chrome.webRequest.onBeforeRequest.addListener(function (details) {
  if (!details.tabId || details.tabId == -1) {
    // This request isn't related to a tab.
    return;
  }
  if (details.type == "main_frame") {
    const parsed = parseUrl(details.url);
    new TabInfo(details.tabId).setInitialDomain(
        parsed.domain, parsed.origin);
  }
  const tabInfo = tabMap[details.tabId];
  if (!tabInfo) {
    return;
  }
  requestMap[details.requestId] = {
    tabInfo: tabInfo,
    domain: null,
  };
}, FILTER_ALL_URLS);

// In the event of an HSTS redirect, the mainOrigin may change
// (from http: to https:) between the onBeforeRequest and onCommitted events,
// triggering an "access denied" error.  We use onSendHeaders to patch this,
// because it fires in between, providing the correct origin.
//
// However, we must treat this event as optional, because file:// and
// ServiceWorker URLs are known to skip over it.
chrome.webRequest.onSendHeaders.addListener(function (details) {
  if (details.type != "main_frame") {
    return;
  }
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  const tabInfo = requestInfo.tabInfo;
  if (tabInfo.state == TAB_DELETED) {
    return;
  }
  if (tabInfo.committed) {
    throw "onCommitted before onSendHeaders!";
  }
  const parsed = parseUrl(details.url);
  tabInfo.setInitialDomain(parsed.domain, parsed.origin);
}, FILTER_ALL_URLS);

chrome.webRequest.onResponseStarted.addListener(function (details) {
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo ||
      requestInfo.tabInfo.state == TAB_DELETED ||
      requestInfo.tabInfo.accessDenied) {
    return;
  }
  const parsed = parseUrl(details.url);
  if (!parsed.domain) {
    return;
  }
  const addr = details.ip || "(no address)";

  let flags = parsed.ssl ? FLAG_SSL : FLAG_NOSSL;
  if (parsed.ws) {
    flags |= FLAG_WEBSOCKET;
  }
  if (!details.fromCache) {
    flags |= FLAG_UNCACHED;
  }
  if (requestInfo.domain) throw "Duplicate onResponseStarted!";
  requestInfo.domain = parsed.domain;
  requestInfo.tabInfo.addDomain(parsed.domain, addr, flags);
}, FILTER_ALL_URLS);

function forgetRequest(details) {
  const requestInfo = requestMap[details.requestId];
  delete requestMap[details.requestId];
  if (requestInfo && requestInfo.domain) {
    requestInfo.tabInfo.disconnectDomain(requestInfo.domain);
    requestInfo.domain = null;
  }
};
chrome.webRequest.onCompleted.addListener(forgetRequest, FILTER_ALL_URLS);
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, FILTER_ALL_URLS);

// -- contextMenus --

// When the user right-clicks an IP address in the popup window, add a menu
// item to look up the address on bgp.he.net.  I don't like picking favorites,
// so I'm open to making this a config option if someone recommends another
// useful non-spammy service.
let menuIsEnabled = false;
const menuId = chrome.contextMenus.create({
  enabled: menuIsEnabled,
  title: "Look up address on bgp.he.net",
  // Scope the menu to text selection in our popup windows.
  contexts: ["selection"],
  documentUrlPatterns: [document.location.origin + "/popup.html"],
  onclick: function(info) {
    const text = info.selectionText;
    if (IP_CHARS.test(text)) {
      chrome.tabs.create({url: "http://bgp.he.net/ip/" + text});
    }
  }
});

// Enable the context menu iff the text might be an IP address.  I think it's
// technically a race to do this from a contextmenu handler, but trivial updates
// seem to work okay.  http://crbug.com/60758 would be helpful here.
function updateContextMenu(text) {
  const enabled = IP_CHARS.test(text);
  if (enabled == menuIsEnabled) {
    return;
  }
  chrome.contextMenus.update(menuId, {enabled: enabled});
  menuIsEnabled = enabled;
}


// -- Options Storage --

const DEFAULT_OPTIONS = {
  regularColorScheme: "darkfg",
  incognitoColorScheme: "lightfg",
};

function setOptions(newOptions, onDone) {
  const added = subtractSets(newOptions, options);
  const removed = subtractSets(options, newOptions);
  if (added.length > 0) {
    throw "Unexpected options: " + added;
  }
  if (removed.length > 0) {
    throw "Missing options: " + removed;
  }
  chrome.storage.sync.set(newOptions, function() {
    loadOptions(onDone);
  });
}

function clearOptions(onDone) {
  chrome.storage.sync.clear(function() {
    loadOptions(onDone);
  });
}

function loadOptions(onDone) {
  chrome.storage.sync.get(Object.keys(options), function(items) {
    for (const option of Object.keys(options)) {
      const optValue = items[option] || DEFAULT_OPTIONS[option];
      if (optValue == options[option]) {
        continue;
      }
      options[option] = optValue;

      if (option.endsWith("ColorScheme")) {
        for (const tabId of Object.keys(tabMap)) {
          const tabInfo = tabMap[tabId];
          if (tabInfo.color == option) {
            tabInfo.refreshPageAction();
          }
        }
      }
    }

    onDone();
  });
}

// Use DEFAULT_OPTIONS until loading completes.
window.options = {};
for (const option of Object.keys(DEFAULT_OPTIONS)) {
  options[option] = DEFAULT_OPTIONS[option];
}
loadOptions(function() {});
