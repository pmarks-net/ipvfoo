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

// Requires <script src="common.js">

window.onload = async () => {
  disableAll(true);
  await spriteImgReady;

  for (const option of Object.keys(DEFAULT_OPTIONS)) {
    if (!option.endsWith("ColorScheme")) continue;
    for (const color of ["darkfg", "lightfg"]) {
      const canvas = document.getElementById(`${option}:${color}`);
      const ctx = canvas.getContext("2d");
      const imageData = buildIcon("646", 16, color);
      ctx.putImageData(imageData, 0, 0);
    }
  }

  const ipv4pages = document.getElementById("ipv4pages");
  for (const domain of IPV4_ONLY_DOMAINS.keys()) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `https://${domain}`;
    a.target = "_blank";
    a.textContent = domain;
    li.appendChild(a);
    ipv4pages.appendChild(li);
  }

  watchOptions(function(optionsChanged) {
    for (const option of optionsChanged) {
      if (option.endsWith("ColorScheme")) {
        const radio = document.optionsForm[option];
        radio.value = options[option];
      } else if (option == NAT64_KEY) {
        const table = document.getElementById("nat64");
        removeChildren(table);
        for (const packed96 of Array.from(options[NAT64_KEY]).sort()) {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.appendChild(document.createTextNode(formatIPv6(packed96) + "/96"));
          tr.appendChild(td);
          table.appendChild(tr);
        }
      }
    }
    disableAll(false);
  });

  document.optionsForm.onchange = function(evt) {
    const newOptions = {};
    for (const option of Object.keys(DEFAULT_OPTIONS)) {
      if (!option.endsWith("ColorScheme")) continue;
      newOptions[option] = document.optionsForm[option].value;
    }
    if (setOptions(newOptions)) {
      disableAll(true);
    }
  };

  document.getElementById("revert_btn").onclick = function() {
    revertNAT64();
    if (setOptions(DEFAULT_OPTIONS)) {
      disableAll(true);
    }
  };

  document.getElementById("dismiss_btn").onclick = function() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  };
}

function disableAll(disabled) {
  for (const e of document.getElementsByClassName("disabler")) {
    e.disabled = disabled;
  }
}
