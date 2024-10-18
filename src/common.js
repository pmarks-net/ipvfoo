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

// Flags are bitwise-OR'd across all connections to a domain.
const FLAG_SSL = 0x1;
const FLAG_NOSSL = 0x2;
const FLAG_UNCACHED = 0x4;
const FLAG_CONNECTED = 0x8;
const FLAG_WEBSOCKET = 0x10;
const FLAG_NOTWORKER = 0x20;  // from a tab, not a service worker


// Distinguish IP address and domain name characters.
// Note that IP6_CHARS must not match "beef.de"
const IP4_CHARS = /^[0-9.]+$/;
const IP6_CHARS = /^[0-9A-Fa-f]*:[0-9A-Fa-f:.]*$/;
const DNS_CHARS = /^[0-9A-Za-z._-]+$/;


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
  nat64Prefix: "64:ff9b::/96",
  nat64Hex: false,
  ipv4Format: "dotDecimal",
};

let _watchOptionsFunc = null;
const options = {ready: false};
const optionsReady = (async function() {
  const items = await chrome.storage.sync.get();
  for (const option of Object.keys(DEFAULT_OPTIONS)) {
    options[option] = items.hasOwnProperty(option) ?
        items[option] : DEFAULT_OPTIONS[option];
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




function setNibbleAtPosition(bigInt, nibble, bitPosition) {
  let nibbleValue = BigInt(parseInt(nibble, 16));

  let mask = ~(BigInt(0xF) << BigInt(bitPosition));
  bigInt = bigInt & mask;

  bigInt = bigInt | (nibbleValue << BigInt(bitPosition));

  return bigInt;
}

function setByteAtPosition(bigInt, byte, bitPosition) {
  let byteValue = BigInt(parseInt(byte, 16));

  let mask = ~(BigInt(0xFF) << BigInt(bitPosition));
  bigInt = bigInt & mask;

  bigInt = bigInt | (byteValue << BigInt(bitPosition));

  return bigInt;
}


function inAddrRange(addr, nat64Addr) {
  try {
    let mask = (BigInt(1) << BigInt(128 - nat64Addr.cidr)) - BigInt(1);
    addr.addr = addr.addr & ~mask;


    nat64Addr.addr = nat64Addr.addr & ~mask;

    return addr.addr === nat64Addr.addr;
  } catch (error) {
    debugLog(error)
    return false;
  }
}

function isValidIPv6Addr(addrMaybeCIDR) {

  let [addr, cidr] = addrMaybeCIDR.split('/');

  if (addr === '') {
    return [false, "Address is empty"]
  }

  // you need at least 2 colons for a v6 addr, '::'
  const colons = countOccurrences(addr, ":")
  if (colons < 2) {
    return [false, "Too few separators"]
  }

  if (!IP6_CHARS.test(addr)) {
    return [false, "Invalid characters"]
  }



  if (addr[addr.length -1] === ':' && addr[addr.length -2] !== ':') {
    return [false, "Can't end with a single separator"]
  }

  let hextetLength = 0;
  let colonsSeen = 0;
  let doubleColon = false;
  for (let i = addr.length - 1; i >= 0; i--) {
    if (addr[i] !== ':') {
      hextetLength += 1;
      colonsSeen = 0;
    } else {
      hextetLength = 0;
      colonsSeen += 1;
    }
    if (hextetLength > 4) {
      return [false, "Can't have more then 4 character between a separator"]
    }


    if (colonsSeen === 2) {
      if (doubleColon) {
        return [false, "Can't have 2 '::' compressions in one address"]
      } else {
        doubleColon = true
      }
    }

    if (colonsSeen > 2) {
      return [false, "Can't have more then 3 separators in a row"]
    }
  }

  if ((!doubleColon) && (colons < 7)) {
    return [false, "Can't have less then 8 hextets without a '::' compression"]
  }

  if (countOccurrences(addrMaybeCIDR, "/") === 1) {
    if (addrMaybeCIDR.endsWith("/")) {
      return [false, "Can't have empty CIDR"]
    }

    if (parseInt(cidr, 10) < 0 || parseInt(cidr, 10) > 128) {
      return [false, "Invalid CIDR, range is 0 - 128 inclusive"]
    }

  } else if (countOccurrences(addrMaybeCIDR, "/") > 1) {
    return [false, "Can't have more then 1 CIDR"]
  }

  return [true, null]
}

function countOccurrences(string, substring) {
  return string.split(substring).length - 1;
}




function parseIPv4WithCidr(addressWithCIDR, defaultCIDR = -1) {
  let [addressSTR, cidrSTR] = addressWithCIDR.split('/');

  let ipv4BigInt = BigInt(0);
  let octets = addressSTR.split('.').map(Number);

  for (let i = 0; i < 4; i++) {
    ipv4BigInt = (ipv4BigInt << BigInt(8)) | BigInt(octets[i]);
  }

  let cidr = cidrSTR ? parseInt(cidrSTR, 10) : defaultCIDR;


  return { addr: ipv4BigInt, cidr: cidr };
}

function parseIPv6WithCIDR(addressWithCIDR, defaultCIDR = -1, isKnownValid = false) {
  let [addressSTR, cidrSTR] = addressWithCIDR.split('/');
  let addr = BigInt(0);
  let bitPos = 0;
  let colonHexRemaining = 16;
  let colonsSeen = 0;

  if (!isKnownValid) {
    let [isValid, problem] = isValidIPv6Addr(addressSTR);
    if (!isValid) {
      debugLog(problem)
      throw new Error('not_ipv6')
    }
  }



  let colons = countOccurrences(addressSTR, ":")
  let doubleSkip = 16 * (8 - colons)



  for (let i = addressSTR.length - 1; i >= 0; i--) {
    if (colonsSeen >= 2) {
      bitPos += doubleSkip
    } else if (colonsSeen === 1) {
      bitPos += colonHexRemaining;
      colonHexRemaining = 16;
    }
    if (addressSTR[i] !== ':') {
      colonsSeen = 0
      addr = setNibbleAtPosition(addr, addressSTR[i], bitPos);
      bitPos += 4;
      colonHexRemaining -= 4;
    } else {
      colonsSeen += 1;
    }
  }



  let cidr = cidrSTR ? parseInt(cidrSTR, 10) : defaultCIDR;


  return { addr: addr, cidr: cidr };
}


function renderIPv4(addr) {

  if (options["ipv4Format"] === "dotDecimal") {
    return renderIPv4DotDecimal(addr);
  } else if (options["ipv4Format"] === "octetHex") {
    return renderIPv4Hex(addr, 2);
  } else if (options["ipv4Format"] === "singleBlockHex") {
    return renderIPv4Hex(addr, 8, true, "shouldnotsee", "0x");
  } else if (options["ipv4Format"] === "ipv6Like") {
    return renderIPv4Hex(addr, 4, true, ":");
  }


  return renderIPv4DotDecimal(addr)
}

function renderIPv4DotDecimal(addr) {
  let ipv4 = []

  for (let i = 3; i >= 0; i--) {
    let mask = (BigInt(1) << BigInt(8)) - BigInt(1);

    let oct = addr >> BigInt(i * 8);
    oct = oct & mask

    ipv4.push(oct)
  }

  return ipv4.join(".")

}


function renderIPv4Hex(bigInt, groupSize, removeLeading0s = false, joiner = ":", prepend = "", append = "") {
  let ipv4Bits = BigInt(bigInt)


  let hex = ipv4Bits.toString(16).padStart(8, '0');

  let ipv4Parts = [];
  for (let i = 0; i < 8 / groupSize; i++) {
    ipv4Parts.push(hex.substr(i * groupSize, groupSize));
  }

  if (removeLeading0s) {
    ipv4Parts = ipv4Parts.map(group => group.replace(/^0+/, '') || '0');
  }


  let ipv4Addr = ipv4Parts.join(joiner);

  if (prepend !== "") {
    ipv4Addr = prepend + ipv4Addr
  }

  if (append !== "") {
    ipv4Addr = ipv4Addr + append
  }

  return ipv4Addr;
}

function renderIPv6(bigInt, nat64 = false) {
  let ipv6Bits = BigInt(bigInt)
  let ipv4Bits = BigInt(bigInt)

  let addrMask = (BigInt(1) << BigInt(32)) - BigInt(1);

  if (nat64) {
    ipv6Bits = ipv6Bits & ~addrMask
    ipv4Bits = ipv4Bits & addrMask
  }

  let hex = ipv6Bits.toString(16).padStart(32, '0');

  let ipv6Parts = [];
  for (let i = 0; i < 8; i++) {
    ipv6Parts.push(hex.substr(i * 4, 4));
  }

  ipv6Parts = ipv6Parts.map(group => group.replace(/^0+/, '') || '0');

  let zeroStart = -1;
  let zeroLength = 0;
  let bestZeroStart = -1;
  let bestZeroLength = 0;

  for (let i = 0; i < ipv6Parts.length; i++) {
    if (ipv6Parts[i] === '0') {
      if (zeroStart === -1) {
        zeroStart = i;
      }
      zeroLength++;
    } else {
      if (zeroLength > bestZeroLength) {
        bestZeroStart = zeroStart;
        bestZeroLength = zeroLength;
      }
      zeroStart = -1;
      zeroLength = 0;
    }
  }

  if (zeroLength > bestZeroLength) {
    bestZeroStart = zeroStart;
    bestZeroLength = zeroLength;
  }

  if (bestZeroLength > 1) {
    ipv6Parts.splice(bestZeroStart, bestZeroLength, '');
  }

  let ipv6Addr = ipv6Parts.join(':');

  if (ipv6Addr.startsWith(':')) {
    ipv6Addr = ':' + ipv6Addr;
  }
  if (ipv6Addr.endsWith(':')) {
    ipv6Addr = ipv6Addr + ':';
  }

  if (nat64) {
    let ipv4 = renderIPv4(ipv4Bits);
    ipv6Addr += ipv4
  }

  return ipv6Addr;
}


