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

const bg = chrome.extension.getBackgroundPage();
const colorSchemeOptions = ["regularColorScheme", "incognitoColorScheme"];

function disableAll(disabled) {
  for (const e of document.getElementsByClassName("disabler")) {
    e.disabled = disabled;
  }
}

function copyOptionsToForm() {
  for (const option of colorSchemeOptions) {
    const radio = document.optionsForm[option];
    radio.value = bg.options[option];
  }
}

document.optionsForm.onchange = function(evt) {
  const options = {};
  for (const option of colorSchemeOptions) {
    options[option] = document.optionsForm[option].value;
  }
  disableAll(true);
  bg.setOptions(options, function() {
    disableAll(false);
  });
};

document.getElementById("revert_btn").onclick = function() {
  disableAll(true);
  bg.clearOptions(function() {
    copyOptionsToForm();
    disableAll(false);
  });
};

document.getElementById("dismiss_btn").onclick = function() {
  window.close();
};

for (const option of colorSchemeOptions) {
  for (const color of ["darkfg", "lightfg"]) {
    const canvas = document.getElementById(option + ":" + color);
    const ctx = canvas.getContext("2d");
    const imageData = bg.buildIcon("646", 16, color);
    ctx.putImageData(imageData, 0, 0);
  }
}

disableAll(true);
bg.loadOptions(function() {
  copyOptionsToForm();
  disableAll(false);
});
