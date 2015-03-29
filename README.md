IPvFoo is a Chrome extension that adds an icon to your location bar, indicating whether the current page was fetched using IPv4 or IPv6. When you click the icon, a pop-up appears, listing the IP address for each domain that served the page elements.

Everything is captured privately using the webRequest API (new in Chrome 17), without creating any additional network traffic.

#### Install it from the Chrome Web Store:
https://chrome.google.com/webstore/detail/ecanpcehffngcegjmadlcijfolapggal

#### Screenshot:
![Screenshot](/misc/screenshot_webstore_640x400.png?raw=true)

#### Firefox Port:
Somebody named "Dagger" reimplemented IPvFoo for Firefox, and called it "[IPvFox](https://addons.mozilla.org/en-US/firefox/addon/ipvfox/)".  It uses the same concept and images, but [different code](https://github.com/Dagger0/IPvFox).
