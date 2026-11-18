const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const code = fs.readFileSync('apps-script/Code.gs', 'utf8');
const setup = fs.readFileSync('apps-script/SetupDatabase.gs', 'utf8');
const index = fs.readFileSync('apps-script/Index.html', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'Function not found: ' + name);
  if (name === 'getPaymentProofData') {
    return source.slice(start, source.indexOf('\n', start));
  }
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'Function end not found: ' + name);
  return source.slice(start, end + 2);
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
        .replace(/\+/g, '-').replace(/\//g, '_');
    }
  };
}

test('Service worker only removes FMart-owned caches', () => {
  assert.ok(serviceWorker.includes("const FMART_CACHE_PREFIX = 'fmart-'"));
  assert.ok(serviceWorker.includes('key.startsWith(FMART_CACHE_PREFIX) && key !== CACHE'));
  const existing = ['fmart-shell-v14', 'psb-shell-v9', 'gps-fm-shell-v2', 'other-app-cache'];
  const removed = existing.filter(key => key.startsWith('fmart-') && key !== 'fmart-shell-v15');
  assert.deepEqual(removed, ['fmart-shell-v14']);
});

test('QRIS approval validator accepts only matching order, owner, method and exact amount', () => {
  const fn = extractFunction(code, 'validateQrisPaymentForApproval_');
  const sandbox = {};
  vm.runInNewContext(fn + '\nthis.validate = validateQrisPaymentForApproval_;', sandbox);
  const payment = ['PAY-1', 'ORD-1', 'QRIS', 125000, 'https://proof', 'MENUNGGU_VERIFIKASI', '', '', new Date(), new Date(), 'APLIKASI', 'WALI-1', ''];
  const order = ['ORD-1', 'FM-0001', 'WALI-1', 'SANTRI-1', 100000, 25000, 0, 125000, 'MENUNGGU_PEMBAYARAN'];
  assert.equal(sandbox.validate(payment, order), true);
  assert.throws(() => sandbox.validate(payment.slice(0, 2).concat(['TRANSFER'], payment.slice(3)), order), /QRIS/);
  assert.throws(() => sandbox.validate(payment.slice(0, 3).concat([124999], payment.slice(4)), order), /Nominal/);
  assert.throws(() => sandbox.validate(payment.slice(0, 11).concat(['WALI-LAIN', '']), order), /Identitas Wali/);
  assert.throws(() => sandbox.validate(payment.slice(0, 1).concat(['ORD-LAIN'], payment.slice(2)), order), /Identitas pesanan/);
});

test('Kasir has limited QRIS proof and verification permission', () => {
  const verify = extractFunction(code, 'verifyPayment');
  const proof = extractFunction(code, 'getPaymentProofData');
  assert.ok(verify.includes('FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN,FMART.ROLES.KASIR'));
  assert.ok(verify.includes("session.role===FMART.ROLES.KASIR && paymentMethod!=='QRIS'"));
  assert.ok(verify.includes('validateQrisPaymentForApproval_(pay.values,order.values)'));
  assert.ok(proof.includes('FMART.ROLES.KASIR'));
  assert.ok(proof.includes("session.role===FMART.ROLES.KASIR&&String(pay.values[2]||'').toUpperCase()!=='QRIS'"));
  assert.ok(index.includes("KASIR:['staffDashboard','staffPOS','staffPaymentVerification']"));
  assert.ok(index.includes('staffPaymentVerification'));
});

test('Staff login cannot create a session before email OTP succeeds', () => {
  const login = extractFunction(code, 'login');
  const verifyOtp = extractFunction(code, 'verifyAdminLoginOtp');
  assert.ok(login.includes('issueAdminLoginOtp_(r, rate)'));
  assert.ok(login.includes('return otpResult'));
  assert.ok(login.indexOf('return otpResult') < login.indexOf('const token = Utilities.getUuid()'));
  assert.ok(verifyOtp.includes('challenge.attempts>=5'));
  assert.ok(verifyOtp.includes('constantTimeEqual_(adminOtpHash_'));
  assert.ok(verifyOtp.includes('setValue(true)'));
  assert.ok(index.includes('id="loginOtpPanel"'));
  assert.ok(index.includes("runServer('verifyAdminLoginOtp'"));
  assert.ok(index.includes('pendingLoginOtpChallengeId'));
});

