#!/usr/bin/env node
// Copy the web pages (public/) into a folder for static hosting, such as
// GitHub Pages, and point them at a comm relay (server.js running elsewhere).
//
//   node tools/export-pages.js <target-folder> [relay]
//   node tools/export-pages.js ../whiskeyfur.github.io/stchat wss://relay.example.com
//
// Without a relay, people enter one on the sign-in screen (or use ?relay=...).
// Pages served over https need a wss:// relay (or one on localhost).
const fs = require('fs');
const path = require('path');

const [target, relay = ''] = process.argv.slice(2);
if (!target) {
  console.error('usage: node tools/export-pages.js <target-folder> [relay]');
  process.exit(1);
}
if (relay && !/^(wss?|https?):\/\/[^\s'"\\]+$/i.test(relay)) {
  console.error(`not a relay address: ${relay} (expected wss://host[:port])`);
  process.exit(1);
}

const src = path.join(__dirname, '..', 'public');
const dest = path.resolve(target);
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
}
fs.writeFileSync(path.join(dest, 'config.js'),
  `// Written by tools/export-pages.js: the comm relay these pages connect to.\nwindow.STCHAT_RELAY = ${JSON.stringify(relay)};\n`);
console.log(`Exported ${fs.readdirSync(src).length} files to ${dest}${relay ? ` (relay: ${relay})` : ' (no relay set; enter one on the sign-in screen)'}`);
