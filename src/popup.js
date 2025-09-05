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

"use strict";

const ALL_URLS = "<all_urls>";
const IS_MOBILE = /\bMobile\b/.test(navigator.userAgent);

// Snip domains longer than this, to avoid horizontal scrolling.
const LONG_DOMAIN = 50;

const tabId = window.location.hash.substr(1);
if (!isFinite(Number(tabId))) {
  throw "Bad tabId";
}

let data = {
  domains: [],
  ips: [],
};
let table = null;

window.onload = async function() {
  table = document.getElementById("addr_table");
  table.onmousedown = handleMouseDown;
  await beg();
  if (IS_MOBILE) {
    document.getElementById("mobile_footer").style.display = "flex";
  }
  connectToExtension();
  addCopyActions();
};

async function beg() {
  const p = await chrome.permissions.getAll();
  for (const origin of p.origins) {
    if (origin == ALL_URLS) {
      return;  // We already have permission.
    }
  }
  const button = document.getElementById("beg");
  button.style.display = "block";  // visible
  button.addEventListener("click", async () => {
    // We need to close the popup before awaiting, otherwise
    // Firefox (at least version 116 on Windows) renders the
    // permission dialog underneath the popup.
    const promise = chrome.permissions.request({origins: [ALL_URLS]});
    window.close();
    await promise;
  });
}

function connectToExtension() {
  const port = chrome.runtime.connect(null, {name: tabId});
  port.onMessage.addListener((msg) => {
    document.bgColor = "";
    //console.log("onMessage", msg.cmd, msg);
    switch (msg.cmd) {
      case "pushAll":
        for (const tuple of msg.tuples) {
          data.domains.push(tuple[0]);
          data.ips.push(tuple[1]);
        }
        return pushAll(msg.tuples, msg.pattern, msg.spillCount);
      case "pushOne":
        data.domains.push(msg.tuple[0]);
        data.ips.push(msg.tuple[1]);
        return pushOne(msg.tuple);
      case "pushPattern":
        return pushPattern(msg.pattern);
      case "pushSpillCount":
        return pushSpillCount(msg.spillCount);
      case "shake":
        return shake("error");
    }
  });

  port.onDisconnect.addListener(() => {
    document.bgColor = "lightpink";
    setTimeout(connectToExtension, 1);
  });
}

function addCopyActions() {
  document.querySelectorAll("a.copy_data").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();

      copyList(a.dataset.type);
    });
  });
}

// Copy domains/IPs helper.
function copyList(kind) {
  const [type, list] = kind.split("-");
  const joiner = list == "comma" ? ", " : "\n";

  let content = [];
  switch (type) {
    case "domains":
      content = data.domains;
      break;
    case "sdl":
      content = getSecondLevelDomains(data.domains);
      break;
    case "ips":
      content = data.ips;
      break;
  }

  content = Array.from(new Set(content));
  const clipboardContent = content.join(joiner);
  try {
    navigator.clipboard.writeText(clipboardContent);
    shake("success");
  } catch (err) {
    shake("error");
  }
}

// Clear the table, and fill it with new data.
function pushAll(tuples, pattern, spillCount) {
  removeChildren(table);
  for (let i = 0; i < tuples.length; i++) {
    table.appendChild(makeRow(i == 0, tuples[i]));
  }
  pushPattern(pattern);
  pushSpillCount(spillCount);
}

// Insert or update a single table row.
function pushOne(tuple) {
  const domain = tuple[0];
  let insertHere = null;
  let isFirst = true;
  for (let tr = table.firstChild; tr; tr = tr.nextSibling) {
    if (tr._domain == domain) {
      // Found an exact match.  Update the row.
      minimalCopy(makeRow(isFirst, tuple), tr);
      return;
    }
    if (isFirst) {
      isFirst = false;
    } else if (tr._domain > domain) {
      insertHere = tr;
      break;
    }
  }
  // No exact match.  Insert the row in alphabetical order.
  table.insertBefore(makeRow(false, tuple), insertHere);
  if (IS_MOBILE) {
    zoomHack();
  } else {
    scrollbarHack();
  }
}

let lastPattern = "";
async function pushPattern(pattern) {
  if (!IS_MOBILE) {
    return;
  }
  if (lastPattern != pattern) {
    lastPattern = pattern;
  } else {
    return;
  }
  await spriteImgReady;
  for (const color of ["darkfg", "lightfg"]) {
    const canvas = document.getElementById(`pattern_icon_${color}`);
    const ctx = canvas.getContext("2d");
    const imageData = buildIcon(pattern, 32, color);
    ctx.putImageData(imageData, 0, 0);
  }
}