test('PBKDF2 implementation matches the RFC 8018 SHA-256 test vector', () => {
  const fn = extractFunction(code, 'pbkdf2HmacSha256_');
  const sandbox = { Utilities: makeUtilitiesMock() };
  vm.runInNewContext(fn + '\nthis.derive = pbkdf2HmacSha256_;', sandbox);
  assert.equal(
    sandbox.derive('password', 'salt', 1),
    'Eg-2z_z4syxD5yJSVsT4N6hlSMkszDVICAWYfLcL4Xs='
  );
});

test('PBKDF2 activation is runtime-gated and preserves legacy hash compatibility', () => {
  assert.ok(code.includes("PASSWORD_HASH_MODE_PROPERTY: 'FMART_PASSWORD_HASH_MODE'"));
  assert.ok(code.includes('function passwordHashMode_()'));
  assert.ok(code.includes('function activatePbkdf2PasswordHashing_()'));
  assert.ok(code.includes('const maxLoginHashMs = 1500'));
  assert.ok(code.includes("if (passwordHashMode_() === 'PBKDF2')"));
  assert.ok(code.includes('return legacyHashPassword_(password, salt)'));
  assert.ok(readme.includes('activatePbkdf2PasswordHashing_()'));
});


test('Kasir queue is limited to QRIS Wali payments and legacy methods cannot be approved', () => {
  assert.ok(code.includes("pendingRows.filter(function(p){return String(p[2]||'').toUpperCase()==='QRIS';}).slice(0,queueLimit).map(mapPendingPayment)"));
  assert.ok(index.includes('Metode legacy tidak dapat disetujui'));
  assert.ok(code.includes("if(session.role===FMART.ROLES.KASIR && paymentMethod!=='QRIS')"));
});

test('Wali payment submission remains QRIS-only', () => {
  const submit = extractFunction(code, 'submitPayment');
  assert.ok(submit.includes("method!=='QRIS'"));
  assert.ok(readme.includes('Wali hanya dapat mengajukan pembayaran melalui QRIS'));
  assert.ok(!readme.includes('Wali dapat memilih Transfer Bank atau QRIS'));
});


