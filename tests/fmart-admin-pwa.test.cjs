const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const manifest = JSON.parse(fs.readFileSync('adminFMart16720/manifest.webmanifest', 'utf8'));
const adminHtml = fs.readFileSync('adminFMart16720/index.html', 'utf8');
const adminWorker = fs.readFileSync('adminFMart16720/service-worker.js', 'utf8');
const rootWorker = fs.readFileSync('service-worker.js', 'utf8');

test('FMart Admin manifest has a unique identity, launch URL and narrow scope', () => {
  assert.equal(manifest.id, '/fmart/adminFMart16720/');
  assert.equal(manifest.name, 'FMart Admin');
  assert.equal(manifest.start_url, './?pwa=admin');
  assert.equal(manifest.scope, '/fmart/adminFMart16720/');
  assert.ok(manifest.start_url.startsWith('./'));
  assert.ok(manifest.icons.every(icon => icon.src.startsWith('../icons/')));
});

test('FMart Admin registers its own service worker inside its own scope', () => {
  assert.match(adminHtml, /register\("\.\/service-worker\.js",\s*\{scope:"\.\/"\}\)/);
  assert.doesNotMatch(adminHtml, /register\("\.\.\/service-worker\.js"/);
  assert.match(adminHtml, /get\("pwa"\)==="admin"/);
  assert.match(adminHtml, /installed:isAdminPwaStandalone\(\)/);
  assert.doesNotMatch(adminHtml, /installed:window\.matchMedia\('\(display-mode: standalone\)'\)\.matches\|\|navigator\.standalone===true/);
});

test('Admin worker cache is private to its prefix and never purges Wali caches', () => {
  assert.match(adminWorker, /admin-fmart-pwa-/);
  assert.match(adminWorker, /key\.startsWith\(FMART_ADMIN_CACHE_PREFIX\)/);
  assert.match(adminWorker, /requestUrl\.pathname\.startsWith\(scopeUrl\.pathname\)/);
  assert.doesNotMatch(adminWorker, /caches\.delete\([^)]*fmart-/);
  assert.doesNotMatch(adminWorker, /importScripts\(/);
  assert.match(rootWorker, /const CACHE = 'fmart-shell-v16'/);
  const rootPrefix = (rootWorker.match(/const FMART_CACHE_PREFIX = '([^']+)'/) || [])[1];
  assert.equal(rootPrefix, 'fmart-');
  assert.ok(!'admin-fmart-pwa-shell-v1'.startsWith(rootPrefix), 'Root worker cleanup must not delete the Admin cache.');
});

test('OneSignal continues using the existing shared root worker and scope', () => {
  assert.match(adminHtml, /serviceWorkerPath:"\/fmart\/service-worker\.js"/);
  assert.match(adminHtml, /serviceWorkerParam:\{scope:"\/fmart\/"\}/);
  assert.match(adminHtml, /FMART_ONESIGNAL_LOGIN/);
  assert.match(adminHtml, /FMART_ONESIGNAL_LOGOUT/);
});

test('Admin inline JavaScript remains syntactically valid', () => {
  const scripts = [...adminHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
});

test('Admin service worker JavaScript remains syntactically valid', () => {
  assert.doesNotThrow(() => new vm.Script(adminWorker));
});
