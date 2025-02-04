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

// Flags are bitwise-OR'd across all connections to a domain.
const FLAG_SSL = 0x1;
const FLAG_NOSSL = 0x2;
const FLAG_UNCACHED = 0x4;
const FLAG_CONNECTED = 0x8;
const FLAG_WEBSOCKET = 0x10;
const FLAG_NOTWORKER = 0x20;  // from a tab, not a service worker

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

const spriteImg = {ready: false};
const spriteImgReady = (async function() {
  for (const size of [16, 32]) {
    const url = chrome.runtime.getURL(`sprites${size}.png`);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      spriteImg[size] = await createImageBitmap(blob);
    } catch (err) {
      // Why does this sometimes fail?  My best guess is that running
      // the unpacked extension from a ChromeOS Linux container exposes
      // it to filesystem reliability issues. If this happens in the wild,
      // maybe consider base64-inlining the PNGs?
      console.error(`failed to fetch ${url}: ${err}`);
      spriteImg[size] = redFailImg();
    }
  }
  spriteImg.ready = true;
})();

function redFailImg() {
  const size = 100;
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "darkred";
  ctx.fillRect(0, 0, size, size);
  return c;
}

// Get a <canvas> element of the given size.
const _canvasElements = newMap();
function _getCanvasContext(size) {
  let c = _canvasElements[size];
  if (!c) {
    c = _canvasElements[size] = new OffscreenCanvas(size, size);
  }
  return c.getContext("2d", {willReadFrequently: true});
}

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

// pattern is 0..3 characters, each '4', '6', or '?'.
// size is 16 or 32.
// color is "lightfg" or "darkfg".
function buildIcon(pattern, size, color) {
  if (!spriteImg.ready) throw "must await spriteImgReady!";
  const ctx = _getCanvasContext(size);
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

const DEFAULT_OPTIONS = {
  regularColorScheme: "darkfg",
  incognitoColorScheme: "lightfg",
};

const NAT64_KEY = "nat64/";
const NAT64_VALIDATE = /^nat64\/[0-9a-f]{24}$/;
const NAT64_DEFAULT = parseIP("64:ff9b::").slice(0, 96/4);

let _watchOptionsFunc = null;
const options = {ready: false, [NAT64_KEY]: new Set([NAT64_DEFAULT])};
const optionsReady = (async function() {
  const items = await chrome.storage.sync.get();
  for (const option of Object.keys(DEFAULT_OPTIONS)) {
    options[option] = items.hasOwnProperty(option) ?
        items[option] : DEFAULT_OPTIONS[option];
  }
  for (const option of Object.keys(items)) {
    if (NAT64_VALIDATE.test(option)) {
      options[NAT64_KEY].add(option.slice(NAT64_KEY.length));
    }
  }
  options.ready = true;
  if (_watchOptionsFunc) {
    _watchOptionsFunc(Object.keys(options));
  }
})();

chrome.storage.sync.onChanged.addListener(function(changes) {
  // changes = {option: {oldValue: x, newValue: y}}
  if (!options.ready) return;
  const optionsChanged = [];
  for (const option of Object.keys(DEFAULT_OPTIONS)) {
    const change = changes[option];
    if (!change) continue;
    options[option] = change.hasOwnProperty("newValue") ?
        change.newValue : DEFAULT_OPTIONS[option];
    optionsChanged.push(option);
  }
  let nat64Changed = false;
  for (const [option, {oldValue, newValue}] of Object.entries(changes)) {
    if (NAT64_VALIDATE.test(option)) {
      const packed96 = option.slice(NAT64_KEY.length);
      if (newValue && !options[NAT64_KEY].has(packed96)) {
        options[NAT64_KEY].add(packed96);
        nat64Changed = true;
      } else if (!newValue && options[NAT64_KEY].has(packed96)) {
        options[NAT64_KEY].delete(packed96);
        nat64Changed = true;
      }
    }
  }
  if (nat64Changed) optionsChanged.push(NAT64_KEY);
  if (_watchOptionsFunc && optionsChanged.length) {
    _watchOptionsFunc(optionsChanged);
  }
});

function watchOptions(f) {
  if (_watchOptionsFunc) throw "redundant watchOptions!";
  _watchOptionsFunc = f;
  if (options.ready) {
    _watchOptionsFunc(Object.keys(options));
  }
}

function setOptions(newOptions) {
  console.log("setOptions", newOptions);
  const toSet = {};
  for (const option of Object.keys(DEFAULT_OPTIONS)) {
    if (newOptions[option] != options[option]) {
      toSet[option] = newOptions[option];
    }
  }
  if (Object.keys(toSet).length == 0) {
    return false;  // no change
  }
  chrome.storage.sync.set(toSet);
  return true;  // caller should wait for watchOptions()
}

function addNAT64(packed96) {
  if (options[NAT64_KEY].has(packed96)) {
    return;
  }
  const key = NAT64_KEY + packed96;
  if (!NAT64_VALIDATE.test(key)) throw "invalid packed96"
  options[NAT64_KEY].add(packed96);
  chrome.storage.sync.set({[key]: 1});
  // NAT64 changes are reported synchronously.  When onChanged fires,
  // our local Set is used for deduplication.
  _watchOptionsFunc([NAT64_KEY]);
}

function revertNAT64() {
  let toRemove = [];
  for (const prefix96 of options[NAT64_KEY].keys()) {
    if (prefix96 != NAT64_DEFAULT) {
      toRemove.push(NAT64_KEY + prefix96);
    }
  }
  options[NAT64_KEY] = new Set([NAT64_DEFAULT]);
  if (toRemove.length) {
    chrome.storage.sync.remove(toRemove);
    // NAT64 changes are reported synchronously.  When onChanged fires,
    // our local Set is used for deduplication.
    _watchOptionsFunc([NAT64_KEY]);
  }
}