test('Checkout retry uses a request key and persisted recovery payload',()=>{
 const f=extractFunction(code,'checkoutCart'),complete=extractFunction(code,'completeCheckoutOrder_');
 for(const x of ['requestKey','values[12]','values[13]','values[14]','completeCheckoutOrder_'])assert.ok(f.includes(x));
 assert.ok(complete.includes('selectedCartIds'));assert.ok(index.includes("localStorage.getItem('fmart.checkout.pending')"));
});
test('Stock receipt retry resumes missing rows without double-applying stock',()=>{
 const f=extractFunction(code,'createStockReceipt'),complete=extractFunction(code,'completeStockReceipt_');
 assert.ok(f.includes('values[10]'));assert.ok(f.includes('values[11]'));assert.ok(f.includes('values[12]'));assert.ok(f.includes('completeStockReceipt_'));
 assert.ok(complete.includes('live===Number(x.before)'));assert.ok(complete.includes('live!==Number(x.after)'));
 assert.ok(index.includes("localStorage.getItem('fmart.receipt.pending')"));
});
test('Payment retries are idempotent and file signatures are validated before Drive storage',()=>{
 const f=extractFunction(code,'submitPayment');assert.ok(f.includes('values[13]'));assert.ok(f.includes('p[14]'));
 assert.ok(f.includes('validateUploadedFileSignature_(bytes,mime)'));assert.ok(f.includes('getOrCreateTransactionProofFile_'));
 assert.ok(index.includes('pending.key'));assert.ok(index.includes('localStorage.removeItem(storageKey)'));
});
test('Delivery proof replay repairs missing records and rejects MIME spoofing',()=>{
 const f=extractFunction(code,'submitDeliveryProof');assert.ok(f.includes('validateUploadedFileSignature_(bytes,mimeType)'));
 assert.ok(f.includes('existingConfirmation')||f.includes('const confRows'));assert.ok(f.includes('RiwayatPengantaran'));assert.ok(f.includes('old.values[11]'));
});
test('Recovery audit is read-only and explicit recovery is role-gated',()=>{
 const a=extractFunction(code,'auditFMartTransactionRecovery_'),r=extractFunction(code,'recoverFMartTransactions_');
 assert.ok(a.includes("mode:'READ_ONLY'"));assert.ok(a.includes('NO_AUTOMATIC_STOCK_OR_PAYMENT_REPAIR'));
 assert.ok(r.includes('FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN'));assert.ok(r.includes('completeCheckoutOrder_'));assert.ok(r.includes('completeStockReceipt_'));
});
test('Reports use inclusive Asia/Jakarta days and include POS and cashier stock movements',()=>{
 const f=extractFunction(code,'getFMartReports'),p=extractFunction(code,'parseReportDate_');
 assert.ok(f.includes("'PenjualanToko'"));assert.ok(f.includes("'MutasiStokKasir'"));assert.ok(f.includes('posPaidTotal'));assert.ok(p.includes('+07:00'));
});
test('Uploaded file signature validator checks supported formats and rejects spoofing',()=>{
 const f=extractFunction(code,'validateUploadedFileSignature_'),sandbox={};vm.runInNewContext(f+'\nthis.validate=validateUploadedFileSignature_;',sandbox);
 assert.equal(sandbox.validate([255,216,255],'image/jpeg'),true);
 assert.equal(sandbox.validate([137,80,78,71,13,10,26,10],'image/png'),true);
 assert.equal(sandbox.validate([82,73,70,70,0,0,0,0,87,69,66,80],'image/webp'),true);
 assert.equal(sandbox.validate([37,80,68,70,45],'application/pdf'),true);
 assert.throws(()=>sandbox.validate([0,0,0],'image/png'),/Isi file/);
});


test('FIFO order stock release records mutation before changing balance and safely resumes partial lines',()=>{
 const build=extractFunction(code,'buildOrderStockPlan_'),apply=extractFunction(code,'applyOrderStockPlan_'),pending=extractFunction(code,'processPendingStockOrders_');
 assert.ok(build.includes('existingMutation'));
 assert.ok(apply.indexOf("mut.appendRow")<apply.indexOf("stock.getRange(x.index+2,4).setValue(x.after)"));
 assert.ok(apply.includes('finalizeReservations!==false'));
 assert.ok(pending.includes('recovery=plan.plan.filter(x=>x.existingMutation)'));
 assert.ok(pending.includes('applyOrderStockPlan_(ss,id,recovery'));
});
test('Stock reconciliation and receiving audits remain read-only',()=>{
 const stock=extractFunction(code,'auditFMartStockReconciliation_'),receipt=extractFunction(code,'auditWarehouseReceivingIntegrity_');
 assert.ok(stock.includes("mode:'READ_ONLY'"));assert.ok(stock.includes('NO_AUTOMATIC_STOCK_ADJUSTMENT'));
 assert.ok(receipt.includes("mode:'READ_ONLY'"));assert.ok(receipt.includes('NO_AUTOMATIC_REPAIR'));
});
test('POS sales retain request-key protection and cashier stock reconciliation',()=>{
 const sale=extractFunction(code,'createCashierSale'),audit=extractFunction(code,'auditFMartStockReconciliation_');
 assert.ok(sale.includes("r[17]||'')===requestKey"));
 assert.ok(sale.includes('sameItems')&&sale.includes('sameBuyer')&&sale.includes('samePayment'));
 assert.ok(audit.includes('POS_SALE_MUTATION_INCOMPLETE'));
});


