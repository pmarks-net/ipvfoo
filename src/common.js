/*
Copyright (C) 2017  Paul Marks  http://www.pmarks.net/

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

"use strict";

// Requires <script src="iputil.js">

const IS_MOBILE = /\bMobile\b/.test(navigator.userAgent);

// Domain flags are bitwise-OR'd across all connections to a domain.
const DFLAG_MASK = 0xFF00;
const DFLAG_SSL = 0x100;
const DFLAG_NOSSL = 0x200;
const DFLAG_CONNECTED = 0x400;
const DFLAG_WEBSOCKET = 0x800;
const DFLAG_NOTWORKER = 0x1000;  // from a tab, not a service worker

// Address flags refer to a specific connection, and are used to prioritize
// which address is shown to the user.  The lowest numerical value wins.
const AFLAG_MASK = 0xFF;
const AFLAG_PREFETCH = 0x4;
const AFLAG_WORKER = 0x2;
const AFLAG_CACHE = 0x1;

const IPV4_ONLY_DOMAINS = new Set(["ipv4.google.com", "ipv4.icanhazip.com", "ipv4.whatismyip.akamai.com"]);

// Returns an Object with no default properties.
function newMap() {
  return Object.create(null);
}

function clearMap(m) {
  for (const k of Object.keys(m)) {
    delete m[k];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeChildren(n) {
  while (n.hasChildNodes()) {
    n.removeChild(n.lastChild);
  }
  return n;
}

function iconPath(pattern, size, color) {
  const filebase = `${color}${size}_${pattern.replaceAll('?', 'q')}`;
  if (!/^(lightfg|darkfg)(16|32)_[46q](|4|6|46)$/.test(filebase)) {
    throw new Error(`Unexpected icon format: ${filebase}`);
  }
  return `generated_icons/${filebase}.png`;
}

const REGULAR_COLOR = "regularColorScheme";
const INCOGNITO_COLOR = "incognitoColorScheme";

const LOOKUP_PROVIDER = "lookupProvider";
const CUSTOM_PROVIDER = "customProvider:";
const CUSTOM_PROVIDER_DOMAIN = CUSTOM_PROVIDER + "domain";
const CUSTOM_PROVIDER_IP = CUSTOM_PROVIDER + "ip";

// "$" is a placeholder for the user's selected domain or IP address.
const LOOKUP_PROVIDERS = {
  "bgp.he.net": {
    domain: "https://bgp.he.net/dns/$",
    ip: "https://bgp.he.net/ip/$",
  },
  "info.addr.tools": {
    domain: "https://info.addr.tools/$",
    ip: "https://info.addr.tools/$",
  },
  "ipinfo.io": {
    domain: "",
    ip: "https://ipinfo.io/$",
  },
};

function parseLookupUrl(pattern, placeholder="") {
  pattern = pattern?.trim();
  if (!pattern) {
    return null;
  }
  if (!/^https:[/][/][^/$]+[/].*[$]/.test(pattern)) {
    throw new Error("malformed");
  }
  return new URL(pattern.replaceAll("$", placeholder));  // may throw
}
function maybeLookupUrl(pattern, placeholder="") {
  try {
    return parseLookupUrl(pattern, placeholder);
  } catch {
    return null;
  }
}

const NAT64_KEY = "nat64/";
const NAT64_VALIDATE = /^nat64\/[0-9a-f]{24}$/;
const NAT64_DEFAULTS = new Set([
  parseIP("::ffff:0:0").slice(0, 96/4),  // For stupid AAAA records
  parseIP("64:ff9b::").slice(0, 96/4),   // RFC 6052
  parseIP("64:ff9b:1::").slice(0, 96/4), // RFC 8215
]);

let _watchOptionsFunc = null;
const DEFAULT_LOCAL_OPTIONS = {
  [REGULAR_COLOR]: "darkfg",  // default immediately replaced
  [INCOGNITO_COLOR]: "lightfg",
};
const DEFAULT_SYNC_OPTIONS = {
  [LOOKUP_PROVIDER]: "bgp.he.net",
  [CUSTOM_PROVIDER_DOMAIN]: "",
  [CUSTOM_PROVIDER_IP]: "",
};
const options = {
  ready: false,
  [NAT64_KEY]: new Set(NAT64_DEFAULTS),
  ...DEFAULT_LOCAL_OPTIONS,
  ...DEFAULT_SYNC_OPTIONS,
};
const optionsReady = (async function() {
  const [localItems, syncItems] = await Promise.all(
      [chrome.storage.local.get(), chrome.storage.sync.get()]);
  for (const [option, value] of Object.entries(localItems)) {
    if (DEFAULT_LOCAL_OPTIONS.hasOwnProperty(option)) {
      options[option] = value;
    }
  }
  for (const [option, value] of Object.entries(syncItems)) {
    if (NAT64_VALIDATE.test(option)) {
      options[NAT64_KEY].add(option.slice(NAT64_KEY.length));
    } else if (DEFAULT_SYNC_OPTIONS.hasOwnProperty(option)) {
      options[option] = value;
    }
  }
  options.ready = true;
  _watchOptionsFunc?.(Object.keys(options));
})();

chrome.storage.local.onChanged.addListener(function(changes) {
  // changes = {option: {oldValue: x, newValue: y}}
  if (!options.ready) return;
  const optionsChanged = [];
  for (const [option, {oldValue, newValue}] of Object.entries(changes)) {
    if (DEFAULT_LOCAL_OPTIONS.hasOwnProperty(option)) {
      if (options[option] != newValue) {
        options[option] = newValue;
        optionsChanged.push(option);
      }
    }
  }
  if (optionsChanged.length) {
    _watchOptionsFunc?.(optionsChanged);
  }
});

chrome.storage.sync.onChanged.addListener(function(changes) {
  // changes = {option: {oldValue: x, newValue: y}}
  if (!options.ready) return;
  const optionsChanged = [];
  for (const [option, {oldValue, newValue}] of Object.entries(changes)) {
    if (NAT64_VALIDATE.test(option)) {
      const packed96 = option.slice(NAT64_KEY.length);
      if (newValue && !options[NAT64_KEY].has(packed96)) {
        options[NAT64_KEY].add(packed96);
      } else if (!newValue && options[NAT64_KEY].has(packed96)) {
        options[NAT64_KEY].delete(packed96);
      } else {
        continue;  // no change
      }
      if (!optionsChanged.includes(NAT64_KEY)) {
        optionsChanged.push(NAT64_KEY);
      }
    } else if (DEFAULT_SYNC_OPTIONS.hasOwnProperty(option)) {
      if (options[option] != newValue) {
        options[option] = newValue;
        optionsChanged.push(option);
      }
    }
  }
  if (optionsChanged.length) {
    _watchOptionsFunc?.(optionsChanged);
  }
});

function watchOptions(f) {
  if (_watchOptionsFunc) throw "redundant watchOptions!";
  _watchOptionsFunc = f;
  if (options.ready) {
    _watchOptionsFunc(Object.keys(options));
  }
}

function setColorIsDarkMode(option, isDarkMode) {
  if (!(option == REGULAR_COLOR || option == INCOGNITO_COLOR)) {
    throw new Error("invalid color scheme", option);
  }
  if (IS_MOBILE && option == INCOGNITO_COLOR) {
    // Firefox for Android, the incognito popup follows the system theme
    // regardless of toolbar color, so just assume dark mode (lightfg).
    // I wonder if there exist edge cases where this assumption is wrong?
    isDarkMode = true;
  }
  const value = isDarkMode ? "lightfg" : "darkfg";
  if (options[option] != value) {
    options[option] = value;
    chrome.storage.local.set({[option]: value});
    _watchOptionsFunc?.([option]);
  }
}

// Users can manually call this function to add a NAT64 prefix from the console.
function addNAT64(ip) {
  if (ip.endsWith("/96")) {
    ip = ip.slice(0, ip.length-3);
  }
  const packed96 = parseIP(ip).slice(0, 96/4);
  addPackedNAT64(packed96);
  return `Added NAT64 prefix ${formatIPv6(packed96)}/96`;
}

function addPackedNAT64(packed96) {
  if (options[NAT64_KEY].has(packed96)) {
    return;
  }
  const key = NAT64_KEY + packed96;
  if (!NAT64_VALIDATE.test(key)) throw "invalid packed96"
  options[NAT64_KEY].add(packed96);
  chrome.storage.sync.set({[key]: 1});
  // NAT64 changes are reported synchronously.  When onChanged fires,
  // our local Set is used for deduplication.
  _watchOptionsFunc?.([NAT64_KEY]);
}

function revertNAT64() {
  let toRemove = [];
  for (const prefix96 of options[NAT64_KEY].keys()) {
    if (!NAT64_DEFAULTS.has(prefix96)) {
      toRemove.push(NAT64_KEY + prefix96);
    }
  }
  options[NAT64_KEY] = new Set(NAT64_DEFAULTS);
  if (toRemove.length) {
    chrome.storage.sync.remove(toRemove);
    // NAT64 changes are reported synchronously.  When onChanged fires,
    // our local Set is used for deduplication.
    _watchOptionsFunc?.([NAT64_KEY]);
  }
}