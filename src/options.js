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



  watchOptions(function(optionsChanged) {

    for (const option of optionsChanged) {
      if (option === "nat64Prefix") {
        document.getElementById('nat64Prefix').value = options["nat64Prefix"];
      }

      if (option === "nat64Hex") {
        document.getElementById('nat64Hex').checked = options["nat64Hex"];
      }

      if (!option.endsWith("ColorScheme")) continue;
      const radio = document.optionsForm[option];
      radio.value = options[option];
    }
    disableAll(false);
  });






  const defaultBrokenNat64 = "Invalid IPv6 network address";
  document.optionsForm.onchange = function(evt) {
    const newOptions = {};

    const nat64Prefix = document.getElementById('nat64Prefix').value;

    let [isValid, problem] = isValidIPv6Addr(nat64Prefix);
    if (isValid) {

      try {
        document.querySelector('.broken-nat64').style.display = 'none';
        if (options["nat64Prefix"] !== nat64Prefix) {
          document.querySelector('.page-reload-txt').style.display = 'flex';
        }
      } catch (error) {

      }

      newOptions['nat64Prefix'] = nat64Prefix;
    } else {
      try {
        document.querySelector('.broken-nat64').textContent = defaultBrokenNat64+': '+problem;
        document.querySelector('.broken-nat64').style.display = 'flex';
      } catch (error) {

      }
      newOptions['nat64Prefix'] = options['nat64Prefix']
    }

    const nat64Hex = document.getElementById('nat64Hex').checked;
    newOptions["nat64Hex"] = nat64Hex;

    for (const option of Object.keys(DEFAULT_OPTIONS)) {
      if (!option.endsWith("ColorScheme")) continue;
      newOptions[option] = document.optionsForm[option].value;
    }
    if (setOptions(newOptions)) {
      disableAll(true);
    }
  };









  // input handling. the use of onmousedown for everything exept the revert button is intentional.
// everything that the user wouldn't want to cancel should use onmousedown instead of onclick



  let radioClickOn = {};

  const radioButtons = document.querySelectorAll('input[type="radio"]');

  radioButtons.forEach(function (radio) {
    radioClickOn[radio.id] = false;

    radio.onclick = function(event) {
      if (!radioClickOn[radio.id]) {
        event.preventDefault();
      }
    };

    radio.onmousedown = function() {
      radioClickOn[radio.id] = true;
      this.click();
      radioClickOn[radio.id] = false;
    };
  });

  let nat64hexClickOn = false;
  document.getElementById("nat64Hex").onclick = function(event) {
    if (!nat64hexClickOn) {
      event.preventDefault();
    }
  };

  document.getElementById("nat64Hex").onmousedown = function() {
    nat64hexClickOn = true;
    this.click()
    nat64hexClickOn = false;

  };

  document.getElementById("revert_btn").onclick = function() {
    if (setOptions(DEFAULT_OPTIONS)) {
      disableAll(true);
    }
  };

  document.getElementById("dismiss_btn").onmousedown = function() {
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