test('Global CSS is consolidated while print receipt styles remain isolated',()=>{
 const styleTags=index.match(/<style/gi)||[];
 assert.equal(styleTags.length,2);
 assert.ok(index.includes('id="fmart-global-styles"'));
 assert.ok(!index.slice(index.indexOf('</html>')).includes('<style'));
 assert.ok(index.includes('FMart Tahap 3 — shared component'));
 assert.ok(index.includes('const html='));
});
test('Shared UI baseline enforces touch targets, visible focus, reduced motion and scroll containment',()=>{
 assert.ok(index.includes('--fm-touch-target:44px'));
 assert.ok(index.includes('min-height:var(--fm-touch-target)'));
 assert.ok(index.includes(':focus-visible'));
 assert.ok(index.includes('prefers-reduced-motion:reduce'));
 assert.ok(index.includes('overscroll-behavior:contain'));
 assert.ok(index.includes('.skip-link'));
 assert.ok(index.includes('Lewati ke konten utama'));
});
test('Responsive and role navigation coverage remains explicit',()=>{
 const nav=extractFunction(index,'configureStaffNavigation');
 for(const role of ['SUPERADMIN','ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'])assert.ok(nav.includes(role));
 assert.ok(nav.includes('aria-hidden'));assert.ok(nav.includes('tabIndex=visible?0:-1'));
 assert.ok(index.includes('@media(max-width:760px)'));
 assert.ok(index.includes('@media (min-width:761px) and (max-width:900px)'));
 assert.ok(index.includes('@media(max-width:380px)'));
});
test('Role-sensitive reports and QRIS settings remain server-gated',()=>{
 const reports=extractFunction(code,'getFMartReports'),settings=extractFunction(code,'getPaymentSettings'),ops=extractFunction(code,'getOperationsDashboard');
 assert.ok(reports.includes('FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN'));
 assert.ok(settings.includes('FMART.ROLES.SUPERADMIN'));
 assert.ok(ops.includes('pendingPayments:waliQrisQueue,products:[],categories:[]'));
});


test('Apps Script editor exposes safe setup and read-only readiness entry points',()=>{
 const setupEntry=extractFunction(setup,'setupFMartDatabase'),readiness=extractFunction(code,'runFMartReadinessAudit');
 assert.ok(setupEntry.includes('setupFMartDatabase_'));
 for(const name of ['auditFMartDatabaseIntegrity_','auditFMartRuntime_','auditFMartOperationalSync_','auditFMartStockReconciliation_','auditCashierPOSIntegrity_','auditWarehouseReceivingIntegrity_','auditFMartTransactionRecovery_'])assert.ok(readiness.includes(name));
 assert.ok(readiness.includes("mode:'READ_ONLY'"));
 assert.ok(!readiness.includes('installDeliveryAutomationTrigger_'));
});


test('Cashier POS integrity audit reads the cashier stock ledger, not warehouse mutations',()=>{
 const audit=extractFunction(code,'auditCashierPOSIntegrity_');
 assert.ok(audit.includes("getSheetByName('MutasiStokKasir')"));
 assert.ok(!audit.includes("getSheetByName('MutasiStok')"));
});


test('Readiness audit logs bounded diagnostic chunks without truncating the full report',()=>{
 const audit=extractFunction(code,'runFMartReadinessAudit');
 const logger=extractFunction(code,'logFMartReadinessAudit_');
 assert.ok(audit.includes('logFMartReadinessAudit_(report)'));
 assert.ok(!audit.includes('Logger.log(JSON.stringify(report,null,2))'));
 assert.ok(logger.includes("FMART_AUDIT_SUMMARY "));
 assert.ok(logger.includes("FMART_AUDIT_CHECK "));
 assert.ok(logger.includes("FMART_AUDIT_ISSUES "));
 assert.ok(logger.includes('issues.slice(i, i + chunkSize)'));
 assert.ok(logger.includes('totalParts: totalParts'));
 assert.ok(logger.includes('FMART_AUDIT_COMPLETE '));
});