// Count must be a number.
function pushSpillCount(count) {
  document.getElementById("spill_count_container").style.display =
      count == 0 ? "none" : "block";
  removeChildren(document.getElementById("spill_count")).appendChild(
      document.createTextNode(count));
  if (IS_MOBILE) {
    zoomHack();
  } else {
    scrollbarHack();
  }
}

// Shake the content (for 500ms) to signal an error.
function shake(type) {
  document.body.className = "shake_" + type;
  setTimeout(function() {
    document.body.className = "";
  }, 600);
}

// On mobile, zoom in so the table fills the viewport.
function zoomHack() {
  const tableWidth = document.querySelector('table').offsetWidth;
  document.querySelector('meta[name="viewport"]').setAttribute('content', `width=${tableWidth}`);
}

// Workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1395025
let redrawn = false;
function scrollbarHack() {
  if (typeof browser == "undefined") {
    return;  // nothing to do on Chrome.
  }
  setTimeout(() => {
    const e = document.documentElement;
    if (e.scrollHeight > e.clientHeight) {
      document.body.style.paddingRight = '20px';
    } else if (!redrawn) {
      document.body.classList.toggle('force-redraw');
      redrawn = true;
    }
  }, 200);
}

// Copy the contents of src into dst, making minimal changes.
function minimalCopy(src, dst) {
  dst.className = src.className;
  for (let s = src.firstChild, d = dst.firstChild, sNext, dNext;
       s && d;
       s = sNext, d = dNext) {
    sNext = s.nextSibling;
    dNext = d.nextSibling;
    // First, sync up the class names.
    d.className = s.className = s.className;
    // Only replace the whole node if something changes.
    // That way, we avoid stomping on the user's selected text.
    if (!d.isEqualNode(s)) {
      dst.replaceChild(s, d);
    }
  }
}

function makeImg(src, title) {
  const img = document.createElement("img");
  img.src = src;
  img.title = title;
  return img;
}

function makeSslImg(flags) {
  switch (flags & (FLAG_SSL | FLAG_NOSSL)) {
    case FLAG_SSL | FLAG_NOSSL:
      return makeImg(
          "gray_schrodingers_lock.png",
          "Mixture of HTTPS and non-HTTPS connections.");
    case FLAG_SSL:
      return makeImg(
          "gray_lock.png",
          "Connection uses HTTPS.\n" +
          "Warning: IPvFoo does not verify the integrity of encryption.");
    default:
      return makeImg(
          "gray_unlock.png",
          "Connection does not use HTTPS.");
  }
}

