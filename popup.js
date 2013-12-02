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

var tabId = Number(window.location.hash.substr(1));
if (!isFinite(tabId)) {
  throw "Bad tabId";
}

var bg = chrome.extension.getBackgroundPage();
var table = null;

window.onload = function() {
  table = document.getElementById("addr_table");
  table.onmousedown = handleMouseDown;
  bg.popups.attachWindow(window);
};

// Clear the table, and fill it with new data.
function pushAll(tuples, spillCount) {
  while (table.hasChildNodes()) {
    table.removeChild(table.lastChild);
  }
  for (var i = 0; i < tuples.length; i++) {
    table.appendChild(makeRow(i == 0, tuples[i]));
  }
  pushSpillCount(spillCount);
}

// Insert or update a single table row.
function pushOne(tuple) {
  var domain = tuple[0];
  var insertHere = null;
  var isFirst = true;
  for (var tr = table.firstChild; tr; tr = tr.nextSibling) {
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
  document.getElementById("spill_count").innerHTML = count;
}

// Copy the contents of src into dst, making minimal changes.
function minimalCopy(src, dst) {
  dst.className = src.className;
  for (var s = src.firstChild, d = dst.firstChild;
       s && d; s = sNext, d = dNext) {
    var sNext = s.nextSibling;
    var dNext = d.nextSibling;
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
  var img = document.createElement("img");
  img.src = src;
  img.title = title;
  return img;
}

function makeSslImg(flags) {
  switch (flags & (bg.FLAG_SSL | bg.FLAG_NOSSL)) {
    case bg.FLAG_SSL | bg.FLAG_NOSSL:
      return makeImg(
          "gray_schrodingers_lock.png",
          "Mixture of HTTPS and non-HTTPS connections.");
    case bg.FLAG_SSL:
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
  var domain = tuple[0];
  var addr = tuple[1];
  var version = tuple[2];
  var flags = tuple[3];

  var tr = document.createElement("tr");
  if (isFirst) {
    tr.className = "mainRow";
  }

  // Build the "SSL" column.
  var sslTd = document.createElement("td");
  sslTd.appendChild(makeSslImg(flags));

  // Build the "Domain" column.
  var domainTd = document.createElement("td");
  domainTd.appendChild(document.createTextNode(domain));
  domainTd.onclick = handleClick;
  domainTd.oncontextmenu = handleContextMenu;

  // Build the "Address" column.
  var addrTd = document.createElement("td");
  var addrClass = "";
  switch (version) {
    case "4": addrClass = " ip4"; break;
    case "6": addrClass = " ip6"; break;
  }
  var connectedClass = (flags & bg.FLAG_CONNECTED) ? " highlight" : "";
  addrTd.className = "ipCell" + addrClass + connectedClass;
  addrTd.appendChild(document.createTextNode(addr));
  addrTd.onclick = handleClick;
  addrTd.oncontextmenu = handleContextMenu;

  // Build the (possibly invisible) "Cached" column.
  var cacheTd = document.createElement("td");
  cacheTd.className = "cacheCell" + connectedClass;
  if (!(flags & bg.FLAG_UNCACHED)) {
    cacheTd.title = "Data from cached requests only.";
    cacheTd.appendChild(document.createTextNode("\u21BB"));
  } else {
    cacheTd.style.padding = 0;
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
var oldTimeStamp = 0;
var oldRanges = [];
function handleMouseDown(e) {
  oldTimeStamp = e.timeStamp;
  oldRanges = [];
  var sel = window.getSelection();
  for (var i = 0; i < sel.rangeCount; i++) {
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
  for (var i = 0; i < sel.rangeCount; i++) {
    var r1 = sel.getRangeAt(i);
    var r2 = oldRanges[i];
    if (r1.compareBoundaryPoints(Range.START_TO_START, r2) != 0 ||
        r1.compareBoundaryPoints(Range.END_TO_END, r2) != 0) {
      return true;
    }
  }
  return false;
}

function handleContextMenu(e) {
  var sel = window.getSelection();
  if (isSpuriousSelection(sel, e.timeStamp)) {
    sel.removeAllRanges();
  }
  selectWholeAddress(this, sel);
}

function handleClick() {
  selectWholeAddress(this, window.getSelection());
}

// If the user hasn't manually selected part of the address, then select
// the whole thing, to make copying easier.
function selectWholeAddress(node, sel) {
  if (sel.isCollapsed || !sel.containsNode(node, true)) {
    var range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
