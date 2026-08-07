Local vendor assets for offline CSP-friendly demos.

Expected filenames (place the minified files here):
- chart.umd.min.js        (Chart.js 4.4.1 UMD build)
- alpine.3.14.9.min.js    (AlpineJS 3.14.9 CDN build)
- fontawesome-6.0.0.min.css (Font Awesome 6.0.0 CSS)

Webfonts for Font Awesome:
- Put FA webfonts under public/webfonts/ (so CSS with ../webfonts resolves correctly)
  Example files (from the CDN package):
  - public/webfonts/fa-solid-900.woff2
  - public/webfonts/fa-regular-400.woff2
  - public/webfonts/fa-brands-400.woff2

Optional: Update SRI hashes in HTML (window.CDN_ASSETS.*.sri) if you want Subresource Integrity on CDN fallback.

You can download from:
- Chart.js: https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
- AlpineJS: https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js

Compute SRI (example using shasum):
  openssl dgst -sha384 -binary chart.umd.min.js | openssl base64 -A
Then set sri to: "sha384-<output>"

Repeat for Alpine and the FA CSS if you want integrity on CSS fallback:
  openssl dgst -sha384 -binary alpine.3.14.9.min.js | openssl base64 -A
  openssl dgst -sha384 -binary fontawesome-6.0.0.min.css | openssl base64 -A
