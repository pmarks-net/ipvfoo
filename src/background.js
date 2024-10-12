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

if (chrome.runtime.getManifest().background.service_worker) {
  // This line runs on Chrome, but not Firefox.
  importScripts("common.js");
}

// Possible states for an instance of TabInfo.
// We begin at BIRTH, and only ever move forward, not backward.
const TAB_BIRTH = 0;    // Waiting for makeAlive() or remove()
const TAB_ALIVE = 1;    // Waiting for remove()
const TAB_DEAD = 2;

// RequestFilter for webRequest events.
const FILTER_ALL_URLS = { urls: ["<all_urls>"] };



const SECONDS = 1000;  // to milliseconds

const NAME_VERSION = (() => {
  const m = chrome.runtime.getManifest();
  return `${m.name} v${m.version}`;
})();

const IS_MOBILE = /\bMobile\b/.test(navigator.userAgent);

let debug = false;
function debugLog() {
  if (debug) {
    console.log(new Date().toISOString(), ...arguments);
  }
}

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
        await chrome.storage.session.remove(key);
        return;
      }
      const j = JSON.stringify(this);
      if (this.#savedJSON == j) {
        return;
      }
      //console.log("saving", key, j);
      await chrome.storage.session.set({[key]: j});
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
    if (this.#prefix == "ip/") {
      // Don't restrict ipCache domain name keys.
      return id;
    } else {
      const idNumeric = parseInt(id, 10);
      if (idNumeric) {
        return idNumeric;
      }
    }
    throw `malformed id: ${id}`;
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
  mainRequestId = null;  // Request that constructed this tab, if any.
  mainDomain = "";       // Bare domain from the main_frame request.
  mainOrigin = "";       // Origin from the main_frame request.
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
    updateOriginMap(this.id(), null, this.mainOrigin);
  }

  tooYoungToDie() {
    // Spare new tabs from garbage collection for a minute or so.
    return (this.#state == TAB_BIRTH &&
            this.born >= Date.now() - 60*SECONDS);
  }

  makeAlive() {
    if (this.#state != TAB_BIRTH) {
      return;
    }
    this.#state = TAB_ALIVE;
    this.updateIcon();
  }

  remove() {
    super.remove();  // no await
    this.#state = TAB_DEAD;
    this.domains = newMap();
    updateOriginMap(this.id(), this.mainOrigin, null);
  }

  setInitialDomain(requestId, domain, origin) {
    if (this.mainRequestId == null) {
      this.mainRequestId = requestId;
    } else if (this.mainRequestId != requestId) {
      console.error("mainRequestId changed!");
    }
    this.mainDomain = domain;
    updateOriginMap(this.id(), this.mainOrigin, origin);
    this.mainOrigin = origin;

    // If anyone's watching, show some preliminary state.
    this.pushAll();
    this.save();
  }

  setCommitted(domain, origin) {
    let changed = false;

    if (this.mainDomain != domain) {
      this.mainDomain = domain;
      changed = true;
    }
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

  addDomain(domain, addr, flags, nat64addr = "") {
    let d = this.domains[domain];
    if (!d) {
      // Limit the number of domains per page, to avoid wasting RAM.
      if (Object.keys(this.domains).length >= 256) {
        popups.pushSpillCount(this.id(), ++this.spillCount);
        return;
      }
      d = this.domains[domain] =
          new DomainInfo(this, domain, addr || "(lost)", flags, nat64addr);
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

    this.updateIcon();
    this.pushOne(domain);
    this.save();
  }

  updateIcon() {
    if (!(this.#state == TAB_ALIVE)) {
      return;
    }
    let pattern = "?";
    let has4 = false;
    let has6 = false;
    let tooltip = "";
    for (const [domain, d] of Object.entries(this.domains)) {
      if (domain == this.mainDomain) {
        let [addrVer, _] = d.addrVersion();
        pattern = addrVer;

        if (IS_MOBILE) {
          tooltip = d.addr;  // Limited tooltip space on Android.
        } else {

          tooltip = `${d.addr}\n${NAME_VERSION}`;
        }
      } else {
        let [addrVer, _] = d.addrVersion();

        switch (addrVer) {
          case "4": has4 = true; break;
          case "6": has6 = true; break;
        }
      }
    }
    if (has4) pattern += "4";
    if (has6) pattern += "6";

    // Firefox might drop support for pageAction someday, but until then
    // let's keep the icon in the address bar.
    const action = chrome.pageAction || chrome.action;

    // Don't waste time rewriting the same tooltip.
    if (this.lastTooltip != tooltip) {
      action.setTitle({
        "tabId": this.id(),
        "title": tooltip,
      });
      this.lastTooltip = tooltip;
      this.save();
    }

    // Don't waste time redrawing the same icon.
    if (this.lastPattern != pattern) {
      const color = options[this.color];
      action.setIcon({
        "tabId": this.id(),
        "imageData": {
          "16": buildIcon(pattern, 16, color),
          "32": buildIcon(pattern, 32, color),
        },
      });
      // Send icon to the popup window (mobile only)
      popups.pushPattern(this.id(), pattern);
      action.setPopup({
        "tabId": this.id(),
        "popup": `popup.html#${this.id()}`,
      });
      if (action.show) {
        action.show(this.id());  // Firefox only
      }
      this.lastPattern = pattern;
      this.save();
    }
  }

  pushAll() {
    popups.pushAll(this.id(), this.getTuples(), this.lastPattern, this.spillCount);
  }

  pushOne(domain) {
    popups.pushOne(this.id(), this.getTuple(domain));
  }

  // Build some [domain, addr, version, flags] tuples, for a popup.
  getTuples() {
    const mainDomain = this.mainDomain || "(no domain)";
    const domains = Object.keys(this.domains).sort();
    const mainTuple = [mainDomain, "(no address)", "?", FLAG_UNCACHED | FLAG_NOTWORKER];
    const tuples = [mainTuple];
    for (const domain of domains) {
      const d = this.domains[domain];
      let [addrVer, _] = d.addrVersion();
      if (domain == mainTuple[0]) {
        mainTuple[1] = d.addr;
        mainTuple[2] = addrVer;
        mainTuple[3] = d.flags;
        mainTuple[4] = d.renderAddr();
      } else {
        tuples.push([domain, d.addr, addrVer, d.flags, d.renderAddr()]);
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

    let [addrVer, _] = d.addrVersion();
    return [domain, d.addr, addrVer, d.flags, d.renderAddr()];
  }
}

class DomainInfo {
  tabInfo;
  domain;

  addr;
  nat64Addr;
  nat64AddrBitsCIDR;
  isNat64;

  flags;
  count = 0;  // count of active requests
  inhibitZero = false;

  constructor(tabInfo, domain, addr, flags, nat64addr = "") {
    this.tabInfo = tabInfo;
    this.domain = domain;
    this.addr = addr;
    this.getNat64Addr(nat64addr)
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

  renderAddr() {
    let [_, nat64] = this.addrVersion(this.addr)
    this.isNat64 = nat64

    if (this.isNat64 && !options["nat64Hex"]) {
      let bits = parseIPv6WithCIDR(this.addr)
      return renderIPv6(bits.addr, true)
    }
    return this.addr

  }

  getNat64Addr(addr = "") {
    if (addr === "") {
      this.nat64Addr = options['nat64Prefix'];
    } else {
      this.nat64Addr = addr
    }

    this.nat64AddrBitsCIDR = parseIPv6WithCIDR(this.nat64Addr, 96);
    let [_, nat64] = this.addrVersion(this.addr)
    this.isNat64 = nat64
  }




  // In theory, we should be using a full-blown subnet parser/matcher here,
  // but let's keep it simple and stick with text for now.
  addrVersion() {
    if (this.addr) {
      if (this.addr.indexOf(".") >= 0) return ["4", false];


      let [isValidV6, problem] = isValidIPv6Addr(this.addr);
      debugLog(problem)

      if (isValidV6) {
        if (inAddrRange(parseIPv6WithCIDR(this.addr, -1, true), this.nat64AddrBitsCIDR)) return ["4", true];  // RFC6052
        return ["6", false];
      }
    }
    return ["?", false];
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
  // Typically this contains one {tabId: tabBorn} entry,
  // but for Service Worker requests there may be multiple tabs.
  tabIdToBorn = newMap();
  domain = null;

  afterLoad() {
    for (const [tabId, tabBorn] of Object.entries(this.tabIdToBorn)) {
      const tabInfo = tabMap[tabId];
      if (tabInfo?.born != tabBorn) {
        delete this.tabIdToBorn[tabId];
        continue;
      }
      if (!this.domain) {
        continue;  // still waiting for onResponseStarted
      }


      tabInfo.addDomain(this.domain, null, 0);
    }
    if (Object.keys(this.tabIdToBorn).length == 0) {
      requestMap.remove(this.id());
      console.log("garbage-collected RequestInfo", this.id());
      return;
    }
  }
}

class IPCacheEntry extends SaveableEntry {
  time = 0;
  addr = "";
}

// tabId -> TabInfo
const tabMap = new SaveableMap(TabInfo, "tab/")

// requestId -> {tabInfo, domain}
const requestMap = new SaveableMap(RequestInfo, "req/");

// Firefox-only domain->ip cache, to help work around
// https://bugzilla.mozilla.org/show_bug.cgi?id=1395020
const IP_CACHE_LIMIT = 1024;
const ipCache = (typeof browser == "undefined") ? null : new SaveableMap(IPCacheEntry, "ip/");
let ipCacheSize = 0;

function ipCacheGrew() {
  ++ipCacheSize;
  //console.log("ipCache", ipCacheSize, Object.keys(ipCache).length);
  if (ipCacheSize <= IP_CACHE_LIMIT) {
    return;
  }
  // Garbage collect half the entries.
  const flat = Object.values(ipCache);
  flat.sort((a, b) => a.time - b.time);
  ipCacheSize = flat.length;  // redundant
  for (const cachedAddr of flat) {
    ipCache.remove(cachedAddr.id());
    if (--ipCacheSize <= IP_CACHE_LIMIT/2) {
      break;
    }
  }
}

// mainOrigin -> Set of tabIds, for tabless service workers.
const originMap = newMap();

function updateOriginMap(tabId, oldOrigin, newOrigin) {
  if (oldOrigin && oldOrigin != newOrigin) {
    const tabs = originMap[oldOrigin];
    if (tabs) {
      tabs.delete(tabId);
      if (!tabs.size) {
        delete originMap[oldOrigin];
      }
    }
  }
  if (newOrigin) {
    let tabs = originMap[newOrigin];
    if (!tabs) {
      tabs = originMap[newOrigin] = new Set();
    }
    tabs.add(tabId);
  }
}

function lookupOriginMap(origin) {
  // returns a Set of tabId values.
  return originMap[origin] || new Set();
}

// Must "await storageReady;" before reading maps.
// You can force initStorage() from the console for debugging purposes.
const initStorage = async () => {
  await spriteImgReady;
  await optionsReady;

  // Migrate previous-version data from local to session storage.
  const oldItems = await chrome.storage.local.get();
  for (const [k, v] of Object.entries(oldItems)) {
    if (k.startsWith("tab/") || k.startsWith("req/")) {
      console.log(`migrating ${k} to storage.session`);
      await chrome.storage.session.set({[k]: v});
      await chrome.storage.local.remove(k);
    }
  }

  // These are be no-ops unless initStorage() is called manually.
  clearMap(tabMap);
  clearMap(requestMap);

  const items = await chrome.storage.session.get();
  const unparseable = [];
  for (const [k, v] of Object.entries(items)) {
    if (!(tabMap.load(k, v) || requestMap.load(k, v) || ipCache?.load(k, v))) {
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
  if (ipCache) {
    ipCacheSize = Object.keys(ipCache).length;
  }
};
const storageReady = initStorage();

// -- Popups --

// This class keeps track of the visible popup windows,
// and streams changes to them as they occur.
class Popups {
  ports = newMap();  // tabId -> Port

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

  pushAll(tabId, tuples, pattern, spillCount) {
    this.ports[tabId]?.postMessage({
      cmd: "pushAll",
      tuples: tuples,
      pattern: pattern,
      spillCount: spillCount,
    });
  };

  pushOne(tabId, tuple) {
    if (!tuple) {
      return;
    }
    this.ports[tabId]?.postMessage({
      cmd: "pushOne",
      tuple: tuple,
    });
  };

  pushPattern(tabId, pattern) {
    this.ports[tabId]?.postMessage({
      cmd: "pushPattern",
      pattern: pattern,
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

// Refresh icons after chrome.runtime.reload()
chrome.runtime.onInstalled.addListener(async () => {
  await storageReady;
  for (const tabInfo of Object.values(tabMap)) {
    tabInfo.refreshPageAction();
  }
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
  tabSet = newMap();  // Set of all known tabIds

  constructor() {
    chrome.tabs.onCreated.addListener(async (tab) => {
      await storageReady;
      this.#addTab(tab.id, "onCreated");
    });
    chrome.tabs.onRemoved.addListener(async (tabId) => {
      await storageReady;
      this.#removeTab(tabId, "onRemoved");
    });
    chrome.tabs.onReplaced.addListener(async (addId, removeId) => {
      await storageReady;
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
      await sleep(300*SECONDS);
    }
  }

  #addTab(tabId, logText) {
    debugLog("addTab", tabId, logText);
    this.tabSet[tabId] = true;
    tabMap[tabId]?.makeAlive();
  }

  #removeTab(tabId, logText) {
    debugLog("removeTab", tabId, logText);
    delete this.tabSet[tabId];
    if (tabMap[tabId]?.tooYoungToDie()) {
      return;
    }
    tabMap.remove(tabId);
  }
}

const tabTracker = new TabTracker();

// -- webNavigation --

// Typically, onBeforeNavigate fires between the main_frame
// onBeforeRequest and onResponseStarted events, and we don't have to do
// anything here.
//
// However, when the site is using a service worker, the main_frame request
// never happens, so we need to initialize the tab here instead.
//
// Conveniently, this also ensures that the previous page data is cleared
// when navigating to a file://, chrome://, or Chrome Web Store URL.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (!(details.frameId == 0 && details.tabId > 0)) {
    return;
  }
  await storageReady;
  let tabInfo = tabMap[details.tabId];
  const requestInfo = requestMap[tabInfo?.mainRequestId];
  if (requestInfo && requestInfo.domain == null) {
    return;  // Typical no-op case.
  }
  debugLog(`tabId=${details.tabId} is a service worker or special URL`);
  const parsed = parseUrl(details.url);
  tabMap.remove(details.tabId);
  tabInfo = tabMap.lookupOrNew(details.tabId);
  tabInfo.setInitialDomain(-1, parsed.domain, parsed.origin);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  debugLog("wN.oC", details?.tabId, details?.url, details);
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
  debugLog("tabs.oU", tabId);
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
  //debugLog("wR.oBR", details?.tabId, details?.url, details);
  await storageReady;
  const tabId = details.tabId;
  const tabInfos = [];
  if (tabId > 0) {
    if (details.type == "main_frame" || details.type == "outermost_frame") {
      const parsed = parseUrl(details.url);
      tabMap.remove(tabId);
      const tabInfo = tabMap.lookupOrNew(tabId);
      tabInfo.setInitialDomain(details.requestId, parsed.domain, parsed.origin);
      tabInfos.push(tabInfo);
    } else {
      const tabInfo = tabMap[tabId];
      if (tabInfo) {
        tabInfos.push(tabInfo);
      }
    }
  } else if (tabId == -1 && (details.initiator || details.documentUrl)) {
    // Chrome uses initiator, Firefox uses documentUrl.
    const initiator = details.initiator || parseUrl(details.documentUrl).origin;
    // Request is from a tabless Service Worker.
    // Find all tabs matching the initiator's origin.
    for (const tabId of lookupOriginMap(initiator)) {
      const tabInfo = tabMap[tabId];
      if (tabInfo) {
        tabInfos.push(tabInfo);
      }
    }
  }
  if (!tabInfos.length) {
    return;
  }
  const requestInfo = requestMap.lookupOrNew(details.requestId);
  if (requestInfo.tabIdToBorn.size || requestInfo.domain) {
    // Can this actually happen?
    console.error("duplicate request; connection count leak");
  }
  for (const tabInfo of tabInfos) {
    requestInfo.tabIdToBorn[tabInfo.id()] = tabInfo.born;
  }
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
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born != tabBorn) {
      continue;
    }
    if (tabInfo.committed) {
      console.error("onCommitted before onBeforeRedirect!");
      continue;
    }
    const parsed = parseUrl(details.redirectUrl);
    tabInfo.setInitialDomain(requestInfo.id(), parsed.domain, parsed.origin);
  }

}, FILTER_ALL_URLS);

chrome.webRequest.onResponseStarted.addListener(async (details) => {
  //debugLog("wR.oRS", details?.tabId, details?.url, details);
  await storageReady;
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  const tabInfos = [];
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born != tabBorn) {
      continue;
    }
    tabInfos.push(tabInfo);
  }
  if (!tabInfos.length) {
    return;
  }
  const parsed = parseUrl(details.url);
  if (!parsed.domain) {
    return;
  }

  let addr = details.ip;
  let fromCache = details.fromCache;
  if (ipCache) {
    // This runs on Firefox only.
    if (addr) {
      const cachedAddr = ipCache.lookupOrNew(parsed.domain);
      const grew = !cachedAddr.addr;
      cachedAddr.time = Date.now();
      cachedAddr.addr = addr;
      cachedAddr.save();
      if (grew) {
        ipCacheGrew();
      }
    } else {
      const cachedAddr = ipCache[parsed.domain];
      if (cachedAddr) {
        fromCache = true;
        addr = cachedAddr.addr;
      }
    }
  }
  addr = addr || "(no address)";

  let flags = parsed.ssl ? FLAG_SSL : FLAG_NOSSL;
  if (parsed.ws) {
    flags |= FLAG_WEBSOCKET;
  }
  if (!fromCache) {
    flags |= FLAG_UNCACHED;
  }
  if (details.tabId > 0) {
    flags |= FLAG_NOTWORKER;
  }
  if (requestInfo.domain) throw `Duplicate onResponseStarted: ${parsed.domain}`;
  requestInfo.domain = parsed.domain;
  requestInfo.save();
  for (const tabInfo of tabInfos) {
    tabInfo.addDomain(parsed.domain, addr, flags);
  }
}, FILTER_ALL_URLS);

const forgetRequest = async (details) => {
  await storageReady;
  const requestInfo = requestMap.remove(details.requestId);
  if (!requestInfo?.domain) {
    return;
  }
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born == tabBorn) {
      tabInfo.domains[requestInfo.domain]?.countDown();
    }
  }
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

chrome.contextMenus?.removeAll(() => {
  chrome.contextMenus.create({
    title: "Look up on bgp.he.net",
    id: MENU_ID,
    // Scope the menu to text selection in our popup windows.
    contexts: ["selection"],
    documentUrlPatterns: [chrome.runtime.getURL("popup.html")],
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
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

watchOptions(async (optionsChanged) => {
  await storageReady;
  for (const option of optionsChanged) {
    if (!option.endsWith("ColorScheme")) continue;
    for (const tabInfo of Object.values(tabMap)) {
      if (tabInfo.color == option) {
        tabInfo.refreshPageAction();
      }
    }
  }
});
