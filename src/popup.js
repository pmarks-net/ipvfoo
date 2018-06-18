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

window.tabId = Number(window.location.hash.substr(1));
if (!isFinite(tabId)) {
  throw "Bad tabId";
}

const bg = chrome.extension.getBackgroundPage();
let table = null;

window.onload = function() {
  table = document.getElementById("addr_table");
  table.onmousedown = handleMouseDown;
  bg.popups.attachWindow(window);
};

// Clear the table, and fill it with new data.
function pushAll(tuples, spillCount) {
  removeChildren(table);
  for (let i = 0; i < tuples.length; i++) {
    table.appendChild(makeRow(i == 0, tuples[i]));
  }
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
}

// Count must be a number.
function pushSpillCount(count) {
  document.getElementById("spill_count_container").style.display =
      count == 0 ? "none" : "block";
  removeChildren(document.getElementById("spill_count")).appendChild(
      document.createTextNode(count));
}

function removeChildren(n) {
  while (n.hasChildNodes()) {
    n.removeChild(n.lastChild);
  }
  return n;
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

  // Build the "SSL" column.
  const sslTd = document.createElement("td");
  sslTd.appendChild(makeSslImg(flags));

  // Build the "Domain" column.
  const domainTd = document.createElement("td");
  domainTd.appendChild(document.createTextNode(domain));
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
  addrTd.className = "ipCell" + addrClass + connectedClass;
  addrTd.appendChild(document.createTextNode(addr));
  addrTd.onclick = handleClick;
  addrTd.oncontextmenu = handleAddrContextMenu;

  // Build the (possibly invisible) "WebSocket/Cached" column.
  // We don't need to worry about drawing both, because a cached WebSocket
  // would be nonsensical.
  const cacheTd = document.createElement("td");
  cacheTd.className = "cacheCell" + connectedClass;
  if (flags & FLAG_WEBSOCKET) {
    cacheTd.appendChild(
        makeImg("websocket.png", "WebSocket handshake; connection may still be active."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (!(flags & FLAG_UNCACHED)) {
    cacheTd.appendChild(
        makeImg("cached_arrow.png", "Data from cached requests only."));
    cacheTd.style.paddingLeft = '6pt';
  } else {
    cacheTd.style.paddingLeft = '0';
  }

  tr._domain = domain;
  tr.appendChild(sslTd);
  tr.appendChild(domainTd);
  tr.appendChild(addrTd);
  tr.appendChild(cacheTd);
  return tr;
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

function handleAddrContextMenu(e) {
  const sel = handleContextMenu.call(this, e);
  const text = sel.toString();
  if (text == this.innerText) {
    bg.updateContextMenu(text);
    e.cancelBubble = true;  // Inhibits the handler below.
  }
}

document.oncontextmenu = function() {
  bg.updateContextMenu("");
};

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
