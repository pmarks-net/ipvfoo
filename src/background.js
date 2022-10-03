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

"use strict";
importScripts("common.js");

/*
(async () => {
  const bootTime = Date.now();
  const key = `heartbeat/${bootTime}`;
  while (true) {
    const msg = `service_worker running for ${(Date.now()-bootTime)/1000}s`;
    chrome.storage.local.set({[key]: msg});
    console.log(msg);
    await sleep(10000);
  }
})();
*/

// Possible states for an instance of TabInfo.
// We begin at BIRTH, and only ever move forward, not backward.
const TAB_BIRTH = 0;    // Waiting for makeAlive() or makeDead()
const TAB_ALIVE = 1;    // Waiting for makeDead()
const TAB_DEAD = 2;

// RequestFilter for webRequest events.
const FILTER_ALL_URLS = { urls: ["<all_urls>"] };

// Distinguish IP address and domain name characters.
// Note that IP6_CHARS must not match "beef.de"
const IP4_CHARS = /^[0-9.]+$/;
const IP6_CHARS = /^[0-9A-Fa-f]*:[0-9A-Fa-f:.]*$/;
const DNS_CHARS = /^[0-9A-Za-z._-]+$/;

function parseUrl(url) {
  let domain = null;
  let ssl = false;
  let ws = false;

  const u = new URL(url);
  if (u.protocol == "file:") {
    domain = "file://";
  } else if (u.protocol == "chrome:") {
    domain = "chrome://";
  } else {
    domain = u.hostname || "";
    switch (u.protocol) {
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
  return { domain: domain, ssl: ssl, ws: ws, origin: u.origin };
}

class SaveableEntry {
  #prefix;
  #id;
  #dirty = false;
  #remove = false;
  #savedJSON = null;

  constructor(prefix, id) {
    if (!prefix) throw "missing prefix";
    if (!id) throw "missing id";
    this.#prefix = prefix;
    this.#id = id;
  }

  id() { return this.#id; }

  load(j) {
    this.#savedJSON = j;
    for (const [k, v] of Object.entries(JSON.parse(j))) {
      if (this.hasOwnProperty(k)) {
        this[k] = v;
      } else {
        console.error("skipping unknown key", k);
      }
    }
    return this;
  }

  // Limit to 1 in-flight chrome.storage operation per key.
  // No need to await.
  async save() {
    if (this.#dirty) {
      return;  // Already saving.
    }
    this.#dirty = true;
    await null;  // Let the caller finish first.
    while (this.#dirty) {
      this.#dirty = false;
      const key = `${this.#prefix}${this.#id}`
      if (this.#remove) {
        await chrome.storage.local.remove(key);
        return;
      }
      const j = JSON.stringify(this);
      if (this.#savedJSON == j) {
        return;
      }
      //console.log("saving", key, j);
      await chrome.storage.local.set({[key]: j});
      this.#savedJSON = j;
    }
  }

  // No need to await.
  async remove() {
    this.#remove = true;
    await this.save();
  }
}

class SaveableMap {
  #factory;
  #prefix;

  constructor(factory, prefix) {
    this.#factory = factory;
    this.#prefix = prefix;
  }

  validateId(id) {
    const idNumeric = parseInt(id, 10);
    if (!idNumeric) {
      throw `malformed id: ${id}`;
    }
    return idNumeric;
  }

  load(key, savedJSON) {
    if (!key.startsWith(this.#prefix)) {
      return false;
    }
    const suffix = key.slice(this.#prefix.length);
    let id;
    try {
      id = this.validateId(suffix);
    } catch(err) {
      console.error(err);
      return false;
    }
    this[id] = new this.#factory(this.#prefix, id).load(savedJSON);
    return true;
  }

  lookupOrNew(id) {
    id = this.validateId(id);
    let o = this[id];
    if (!o) {
      o = this[id] = new this.#factory(this.#prefix, id);
    }
    return o;
  }

  remove(id) {
    id = this.validateId(id);
    const o = this[id];
    if (o) {
      delete this[id];
      o.remove();
    }
    return o;
  }
}

// -- TabInfo --

class TabInfo extends SaveableEntry {
  born = Date.now();     // For TabTracker timeout.
  mainDomain = "";       // Bare domain from the main_frame request.
  mainOrigin = "";       // Origin from the main_frame request.
  dataExists = false;    // True if we have data to publish.
  committed = false;     // True if onCommitted has fired.
  domains = newMap();    // Updated whenever we get some IPs.
  spillCount = 0;        // How many requests didn't fit in domains.
  lastPattern = "";      // To avoid redundant icon redraws.
  lastTooltip = "";      // To avoid redundant tooltip updates.
  color = "regularColorScheme";  // ... or incognitoColorScheme.

  // Private, to avoid writing to storage.
  #state = TAB_BIRTH;

  constructor(prefix, tabId) {
    super(prefix, tabId);

    if (!spriteImg.ready) throw "must await spriteImgReady!";
    if (!options.ready) throw "must await optionsReady!";

    if (tabMap[tabId]) throw "Duplicate entry in tabMap";
    if (tabTracker.exists(tabId)) {
      this.makeAlive();
    }
  }

  afterLoad() {
    for (const [domain, json] of Object.entries(this.domains)) {
      this.domains[domain] = DomainInfo.fromJSON(this, domain, json);
    }
  }

  tooYoungToDie() {
    // Spare new tabs from garbage collection for a minute or so.
    return (this.#state == TAB_BIRTH &&
            this.born >= Date.now() - 60 * 1000);
  }

  makeAlive() {
    if (this.#state != TAB_BIRTH) {
      return;
    }
    this.#state = TAB_ALIVE;
    this.updateIcon();
  }

  makeDead() {
    this.#state = TAB_DEAD;
    this.domains = newMap();
  }

  setInitialDomain(domain, origin) {
    this.mainDomain = domain;
    this.mainOrigin = origin;

    // If anyone's watching, show some preliminary state.
    this.pushAll();
    this.save();
  }

  setCommitted(domain, origin) {
    let changed = false;

    if (origin != this.mainOrigin) {
      // We never saw a main_frame webRequest for this page, so it must've
      // been blocked by some policy.  Wipe previous state to avoid reporting
      // misleading information.  Known cases where this can occur:
      // - chrome:// URLs
      // - file:// URLs (when "allow" is unchecked)
      // - Pages in the Chrome Web Store
      // - Pages generated by a service worker
      //
      // This case used to show (access denied), but it seems more useful
      // to report (no address) for the main domain, and continue tracking
      // subsequent requests.
      this.domains = newMap();
      this.spillCount = 0;
      changed = true;
    }

    if (this.mainDomain != domain) {
      this.mainDomain = domain;
      changed = true;
    }
    this.dataExists = true;
    this.committed = true;

    // This is usually redundant, but lastPattern takes care of it.
    this.updateIcon();

    // If the table contents changed, then redraw it.
    if (changed) {
      this.pushAll();
    }

    this.save();
  }

  // If the pageAction is supposed to be visible now, then draw it again.
  refreshPageAction() {
    this.lastTooltip = "";
    this.lastPattern = "";
    this.updateIcon();
    this.save();
  }

  addDomain(domain, addr, flags) {
    let d = this.domains[domain];
    if (!d) {
      // Limit the number of domains per page, to avoid wasting RAM.
      if (Object.keys(this.domains).length >= 256) {
        popups.pushSpillCount(this.id(), ++this.spillCount);
        return;
      }
      d = this.domains[domain] =
          new DomainInfo(this, domain, addr || "(lost)", flags);
      d.countUp();
    } else {
      const oldAddr = d.addr;
      const oldFlags = d.flags;
      // Don't allow a cached IP to overwrite an actually-connected IP.
      if (addr && ((flags & FLAG_UNCACHED) || !(oldFlags & FLAG_UNCACHED))) {
        d.addr = addr;
      }
      // Merge in the previous flags.
      d.flags |= flags;
      d.countUp();
      // Don't update if nothing has changed.
      if (d.addr == oldAddr && d.flags == oldFlags) {
        return;
      }
    }

    this.dataExists = true;
    this.updateIcon();
    this.pushOne(domain);
    this.save();
  }

  updateIcon() {
    if (!(this.#state == TAB_ALIVE && this.dataExists)) {
      return;
    }
    let pattern = "?";
    let has4 = false;
    let has6 = false;
    let tooltip = "";
    for (const [domain, d] of Object.entries(this.domains)) {
      if (domain == this.mainDomain) {
        pattern = d.addrVersion();
        tooltip = `${d.addr} - IPvFoo`;
      } else {
        switch (d.addrVersion()) {
          case "4": has4 = true; break;
          case "6": has6 = true; break;
        }
      }
    }
    if (has4) pattern += "4";
    if (has6) pattern += "6";

    // Don't waste time rewriting the same tooltip.
    if (this.lastTooltip != tooltip) {
      chrome.action.setTitle({
        "tabId": this.id(),
        "title": tooltip,
      });
      this.lastTooltip = tooltip;
      this.save();
    }

    // Don't waste time redrawing the same icon.
    if (this.lastPattern != pattern) {
      const color = options[this.color];
      chrome.action.setIcon({
        "tabId": this.id(),
        "imageData": {
          "16": buildIcon(pattern, 16, color),
          "32": buildIcon(pattern, 32, color),
        },
      });
      chrome.action.setPopup({
        "tabId": this.id(),
        "popup": `popup.html#${this.id()}`,
      });
      this.lastPattern = pattern;
      this.save();
    }
  }

  pushAll() {
    popups.pushAll(this.id(), this.getTuples(), this.spillCount);
  }

  pushOne(domain) {
    popups.pushOne(this.id(), this.getTuple(domain));
  }

  // Build some [domain, addr, version, flags] tuples, for a popup.
  getTuples() {
    const mainDomain = this.mainDomain || "---";
    const domains = Object.keys(this.domains).sort();
    const mainTuple = [mainDomain, "(no address)", "?", FLAG_UNCACHED];
    const tuples = [mainTuple];
    for (const domain of domains) {
      const d = this.domains[domain];
      if (domain == mainTuple[0]) {
        mainTuple[1] = d.addr;
        mainTuple[2] = d.addrVersion();
        mainTuple[3] = d.flags;
      } else {
        tuples.push([domain, d.addr, d.addrVersion(), d.flags]);
      }
    }
    return tuples;
  }

  // Build [domain, addr, version, flags] tuple, for a popup.
  getTuple(domain) {
    const d = this.domains[domain];
    if (!d) {
      // Perhaps this.domains was cleared during the request's lifetime.
      return null;
    }
    return [domain, d.addr, d.addrVersion(), d.flags];
  }
}

class DomainInfo {
  tabInfo;
  domain;
  addr;
  flags;

  count = 0;  // count of active requests
  inhibitZero = false;

  constructor(tabInfo, domain, addr, flags) {
    this.tabInfo = tabInfo;
    this.domain = domain;
    this.addr = addr;
    this.flags = flags;
  }

  // count and FLAG_CONNECTED will be computed from requestMap.
  toJSON() {
    return [this.addr, this.flags & ~FLAG_CONNECTED];
  }

  static fromJSON(tabInfo, domain, json) {
    const [addr, flags] = json;
    return new DomainInfo(tabInfo, domain, addr, flags);
  }

  // In theory, we should be using a full-blown subnet parser/matcher here,
  // but let's keep it simple and stick with text for now.
  addrVersion() {
    if (this.addr) {
      if (/^64:ff9b::/.test(this.addr)) return "4";  // RFC6052
      if (this.addr.indexOf(".") >= 0) return "4";
      if (this.addr.indexOf(":") >= 0) return "6";
    }
    return "?";
  }

  async countUp() {
    this.flags |= FLAG_CONNECTED;
    if (++this.count == 1 && !this.inhibitZero) {
      // Keep the address highlighted for at least 500ms.
      this.inhibitZero = true;
      await sleep(500);
      this.inhibitZero = false;
      this.#checkZero();
    }
  }

  countDown() {
    if (!(this.count > 0)) throw "Count went negative!";
    --this.count;
    this.#checkZero();
  }

  #checkZero() {
    if (this.count == 0 && !this.inhibitZero) {
      this.flags &= ~FLAG_CONNECTED;
      this.tabInfo.pushOne(this.domain);
    }
  }
}

class RequestInfo extends SaveableEntry {
  tabId = null;
  tabBorn = null;
  domain = null;

  afterLoad() {
    const tabInfo = tabMap[this.tabId];
    if (tabInfo?.born != this.tabBorn) {
      // In theory this shouldn't happen, because every request terminates
      // with forgetRequest(), but MV3 probably adds chaos.
      requestMap.remove(this.id());
      console.log("garbage-collected RequestInfo", this.id());
      return;
    }
    if (!this.domain) {
      return;  // still waiting for onResponseStarted
    }
    tabInfo.addDomain(this.domain, null, 0);
  }
}

// tabId -> TabInfo
const tabMap = new SaveableMap(TabInfo, "tab/")

// requestId -> {tabInfo, domain}
const requestMap = new SaveableMap(RequestInfo, "req/");

// Must "await storageReady;" before reading maps.
const storageReady = (async () => {
  const items = await chrome.storage.local.get();
  await spriteImgReady;
  await optionsReady;

  const unparseable = [];
  for (const [k, v] of Object.entries(items)) {
    if (!(tabMap.load(k, v) || requestMap.load(k, v))) {
      unparseable.push(k);
    }
  }
  if (unparseable.length) {
    console.error("skipped unparseable keys:", unparseable);
  }
  // Reconsitute the DomainInfo objects and connection counts.
  for (const tabInfo of Object.values(tabMap)) {
    tabInfo.afterLoad();
  }
  for (const requestInfo of Object.values(requestMap)) {
    requestInfo.afterLoad();
  }
})();

// -- Popups --

// This class keeps track of the visible popup windows,
// and streams changes to them as they occur.
class Popups {
  ports = newMap();      // tabId -> Port

  // Attach a new popup window, and start sending it updates.
  attachPort(port) {
    const tabId = port.name;
    this.ports[tabId] = port;
    tabMap[tabId]?.pushAll();
  };

  detachPort(port) {
    const tabId = port.name;
    delete this.ports[tabId];
  };

  pushAll(tabId, tuples, spillCount) {
    this.ports[tabId]?.postMessage({
      cmd: "pushAll",
      tuples: tuples,
      spillCount: spillCount
    });
  };

  pushOne(tabId, tuple) {
    if (!tuple) {
      return;
    }
    this.ports[tabId]?.postMessage({
      cmd: "pushOne",
      tuple: tuple
    });
  };

  pushSpillCount(tabId, count) {
    this.ports[tabId]?.postMessage({
      cmd: "pushSpillCount",
      spillCount: count,
    });
  };

  shake(tabId) {
    this.ports[tabId]?.postMessage({
      cmd: "shake",
    });
  }
}

const popups = new Popups();

chrome.runtime.onConnect.addListener(async (port) => {
  await storageReady;
  popups.attachPort(port);
  port.onDisconnect.addListener(() => {
    popups.detachPort(port);
  });
});

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
class TabTracker {
  tabSet = newMap();               // Set of all known tabIds

  constructor() {
    chrome.tabs.onCreated.addListener((tab) => {
      this.#addTab(tab.id, "onCreated");
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.#removeTab(tabId, "onRemoved");
    });
    chrome.tabs.onReplaced.addListener((addId, removeId) => {
      this.#removeTab(removeId, "onReplaced");
      this.#addTab(addId, "onReplaced");
    });
    this.#pollAllTabs();
  }

  exists(tabId) {
    return !!this.tabSet[tabId];
  }

  // Every 5 minutes (or after a service_worker restart),
  // poke any tabs that have become out of sync.
  async #pollAllTabs() {
    await storageReady;  // load 'born' timestamps first.
    while (true) {
      const result = await chrome.tabs.query({});
      this.tabSet = newMap();
      for (const tab of result) {
        this.#addTab(tab.id, "pollAlltabs")
      }
      for (const tabId of Object.keys(tabMap)) {
        if (!this.tabSet[tabId]) {
          this.#removeTab(tabId, "pollAllTabs");
        }
      }
      await sleep(300 * 1000);
    }
  }

  #addTab(tabId, logText) {
    this.tabSet[tabId] = true;
    tabMap[tabId]?.makeAlive();
  }

  #removeTab(tabId, logText) {
    delete this.tabSet[tabId];
    if (tabMap[tabId]?.tooYoungToDie()) {
      return;
    }
    tabMap.remove(tabId)?.makeDead();
  }
}

const tabTracker = new TabTracker();

// -- webNavigation --

chrome.webNavigation.onCommitted.addListener(async (details) => {
  await storageReady;
  if (details.frameId != 0) {
    return;
  }
  const parsed = parseUrl(details.url);
  const tabInfo = tabMap.lookupOrNew(details.tabId);
  tabInfo.setCommitted(parsed.domain, parsed.origin);
});

// -- tabs --

// Whenever anything tab-related happens, try to refresh the pageAction.  This
// is hacky and inefficient, but the back-stabbing browser leaves me no choice.
// This seems to fix http://crbug.com/124970 and some problems on Google+.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await storageReady;
  const tabInfo = tabMap[tabId];
  if (tabInfo) {
    tabInfo.color = tab.incognito ?
        "incognitoColorScheme" : "regularColorScheme";
    tabInfo.refreshPageAction();
  }
});

