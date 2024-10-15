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


let currentNAT64Valid = true;




function getBodyTotalHeight() {
    const body = document.body;

    const style = getComputedStyle(body);

    const marginTop = parseFloat(style.marginTop);
    const marginBottom = parseFloat(style.marginBottom);

    const totalHeight = body.offsetHeight + marginTop + marginBottom;

    return totalHeight;
}



async function scrollbarDelayedCheck() {
  await new Promise(resolve => setTimeout(resolve, 500));
  setScrollbar()
}


async function setScrollbar() {
  console.log(getBodyTotalHeight(), window.innerHeight, Math.abs(getBodyTotalHeight() - window.innerHeight))
  if (Math.abs(getBodyTotalHeight() - window.innerHeight) <= 5) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = 'auto';
  }
}





window.onload = async () => {
  disableAll(true);
  await spriteImgReady;

  document.body.style.overflow = 'hidden';

  document.body.onresize = async () => {
    document.body.style.overflow = 'hidden';
    scrollbarDelayedCheck();
  }


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
      currentNAT64Valid = true;
    } else {
      try {
        document.querySelector('.broken-nat64').textContent = problem;
        document.querySelector('.broken-nat64').style.display = 'flex';
      } catch (error) {

      }
      newOptions['nat64Prefix'] = options['nat64Prefix']
      currentNAT64Valid = false;
    }

    const nat64Hex = document.getElementById('nat64Hex').checked;
    newOptions["nat64Hex"] = nat64Hex;

    for (const option of Object.keys(DEFAULT_OPTIONS)) {
      if (!option.endsWith("ColorScheme")) continue;
      newOptions[option] = document.optionsForm[option].value;
    }

    dismissBtnOnmousedown = getDismissOnmousedown();

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

  let dismissBtnOnmousedown = getDismissOnmousedown();
  document.getElementById("dismiss_btn").onmousedown = function() {
    if (dismissBtnOnmousedown) {
      dismiss()
    }
  };

  document.getElementById("dismiss_btn").onclick = function() {
    if (!dismissBtnOnmousedown) {
      dismiss()
    }
  };



}

function dismiss() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.close();
  }
}

function getDismissOnmousedown() {
  if (currentNAT64Valid) {
    document.getElementById('dismiss_btn').className = 'dismiss_btn_normal';
    return true
  } else {
    document.getElementById('dismiss_btn').className = 'dismiss_btn_discard';
    return false
  }
}


function disableAll(disabled) {
  for (const e of document.getElementsByClassName("disabler")) {
    e.disabled = disabled;
  }
}
