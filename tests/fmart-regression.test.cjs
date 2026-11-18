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

const inlineScripts = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]
  .filter((match) => !/\\bsrc\\s*=/.test(match[1]));
assert.ok(inlineScripts.length > 0, 'Index.html must contain an inline application script');
for (const [index, match] of inlineScripts.entries()) {
  const source = match[2].replace(/<\\?=\\s*portalMode\\s*\\?>/g, 'BUYER');
  parseJavaScript(source, 'Index.html inline script #' + (index + 1));
}

const backendFunctions = new Set(
  [...(backend + '\\n' + setup).matchAll(/^\\s*function\\s+([A-Za-z_$][\\w$]*)\\s*\\(/gm)]
    .map((match) => match[1])
);
const frontendEndpoints = new Set(
  [...html.matchAll(/runServer\\(\\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
);
const missingEndpoints = [...frontendEndpoints].filter((name) => !backendFunctions.has(name));
assert.deepEqual(missingEndpoints, [], 'Every frontend runServer endpoint must exist in Apps Script');
assert.equal(frontendEndpoints.size, 75, 'Unexpected change in the registered frontend API surface');

assert.match(backend, /method !== 'TRANSFER'/, 'Guardian payment must accept bank transfer only');
assert.match(backend, /PAYMENT_BANK_NAME/);
assert.match(backend, /PAYMENT_ACCOUNT_NUMBER/);
assert.match(backend, /PAYMENT_ACCOUNT_NAME/);
assert.match(backend, /FMART\\.ROLES\\.ADMIN,FMART\\.ROLES\\.KASIR,FMART\\.ROLES\\.SUPERADMIN/);
assert.match(html, /const method='TRANSFER'/, 'Guardian UI must submit TRANSFER');
assert.match(html, /Rekening Transfer FMart/, 'Staff settings must manage bank account details');
assert.match(html, /copyBankAccountBtn/, 'Guardian UI must offer account-number copy');
assert.match(backend, /function confirmCashierQrisPayment\\(/, 'POS QRIS confirmation must remain available');
assert.match(backend, /function getCashierQrisQueue\\(/, 'POS QRIS queue must remain available');

console.log('FMart regression checks passed: Apps Script syntax, inline UI syntax, 75 API endpoints, bank-transfer contract, cashier verification, and POS QRIS preservation.');