// -- webRequest --

chrome.webRequest.onBeforeRequest.addListener(async (details) => {
  await storageReady;
  if (!(details.tabId > 0)) {
    // This request isn't related to a tab.
    return;
  }
  let tabInfo = null;
  if (details.type == "main_frame" || details.type == "outermost_frame") {
    const parsed = parseUrl(details.url);
    tabMap.remove(details.tabId);
    tabInfo = tabMap.lookupOrNew(details.tabId);
    tabInfo.setInitialDomain(parsed.domain, parsed.origin);
  } else {
    tabInfo = tabMap[details.tabId];
    if (!tabInfo) {
      return;
    }
  }
  const requestInfo = requestMap.lookupOrNew(details.requestId);
  if (requestInfo.tabId && requestInfo.domain) {
    // Can this actually happen?
    console.error("duplicate request; connection count leak");
  }
  requestInfo.tabId = tabInfo.id();
  requestInfo.tabBorn = tabInfo.born;
  requestInfo.domain = null;
  requestInfo.save();
}, FILTER_ALL_URLS);

// In the event of a redirect, the mainOrigin may change
// (from http: to https:) between the onBeforeRequest and onCommitted events,
// triggering an "access denied" error.  Patch this from onBeforeRedirect.
//
// As of 2022, this can be tested by visiting http://maps.google.com/
chrome.webRequest.onBeforeRedirect.addListener(async (details) => {
  await storageReady;
  if (!(details.type == "main_frame" ||
        details.type == "outermost_frame")) {
    return;
  }
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  const tabInfo = tabMap[requestInfo.tabId];
  if (tabInfo?.born != requestInfo.tabBorn) {
    return;
  }
  if (tabInfo.committed) {
    throw "onCommitted before onBeforeRedirect!";
  }
  const parsed = parseUrl(details.redirectUrl);
  tabInfo.setInitialDomain(parsed.domain, parsed.origin);
}, FILTER_ALL_URLS);