function makeRow(isFirst, tuple) {
  const domain = tuple[0];
  const addr = tuple[1];
  const version = tuple[2];
  const flags = tuple[3];

  const tr = document.createElement("tr");
  if (isFirst) {
    tr.className = "mainRow";
  }

  // Build the SSL icon for the "zeroth" pseudo-column.
  const sslImg = makeSslImg(flags);
  sslImg.className = "sslImg";

  // Build the "Domain" column.
  const domainTd = document.createElement("td");
  domainTd.appendChild(sslImg);
  if (domain.length > LONG_DOMAIN) {
    domainTd.appendChild(makeSnippedText(domain, Math.floor(LONG_DOMAIN / 2)));
  } else {
    domainTd.appendChild(document.createTextNode(domain));
  }
  domainTd.className = "domainTd";
  domainTd.onclick = handleClick;
  domainTd.oncontextmenu = handleContextMenu;

  // Build the "Address" column.
  const addrTd = document.createElement("td");
  let addrClass = "";
  switch (version) {
    case "4": addrClass = " ip4"; break;
    case "6": addrClass = " ip6"; break;
  }
  const connectedClass = (flags & FLAG_CONNECTED) ? " highlight" : "";
  addrTd.className = `addrTd${addrClass}${connectedClass}`;
  addrTd.appendChild(document.createTextNode(addr));
  addrTd.onclick = handleClick;
  addrTd.oncontextmenu = handleContextMenu;

  // Build the (possibly invisible) "WebSocket/Cached" column.
  // We don't need to worry about drawing both, because a cached WebSocket
  // would be nonsensical.
  //
  // Now that we also have a Service Worker icon, I just made it replace
  // the Cached icon because I'm too lazy to align multiple columns properly.
  const cacheTd = document.createElement("td");
  cacheTd.className = `cacheTd${connectedClass}`;
  if (flags & FLAG_WEBSOCKET) {
    cacheTd.appendChild(
        makeImg("websocket.png", "WebSocket handshake; connection may still be active."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (!(flags & FLAG_NOTWORKER)) {
    cacheTd.appendChild(
        makeImg("serviceworker.png", "Service Worker request; possibly from a different tab."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (!(flags & FLAG_UNCACHED)) {
    cacheTd.appendChild(
        makeImg("cached_arrow.png", "Data from cached requests only."));
    cacheTd.style.paddingLeft = '6pt';
  } else {
    cacheTd.style.paddingLeft = '0';
  }

  tr._domain = domain;
  tr.appendChild(domainTd);
  tr.appendChild(addrTd);
  tr.appendChild(cacheTd);
  return tr;
}

// Given a long domain name, generate "prefix...suffix".  When the user
// clicks "...", all domains are expanded.  The CSS is tricky because
// we want the original domain to remain intact for clipboard purposes.
function makeSnippedText(domain, keep) {
  const prefix = domain.substr(0, keep);
  const snipped = domain.substr(keep, domain.length - 2 * keep);
  const suffix = domain.substr(domain.length - keep);
  const f = document.createDocumentFragment();

  // Add prefix text.
  f.appendChild(document.createTextNode(prefix));

  // Add snipped text, invisible but copyable.
  let snippedText = document.createElement("span");
  snippedText.className = "snippedTextInvisible";
  snippedText.textContent = snipped;
  f.appendChild(snippedText);

  // Add clickable "..." image.
  const snipImg = makeImg("snip.png", "");
  snipImg.className = "snipImg";
  const snipLink = document.createElement("a");
  snipLink.className = "snipLinkInvisible snipLinkVisible";
  snipLink.href = "#";
  snipLink.addEventListener("click", unsnipAll);
  snipLink.appendChild(snipImg);
  f.appendChild(snipLink);

  // Add suffix text.
  f.appendChild(document.createTextNode(suffix));
  return f;
}

function unsnipAll(event) {
  event.preventDefault();
  removeStyles(".snippedTextInvisible", ".snipLinkVisible");
}

function removeStyles(...selectors) {
  const stylesheet = document.styleSheets[0];
  for (const selector of selectors) {
    for (let i = stylesheet.cssRules.length - 1; i >= 0; i--) {
      const rule = stylesheet.cssRules[i];
      if (rule.selectorText === selector) {
        stylesheet.deleteRule(i);
      }
    }
  }
}

// Mac OS has an annoying feature where right-click selects the current
// "word" (i.e. a useless fragment of the address) before showing a
// context menu.  Detect this by watching for the selection to change
// between consecutive onmousedown and oncontextmenu events.
let oldTimeStamp = 0;
let oldRanges = [];
function handleMouseDown(e) {
  oldTimeStamp = e.timeStamp;
  oldRanges = [];
  const sel = window.getSelection();
  for (let i = 0; i < sel.rangeCount; i++) {
    oldRanges.push(sel.getRangeAt(i));
  }
}

function isSpuriousSelection(sel, newTimeStamp) {
  if (newTimeStamp - oldTimeStamp > 10) {
    return false;
  }
  if (sel.rangeCount != oldRanges.length) {
    return true;
  }
  for (let i = 0; i < sel.rangeCount; i++) {
    const r1 = sel.getRangeAt(i);
    const r2 = oldRanges[i];
    if (r1.compareBoundaryPoints(Range.START_TO_START, r2) != 0 ||
        r1.compareBoundaryPoints(Range.END_TO_END, r2) != 0) {
      return true;
    }
  }
  return false;
}

function handleContextMenu(e) {
  const sel = window.getSelection();
  if (isSpuriousSelection(sel, e.timeStamp)) {
    sel.removeAllRanges();
  }
  selectWholeAddress(this, sel);
  return sel;
}

function handleClick() {
  selectWholeAddress(this, window.getSelection());
}

// If the user hasn't manually selected part of the address, then select
// the whole thing, to make copying easier.
function selectWholeAddress(node, sel) {
  if (sel.isCollapsed || !sel.containsNode(node, true)) {
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Return only base domains, e.g. example.com from a.b.example.com.
function getSecondLevelDomains(domains) {
  const sdls = new Set();
  domains.forEach((domain) => {
    const split = domain.split(".");
    if (split.length > 2) {
      const topDomain = split.slice(split.length - 2).join(".");
      sdls.add(topDomain);
    } else {
      sdls.add(domain);
    }
  });
  return Array.from(sdls);
}