test('Warehouse stock ledger is authoritative and missing rows never fall back to variation mirrors',()=>{
 const snapshot=extractFunction(code,'getProductSnapshot_'),catalog=extractFunction(code,'getCatalog'),detail=extractFunction(code,'getProductDetail'),admin=extractFunction(code,'getAdminCatalog'),stockCatalog=extractFunction(code,'getStockCatalog'),stockManagement=extractFunction(code,'getStockManagement'),minimum=extractFunction(code,'setStockMinimum'),dashboard=extractFunction(code,'getOperationsDashboard');
 assert.ok(snapshot.includes("stock=sr?Number(sr[3]):0"));assert.ok(!snapshot.includes('vr.values[5]'));
 assert.ok(catalog.includes('? stockByKey[key] : 0'));assert.ok(!catalog.includes('Number(r[5]) || 0'));
 assert.ok(detail.includes('stock:0'));assert.ok(!detail.includes('Number(v[5])'));
 assert.ok(admin.includes("getSheetByName('Stok')"));assert.ok(admin.includes('stockRecordMissing'));
 assert.ok(stockCatalog.includes('stockRecordMissing'));assert.ok(!stockCatalog.includes('Number(v[5])'));
 assert.ok(stockManagement.includes('stockRecordMissing'));assert.ok(!stockManagement.includes('Number(v[5])'));
 assert.ok(stockManagement.includes('missingStockRows'));assert.ok(index.includes('Data stok belum lengkap'));assert.ok(index.includes('Saldo utama belum tercatat'));
 assert.ok(minimum.includes('else stockSheet.appendRow([makeFMartId_(\'STK\'),productId,variationId,0,minStock,now])'));
 assert.ok(!dashboard.includes("stockMap[key]=Number(r[5])||0"));
});

test('Wali catalog uses authenticated server-side pagination and never sends stock fields',()=>{
 const initial=extractFunction(code,'getCatalog'),page=extractFunction(code,'getBuyerProductBatch');
 assert.ok(initial.includes('session.role === FMART.ROLES.WALI_SANTRI'));
 assert.ok(initial.includes('products:[]'));
 assert.ok(initial.includes('productCountsByCategory'));
 assert.ok(page.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"));
 assert.ok(page.includes('all.slice(offset,offset+limit)'));
 assert.ok(page.includes('hasMore:offset+items.length<all.length'));
 assert.ok(!page.includes('stock:'));
 assert.ok(index.includes("runServer('getBuyerProductBatch'"));
 assert.ok(index.includes('IntersectionObserver'));
 assert.ok(index.includes('productLoadSentinel'));
});

test('Wali Santri relationships are presented and used as saved delivery addresses',()=>{
 const record=extractFunction(code,'santriRecord_');
 const profile=extractFunction(code,'getWaliProfileManagement');
 const checkout=extractFunction(code,'checkoutCart');
 assert.ok(record.includes("asrama: String(santriField_(row, map, 'asrama') || '')"));
 assert.ok(profile.includes('asrama:String(child.asrama || \'\')'));
 assert.ok(checkout.includes('const santriAddress='));
 assert.ok(checkout.includes('child.asrama'));
 assert.ok(index.includes('Alamat Pengiriman Santri'));
 assert.ok(index.includes('checkout-address-card'));
 assert.ok(index.includes('name="checkoutSantriId"'));
 assert.ok(index.includes('Catatan titik penerimaan (opsional)'));
});


test('Wali can link an active Santri immediately without Admin approval',()=>{
 const link=extractFunction(code,'requestWaliSantriLink');
 const classes=extractFunction(code,'getSantriClassesForWaliSelf');
 const search=extractFunction(code,'searchSantriForWaliSelf');
 assert.ok(link.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"));
 assert.ok(link.includes("['AKTIF',now,hubungan]"));
 assert.ok(link.includes("'AKTIF',now,hubungan"));
 assert.ok(!link.includes('MENUNGGU_VERIFIKASI'));
 assert.ok(link.includes('activeCount>=2'));
 assert.ok(classes.includes("String(r[3]||'').toUpperCase()==='AKTIF'"));
 assert.ok(search.includes("String(r[3]||'').toUpperCase()==='AKTIF'"));
 assert.ok(index.includes('Hubungan langsung aktif tanpa persetujuan Admin.'));
 assert.ok(index.includes('Hubungkan Santri'));
 assert.ok(!index.includes('Pengajuan dari Wali harus disetujui Admin/Superadmin.'));
});


test('Buyer and staff inline application JavaScript parses after Apps Script template substitution',()=>{
 const match=index.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
 assert.ok(match,'Inline application script must exist.');
 const clientScript=match[1].replace(/<\?=\s*portalMode\s*\?>/g,'BUYER');
 assert.doesNotThrow(()=>new vm.Script(clientScript));
});