chrome.webRequest.onResponseStarted.addListener(async (details) => {
  await storageReady;
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  const tabInfo = tabMap[requestInfo.tabId];
  if (tabInfo?.born != requestInfo.tabBorn) {
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
  if (requestInfo.domain) throw `Duplicate onResponseStarted: ${parsed.domain}`;
  requestInfo.domain = parsed.domain;
  requestInfo.save();
  tabInfo.addDomain(parsed.domain, addr, flags);
}, FILTER_ALL_URLS);

const forgetRequest = async (details) => {
  await storageReady;
  const requestInfo = requestMap.remove(details.requestId);
  if (!requestInfo?.domain) {
    return;
  }
  const tabInfo = tabMap[requestInfo.tabId];
  if (tabInfo?.born != requestInfo.tabBorn) {
    return;
  }
  tabInfo.domains[requestInfo.domain]?.countDown();
};
chrome.webRequest.onCompleted.addListener(forgetRequest, FILTER_ALL_URLS);
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, FILTER_ALL_URLS);

// -- contextMenus --

// When the user right-clicks an IP address in the popup window, add a menu
// item to look up the address on bgp.he.net.  I don't like picking favorites,
// so I'm open to making this a config option if someone recommends another
// useful non-spammy service.
//
// Unless http://crbug.com/60758 gets resolved, the context menu's appearance
// cannot vary based on content.
const MENU_ID = "ipvfoo-lookup";

chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    title: "Look up on bgp.he.net",
    id: MENU_ID,
    // Scope the menu to text selection in our popup windows.
    contexts: ["selection"],
    documentUrlPatterns: [chrome.runtime.getURL("popup.html")],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId != MENU_ID) return;
  const text = info.selectionText;
  if (IP4_CHARS.test(text) || IP6_CHARS.test(text)) {
    chrome.tabs.create({url: `https://bgp.he.net/ip/${text}`});
  } else if (DNS_CHARS.test(text)) {
    chrome.tabs.create({url: `https://bgp.he.net/dns/${text}`});
  } else {
    // Malformed selection; shake the popup content.
    const tabId = /#(\d+)$/.exec(info.pageUrl);
    if (tabId) {
      popups.shake(Number(tabId[1]));
    }
  }
});

watchOptions((optionsChanged) => {
  for (const option of optionsChanged) {
    if (!option.endsWith("ColorScheme")) continue;
    for (const [tabId, tabInfo] of Object.entries(tabMap)) {
      if (tabInfo.color == option) {
        tabInfo.refreshPageAction();
      }
    }
  }
});
