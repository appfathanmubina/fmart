const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const code = fs.readFileSync('apps-script/Code.gs', 'utf8');
const index = fs.readFileSync('apps-script/Index.html', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

function extractFunction(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp('function\\s+' + escaped + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm'));
  assert.ok(match, 'Function not found: ' + name);
  return match[0];
}

function signedBytes(buffer) {
  return Array.from(buffer, value => value > 127 ? value - 256 : value);
}

function makeUtilitiesMock() {
  const toBuffer = value => {
    if (Array.isArray(value)) return Buffer.from(value.map(byte => byte & 255));
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(String(value), 'utf8');
  };
  return {
    newBlob(value) {
      return { getBytes: () => signedBytes(Buffer.from(String(value), 'utf8')) };
    },
    computeHmacSha256Signature(data, key) {
      return signedBytes(createHmac('sha256', toBuffer(key)).update(toBuffer(data)).digest());
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(bytes.map(byte => byte & 255)).toString('base64')
        .replace(/\\+/g, '-').replace(/\\//g, '_');
    }
  };
}

test('Service worker only removes FMart-owned caches', () => {
  assert.match(serviceWorker, /const FMART_CACHE_PREFIX = ['"]fmart-['"]/);
  assert.match(serviceWorker, /key\\.startsWith\\(FMART_CACHE_PREFIX\\) && key !== CACHE/);
  const existing = ['fmart-shell-v14', 'psb-shell-v9', 'gps-fm-shell-v2', 'other-app-cache'];
  const removed = existing.filter(key => key.startsWith('fmart-') && key !== 'fmart-shell-v15');
  assert.deepEqual(removed, ['fmart-shell-v14']);
});

test('QRIS approval validator accepts only matching order, owner, method and exact amount', () => {
  const fn = extractFunction(code, 'validateQrisPaymentForApproval_');
  const sandbox = {};
  vm.runInNewContext(fn + '\\nthis.validate = validateQrisPaymentForApproval_;', sandbox);
  const payment = ['PAY-1', 'ORD-1', 'QRIS', 125000, 'https://proof', 'MENUNGGU_VERIFIKASI', '', '', new Date(), new Date(), 'APLIKASI', 'WALI-1', ''];
  const order = ['ORD-1', 'FM-0001', 'WALI-1', 'SANTRI-1', 100000, 25000, 0, 125000, 'MENUNGGU_PEMBAYARAN'];
  assert.equal(sandbox.validate(payment, order), true);
  assert.throws(() => sandbox.validate(payment.slice(0, 2).concat(['TRANSFER'], payment.slice(3)), order), /QRIS/);
  assert.throws(() => sandbox.validate(payment.slice(0, 3).concat([124999], payment.slice(4)), order), /Nominal/);
  assert.throws(() => sandbox.validate(payment.slice(0, 11).concat(['WALI-LAIN', '']), order), /Identitas Wali/);
  assert.throws(() => sandbox.validate(payment.slice(0, 1).concat(['ORD-LAIN'], payment.slice(2)), order), /Identitas pesanan/);
});

test('Kasir has limited QRIS proof and verification permission, not general admin access', () => {
  const verify = extractFunction(code, 'verifyPayment');
  const proof = extractFunction(code, 'getPaymentProofData');
  assert.match(verify, /FMART\\.ROLES\\.KASIR/);
  assert.match(verify, /session\\.role===FMART\\.ROLES\\.KASIR && paymentMethod!=='QRIS'/);
  assert.match(proof, /FMART\\.ROLES\\.KASIR/);
  assert.match(proof, /session\\.role===FMART\\.ROLES\\.KASIR&&String\\(pay\\.values\\[2\\]\\|\\|''\\)\\.toUpperCase\\(\\)!=='QRIS'/);
  assert.match(index, /KASIR:\\['staffDashboard','staffPOS','staffPaymentVerification'\\]/);
  assert.match(index, /staffPaymentVerification/);
});

test('Staff login cannot create a session before email OTP succeeds', () => {
  const login = extractFunction(code, 'login');
  const verifyOtp = extractFunction(code, 'verifyAdminLoginOtp');
  assert.match(login, /issueAdminLoginOtp_\\(r, rate\\)/);
  assert.match(login, /return otpResult/);
  assert.ok(login.indexOf('return otpResult') < login.indexOf('const token = Utilities.getUuid()'));
  assert.match(verifyOtp, /challenge\\.attempts>=5/);
  assert.match(verifyOtp, /constantTimeEqual_\\(adminOtpHash_/);
  assert.match(verifyOtp, /setValue\\(true\\)/);
  assert.match(index, /id="loginOtpPanel"/);
  assert.match(index, /runServer\\('verifyAdminLoginOtp'/);
  assert.match(index, /pendingLoginOtpChallengeId/);
});

test('PBKDF2 implementation matches the RFC 8018 SHA-256 test vector', () => {
  const fn = extractFunction(code, 'pbkdf2HmacSha256_');
  const sandbox = { Utilities: makeUtilitiesMock() };
  vm.runInNewContext(fn + '\\nthis.derive = pbkdf2HmacSha256_;', sandbox);
  assert.equal(
    sandbox.derive('password', 'salt', 1),
    'Eg-2z_z4syxD5yJSVsT4N6hlSMkszDVICAWYfLcL4Xs='
  );
});

test('PBKDF2 activation is runtime-gated and preserves legacy hash compatibility', () => {
  assert.match(code, /PASSWORD_HASH_MODE_PROPERTY: 'FMART_PASSWORD_HASH_MODE'/);
  assert.match(code, /function passwordHashMode_\\(\\)/);
  assert.match(code, /function activatePbkdf2PasswordHashing_\\(\\)/);
  assert.match(code, /const maxLoginHashMs = 1500/);
  assert.match(code, /if \(passwordHashMode_\\(\\) === 'PBKDF2'\)/);
  assert.match(code, /legacyHashPassword_\\(password, salt\\)/);
  assert.match(readme, /activatePbkdf2PasswordHashing_\\(\\)/);
});

test('Wali payment submission remains QRIS-only', () => {
  const submit = extractFunction(code, 'submitPayment');
  assert.match(submit, /method !== 'QRIS'/);
  assert.match(readme, /Wali hanya dapat mengajukan pembayaran melalui QRIS/);
  assert.doesNotMatch(readme, /Wali dapat memilih Transfer Bank atau QRIS/);
});
