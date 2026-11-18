'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const setup = fs.readFileSync(path.join(root, 'apps-script/SetupDatabase.gs'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps-script/Index.html'), 'utf8');

function parseJavaScript(source, label) {
  assert.doesNotThrow(() => new vm.Script(source, { filename: label }), label + ' must parse');
}

parseJavaScript(setup, 'SetupDatabase.gs');
parseJavaScript(backend, 'Code.gs');

const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/.test(match[1]));
assert.ok(inlineScripts.length > 0, 'Index.html must contain an inline application script');
for (const [index, match] of inlineScripts.entries()) {
  const source = match[2].replace(/<\?=\s*portalMode\s*\?>/g, 'BUYER');
  parseJavaScript(source, 'Index.html inline script #' + (index + 1));
}

const backendFunctions = new Set(
  [...(backend + '\n' + setup).matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map((match) => match[1])
);
const frontendEndpoints = new Set(
  [...html.matchAll(/runServer\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
);
const missingEndpoints = [...frontendEndpoints].filter((name) => !backendFunctions.has(name));
assert.deepEqual(missingEndpoints, [], 'Every frontend runServer endpoint must exist in Apps Script');
assert.equal(frontendEndpoints.size, 75, 'Unexpected change in the registered frontend API surface');

function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  const next = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

const catalog = functionBody(backend, 'getCatalog');
const productDetail = functionBody(backend, 'getProductDetail');
const cashierPos = functionBody(backend, 'getCashierPOSData');
assert.doesNotMatch(catalog.slice(0, 400), /FMART\.ROLES\.KASIR/, 'Cashier must not call the warehouse catalog endpoint');
assert.doesNotMatch(productDetail.slice(0, 400), /FMART\.ROLES\.KASIR/, 'Cashier must not call warehouse product detail');
assert.match(cashierPos, /getSheetByName\('StokKasir'\)/, 'Cashier POS must read cashier stock only');

const loadInitialStart = html.indexOf('async function loadInitial()');
const loadInitialEnd = html.indexOf('\n    function render()', loadInitialStart);
assert.ok(loadInitialStart >= 0 && loadInitialEnd > loadInitialStart, 'loadInitial must exist');
const loadInitial = html.slice(loadInitialStart, loadInitialEnd);
const cashierBranch = loadInitial.indexOf("if(session.user.role==='KASIR')");
const warehouseCatalogCall = loadInitial.indexOf("runServer('getCatalog'");
assert.ok(cashierBranch >= 0 && warehouseCatalogCall > cashierBranch, 'Cashier must branch before warehouse catalog loading');
assert.match(loadInitial.slice(cashierBranch, warehouseCatalogCall), /state\.data=\{user:session\.user,categories:\[\],products:\[\],children:\[\]\}/);
assert.match(loadInitial.slice(cashierBranch, warehouseCatalogCall), /showStaffApp\(\)/);
assert.match(loadInitial.slice(cashierBranch, warehouseCatalogCall), /loadOps\(\)/);

console.log('FMart regression checks passed: Apps Script syntax, inline UI syntax, 75 API endpoints, cashier role isolation, and StokKasir-only POS inventory.');
