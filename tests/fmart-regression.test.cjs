const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const code = fs.readFileSync('apps-script/Code.gs', 'utf8');
const setup = fs.readFileSync('apps-script/SetupDatabase.gs', 'utf8');
const index = fs.readFileSync('apps-script/Index.html', 'utf8');
const buyerShell = fs.readFileSync('index.html', 'utf8');
const adminIndex = fs.readFileSync('adminFMart16720/index.html', 'utf8');
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

test('Private Drive QRIS images are served safely for the Wali PWA',()=>{
 const helper=extractFunction(code,'extractQrisDriveFileId_'),reader=extractFunction(code,'getQrisImageData');
 const sandbox={};vm.runInNewContext(helper+'\nthis.extract=extractQrisDriveFileId_;',sandbox);
 assert.equal(sandbox.extract('https://drive.google.com/file/d/1Abcdefghijklmnop/view?usp=sharing'),'1Abcdefghijklmnop');
 assert.equal(sandbox.extract('https://drive.google.com/uc?export=view&id=1Abcdefghijklmnop'),'1Abcdefghijklmnop');
 assert.equal(sandbox.extract('https://example.com/image.png?id=1Abcdefghijklmnop'),'');
 assert.ok(reader.includes('FMART.ROLES.WALI_SANTRI,FMART.ROLES.SUPERADMIN'));
 assert.ok(reader.includes('file.isTrashed()')&&reader.includes('5*1024*1024'));
 assert.ok(reader.includes('validateUploadedFileSignature_(bytes,mime)'));
 assert.ok(reader.includes("'data:'+mime+';base64,'"));
 const display=extractFunction(index,'qrisDisplayImageUrl_');
 assert.ok(display.includes('drive\\.google\\.com'));
 assert.ok(index.includes("runServer('getQrisImageData',state.token)"));
 assert.ok(index.includes('qrisImageFallback')&&index.includes("paymentQrisImage').onerror"));
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

test('Superadmin can access Wali payment verification while other role navigation remains unchanged', () => {
  const nav = extractFunction(index, 'configureStaffNavigation');
  const superadminStart = nav.indexOf('SUPERADMIN:');
  const adminStart = nav.indexOf('ADMIN:');
  const superadminLine = nav.slice(superadminStart, nav.indexOf(String.fromCharCode(10), superadminStart));
  const adminLine = nav.slice(adminStart, nav.indexOf(String.fromCharCode(10), adminStart));
  assert.ok(superadminLine.includes("'staffPaymentVerification'"));
  assert.ok(!adminLine.includes("'staffPaymentVerification'"));
  const handlerStart = index.indexOf("$('staffPaymentVerification').addEventListener");
  const handler = index.slice(handlerStart, handlerStart + 500);
  assert.ok(handler.includes("['KASIR','SUPERADMIN'].includes(state.data.user.role)"));
  assert.ok(handler.includes('renderOpsPayments()'));
  const workspace = extractFunction(index, 'renderOpsPayments');
  assert.ok(workspace.includes("['ADMIN','SUPERADMIN','KASIR'].includes(role)"));
});

test('Profile shortcuts keep the matching staff sidebar item active', () => {
  assert.ok(index.includes("async function openReportsFromProfile(){closeProfile();const role=state.data?.user?.role;if(!state.token||!role){showToast('Sesi pengguna belum siap. Silakan masuk kembali ke FMart.','error');return}if(!['ADMIN','SUPERADMIN','SUPERVISOR'].includes(role)){showToast('Menu laporan tidak tersedia untuk role Anda.','error');return}setStaffActiveNavigation('staffReports');"));
  assert.ok(index.includes("async function openUserManagement(){closeProfile();if(!state.token){showToast('Sesi pengguna belum siap. Silakan masuk kembali ke FMart.','error');return}setStaffActiveNavigation('staffUsers');"));
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
test('Manual inbound stock audit accepts requestKey only with an exact matching AuditLog',()=>{
 const helper=extractFunction(code,'hasMatchingManualInboundAudit_'),audit=extractFunction(code,'auditWarehouseReceivingIntegrity_'),sandbox={};
 vm.runInNewContext(helper+'\nthis.match=hasMatchingManualInboundAudit_;',sandbox);
 const timestamp=new Date('2026-11-19T03:00:00.000Z');
 const mutation=['MUT-1','PROD-1','','MASUK',7,0,7,'request-key-123456','Saldo awal','USER-1',timestamp];
 const payload={productId:'PROD-1',variationId:'',type:'MASUK',qty:7,stockBefore:0,stockAfter:7};
 const auditRow=['','','','ADJUST_STOCK','STOK','request-key-123456','',''+JSON.stringify(payload),'',timestamp];
 assert.equal(sandbox.match([auditRow],mutation),true);
 assert.equal(sandbox.match([auditRow],mutation.map((v,i)=>i===4?8:v)),false);
 const wrongTime=auditRow.slice();wrongTime[9]=new Date(timestamp.getTime()+1000);
 assert.equal(sandbox.match([wrongTime],mutation),false);
 const legacyAudit=auditRow.slice();legacyAudit[5]='PROD-1';
 const legacyMutation=mutation.slice();legacyMutation[7]='';
 assert.equal(sandbox.match([legacyAudit],legacyMutation),true);
 assert.ok(audit.includes('hasMatchingManualInboundAudit_(auditRows,m)'));
 assert.ok(!audit.includes('INBOUND_MUTATION_REFERENCE_UNKNOWN'));
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
 assert.ok(reports.includes('FMART.ROLES.ADMIN,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN'));assert.ok(reports.includes('hppMissingLines'));assert.ok(reports.includes('grossProfit:grossProfit'));
 assert.ok(settings.includes('FMART.ROLES.SUPERADMIN'));
 assert.ok(ops.includes('pendingPayments:waliQrisQueue,products:[],categories:[]'));
 assert.ok(ops.includes("const users = readRows_(ss.getSheetByName('Users'));")&&ops.indexOf("const users = readRows_(ss.getSheetByName('Users'));")<ops.indexOf('const userMap = {}'),'Operations dashboard must load Users before building the recipient map.');
});


test('Apps Script editor exposes safe setup and read-only readiness entry points',()=>{
 const setupEntry=extractFunction(setup,'setupFMartDatabase_'),readiness=extractFunction(code,'runFMartReadinessAudit_');
 assert.ok(!setup.includes('function setupFMartDatabase('),'Database setup must not be exposed as a browser endpoint.');
 assert.ok(!code.includes('function runFMartReadinessAudit('),'Readiness audit must not be exposed as a browser endpoint.');
 assert.ok(setupEntry.includes('SpreadsheetApp.getActiveSpreadsheet()'));
 assert.ok(setupEntry.includes('ensureSheet_'));
 for(const name of ['auditFMartDatabaseIntegrity_','auditFMartRuntime_','auditFMartOperationalSync_','auditFMartStockReconciliation_','auditCashierPOSIntegrity_','auditWarehouseReceivingIntegrity_','auditFMartTransactionRecovery_'])assert.ok(readiness.includes(name));
 assert.ok(readiness.includes("mode:'READ_ONLY'"));
 assert.ok(!readiness.includes('installDeliveryAutomationTrigger_'));
});


test('Warehouse receiving audit delegates manual inbound validation to the exact-match helper',()=>{
 const audit=extractFunction(code,'auditWarehouseReceivingIntegrity_'),helper=extractFunction(code,'hasMatchingManualInboundAudit_');
 assert.ok(audit.includes('hasMatchingManualInboundAudit_(auditRows,m)'));
 assert.ok(helper.includes('entityId===requestKey||entityId===pid'));
 assert.ok(helper.includes("after.productId||'')===pid"));
 assert.ok(helper.includes('Number(after.stockBefore)===Number(mutation[5])'));
 assert.ok(helper.includes('Number(after.stockAfter)===Number(mutation[6])'));
});

test('Operational sync audit flags active non-variant products without canonical warehouse stock rows',()=>{
 const audit=extractFunction(code,'auditFMartOperationalSync_');
 assert.ok(audit.includes("status==='AKTIF'&&!productsWithVariations[id]&&!stockByKey[id+'|']"));
 assert.ok(audit.includes("'PRODUCT_STOCK_ROW_MISSING'"));
});

test('Cashier POS integrity audit reads the cashier stock ledger, not warehouse mutations',()=>{
 const audit=extractFunction(code,'auditCashierPOSIntegrity_');
 assert.ok(audit.includes("getSheetByName('MutasiStokKasir')"));
 assert.ok(!audit.includes("getSheetByName('MutasiStok')"));
});


test('Readiness audit logs bounded diagnostic chunks without truncating the full report',()=>{
 const audit=extractFunction(code,'runFMartReadinessAudit_');
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
 assert.ok(stockManagement.includes('missingStockRows'));assert.ok(index.includes('Data stok belum lengkap'));assert.ok(index.includes('Saldo utama belum tercatat'));assert.ok(index.includes('Saldo Gudang belum tercatat'));
 assert.ok(minimum.includes('stockSheet.appendRow([makeFMartId_(\'STK\'),productId,variationId,0,minStock,now])'));
 assert.ok(minimum.includes('Jalankan audit dan rekonsiliasi stok'));
 assert.ok(stockManagement.includes("stockRecordMissing:!sr"));
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

test('Wali checkout uses manual recipient snapshots and does not create or require a Wali-Santri relation',()=>{
 const checkout=extractFunction(code,'checkoutCart');
 const normalize=extractFunction(code,'normalizeOrderRecipient_');
 const snapshot=extractFunction(code,'getOrderRecipientSnapshot_');
 const detail=extractFunction(code,'getOrderDetail');
 assert.ok(checkout.includes('normalizeOrderRecipient_(recipientData,metodePengiriman,tujuan)'));
 assert.ok(checkout.includes('recipientSnapshot:recipient'));
 assert.ok(checkout.includes("session.userId,'',subtotal"));
 assert.ok(!checkout.includes('assertWaliChild_'));
 assert.ok(normalize.includes('recipient.address'));
 assert.ok(normalize.includes('Nama Santri/penerima wajib diisi'));
 assert.ok(snapshot.includes('payload.recipientSnapshot'));
 assert.ok(snapshot.includes('findSantriRowById_'),'Legacy orders must still resolve from the Santri master.');
 assert.ok(detail.includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(!detail.includes('assertWaliChild_'),'Order detail must not depend on an active relation after checkout.');
 assert.ok(index.includes('checkoutRecipientName'));
 assert.ok(index.includes('checkoutRecipientAddress'));
 assert.ok(index.includes('Data ini hanya digunakan sebagai alamat pesanan'));
 assert.ok(index.includes('runServer(\'checkoutCart\',state.token,recipient,selectedIds'));
 assert.ok(!index.includes('name="checkoutSantriId"'));
});
test('Order recipient snapshots are reused by internal order and delivery workspaces',()=>{
 assert.ok(extractFunction(code,'getMyOrders').includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(extractFunction(code,'getOperationsOrderDetail').includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(extractFunction(code,'getDeliveryAssignmentWorkspace').includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(extractFunction(code,'getDeliveryDashboard').includes('getOrderRecipientSnapshot_(ss,order)'));
 const delivery=extractFunction(code,'getDeliveryDashboard');
 assert.ok(delivery.includes("recipientName:String(child.name || 'Santri')"),'Delivery recipient name must come from the immutable order snapshot.');
 assert.ok(delivery.includes("recipientContact:String(child.phone || '')"),'Delivery contact must come from the recipient snapshot, not the Wali account.');
 assert.ok(!delivery.includes('recipientContact:String(wali.phone'),'Delivery must not substitute Wali contact for recipient contact.');
 assert.ok(!delivery.includes('waliByUserId')&&!delivery.includes('userById'),'Delivery task loading must not read unrelated Wali profile details.');
 assert.ok(index.includes('Kontak penerima:'),'Delivery UI must label the snapshot phone as recipient contact.');
 const operations=extractFunction(code,'getOperationsDashboard');
 const recovery=extractFunction(code,'recoverFMartTransactions_');
 const reports=extractFunction(code,'getWarehouseHistoryReport');
 assert.ok(operations.includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(operations.includes('child=getOrderRecipientSnapshot_(ss,o)'),'Payment verification must display the saved recipient.');
 assert.ok(recovery.includes('p.recipientSnapshot?{userId:p.userId,recipient:p.recipientSnapshot'),'Transaction recovery must validate the new recipient fingerprint.');
 assert.ok(reports.includes('getOrderRecipientSnapshot_(ss,order.row)'),'Order and delivery history must show the saved recipient.');
 assert.ok(extractFunction(code,'auditFMartOperationalSync_').includes('ORDER_RECIPIENT_MISSING'));
});


test('Wali-Santri relationship limits count distinct active and pending Wali accounts',()=>{
 const helper=extractFunction(code,'countDistinctActiveWaliForSantri_');
 assert.ok(helper.includes('activeWaliIds[waliId]=true'));
 assert.ok(helper.includes('Object.keys(activeWaliIds).length'));
 const self=extractFunction(code,'requestWaliSantriLink');
 assert.ok(self.includes('pairRows.some(function(item){return String(item.row[3]||\'\').toUpperCase()===\'AKTIF\';})'));
 assert.ok(self.includes('countDistinctActiveOrPendingWaliForSantri_(relRows,santriId)'));
 assert.ok(self.includes('otherWaliCount>=2'));
 const admin=extractFunction(code,'linkWaliSantri');
 assert.ok(admin.includes("String(wali.values[6]||'').toUpperCase()!=='AKTIF'"),'Admin cannot attach relationships to inactive Wali accounts.');
 assert.ok(admin.includes('activeOrPendingWaliIds'));
 const approve=extractFunction(code,'approveWaliSantriRequest');
 assert.ok(approve.includes('countDistinctActiveOrPendingWaliForSantri_'));
});

test('Critical write endpoints retain role guards, locks, ownership and state-transition checks',()=>{
 const roleMatrix={
  addToCart:['WALI_SANTRI'],updateCartItem:['WALI_SANTRI'],checkoutCart:['WALI_SANTRI'],submitPayment:['WALI_SANTRI'],
  markOrderReceived:['WALI_SANTRI'],reportDeliveryComplaint:['WALI_SANTRI'],cancelMyWaliSantriRequest:['WALI_SANTRI'],
  adjustStock:['GUDANG','ADMIN','SUPERADMIN'],transferWarehouseStockToCashier:['GUDANG','ADMIN','SUPERADMIN'],createStockReceipt:['GUDANG','ADMIN','SUPERADMIN'],
  createCashierSale:['KASIR','ADMIN','SUPERADMIN'],cancelCashierQrisSale:['KASIR','ADMIN','SUPERADMIN'],confirmCashierQrisPayment:['KASIR','ADMIN','SUPERADMIN'],
  updateOrderOperation:['GUDANG','ADMIN','SUPERADMIN'],assignDeliveryOrder:['ADMIN','GUDANG','SUPERADMIN'],
  respondDeliveryAssignment:['PETUGAS_PENGANTAR','GUDANG'],startDeliveryTrip:['PETUGAS_PENGANTAR','GUDANG'],
  updateDeliveryProgress:['PETUGAS_PENGANTAR','GUDANG'],reportDeliveryFailure:['PETUGAS_PENGANTAR','GUDANG'],submitDeliveryProof:['PETUGAS_PENGANTAR','GUDANG'],
  verifyPayment:['ADMIN','SUPERADMIN','KASIR'],linkWaliSantri:['ADMIN','SUPERADMIN'],approveWaliSantriRequest:['ADMIN','SUPERADMIN'],
  createStaffUser:['SUPERADMIN'],toggleFMartUser:['SUPERADMIN'],resetFMartUserPassword:['SUPERADMIN']
 };
 for(const [name,roles] of Object.entries(roleMatrix)){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes('requireRole_('),name+' must enforce server-side role authorization.');
  for(const role of roles)assert.ok(fn.includes('FMART.ROLES.'+role),name+' must retain '+role+' authorization.');
  assert.ok(fn.includes('LockService.getScriptLock()'),name+' must serialize concurrent writes.');
 }
 const remove=extractFunction(code,'removeCartItem');
 assert.ok(remove.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])")&&remove.includes('updateCartItem(token, cartId, 0)'),'Cart removal must delegate to the owner-checked update path.');
 const cart=extractFunction(code,'updateCartItem');
 assert.ok(cart.includes('String(row.values[1]) !== session.userId'),'Wali cannot change another account cart item.');
 for(const name of ['checkoutCart','submitPayment']){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes('requestKey'),'Checkout/payment writes must retain idempotency keys.');
  assert.ok(fn.includes('session.userId'),'Checkout/payment writes must bind the transaction to the active Wali.');
 }
 for(const name of ['markOrderReceived','reportDeliveryComplaint']){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes('String(order.values[2])!==String(session.userId)'),'Wali order mutations must be owner-scoped.');
 }
 const cancelRequest=extractFunction(code,'cancelMyWaliSantriRequest');
 assert.ok(cancelRequest.includes("String(row.values[1] || '') !== String(wali.waliId)"));
 assert.ok(cancelRequest.includes("!== 'MENUNGGU_VERIFIKASI'"));
 for(const name of ['adjustStock','transferWarehouseStockToCashier','createStockReceipt','createCashierSale']){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes('requestKey'),'Stock/POS mutations must be idempotent.');
 }
 const receipt=extractFunction(code,'createStockReceipt');
 assert.ok(receipt.includes('completeStockReceipt_'),'Stock receipt must use the shared atomic completion/recovery path.');
 const cashierCancel=extractFunction(code,'cancelCashierQrisSale');
 const cashierConfirm=extractFunction(code,'confirmCashierQrisPayment');
 for(const fn of [cashierCancel,cashierConfirm]){
  assert.ok(fn.includes("String(sale.values[13]||'')!==String(session.userId)"),'Cashier actions must be limited to sales created by that cashier.');
  assert.ok(fn.includes("String(sale.values[8]||'').toUpperCase()!=='QRIS'"),'Cashier payment action must be QRIS-only.');
 }
 const verify=extractFunction(code,'verifyPayment');
 assert.ok(verify.includes("paymentMethod!=='QRIS'"),'Kasir may only verify QRIS Wali payments.');
 const orderUpdate=extractFunction(code,'updateOrderOperation');
 assert.ok(orderUpdate.includes("nextStatus==='DIBATALKAN' && session.role==='GUDANG'"));
 assert.ok(orderUpdate.includes('orderFlow[current].indexOf(nextStatus)<0'),'Order status changes must follow the server transition map.');
 const assignment=extractFunction(code,'assignDeliveryOrder');
 assert.ok(assignment.includes("driver[6]||'').toUpperCase()!=='AKTIF'")&&assignment.includes("payment[5]||'').toUpperCase()!=='TERVERIFIKASI'"));
 for(const name of ['respondDeliveryAssignment','startDeliveryTrip','updateDeliveryProgress','reportDeliveryFailure','submitDeliveryProof']){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes('session.userId'),'Delivery writes must bind the task to the active staff account.');
  assert.ok(fn.includes("!==session.userId")||fn.includes("!== session.userId")||fn.includes("!==String(session.userId)"),name+' must reject another user assignment.');
 }
});

test('Self-link and Admin approval enforce the same two active-or-pending Wali limit',()=>{
 const helper=extractFunction(code,'countDistinctActiveOrPendingWaliForSantri_');
 assert.ok(helper.includes("['AKTIF','MENUNGGU_VERIFIKASI']"));
 assert.ok(helper.includes('waliIds[waliId]=true'));
 assert.ok(helper.includes('Object.keys(waliIds).length'));
 const self=extractFunction(code,'requestWaliSantriLink');
 assert.ok(self.includes('countDistinctActiveOrPendingWaliForSantri_(relRows,santriId)'));
 assert.ok(self.includes('linkedCount-((activePair||pendingPair)?1:0)'));
 const approve=extractFunction(code,'approveWaliSantriRequest');
 assert.ok(approve.includes('countDistinctActiveOrPendingWaliForSantri_'));
 assert.ok(approve.includes('activeOrPendingCount>2'));
 assert.ok(!approve.includes('activeCount>=2'),'Admin approval must not count active rows while ignoring other pending requests.');
});

test('Wali self-link auto-activates only on exact phone match and otherwise waits for Admin',()=>{
 const link=extractFunction(code,'requestWaliSantriLink');
 const classes=extractFunction(code,'getSantriClassesForWaliSelf');
 const search=extractFunction(code,'searchSantriForWaliSelf');
 assert.ok(link.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"));
 assert.ok(link.includes("santriField_(santri.values,santriMap,'no_wa_wali')"));
 assert.ok(link.includes('guardianPhone===waliPhone'));
 assert.ok(link.includes("phoneMatched?'AKTIF':'MENUNGGU_VERIFIKASI'"));
 assert.ok(link.includes('REQUEST_WALI_SANTRI_SELF'));
 assert.ok(classes.includes("['AKTIF','MENUNGGU_VERIFIKASI']"));
 assert.ok(search.includes("['AKTIF','MENUNGGU_VERIFIKASI']"));
 assert.ok(index.includes('Hubungan aktif otomatis jika nomor HP Wali cocok dengan no_wa_wali'));
 assert.ok(index.includes('pengajuan menunggu verifikasi Admin'));
 assert.ok(index.includes('Proses Penghubungan'));
 assert.ok(!index.includes('Hubungan langsung aktif tanpa persetujuan Admin.'));
});


test('Buyer and staff inline application JavaScript parses after Apps Script template substitution',()=>{
 const match=index.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
 assert.ok(match,'Inline application script must exist.');
 const clientScript=match[1].replace(/<\?=\s*portalMode\s*\?>/g,'BUYER');
 let parseError='';try{new vm.Script(clientScript,{filename:'apps-script/Index.html inline script'});}catch(error){parseError=String(error.stack||error);}
 assert.equal(parseError,'',parseError);
});

test('Logout clears only the active portal session namespace',()=>{
 assert.ok(index.includes('sessionStorage.removeItem(FMART_SESSION_TOKEN_KEY)'));
 assert.ok(index.includes("if(sessionStorage.getItem('fmartToken')===state.token)sessionStorage.removeItem('fmartToken')"));
 assert.ok(!index.includes('sessionStorage.clear()'));
});

test('Admin PWA resolves its own portal, token namespace, and distinct login layout',()=>{
 assert.ok(index.includes("new URLSearchParams(window.location.search).get('portal')"));
 assert.ok(index.includes("'fmartToken_admin'"));
 assert.ok(index.includes("'fmartToken_buyer'"));
 assert.ok(index.includes("sessionStorage.getItem('fmartToken')"));
 assert.ok(index.includes("sessionStorage.setItem(FMART_SESSION_TOKEN_KEY,legacyToken)"));
 assert.ok(index.includes("body.admin-portal .login-showcase{display:none}"));
 assert.ok(index.includes("Masuk Portal Petugas"));
});
test('Staff portal opens its shell before dashboard data and does not load the buyer catalog',()=>{
 const load= index.slice(index.indexOf('async function loadInitial(){'),index.indexOf('    function render(){',index.indexOf('async function loadInitial(){')));
 const staffBranch=load.slice(load.indexOf("if(session.user.role!=='WALI_SANTRI')"),load.indexOf("const catalog=await runServer('getCatalog'"));
 assert.ok(staffBranch.indexOf("showApp()")<staffBranch.indexOf("showStaffApp()"));
 assert.ok(staffBranch.indexOf("showStaffApp()")<staffBranch.indexOf("await loadOps()"));
 assert.ok(staffBranch.includes('showApp()'));
 assert.ok(!staffBranch.includes("runServer('getCatalog'"));
 assert.ok(load.includes('retryOpsStartup'));
});


test('Gudang can be assigned as a delivery executor without granting access to other users assignments',()=>{
 const dashboard=extractFunction(code,'getDeliveryDashboard');
 const respond=extractFunction(code,'respondDeliveryAssignment');
 const start=extractFunction(code,'startDeliveryTrip');
 const progress=extractFunction(code,'updateDeliveryProgress');
 const fail=extractFunction(code,'reportDeliveryFailure');
 const proof=extractFunction(code,'submitDeliveryProof');
 const workspace=extractFunction(code,'getDeliveryAssignmentWorkspace');
 const assign=extractFunction(code,'assignDeliveryOrder');
 for(const fn of [dashboard,respond,start,progress,fail,proof])assert.ok(fn.includes('FMART.ROLES.GUDANG'),'Gudang executor permission missing in delivery workflow.');
 assert.ok(dashboard.includes("String(row[2] || '') === String(session.userId)"),'Executor dashboard must remain scoped to the signed-in assignee.');
 for(const fn of [respond,start,progress,fail,proof])assert.ok(fn.includes('session.userId'),'Delivery mutations must retain assignee ownership checks.');
 assert.ok(workspace.includes("'PETUGAS_PENGANTAR','GUDANG'"),'Distribution list must include active Gudang accounts.');
 assert.ok(assign.includes("'PETUGAS_PENGANTAR','GUDANG'"),'Assignment endpoint must validate both supported executor roles.');
 assert.ok(assign.includes("String(driver[6]||'').toUpperCase()!=='AKTIF'"),'Inactive users must not be assigned.');
});

test('Gudang delivery workspace is available in the staff UI without changing its warehouse landing flow',()=>{
 const nav=extractFunction(index,'configureStaffNavigation');
 const workspace=extractFunction(index,'renderDeliveryWorkspace');
 assert.ok(nav.includes("GUDANG:['staffDashboard','staffOrders','staffStock','staffReceiving','staffWarehouseReports','staffDeliveryAssign','staffDelivery']"));
 assert.ok(workspace.includes("'PETUGAS_PENGANTAR','GUDANG'"));
 assert.ok(index.includes("if(!['PETUGAS_PENGANTAR','GUDANG'].includes(state.data.user.role)){showToast('Menu tidak tersedia untuk role Anda.')"));
 assert.ok(index.includes("await loadOps();"),'Gudang must retain the existing warehouse startup/dashboard flow.');
});



test('Wali-facing catalog, product detail, cart, and order endpoints do not expose stock quantities or shortage metadata',()=>{
 const catalog=extractFunction(code,'getCatalog'),page=extractFunction(code,'getBuyerProductBatch'),detail=extractFunction(code,'getProductDetail'),cart=extractFunction(code,'getCart'),add=extractFunction(code,'addToCart'),update=extractFunction(code,'updateCartItem'),orders=extractFunction(code,'getMyOrders'),orderDetail=extractFunction(code,'getOrderDetail'),dashboard=extractFunction(code,'getWaliDashboard');
 assert.ok(catalog.includes('products:[]'),'Wali initial catalog must not include the staff stock catalog payload.');
 assert.ok(page.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"));
 assert.ok(!page.includes('stock:'));
 assert.ok(detail.includes('delete productResult.stock')&&detail.includes('delete productResult.minStock'));
 assert.ok(detail.includes('priceAddition:v.priceAddition')&&!detail.includes('stock:v.stock'));
 assert.ok(cart.includes('available:snap ? snap.active : false'),'Cart availability must indicate product activity only, not stock quantity.');
 assert.ok(!cart.includes('stock:snap')&&!cart.includes('minStock:'));
 assert.ok(add.includes('return getCart(token)')&&update.includes('return getCart(token)'));
 for(const fn of [orders,orderDetail,dashboard])assert.ok(!/\b(?:stock|minStock|available|shortage|missingStock)\s*:/.test(fn),'Wali order response must not include inventory metadata.');
});

test('Wali stock-related notes and notifications are consistently redacted, including internal notification type',()=>{
 const sandbox={};
 vm.runInNewContext(extractFunction(code,'isWaliStockRelatedText_')+';'+extractFunction(code,'sanitizeWaliStockNote_'),sandbox);
 const stockText=sandbox.isWaliStockRelatedText_,sanitize=sandbox.sanitizeWaliStockNote_;
 const generic='Pesanan sedang diproses. Informasi perkembangan akan disampaikan melalui aplikasi.';
 for(const phrase of ['Stok belum mencukupi','Persediaan Gudang belum terpenuhi','Reservasi barang berakhir','Barang belum lengkap dari Gudang','Backorder masih diproses','Inventory warehouse shortage']){
  assert.equal(stockText(phrase),true,'Expected stock-related phrase to be detected: '+phrase);
  assert.equal(sanitize(phrase,'DIPROSES'),generic,'Expected stock-related note to be redacted: '+phrase);
 }
 assert.equal(sanitize('Mohon letakkan pesanan di meja penerimaan.','DIPROSES'),'Mohon letakkan pesanan di meja penerimaan.');
 const notifications=extractFunction(code,'getMyNotifications');
 assert.ok(notifications.includes("isWaliStockRelatedText_(title+' '+message)"));
 assert.ok(notifications.includes("type:redactStockDetails?'PESANAN':String(r[5]||'')"),'Raw internal notification type must not accompany a redacted Wali notification.');
 assert.ok(notifications.includes('waitingStockOrderIds[orderId]'),'Active internal stock-queue orders must always receive generic Wali notification copy.');
});

test('Buyer product detail UI never displays physical stock or shortage information',()=>{
 const detail=extractFunction(index,'openProduct'),sync=extractFunction(index,'syncDetailStockUI'),cart=extractFunction(index,'renderCart');
 assert.ok(sync.includes("badge.textContent='Produk dapat dipesan'"));
 assert.ok(!/\\bp\\.(?:stock|minStock)\\b|\\.available\\b/i.test(sync));
 assert.ok(cart.includes('!i.available?')&&cart.includes('Produk tidak tersedia'),'Cart may only report inactive products, never stock shortages.');
 assert.ok(!detail.includes('p.stock')&&!detail.includes('p.minStock'));
});

test('Changing a staff email does not mutate account security state when verification email delivery fails',()=>{
 const fn=extractFunction(code,'setStaffEmail');
 const send=fn.indexOf('MailApp.sendEmail');
 const emailWrite=fn.indexOf('setValues([[email,false]])');
 const securityTimestampWrite=fn.indexOf('setValue(new Date())');
 assert.ok(send>=0&&emailWrite>send&&securityTimestampWrite>send,'Account email and auth timestamp must only change after the verification email is accepted.');
 assert.ok(fn.includes("catch(sendError)"));
 assert.ok(fn.includes('CacheService.getScriptCache().remove(challengeKey)'),'A failed email delivery must discard its unusable challenge.');
 assert.ok(fn.includes('Data email akun tidak diubah'),'Failure response must make the no-mutation guarantee clear.');
 assert.ok(fn.includes('requireRole_(token,[FMART.ROLES.SUPERADMIN])'),'Only Superadmin may change staff email.');
});

test('Admin OTP and sessions remain bound to the active account security state',()=>{
 const otp=extractFunction(code,'verifyAdminLoginOtp');
 const session=extractFunction(code,'requireSession_');
 assert.ok(otp.includes('challenge.attempts>=5'));
 assert.ok(otp.includes('cache.remove(key)'),'Successful OTP must be consumed before a session is created.');
 assert.ok(otp.includes("String(user.values[6]||'').toUpperCase()!=='AKTIF'"));
 assert.ok(otp.includes("String(user.values[5]||'').toUpperCase()!==challenge.role"));
 assert.ok(otp.includes('normalizeEmail_(user.values[10])!==challenge.email'));
 assert.ok(otp.includes('updatedAt!==Number(challenge.authUpdatedAt)'));
 assert.ok(session.includes("status!=='AKTIF'||role!==String(s.role).toUpperCase()||updatedAt!==Number(s.authUpdatedAt)"),'Disabled accounts, changed roles, and password/security changes must revoke existing sessions.');
});

test('Database integrity audit accepts manual order recipient snapshots without a SantriId',()=>{
 const databaseAudit=extractFunction(setup,'auditFMartDatabaseIntegrity_');
 const operationalAudit=extractFunction(code,'auditFMartOperationalSync_');
 assert.ok(databaseAudit.includes("checkReference_('Pesanan', 3, 'Santri', 'SantriId pesanan', true)"),'SantriId is optional for orders that use the manual recipient snapshot model.');
 assert.ok(operationalAudit.includes("const hasManualRecipient=!!(payload.recipientSnapshot&&String(payload.recipientSnapshot.name||'').trim())"));
 assert.ok(operationalAudit.includes("if(!sid&&!hasManualRecipient)issue('ORDER_RECIPIENT_MISSING'"),'Orders without SantriId must still have a valid recipient snapshot.');
 assert.ok(operationalAudit.includes("if(sid&&!santriById[sid])issue('ORDER_SANTRI_REFERENCE_MISSING'"),'Legacy Santri-linked orders must continue validating their Santri reference.');
});

test('Database integrity audit supports decoupled cart and order recipient records',()=>{
 const databaseAudit=extractFunction(setup,'auditFMartDatabaseIntegrity_');
 const add=extractFunction(code,'addToCart');
 const update=extractFunction(code,'updateCartItem');
 const checkout=extractFunction(code,'checkoutCart');
 assert.ok(databaseAudit.includes("checkReference_('Keranjang', 2, 'Santri', 'SantriId keranjang', true)"),'Cart SantriId is optional because recipient data is entered at checkout.');
 assert.ok(databaseAudit.includes("checkReference_('Pesanan', 3, 'Santri', 'SantriId pesanan', true)"),'Order SantriId is optional when a manual recipient snapshot is present.');
 assert.ok(add.includes("session.userId,'',productId")&&update.includes("getRange(row.rowNumber, 3).clearContent()"),'Cart writes intentionally leave SantriId empty.');
 assert.ok(checkout.includes('recipientSnapshot'),'Checkout must persist the recipient snapshot.');
 assert.ok(databaseAudit.includes("checkReference_('Keranjang', 1, 'Users', 'UserId keranjang', false)"),'Required owner references remain enforced.');
 assert.ok(databaseAudit.includes("checkReference_('Pesanan', 2, 'Users', 'UserId pesanan', false)"),'Required order owner references remain enforced.');
});

test('Verified payment can resume an interrupted order transition without duplicate payment notification',()=>{
 const verify=extractFunction(code,'verifyPayment');
 assert.ok(verify.includes("if(paymentStatus==='TERVERIFIKASI')"),'A previously verified payment must enter a recovery path.');
 assert.ok(verify.includes("if(orderStatus==='MENUNGGU_PEMBAYARAN')"),'Recovery must complete the interrupted transition to MENUNGGU_STOK.');
 assert.ok(verify.includes("orderStatus!=='MENUNGGU_STOK'&&paidStatuses.indexOf(orderStatus)<0"),'Recovery must reject unrelated or cancelled order states.');
 assert.ok(verify.includes("if(orderStatus==='MENUNGGU_PEMBAYARAN'||orderStatus==='MENUNGGU_STOK')processPendingStockOrders_"),'Recovery must resume stock fulfillment only while the order remains in the pending-stock stage.');
 assert.ok(verify.includes("String(r[3]||'')==='Pembayaran terverifikasi'"),'Payment notification must be deduplicated during retry.');
 assert.ok(verify.includes("String(r[3]||'').toUpperCase()==='VERIFY_PAYMENT'&&String(r[5]||'')===paymentId"),'Verification audit must be deduplicated during retry.');
 assert.ok(verify.indexOf("if(paymentStatus==='TERVERIFIKASI')")<verify.indexOf("if(paymentStatus!=='MENUNGGU_VERIFIKASI')"),'Recovery must be checked before rejecting an already-verified payment.');
});

test('Manual stock adjustments are idempotent and recover journal-first partial writes',()=>{
 const fn=extractFunction(code,'adjustStock');
 assert.ok(fn.includes("requestKey=String(requestKey||'').trim()"));
 assert.ok(fn.includes("String(x.values[7]||'')===requestKey"));
 assert.ok(fn.indexOf("mutationSheet.appendRow")<fn.indexOf("sheet.getRange(row+2,4).setValue(after)"),'Mutation journal must be written before stock balance.');
 assert.ok(fn.includes("if(live===savedBefore)"),'Retry must finish an interrupted balance update.');
 assert.ok(fn.includes("if(live!==savedAfter)throw new Error"),'Unexpected balance must stop recovery.');
 assert.ok(fn.includes("String(m[9]||'')!==session.userId"),'A different actor must not replay another user request key.');
 assert.ok(index.includes("fmart.stock.adjust.pending")&&index.includes("pending.key"),'UI must retain request key while retrying the same adjustment.');
});

test('Warehouse-to-cashier transfers recover both ledgers and balances exactly once',()=>{
 const fn=extractFunction(code,'transferWarehouseStockToCashier');
 assert.ok(fn.includes("priorW=readRows_(wm).filter(r=>String(r[7]||'')===requestKey)"));
 assert.ok(fn.includes("priorC=readRows_(cm).filter(r=>String(r[7]||'')===requestKey)"));
 assert.ok(fn.includes("if(!priorW.length)throw new Error"),'Recovery must fail closed if the source ledger is missing instead of guessing the warehouse before-balance.');
 assert.ok(fn.includes("if(!priorC.length)cm.appendRow"),'Retry must complete the missing cashier ledger from the verified warehouse journal and current cashier balance.');
 assert.ok(fn.includes("if(live===before)"),'Retry must apply a balance that was not yet changed.');
 assert.ok(fn.includes("else if(live!==after)throw new Error"),'Unexpected balance must stop transfer recovery.');
 assert.ok(fn.includes("String(r[9]||'')===session.userId"),'A different actor must not replay another user transfer.');
 assert.ok(index.includes("fmart.stock.transfer.pending")&&index.includes("pending.key"));
});

test('Stock transfer and adjustment preserve warehouse reservation floor and variation mirror',()=>{
 const adjustment=extractFunction(code,'adjustStock'),transfer=extractFunction(code,'transferWarehouseStockToCashier');
 assert.ok(adjustment.includes("after<reservedNow"));
 assert.ok(transfer.includes("beforeW-qty<reserved"));
 assert.ok(adjustment.includes("getRange(variationRow.rowNumber,6,1,3).setValues"));
 assert.ok(transfer.includes("getRange(vr.rowNumber,6,1,3).setValues"));
});

test('Stock card sorts movements chronologically and validates the full balance chain',()=>{
 const fn=extractFunction(code,'getStockCardReport');
 assert.ok(fn.includes("targetMutations.sort(function(a,b){return a.time-b.time||a.row-b.row;})"),'Rows must be ordered by movement timestamp, not spreadsheet insertion order.');
 assert.ok(fn.includes("const chain=previous===null||previous===m.before"),'The report must validate continuity across all historical movements, not only the selected period.');
 assert.ok(fn.includes("if(!Number.isFinite(time))"),'Invalid movement timestamps must be surfaced instead of silently affecting period balances.');
 assert.ok(fn.includes("mutationIdCounts[id]>1"),'Duplicate movement IDs must be reported.');
 assert.ok(fn.includes("selectedItem.stock!==lastBalance"),'Current physical stock must reconcile to the latest chronologically valid movement.');
 assert.ok(fn.includes("valuation:{available:false,value:null"),'Stock value must remain unavailable without purchase-cost data.');
 assert.ok(fn.includes("Harga jual tidak digunakan sebagai pengganti harga pokok."));
});

test('Warehouse stock valuation never treats selling price as inventory cost',()=>{
 const fn=extractFunction(code,'getStockCardReport');
 assert.ok(fn.includes("valuation:{available:false,value:null"));
 assert.ok(index.toLowerCase().includes("harga jual produk")&&index.toLowerCase().includes("bukan nilai modal persediaan"),'UI must explain why selling price cannot be used as inventory value.');
});

test('Starting delivery can resume interrupted order, shipment, notification and history updates',()=>{
 const fn=extractFunction(code,'startDeliveryTrip');
 assert.ok(fn.includes("const recovering=before==='DALAM_PERJALANAN'"));
 assert.ok(fn.includes("orderStatus!=='DISIAPKAN'&&!(recovering&&orderStatus==='DIANTAR')"));
 assert.ok(fn.includes("shipmentStatus!=='DISIAPKAN'&&!(recovering&&shipmentStatus==='DIANTAR')"));
 assert.ok(fn.includes("String(n[3])==='Pesanan sedang diantar'"),'Retry must not duplicate the Wali notification.');
 assert.ok(fn.includes("MULAI_PENGANTARAN"),'Delivery history must be deduplicated.');
 assert.ok(fn.includes("START_DELIVERY"),'Audit log must be deduplicated.');
});

test('Reporting delivery failure can resume partial updates without duplicate notifications',()=>{
 const fn=extractFunction(code,'reportDeliveryFailure');
 assert.ok(fn.includes("const recovering=before==='GAGAL'"));
 assert.ok(fn.includes("String(row[11]||'').indexOf('[GAGAL] '+reason)<0"),'Recovery must be bound to the original failure reason.');
 assert.ok(fn.includes("orderStatus!=='DIANTAR'&&!(recovering&&orderStatus==='DISIAPKAN')"));
 assert.ok(fn.includes("shipmentStatus!=='DIANTAR'&&shipmentStatus!=='DISIAPKAN'"));
 assert.ok(fn.includes("Pengantaran belum berhasil")&&fn.includes("Pengantaran gagal - perlu penugasan ulang"),'Wali and staff notifications must be deduplicated.');
 assert.ok(fn.includes("PENGANTARAN_GAGAL")&&fn.includes("DELIVERY_FAILED"),'History and audit entries must be deduplicated.');
});

test('PWA service worker keeps the shell installable when the OneSignal CDN is unavailable',()=>{
 assert.ok(serviceWorker.includes('try {'));
 assert.ok(serviceWorker.includes('catch (error)'));
 assert.ok(serviceWorker.includes('PWA shell must still install'));
 assert.ok(serviceWorker.includes("const CACHE = 'fmart-shell-v16'"),'A cache version bump must invalidate stale shell assets.');
 assert.ok(serviceWorker.includes("cache.add(asset).catch"),'One unavailable optional shell asset must not reject the entire cache installation.');
});

test('PWA service worker caches first-seen static assets and keeps deployment config network-first',()=>{
 assert.ok(serviceWorker.includes('caches.match(request).then(cached => {'));
 assert.ok(serviceWorker.includes('if (cached) return cached;'));
 assert.ok(serviceWorker.includes('cache.put(request, response.clone())'));
 const configHandler=serviceWorker.slice(serviceWorker.indexOf("if (/\\/config\\.js$/i.test(url.pathname))"),serviceWorker.indexOf('// Cache-first untuk aset'));
 assert.ok(configHandler.includes('fetch(request)'),'Deployment config must prefer the network.');
 assert.ok(configHandler.includes('catch(() => caches.match(request))'),'Last known configuration remains the offline fallback.');
});

test('PWA offline navigation preserves separate Wali and Admin shell fallbacks',()=>{
 assert.ok(serviceWorker.includes("const isAdminRoute = /\\/adminFMart16720\\/?$/i.test(url.pathname)"));
 assert.ok(serviceWorker.includes("cached || caches.match(isAdminRoute ? './adminFMart16720/' : './index.html')"));
 assert.ok(serviceWorker.includes("url.origin !== self.location.origin"),'The service worker must not cache cross-origin Apps Script responses.');
});

test('Top-level cart removal endpoint explicitly enforces the Wali portal role',()=>{
 const fn=extractFunction(code,'removeCartItem');
 assert.ok(fn.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"),'Cart removal must enforce Wali authorization at its own public entry point.');
 assert.ok(fn.includes('updateCartItem(token, cartId, 0)'),'Removal must continue to reuse the validated cart update logic.');
});

test('Role workflow authorization matrix protects sensitive endpoints server-side',()=>{
 const matrix={
  wali:['getCart','addToCart','updateCartItem','removeCartItem','checkoutCart','getMyOrders','getOrderDetail','submitPayment','markOrderReceived','reportDeliveryComplaint','requestWaliSantriLink'],
  kasir:['getCashierPOSData','createCashierSale','getCashierSalesHistory','getCashierQrisQueue','confirmCashierQrisPayment','cancelCashierQrisSale','verifyPayment'],
  gudang:['getStockReceivingData','createStockReceipt','getStockManagement','adjustStock','transferWarehouseStockToCashier','getDeliveryDashboard','startDeliveryTrip','submitDeliveryProof'],
  pengantar:['getDeliveryDashboard','respondDeliveryAssignment','startDeliveryTrip','reportDeliveryFailure','updateDeliveryProgress','submitDeliveryProof'],
  admin:['getOperationsDashboard','getFMartReports','getFMartAuditLog','getDeliveryAssignmentWorkspace','assignDeliveryOrder','resolveDeliveryComplaint'],
  supervisor:['getOperationsDashboard','getOperationsOrderDetail','getAdminCatalog','getFMartReports'],
  superadmin:['createStaffUser','savePaymentSettings','setStaffEmail','updateFMartUser','toggleFMartUser','resetFMartUserPassword']
 };
 const roleNames={wali:'WALI_SANTRI',kasir:'KASIR',gudang:'GUDANG',pengantar:'PETUGAS_PENGANTAR',admin:'ADMIN',supervisor:'SUPERVISOR',superadmin:'SUPERADMIN'};
 for(const group of Object.keys(matrix)){
  for(const name of matrix[group]){
   const fn=extractFunction(code,name);
   assert.ok(fn,'Endpoint exists: '+name);
   assert.ok(fn.includes('requireRole_(')||fn.includes('requireSession_('),'Endpoint must validate session/role: '+name);
   assert.ok(fn.includes('FMART.ROLES.'+roleNames[group])||(group==='admin'&&fn.includes('FMART.ROLES.SUPERADMIN'))||(group==='superadmin'&&fn.includes('FMART.ROLES.SUPERADMIN')),'Endpoint role matrix must include '+roleNames[group]+': '+name);
  }
 }
});

test('Manual recipient checkout remains separate from official Wali-Santri linking workflows',()=>{
 const checkout=extractFunction(code,'checkoutCart');
 const link=extractFunction(code,'requestWaliSantriLink');
 assert.ok(checkout.includes('normalizeOrderRecipient_'));
 assert.ok(!checkout.includes('requestWaliSantriLink('),'Checkout must not create official Wali-Santri relationships.');
 assert.ok(link.includes("requireRole_(token,[FMART.ROLES.WALI_SANTRI])"));
});


test('Delivery proof storage rejects reuse of the payment proof folder',()=>{
 const fn=extractFunction(code,'getDeliveryProofFolder_');
 assert.ok(fn.includes("props.getProperty('FMART_PAYMENT_PROOF_FOLDER_ID')"));
 assert.ok(fn.includes("id===paymentId"));
 assert.ok(fn.includes('Folder bukti pengantaran harus berbeda'));
});

test('Runtime audit detects payment and delivery proof folder ID reuse',()=>{
 const start=code.indexOf('function auditFMartRuntime_()');
 const end=code.indexOf('\nfunction ',start+10);
 const fn=code.slice(start,end>0?end:undefined);
 assert.ok(fn.includes("code: 'DRIVE_PROOF_FOLDERS_REUSED'"));
 assert.ok(fn.includes('proofFolderIds.paymentProof === proofFolderIds.deliveryProof'));
});

test('Superadmin create-user form offers the supported delivery staff role',()=>{
 const formStart=index.indexOf('function openStaffUserForm()');
 const formEnd=index.indexOf('async function openPaymentProof',formStart);
 assert.ok(formStart>=0&&formEnd>formStart,'Staff user form must exist.');
 const form=index.slice(formStart,formEnd);
 assert.ok(form.includes('<option>PETUGAS_PENGANTAR</option>'),'Delivery staff must be selectable when creating a user.');
 assert.ok(form.includes("runServer('createStaffUser'"),'The form must continue to use the protected staff-user endpoint.');
 const endpoint=extractFunction(code,'createStaffUser');
 assert.ok(endpoint.includes("'PETUGAS_PENGANTAR'"),'Backend must accept the delivery staff role.');
});


test('Wali and staff navigation landmarks have accessible labels',()=>{
 assert.ok(index.includes('<nav class="bottom-nav" id="customerNav" aria-label="Navigasi Wali Santri">'));
 assert.ok(index.includes('<nav class="bottom-nav hidden" id="staffNav" aria-label="Navigasi petugas">'));
});

test('Admin desktop and tablet-landscape sidebar contains scrolling and supports short viewports',()=>{
 const desktopStart=index.indexOf('body.admin-portal #staffNav.bottom-nav{');
 assert.ok(desktopStart>=0,'Desktop sidebar rule must exist.');
 const desktopEnd=index.indexOf('}',desktopStart);
 const desktopRule=index.slice(desktopStart,desktopEnd);
 assert.ok(desktopRule.includes('transform:none'));
 assert.ok(desktopRule.includes('overflow-y:auto'),'Long role menus must remain vertically scrollable.');
 const stage38=index.slice(index.lastIndexOf('/* Tahap 38.2'),index.lastIndexOf('</style>'));
 assert.ok(stage38.includes('overscroll-behavior-y:contain'),'Sidebar scroll must not chain into the page.');
 assert.ok(stage38.includes('scrollbar-width:thin'));
 assert.ok(stage38.includes('@media (min-width:901px) and (max-height:640px)'),'Short desktop/tablet landscape viewports need compact sidebar spacing.');
 assert.ok(stage38.includes('min-height:44px'));
});

test('Tablet portrait keeps the staff navigation as a horizontally scrollable bottom bar',()=>{
 const start=index.indexOf('/* Tahap F — tablet portrait');
 const end=index.indexOf('/* Semua panel petugas',start);
 assert.ok(start>=0&&end>start,'Tablet portrait navigation override must exist.');
 const tablet=index.slice(start,end);
 assert.ok(tablet.includes('@media (min-width:761px) and (max-width:900px)'));
 assert.ok(tablet.includes('overflow-x:auto'));
 assert.ok(tablet.includes('overscroll-behavior-x:contain'));
});


test('Wali and staff navigation landmarks have accessible labels',()=>{
 assert.ok(index.includes('<nav class="bottom-nav" id="customerNav" aria-label="Navigasi Wali Santri">'));
 assert.ok(index.includes('<nav class="bottom-nav hidden" id="staffNav" aria-label="Navigasi petugas">'));
});

test('Admin desktop and tablet-landscape sidebar contains scrolling and supports short viewports',()=>{
 const desktopStart=index.indexOf('body.admin-portal #staffNav.bottom-nav{');
 assert.ok(desktopStart>=0,'Desktop sidebar rule must exist.');
 const desktopEnd=index.indexOf('}',desktopStart);
 const desktopRule=index.slice(desktopStart,desktopEnd);
 assert.ok(desktopRule.includes('transform:none'));
 assert.ok(desktopRule.includes('overflow-y:auto'),'Long role menus must remain vertically scrollable.');
 const stage38=index.slice(index.lastIndexOf('/* Tahap 38.2'),index.lastIndexOf('</style>'));
 assert.ok(stage38.includes('overscroll-behavior-y:contain'),'Sidebar scroll must not chain into the page.');
 assert.ok(stage38.includes('scrollbar-width:thin'));
 assert.ok(stage38.includes('@media (min-width:901px) and (max-height:640px)'),'Short desktop/tablet landscape viewports need compact sidebar spacing.');
 assert.ok(stage38.includes('min-height:44px'));
});

test('Tablet portrait keeps the staff navigation as a horizontally scrollable bottom bar',()=>{
 const start=index.indexOf('/* Tahap F — tablet portrait');
 const end=index.indexOf('/* Semua panel petugas',start);
 assert.ok(start>=0&&end>start,'Tablet portrait navigation override must exist.');
 const tablet=index.slice(start,end);
 assert.ok(tablet.includes('@media (min-width:761px) and (max-width:900px)'));
 assert.ok(tablet.includes('overflow-x:auto'));
 assert.ok(tablet.includes('overscroll-behavior-x:contain'));
});


test('FMart brand header returns each portal to its own home dashboard',()=>{
 const fn=extractFunction(index,'navigateHomeFromBrand_');
 assert.ok(fn.includes("user.role!=='WALI_SANTRI'"),'Staff roles must use the staff navigation path.');
 assert.ok(fn.includes("$('staffDashboard')")&&fn.includes('dashboard.click()'),'Staff must return to their authorized operational dashboard.');
 assert.ok(fn.includes("$('navHome')")&&fn.includes('buyerHome.click()'),'Wali must retain the buyer home navigation path.');
 const start=index.indexOf("const brandHome=$('brandHome')");
 const end=index.indexOf("$('closeWaliLink')",start);
 assert.ok(start>=0&&end>start,'Brand navigation handlers must exist.');
 const handlers=index.slice(start,end);
 assert.ok(handlers.includes("addEventListener('click',navigateHomeFromBrand_)"));
 assert.ok(handlers.includes("navigateHomeFromBrand_()"),'Keyboard activation must use the same role-aware navigation.');
});


test('Admin login restores the two-column showcase on desktop and tablet',()=>{
 const adminCssStart=index.indexOf('/* Login Admin — dua kolom pada Desktop/Tablet, ringkas pada HP. */');
 const adminCssEnd=index.indexOf('/* FMart Admin — Tahap 2',adminCssStart);
 assert.ok(adminCssStart>=0&&adminCssEnd>adminCssStart,'Dedicated Admin login layout rules must exist.');
 const css=index.slice(adminCssStart,adminCssEnd);
 assert.ok(css.includes('@media(min-width:761px)'));
 assert.ok(css.includes('body.admin-portal .login-wrap{grid-template-columns:minmax(0,6fr) minmax(340px,4fr)'));
 assert.ok(css.includes('body.admin-portal .login-showcase{display:flex'),'The Admin showcase must be visible on desktop/tablet.');
 assert.ok(css.includes('body.admin-portal .login-panel{width:auto;min-width:0;min-height:100svh'));
 assert.ok(css.includes('@media(min-width:1051px)'));
 assert.ok(css.includes('grid-template-columns:minmax(0,7fr) minmax(380px,3fr)'));
 assert.ok(css.includes('@media(max-width:760px)'));
 assert.ok(css.includes('body.admin-portal .login-showcase{display:none}'),'The compact single-column mobile layout must be preserved.');
});

test('Admin login showcase copy describes staff operations instead of Wali shopping',()=>{
 assert.ok(index.includes('id="showcaseTitle"'));
 assert.ok(index.includes('id="showcaseDescription"'));
 assert.ok(index.includes('id="showcaseFeatureOneTitle"'));
 assert.ok(index.includes('id="showcaseFeatureTwoTitle"'));
 assert.ok(index.includes('id="showcaseFeatureThreeTitle"'));
 const scriptStart=index.indexOf("if(FMART_PORTAL_MODE==='ADMINFMART16720'){");
 const scriptEnd=index.indexOf("if ($('registerBtn'))",scriptStart);
 assert.ok(scriptStart>=0&&scriptEnd>scriptStart);
 const adminInit=index.slice(scriptStart,scriptEnd);
 assert.ok(adminInit.includes("Satu portal untuk operasional pesantren"));
 assert.ok(adminInit.includes("Operasional terpusat"));
 assert.ok(adminInit.includes("Data lebih terpantau"));
 assert.ok(adminInit.includes("Akses berbasis peran"));
 assert.ok(adminInit.includes("Email Staf"),'Admin must retain email-based login.');
});


test('Admin login showcase initialization uses the ID-based DOM helper safely',()=>{
 assert.ok(index.includes('<section class="login-showcase" id="loginShowcase"'));
 const start=index.indexOf("if(FMART_PORTAL_MODE==='ADMINFMART16720'){");
 const end=index.indexOf("if ($('registerBtn'))",start);
 const adminInit=index.slice(start,end);
 assert.ok(adminInit.includes("$('loginShowcase').setAttribute("));
 assert.ok(!adminInit.includes("$('.login-showcase')"),'The ID-only helper must not receive a class selector.');
});


test('Staff dashboard shows a recoverable retry state when the initial summary request fails',()=>{
 const start=index.indexOf('async function loadOps(){');
 const end=index.indexOf('function renderOps(){',start);
 assert.ok(start>=0&&end>start,'Operational dashboard loader must exist.');
 const loader=index.slice(start,end);
 assert.ok(loader.includes("runServer('getOperationsDashboard',state.token)"));
 assert.ok(loader.includes("if(!opsData)"),'Initial load failures need a dedicated empty-state fallback.');
 assert.ok(loader.includes("id=\"retryOpsDashboard\""));
 assert.ok(loader.includes("$('retryOpsDashboard').onclick=loadOps"),'The retry action must invoke the same loader.');
 assert.ok(loader.includes("$('opsStats').classList.add('hidden')"),'Empty stats must be hidden when no summary is available.');
 assert.ok(loader.includes("showToast(message,'error')"),'Refresh failures after a successful load must preserve the current dashboard and report the error.');
 const renderStart=end;
 const renderEnd=index.indexOf('async function renderOpsReports',renderStart);
 const renderer=index.slice(renderStart,renderEnd);
 assert.ok(renderer.includes("$('opsStats').classList.remove('hidden')"),'Successful dashboard rendering must restore the stats panel.');
});

test('Buyer product-card action label matches its actual detail-opening behavior',()=>{
 const start=index.indexOf('function productCardMarkup(p){');
 const end=index.indexOf('\nfunction bindBuyerProductFeedObserver',start);
 assert.ok(start>=0&&end>start,'Buyer product-card renderer must exist.');
 const card=index.slice(start,end);
 assert.ok(card.includes('data-open-product='));
 assert.ok(card.includes('aria-label="Lihat detail produk '));
 assert.ok(card.includes('escapeHtml(p.name)'));
 assert.ok(card.includes('title="Lihat detail produk"'));
 assert.ok(!card.includes('title="Tambah ke keranjang"'),'The control must not claim to add directly when it opens product details.');
});


test('Buyer product detail loading errors use the non-blocking app feedback pattern',()=>{
 const start=index.indexOf('async function openProduct(productId){');
 const end=index.indexOf('\nfunction getCurrentDetailVariation',start);
 assert.ok(start>=0&&end>start,'Product detail loader must exist.');
 const fn=index.slice(start,end);
 assert.ok(fn.includes("showToast(e.message||'Gagal memuat detail produk.','error')"));
 assert.ok(!fn.includes('alert('),'Product detail failures must not interrupt the page with a blocking browser alert.');
 assert.ok(fn.includes('finally{loading(false)}'),'Loading state must always be dismissed.');
});


test('Wali cart quantity controls are accessible and respect the 10,000-unit limit',()=>{
 const start=index.indexOf('function renderCart(cart){');
 const end=index.indexOf('async function changeCartQty',start);
 assert.ok(start>=0&&end>start,'Cart renderer must exist.');
 const cart=index.slice(start,end);
 assert.ok(cart.includes('aria-label="Kurangi jumlah '));
 assert.ok(cart.includes('aria-label="Jumlah '));
 assert.ok(cart.includes('max="10000"'));
 assert.ok(cart.includes('aria-label="Tambah jumlah '));
 assert.ok(cart.includes("Number(i.qty)>=10000?'disabled':''"),'The increase control must be disabled at the server-side maximum.');
 assert.ok(cart.includes('aria-label="Hapus '));
});


test('Admin category, product, and staff forms associate labels with controls',()=>{
 const categoryStart=index.indexOf('function openCategoryForm(item){');
 const productStart=index.indexOf('function openProductForm(item){');
 const staffStart=index.indexOf('function openStaffUserForm(){');
 const proofStart=index.indexOf('async function openPaymentProof',staffStart);
 assert.ok(categoryStart>=0&&productStart>categoryStart&&staffStart>productStart&&proofStart>staffStart);
 const category=index.slice(categoryStart,productStart);
 const product=index.slice(productStart,staffStart);
 const staff=index.slice(staffStart,proofStart);
 for(const [source,id] of [[category,'catName'],[category,'catDesc'],[category,'catOrder'],[category,'catStatus'],[product,'prdCat'],[product,'prdSku'],[product,'prdName'],[product,'prdDesc'],[product,'prdPrice'],[product,'prdMin'],[product,'prdPhoto'],[product,'prdStatus'],[staff,'staffName'],[staff,'staffEmail'],[staff,'staffPassword'],[staff,'staffRole']]){
  assert.ok(source.includes('for="'+id+'"'),id+' label must be associated with its control.');
  assert.ok(source.includes('id="'+id+'"'),id+' control must remain present.');
 }
 for(const id of ['catName','prdCat','prdSku','prdName','prdPrice','staffName','staffEmail','staffPassword','staffRole']){
  const source=id.startsWith('cat')?category:id.startsWith('prd')?product:staff;
  assert.ok(source.includes('id="'+id+'" required'),id+' must expose its required state to browsers and assistive technology.');
 }
});


test('Admin payment, account, and warehouse forms associate labels with controls',()=>{
 const section=(start,end)=>{const a=index.indexOf(start),b=index.indexOf(end,a);assert.ok(a>=0&&b>a,start+' section must exist.');return index.slice(a,b)};
 const payment=section('function openPaymentSettings(){','async function openReportsFromProfile');
 const editWali=section('function openEditWaliForm(userId,waliId){','async function handleUserAction');
 const editUser=section('function openEditUserForm(id){','function openOpsModal');
 const staff=section('function openStaffUserForm(){','async function openPaymentProof');
 const receipt=section('function openStockReceiptForm(products){','function openStockMinimumForm');
 const minimum=section('function openStockMinimumForm(productId,variationId,currentMinimum,itemName){','async function openOpsOrderDetail');
 const variation=section('function openVariationForm(item){','async function openStockTransferForm');
 const transfer=section('async function openStockTransferForm(productId,variationId){','function openStockForm');
 const mutation=section('function openStockForm(productId,variationId){','function closeOpsModal');
 for(const [source,id] of [
  [payment,'payQrisImageUrl'],[payment,'payAdminWhatsapp'],
  [editWali,'editWaliName'],[editWali,'editWaliPhone'],[editWali,'editWaliEmail'],[editWali,'editWaliAddress'],
  [editUser,'editUserName'],[editUser,'editUserRole'],
  [receipt,'receiptSupplier'],[receipt,'receiptReference'],[receipt,'receiptDate'],[receipt,'receiptNote'],
  [minimum,'stockMinimumValue'],
  [variation,'varName'],[variation,'varValue'],[variation,'varPrice'],[variation,'varStock'],[variation,'varStatus'],
  [transfer,'transferProduct'],[transfer,'transferVariation'],[transfer,'transferQty'],[transfer,'transferNote'],
  [mutation,'stockProduct'],[mutation,'stockVariation'],[mutation,'stockType'],[mutation,'stockQty'],[mutation,'stockNote']
 ]){
  assert.ok(source.includes('for="'+id+'"'),id+' label must be associated with its control.');
 }
 assert.ok(receipt.includes('for="receiptProduct\'+i+\'"')&&receipt.includes('id="receiptProduct\'+i+\'"'));
 assert.ok(receipt.includes('for="receiptVariation\'+i+\'"')&&receipt.includes('id="receiptVariation\'+i+\'"'));
 assert.ok(receipt.includes('for="receiptQty\'+i+\'"')&&receipt.includes('id="receiptQty\'+i+\'"'));
 for(const [source,id] of [[payment,'payQrisImageUrl'],[receipt,'receiptSupplier'],[receipt,'receiptDate'],[minimum,'stockMinimumValue'],[transfer,'transferProduct'],[transfer,'transferQty'],[mutation,'stockProduct'],[mutation,'stockType'],[mutation,'stockQty'],[editUser,'editUserName'],[editUser,'editUserRole'],[editWali,'editWaliName'],[editWali,'editWaliPhone'],[variation,'varName'],[variation,'varValue'],[staff,'staffName'],[staff,'staffEmail'],[staff,'staffPassword']]){
  const control=source.match(new RegExp('<(?:input|select)[^>]*id="'+id+'"[^>]*>'));
  assert.ok(control&&/\brequired\b/.test(control[0]),id+' must expose its required state.');
 }
});


test('Admin report and audit filters expose associated labels and selected tab state',()=>{
 const dateControls=index.slice(index.indexOf('function reportDateControls_(prefix){'),index.indexOf('function renderReportWorkspace(){'));
 assert.ok(dateControls.includes("for=\"'+prefix+'Start\""));
 assert.ok(dateControls.includes("for=\"'+prefix+'End\""));
 const audit=index.slice(index.indexOf('function renderAuditWorkspace(){'),index.indexOf('async function loadAuditLog(){'));
 for(const id of ['auditRole','auditAction','auditSearch'])assert.ok(audit.includes('for="'+id+'"'),id+' filter must have an associated label.');
 const tabs=index.slice(index.indexOf('function renderOpsReports(){'),index.indexOf("let currentReportTab='sales';"));
 assert.ok(tabs.includes('role="group" aria-label="Jenis laporan"'));
 assert.ok(tabs.includes('aria-pressed="true"')&&tabs.includes('aria-pressed="false"'));
 const setter=index.slice(index.indexOf('function setReportTab_(tab){'),index.indexOf('function localDateInput_',index.indexOf('function setReportTab_(tab){')));
 assert.ok(setter.includes("setAttribute('aria-pressed'"),'Selected report tab state must be exposed to assistive technology.');
});

test('Admin report, audit, and integration loading failures have retryable recovery states',()=>{
 const report=index.slice(index.indexOf('async function loadReport(){'),index.indexOf('async function loadAuditLog(){'));
 assert.ok(report.includes("$('reportBody').dataset.loaded='true'"));
 assert.ok(report.includes('id="retryReport"')&&report.includes("$('retryReport').onclick=loadReport"));
 assert.ok(report.includes('hasil sebelumnya tetap ditampilkan'),'A failed report refresh must preserve the previous report.');
 const audit=index.slice(index.indexOf('async function loadAuditLog(){'),index.indexOf('async function loadIntegrationStatus(){'));
 assert.ok(audit.includes("$('auditRows').dataset.loaded='true'"));
 assert.ok(audit.includes('id="retryAuditLog"')&&audit.includes("$('retryAuditLog').onclick=loadAuditLog"));
 assert.ok(audit.includes('hasil sebelumnya tetap ditampilkan'),'A failed audit refresh must preserve the previous result.');
 const integration=index.slice(index.indexOf('async function loadIntegrationStatus(){'),index.indexOf('function opsWelcomeMarkup'));
 assert.ok(integration.includes('id="retryIntegrationStatus"'));
 assert.ok(integration.includes("$('retryIntegrationStatus').onclick=loadIntegrationStatus"));
 assert.ok(integration.includes('for="tabunganId"'));
});


test('Gudang dashboard exposes the internal waiting-stock queue as a filterable stage',()=>{
 const start=index.indexOf('function renderOpsWarehouseDashboard(){');
 const end=index.indexOf('function renderOpsWarehouse(){',start);
 assert.ok(start>=0&&end>start,'Warehouse dashboard renderer must exist.');
 const dashboard=index.slice(start,end);
 assert.ok(dashboard.includes("['MENUNGGU_STOK','Menunggu stok',count.MENUNGGU_STOK"));
 assert.ok(dashboard.includes('class="warehouse-home-flow warehouse-home-flow-stages"'));
 assert.ok(dashboard.includes("data-warehouse-stage=\"'+x[0]+'\""));
 assert.ok(dashboard.includes("openOrders(b.dataset.warehouseStage)"),'Stage cards must open the matching warehouse queue filter.');
 const styleStart=index.indexOf('/* Tahap 38 — six warehouse fulfillment stages');
 const styleEnd=index.indexOf('</style>',styleStart);
 const css=index.slice(styleStart,styleEnd);
 assert.ok(css.includes('@media(min-width:981px)'));
 assert.ok(css.includes('grid-template-columns:repeat(3,minmax(0,1fr))'));
 assert.ok(index.includes("['Menunggu Stok',counts.MENUNGGU_STOK]"),'The existing fulfillment queue must retain its internal stock-waiting count.');
});


test('Operations modal has an accessible close name and supports Escape dismissal',()=>{
 assert.ok(index.includes('id="closeOpsModal" aria-label="Tutup dialog"'));
 assert.ok(index.includes("$('closeOpsModal').addEventListener('click',closeOpsModal)"));
 const escapeStart=index.indexOf("document.addEventListener('keydown',e=>{\n      const visible=Array.from(document.querySelectorAll('.modal:not(.hidden)'));");
 const escapeEnd=index.indexOf("window.addEventListener('load',boot)",escapeStart);
 const escapeHandler=index.slice(escapeStart,escapeEnd);
 assert.ok(escapeStart>=0&&escapeEnd>escapeStart,'Global Escape handler must exist.');
 assert.ok(escapeHandler.includes('opsModal:closeOpsModal'),'Escape must still close the staff operations modal when it is on top.');
 assert.ok(escapeHandler.includes('const close=closeById[top.id]'),'Escape must dispatch to the topmost visible modal.');
});


test('Santri search, class filter, and relationship labels are explicitly associated with their controls',()=>{
 for(const id of ['waliChildSearch','waliClassFilter','pickerSantriSearch','pickerClassFilter','santriSearch','waliHubungan']){
  assert.ok(index.includes('label for="'+id+'"'),'Missing associated label for '+id);
  assert.ok(index.includes('id="'+id+'"'),'Missing control '+id);
 }
});


test('Delivery status filters include all backend status aliases in the same user-facing group',()=>{
 const start=index.indexOf('function drawDeliveryDashboard(){');
 const end=index.indexOf('async function loadDeliveryProofPreview',start);
 assert.ok(start>=0&&end>start,'Delivery dashboard renderer must exist.');
 const fn=index.slice(start,end);
 assert.ok(fn.includes("DITUGASKAN:['DITUGASKAN','BARU','MENUNGGU_KONFIRMASI']"));
 assert.ok(fn.includes("DITERIMA:['DITERIMA','DITERIMA_PETUGAS']"));
 assert.ok(fn.includes("DALAM_PERJALANAN:['DALAM_PERJALANAN','DIANTAR']"));
 assert.ok(fn.includes('matchingStatuses.includes(String(t.assignmentStatus||\'\').toUpperCase())'));
 assert.ok(fn.includes('value="DITUGASKAN"')&&fn.includes('value="DITERIMA"')&&fn.includes('value="DALAM_PERJALANAN"'),'The existing filter options must remain stable and map to status groups.');
});


test('Cashier POS buyer, payment, and quantity controls have accessible names',()=>{
 const start=index.indexOf('function renderCashierPOSPanel_(){');
 const end=index.indexOf('function bindCashierPOSPanel_(){',start);
 assert.ok(start>=0&&end>start,'Cashier POS renderer must exist.');
 const pos=index.slice(start,end);
 assert.ok(pos.includes('aria-labelledby="cashierBuyerHeading"'));
 assert.ok(pos.includes('aria-label="Nama pembeli"'));
 assert.ok(pos.includes('aria-label="Cari nama atau NIS santri"'));
 assert.ok(pos.includes('aria-labelledby="cashierPaymentHeading"'));
 assert.ok(pos.includes('for="cashierPaymentMethod"'));
 assert.ok(pos.includes('aria-label="Kurangi jumlah '));
 assert.ok(pos.includes('aria-label="Tambah jumlah '));
 assert.ok(pos.includes('escapeHtml(x.name)'));
 assert.ok(pos.includes('aria-label="Cari riwayat penjualan"'));
});


test('Delivery dashboard refresh preserves the last rendered tasks when a refresh request fails',()=>{
 const start=index.indexOf('async function renderDeliveryWorkspace(){');
 const end=index.indexOf('let deliveryDashboardRendered=false;',start);
 assert.ok(start>=0&&end>start,'Delivery dashboard loader must exist.');
 const loader=index.slice(start,end);
 assert.ok(loader.includes("const hasPreviousDashboard=!!deliveryDashboardData&&deliveryDashboardRendered&&!!currentTaskList&&$('opsMainBody').contains(currentTaskList)"));
 assert.ok(loader.includes("if(!hasPreviousDashboard)$('opsMainBody').innerHTML="),'Only an initial load should replace the workspace with a loading state.');
 assert.ok(loader.includes("if(hasPreviousDashboard){"));
 assert.ok(loader.includes("Data terakhir tetap ditampilkan."),'Refresh failures must preserve the last successful view.');
 assert.ok(loader.includes("id=\"retryDeliveryDashboard\""),'Initial failures must still offer retry.');
 const logout=index.indexOf("deliveryDashboardData=null;deliveryDashboardRendered=false;deliveryAssignmentData=null;$('opsMainBody').innerHTML='';document.querySelectorAll('.modal').forEach(modal=>modal.classList.add('hidden'));$('opsModalBody').innerHTML='';updateCartBadge(0)");
 assert.ok(logout>=0,'Cached delivery and assignment data plus internal DOM must be cleared when the user logs out.');
});


test('Cashier POS refresh failures preserve previously loaded catalog and cart state',()=>{
 const pos=index.slice(index.indexOf('async function loadCashierPOSData_(query){'),index.indexOf('async function loadCashierQrisQueue_(render){'));
 assert.ok(pos.includes('pos.loadedSearch=String(query||\'\');pos.hasLoadedProducts=true'));
 assert.ok(pos.includes('if(pos.hasLoadedProducts)'));
 assert.ok(pos.includes('pos.search=pos.loadedSearch||\'\''));
 assert.ok(pos.includes('hasil sebelumnya tetap ditampilkan'));
 assert.ok(pos.includes('renderCashierPOSPanel_()'),'Previously loaded POS products and cart must be redrawn after a failed search.');
 assert.ok(pos.includes('id="cashierPOSRetry"'),'Initial catalog failure must still provide a retry button.');
});

test('Cashier QRIS queue and sales-history refresh failures preserve previous results',()=>{
 const qris=index.slice(index.indexOf('async function loadCashierQrisQueue_(render){'),index.indexOf('function cashierQrisRemaining_'));
 assert.ok(qris.includes('hadData=!!pos.qrisQueueLoaded'));
 assert.ok(qris.includes('Pembaruan antrean QRIS gagal; data sebelumnya tetap ditampilkan.'));
 const sales=index.slice(index.indexOf('async function loadCashierSalesHistory_(){'),index.indexOf('function cashierSaleStatus_'));
 assert.ok(sales.includes('hadData=!!pos.salesHistoryLoaded'));
 assert.ok(sales.includes('Pembaruan riwayat gagal; hasil sebelumnya tetap ditampilkan.'));
 assert.ok(sales.includes('if(body&&!hadData)'),'Initial history loading must still show a loading state.');
});


test('Delivery assignment refresh preserves the last successful distribution workspace on request failure',()=>{
 const start=index.indexOf('async function renderDeliveryAssignmentWorkspace(){');
 const end=index.indexOf('function drawDeliveryAssignmentWorkspace(){',start);
 assert.ok(start>=0&&end>start,'Delivery assignment loader must exist.');
 const loader=index.slice(start,end);
 assert.ok(loader.includes("const hasPreviousWorkspace=!!deliveryAssignmentData&&!!refreshButton&&$('opsMainBody').contains(refreshButton)"));
 assert.ok(loader.includes("if(!hasPreviousWorkspace)$('opsMainBody').innerHTML="),'Only the initial load should replace the workspace with a loading state.');
 assert.ok(loader.includes("if(hasPreviousWorkspace){"));
 assert.ok(loader.includes('Data terakhir tetap ditampilkan.'));
 assert.ok(loader.includes('id="retryDeliveryAssign"'),'Initial failure must keep a retry action.');
 assert.ok(index.includes("deliveryAssignmentData=null;$('opsMainBody').innerHTML='';document.querySelectorAll('.modal').forEach(modal=>modal.classList.add('hidden'));$('opsModalBody').innerHTML='';updateCartBadge(0)"),'Logout must clear cached distribution data and internal DOM.');
});


test('Delivery complaints refresh preserves the last successful workspace and logout clears internal content',()=>{
 const start=index.indexOf('async function renderDeliveryComplaintsWorkspace(){');
 const end=index.indexOf('async function renderDeliveryWorkspace(){',start);
 assert.ok(start>=0&&end>start,'Delivery complaints loader must exist.');
 const fn=index.slice(start,end);
 assert.ok(fn.includes("const hasPreviousWorkspace=!!refreshButton&&$('opsMainBody').contains(refreshButton)"));
 assert.ok(fn.includes("if(!hasPreviousWorkspace)$('opsMainBody').innerHTML="));
 assert.ok(fn.includes('Komplain gagal diperbarui. Data terakhir tetap ditampilkan.'));
 assert.ok(fn.includes('id="retryDeliveryComplaints"'),'Initial failure must keep a retry action.');
 assert.ok(index.includes("$('opsMainBody').innerHTML='';document.querySelectorAll('.modal').forEach(modal=>modal.classList.add('hidden'));$('opsModalBody').innerHTML='';updateCartBadge(0)"),'Logout must clear internal operational DOM to avoid stale content across accounts.');
});


test('Escape closes only the topmost visible modal and preserves the underlying modal',()=>{
 const start=index.indexOf("document.addEventListener('keydown',e=>{\n      const visible=Array.from(document.querySelectorAll('.modal:not(.hidden)'));");
 const end=index.indexOf("window.addEventListener('load',boot)",start);
 assert.ok(start>=0&&end>start,'Global Escape handler must exist.');
 const handler=index.slice(start,end);
 assert.ok(handler.includes("document.querySelectorAll('.modal:not(.hidden)')"));
 assert.ok(handler.includes('const top=visible[visible.length-1]'));
 assert.ok(handler.includes('const close=closeById[top.id]'));
 assert.ok(handler.includes('if(close){e.preventDefault();close()}'));
 for(const id of ['paymentModal','orderDetailModal','profileModal','childPickerModal','opsModal'])assert.ok(handler.includes(id+':close'));
 assert.ok(!handler.includes('closeRegister();closeProfile();'),'Escape must not close every modal at once.');
});


test('Delivery dashboard search and status filters collapse to one column on narrow screens',()=>{
 const start=index.indexOf('function drawDeliveryDashboard(){');
 const end=index.indexOf('async function uploadDeliveryProofFromDevice',start);
 assert.ok(start>=0&&end>start);
 const renderer=index.slice(start,end);
 assert.ok(renderer.includes('<div class="delivery-filters">'));
 assert.ok(!renderer.includes('grid-template-columns:1fr 1fr'),'The filter layout must not be hard-coded inline to two columns.');
 assert.ok(index.includes('body.admin-portal .delivery-filters{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(170px,1fr)'));
 assert.ok(index.includes('@media(max-width:620px){body.admin-portal .delivery-filters{grid-template-columns:minmax(0,1fr);gap:8px}}'));
 assert.ok(renderer.includes('aria-label="Cari tugas pengantaran"')&&renderer.includes('aria-label="Filter status tugas"'));
});


test('Admin, Gudang, and Wali management search/filter controls expose accessible names',()=>{
 const names={
  staffSearch:'Cari akun petugas',
  waliSearch:'Cari akun Wali Santri',
  catalogSearch:'Cari produk katalog Admin',
  catalogCategory:'Filter kategori produk',
  catalogStatus:'Filter status produk',
  warehouseSearch:'Cari antrean pesanan Gudang',
  warehouseStatus:'Filter tahapan pesanan Gudang',
  warehouseReportSearch:'Cari riwayat laporan Gudang',
  receiptSearch:'Cari riwayat penerimaan barang',
  stockSearch:'Cari data stok Gudang',
  stockStatusFilter:'Filter kondisi stok',
  stockActiveFilter:'Filter status produk'
 };
 for(const [id,label] of Object.entries(names)){
  const start=index.indexOf('id="'+id+'"');
  assert.ok(start>=0,'Missing filter '+id);
  const tagStart=index.lastIndexOf('<input',start)>=index.lastIndexOf('<select',start)?index.lastIndexOf('<input',start):index.lastIndexOf('<select',start);
  const tagEnd=index.indexOf('>',start);
  const tag=index.slice(tagStart,tagEnd+1);
  assert.ok(tag.includes('aria-label="'+label+'"'),id+' must have a meaningful accessible name.');
 }
});


test('Horizontally scrollable data tables are keyboard reachable and announced as regions',()=>{
 const wrappers=[...index.matchAll(/<div class="table-wrap"[^>]*>/g)].map(m=>m[0]);
 assert.ok(wrappers.length>=15,'Expected the primary data-table wrappers to remain present.');
 for(const tag of wrappers){
  assert.ok(tag.includes('tabindex="0"'),'Every horizontal table region must be keyboard focusable.');
  assert.ok(tag.includes('role="region"'),'Scrollable table wrapper must be exposed as a region.');
  assert.ok(tag.includes('aria-label="Tabel data FMart; geser secara horizontal untuk melihat kolom lainnya"'),'Scrollable table region must have an accessible description.');
 }
 const picker=[...index.matchAll(/<div class="picker-table-wrap"[^>]*>/g)].map(m=>m[0]);
 assert.ok(picker.length>=2);
 for(const tag of picker){
  assert.ok(tag.includes('tabindex="0"')&&tag.includes('role="region"'));
  assert.ok(tag.includes('aria-label="Daftar Santri; geser secara horizontal untuk melihat kolom lainnya"'));
 }
 assert.ok(index.includes('.table-wrap[tabindex="0"]:focus-visible'));
 assert.ok(index.includes('.picker-table-wrap[tabindex="0"]:focus-visible'));
});


test('Admin header uses the existing compact spacing throughout the tablet breakpoint',()=>{
 const start=index.indexOf('@media (min-width:761px) and (max-width:1100px){');
 const end=index.indexOf('.report-tabs{',start);
 assert.ok(start>=0&&end>start,'Tablet header override must exist.');
 const tablet=index.slice(start,end);
 assert.ok(tablet.includes('body.admin-portal .header-inner{'));
 assert.ok(tablet.includes('padding-left:20px!important;'));
 assert.ok(tablet.includes('padding-right:20px!important;'));
 assert.ok(!index.includes('Navigasi tablet portrait berada di bawah, jadi header tidak boleh menyisakan ruang sidebar.'));
});


test('Logout closes every modal and clears the operational modal content',()=>{
 const start=index.indexOf("profileLogoutBtn");
 const end=index.indexOf("showLogin('Anda telah keluar dari FMart.')",start);
 assert.ok(start>=0&&end>start,'Profile logout handler must exist.');
 const logout=index.slice(start,end);
 assert.ok(logout.includes("document.querySelectorAll('.modal').forEach(modal=>modal.classList.add('hidden'))"));
 assert.ok(logout.includes("$('opsModalBody').innerHTML=''"),'Operational form content must not remain visible or cached after logout.');
 assert.ok(logout.includes("$('opsMainBody').innerHTML=''"),'Operational workspace content must be cleared.');
});


test('Modal keyboard navigation traps Tab and Shift+Tab inside the topmost visible dialog',()=>{
 const start=index.indexOf("document.addEventListener('keydown',e=>{\n      const visible=Array.from(document.querySelectorAll('.modal:not(.hidden)'));");
 const end=index.indexOf("window.addEventListener('load',boot)",start);
 assert.ok(start>=0&&end>start,'Global modal keyboard handler must exist.');
 const handler=index.slice(start,end);
 assert.ok(handler.includes("if(e.key==='Tab'&&top)"));
 assert.ok(handler.includes("top.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"])')"));
 assert.ok(handler.includes("if(!top.contains(document.activeElement))"));
 assert.ok(handler.includes("e.shiftKey?last:first"));
 assert.ok(handler.includes("document.activeElement===first"));
 assert.ok(handler.includes("document.activeElement===last"));
 assert.ok(handler.includes("const close=closeById[top.id]"),'Existing Escape close behavior must remain intact.');
});


test('Wali product card, detail, and cart images fall back cleanly when an image URL fails',()=>{
 const cardStart=index.indexOf('function productCardMarkup(p){');
 const cardEnd=index.indexOf('function bindBuyerProductFeedObserver',cardStart);
 assert.ok(cardStart>=0&&cardEnd>cardStart);
 const card=index.slice(cardStart,cardEnd);
 assert.ok(card.includes('const photo=safeUrl(p.photoUrl)'));
 assert.ok(card.includes('data-image-fallback'));
 assert.ok(card.includes('product-photo-fallback hidden'));
 const detailStart=index.indexOf('async function openProduct(productId){');
 const detailEnd=index.indexOf('function getCurrentDetailVariation',detailStart);
 assert.ok(detailStart>=0&&detailEnd>detailStart);
 const detail=index.slice(detailStart,detailEnd);
 assert.ok(detail.includes('data-image-fallback'));
 assert.ok(detail.includes('detail-photo-placeholder hidden'));
 const cartStart=index.indexOf('function renderCart(cart){');
 const cartEnd=index.indexOf('async function changeCartQty',cartStart);
 assert.ok(cartStart>=0&&cartEnd>cartStart);
 const cart=index.slice(cartStart,cartEnd);
 assert.ok(cart.includes('data-image-fallback'));
 assert.ok(cart.includes('cart-photo-fallback hidden'));
 assert.ok(index.includes('.cart-photo img{width:100%;height:100%;object-fit:cover;display:block}'));
 const handler=index.indexOf("document.addEventListener('error',e=>{");
 assert.ok(handler>=0);
 assert.ok(index.slice(handler,handler+500).includes("img.hasAttribute('data-image-fallback')"));
 assert.ok(index.slice(handler,handler+500).includes('img.nextElementSibling'));
});

test('Required checkout, payment-proof, and password fields expose native required semantics',()=>{
 const checkout=index.slice(index.indexOf('function openCheckout(){'),index.indexOf('function updateCheckoutFulfillmentUI(){'));
 assert.ok(checkout.includes('id="checkoutRecipientName" type="text" required'));
 assert.ok(checkout.includes('id="checkoutRecipientAddress" rows="3" required'));
 const fulfillment=extractFunction(index,'updateCheckoutFulfillmentUI');
 assert.ok(fulfillment.includes('address.required=true'));
 assert.ok(fulfillment.includes('address.required=false'),'Pickup mode must make the delivery address optional.');
 const payment=extractFunction(index,'openPayment');
 assert.ok(payment.includes('id="paymentProof" class="file-input" type="file" required'));
 const password=extractFunction(index,'openChangePassword');
 assert.ok(password.includes('id="currentPassword" type="password" autocomplete="current-password" required'));
 assert.ok(password.includes('id="newPassword" type="password" autocomplete="new-password" minlength="10" required'));
 assert.ok(password.includes('id="confirmPassword" type="password" autocomplete="new-password" minlength="10" required'));
});

test('Wali self-link activates only on exact normalized guardian phone match',()=>{
 const helper=extractFunction(code,'normalizePhone_');
 assert.ok(helper.includes("s.indexOf('+62') === 0")&&helper.includes("s.indexOf('62') === 0")&&helper.includes("s.charAt(0) === '8'"),'Phone comparison must normalize Indonesian formats.');
 const request=extractFunction(code,'requestWaliSantriLink');
 assert.ok(request.includes("santriField_(santri.values,santriMap,'no_wa_wali')"),'The server must read the guardian phone from the Santri master record.');
 assert.ok(request.includes('normalizePhone_(wali.noHp)')&&request.includes('normalizePhone_(santriField_'), 'Both account and Santri guardian phones must be normalized.');
 assert.ok(request.includes('guardianPhone===waliPhone'),'Automatic linking requires exact normalized phone equality.');
 assert.ok(request.includes("phoneMatched?'AKTIF':'MENUNGGU_VERIFIKASI'"),'Mismatch or missing phone must become an Admin-verification request.');
 assert.ok(request.includes("phoneMatched?'LINK_WALI_SANTRI_SELF':'REQUEST_WALI_SANTRI_SELF'"),'Audit events must distinguish direct link from pending request.');
 assert.ok(request.includes("status:'MENUNGGU_VERIFIKASI'")&&request.includes('Pengajuan dikirim ke Admin untuk verifikasi.'));
 assert.ok(request.includes('countDistinctActiveOrPendingWaliForSantri_(relRows,santriId)')&&request.includes('otherWaliCount>=2'),'The maximum two Wali limit must include pending requests.');
 for(const name of ['getSantriClassesForWaliSelf','searchSantriForWaliSelf']){
  const fn=extractFunction(code,name);
  assert.ok(fn.includes("['AKTIF','MENUNGGU_VERIFIKASI']"),name+' must hide both already linked and pending Santri from duplicate requests.');
 }
});

test('Wali self-link copy explains automatic phone match and Admin verification fallback',()=>{
 const start=index.indexOf('<div id="waliLinkModal"');
 const end=index.indexOf('<div id="changePasswordModal"',start);
 assert.ok(start>=0&&end>start,'Wali link modal must exist.');
 const modal=index.slice(start,end);
 assert.ok(modal.includes('Hubungan aktif otomatis jika nomor HP Wali cocok dengan no_wa_wali'));
 assert.ok(modal.includes('pengajuan menunggu verifikasi Admin'));
 const submitStart=index.indexOf('function openWaliRequestForm(');
 const submitEnd=index.indexOf('function closeProfile(',submitStart);
 assert.ok(submitStart>=0&&submitEnd>submitStart,'Wali self-link action must exist.');
 const submit=index.slice(submitStart,submitEnd);
 assert.ok(submit.includes('Nomor HP Wali akan dicocokkan dengan no_wa_wali'));
 assert.ok(submit.includes("runServer('requestWaliSantriLink'"));
 assert.ok(submit.includes('Proses Penghubungan'));
});

test('Payment rejection note is semantically required only for rejection',()=>{
 const fn=extractFunction(index,'openVerifyPayment');
 assert.ok(fn.includes("maxlength=\"300\"'+(accepting?'':' required')+' placeholder=\"'+(accepting?'Catatan pemeriksaan (opsional)':'Jelaskan alasan penolakan')+'\""));
 assert.ok(fn.includes("if(!accepting&&!note)"),'Existing rejection validation must remain.');
 assert.ok(fn.includes("accepting?'Catatan pemeriksaan (opsional)':'Jelaskan alasan penolakan'"));
});

test('Empty Wali child picker explains phone match and Admin verification fallback',()=>{
 const start=index.indexOf('function renderEmptyChildPicker(){');
 const end=index.indexOf('let childPickerSearchTimer',start);
 assert.ok(start>=0&&end>start,'Empty child picker renderer must exist.');
 const empty=index.slice(start,end);
 assert.ok(empty.includes('Hubungan otomatis aktif jika nomor HP cocok'));
 assert.ok(empty.includes('pengajuan dikirim ke Admin untuk verifikasi'));
 const searchStart=index.indexOf('async function searchChildPickerDirectory(');
 const searchEnd=index.indexOf('function ',searchStart+10);
 const search=index.slice(searchStart,searchEnd>0?searchEnd:undefined);
 assert.ok(index.includes("data-picker-request=\"'+escapeHtml(c.id)+'\">Hubungkan</button>"));
 assert.ok(search.includes('openWaliLinkModal(c)'),'Selecting a Santri must continue to use the conditional self-link flow.');
});

test('Login form is not blocked by the hidden OTP field before staff OTP is requested',()=>{
 const start=index.indexOf('id="loginOtpCode"');
 const inputStart=index.lastIndexOf('<input',start);
 const inputEnd=index.indexOf('>',start);
 assert.ok(start>=0&&inputStart>=0&&inputEnd>start,'OTP input must exist.');
 const input=index.slice(inputStart,inputEnd+1);
 assert.ok(!input.includes('required'),'Hidden OTP input must not block the initial login form submission.');
 assert.ok(input.includes('maxlength="6"'));
 assert.ok(input.includes('pattern="[0-9]{6}"'));
 assert.ok(input.includes('autocomplete="one-time-code"'));
 const reset=extractFunction(index,'resetLoginOtpPanel_');
 assert.ok(reset.includes("$('loginOtpCode').required=false"),'Returning to the login form must clear OTP required state.');
 const submitStart=index.indexOf("$('loginForm').addEventListener('submit'");
 const otpReveal=index.indexOf("$('loginOtpCode').required=true",submitStart);
 const otpPanel=index.indexOf("$('loginOtpPanel').classList.remove('hidden')",submitStart);
 assert.ok(submitStart>=0&&otpReveal>submitStart&&otpPanel>otpReveal,'OTP becomes required only when the server requests OTP and the panel is revealed.');
 const handler=extractFunction(index,'finishStaffLoginWithOtp_');
 assert.ok(handler.includes("!/^[0-9]{6}$/.test(code)"),'Existing six-digit OTP validation must remain.');
});

test('Wali profile loading skeleton labels are associated with their read-only fields',()=>{
 const start=index.indexOf('function openWaliProfilePage(){');
 const end=index.indexOf('function renderWaliProfileManagement(',start);
 assert.ok(start>=0&&end>start,'Wali profile loader must exist.');
 const loader=index.slice(start,end);
 for(const id of ['waliProfilePreviewName','waliProfilePreviewPhone','waliProfilePreviewEmail']){
  assert.ok(loader.includes('for="'+id+'"'),'Missing skeleton label association for '+id);
  assert.ok(loader.includes('id="'+id+'"'),'Missing skeleton control '+id);
 }
});

test('Modal focus lifecycle moves focus into dialogs and restores it safely on close',()=>{
 const marker='(function setupModalFocusLifecycle_(){';
 const start=index.indexOf(marker);
 const end=index.indexOf("document.addEventListener('keydown',e=>{\n      const visible=Array.from(document.querySelectorAll('.modal:not(.hidden)'));",start);
 assert.ok(start>=0&&end>start,'Shared modal focus lifecycle must be installed before keyboard handling.');
 const lifecycle=index.slice(start,end);
 assert.ok(lifecycle.includes("new MutationObserver(records=>"),'Modal visibility changes must be observed centrally.');
 assert.ok(lifecycle.includes("observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']})"));
 assert.ok(lifecycle.includes("openers.set(modal.id,active&&active!==modal&&!modal.contains(active)?active:null)"),'Opening modal must retain its opener.');
 assert.ok(lifecycle.includes('focusModal(top)'),'New topmost dialog must receive initial focus.');
 assert.ok(lifecycle.includes('top.contains(target)&&isUsable(target)'),'Closing a nested dialog must restore focus to its opener in the parent.');
 assert.ok(lifecycle.indexOf('if(top&&pendingOpenedModal===top.id)')<lifecycle.indexOf('if(top&&restoreTarget)'), 'A newly opened dialog takes focus first; when only a parent remains, its opener is restored before generic top-modal focus.');
 assert.ok(lifecycle.includes('pendingOpenedModal=modal.id'),'Newly opened modal must be distinguished from a just-closed nested modal.');
 assert.ok(lifecycle.includes('if(isUsable(target))focusElement(target);else focusFallback()'),'Closing the final dialog must restore a usable opener or a safe page fallback.');
 assert.ok(lifecycle.includes("modal.setAttribute('tabindex','-1')"),'A dialog without controls must remain programmatically focusable.');
 const keyboard=index.slice(end,index.indexOf("window.addEventListener('load',boot)",end));
 assert.ok(keyboard.includes("if(e.key==='Tab'&&top)"),'Existing Tab focus trap must remain.');
 assert.ok(keyboard.includes("if(e.key!=='Escape')return"),'Existing Escape behavior must remain.');
});

test('Every static dialog root has modal semantics and a resolvable accessible name',()=>{
 const re=/<div\b(?=[^>]*\bid="([^"]+Modal)")(?=[^>]*\bclass="[^"]*\bmodal\b)([^>]*)>/g;
 const roots=[];let match;
 while((match=re.exec(index))!==null)roots.push({id:match[1],attrs:match[2]});
 assert.ok(roots.length>=12,'Expected the full set of customer and operational dialogs.');
 for(const root of roots){
  assert.match(root.attrs,/\brole="dialog"/,'Dialog '+root.id+' must expose dialog role.');
  assert.match(root.attrs,/\baria-modal="true"/,'Dialog '+root.id+' must be announced as modal.');
  const label=(root.attrs.match(/\baria-labelledby="([^"]+)"/)||[])[1];
  const ariaLabel=(root.attrs.match(/\baria-label="([^"]+)"/)||[])[1];
  assert.ok(label||ariaLabel,'Dialog '+root.id+' must have an accessible name.');
  if(label)assert.ok(index.includes('id="'+label+'"'),'Dialog '+root.id+' references missing label '+label+'.');
 }
 assert.ok(index.includes('id="opsModalTitle"'),'Dynamic operations dialog title target must exist.');
 assert.ok(index.includes("$('opsModalTitle').textContent=title"),'Dynamic operations dialog must update its accessible title.');
});

test('Custom interactive markup remains keyboard operable and native controls stay semantic',()=>{
 const inlineClick=/<([a-z][a-z0-9-]*)\b([^>]*\bonclick\s*=\s*["'][^"']*["'][^>]*)>/gi;
 const nativeTags=new Set(['button','a','input','select','textarea']);
 let match;
 while((match=inlineClick.exec(index))!==null){
  assert.ok(nativeTags.has(match[1].toLowerCase()),'Inline click handler must use a native interactive element, not <'+match[1]+'>.');
 }
 const rolePattern=/<([a-z][a-z0-9-]*)\b([^>]*\brole=["'](?:button|menuitem|option|tab)["'][^>]*)>/gi;
 const custom=[];
 while((match=rolePattern.exec(index))!==null){
  if(!nativeTags.has(match[1].toLowerCase()))custom.push({tag:match[1],attrs:match[2]});
 }
 assert.equal(custom.length,1,'Only the documented brand navigation control should require custom keyboard semantics.');
 const brand=custom[0];
 assert.equal(brand.tag,'div');
 assert.ok(brand.attrs.includes('id="brandHome"')&&brand.attrs.includes('tabindex="0"'));
 assert.ok(index.includes("brandHome.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')"),'Custom brand button must support Enter and Space.');
 assert.ok((index.match(/<select\b/g)||[]).length>=5,'Operational dropdowns should remain native select controls.');
 assert.ok(!index.includes('role="combobox"'),'Do not replace native selects with inaccessible custom dropdowns.');
});

test('Sensitive Wali, Kasir and delivery reads enforce data ownership and role minimization',()=>{
 const myOrders=extractFunction(code,'getMyOrders');
 assert.ok(myOrders.includes('requireRole_(token, [FMART.ROLES.WALI_SANTRI])'));
 assert.ok(myOrders.includes('String(r[2]) === String(session.userId)'),'Wali order lists must be scoped to the active account.');
 const orderDetail=extractFunction(code,'getOrderDetail');
 assert.ok(orderDetail.includes('requireRole_(token, [FMART.ROLES.WALI_SANTRI])'));
 assert.ok(orderDetail.includes('String(orderRow.values[2]) !== String(session.userId)'),'Wali order details must reject another account order.');
 const cart=extractFunction(code,'getCart');
 assert.ok(cart.includes('requireRole_(token, [FMART.ROLES.WALI_SANTRI])'));
 assert.ok(cart.includes("if (String(r[1]) !== String(session.userId)) return;"),'Cart reads must be scoped to the current Wali.');
 const notifications=extractFunction(code,'getMyNotifications');
 assert.ok(notifications.includes("String(r[1]||'')===String(session.userId)"),'Notifications must be scoped to their recipient.');
 assert.ok(notifications.includes('redactStockDetails'),'Wali notification copy must continue to redact internal stock conditions.');
 const catalog=extractFunction(code,'getCatalog');
 assert.ok(catalog.includes('if (session.role === FMART.ROLES.WALI_SANTRI)'));
 assert.ok(catalog.includes('products:[]')&&catalog.includes('children:getChildrenForWali_(ss,session.userId)'),'Wali catalog bootstrap must not return stock-bearing product rows.');
 const batch=extractFunction(code,'getBuyerProductBatch');
 assert.ok(batch.includes('requireRole_(token,[FMART.ROLES.WALI_SANTRI])'));
 assert.ok(!batch.includes('stock:'),'Buyer product batches must not contain stock quantities.');
 const detail=extractFunction(code,'getProductDetail');
 assert.ok(detail.includes('delete productResult.stock')&&detail.includes('delete productResult.minStock'),'Wali product detail must remove stock and minimum-stock fields.');
 const delivery=extractFunction(code,'getDeliveryDashboard');
 assert.ok(delivery.includes('requireRole_(token, [FMART.ROLES.PETUGAS_PENGANTAR, FMART.ROLES.GUDANG])'));
 assert.ok(delivery.includes("String(row[2] || '') === String(session.userId)"),'Delivery tasks must only include assignments owned by the active driver/Gudang account.');
 const operations=extractFunction(code,'getOperationsDashboard');
 assert.ok(operations.includes('if(session.role===FMART.ROLES.KASIR)'));
 assert.ok(operations.includes('orders:[],pendingPayments:waliQrisQueue'),'Cashier dashboard must not return the global order list.');
 assert.ok(operations.includes("String(p[2]||'').toUpperCase()==='QRIS'"),'Cashier payment queue must be limited to QRIS Wali payments.');
 assert.ok(operations.includes("String(r[13]||'')===String(session.userId)"),'Cashier sales metrics must be scoped to the current cashier.');
 const cashierProof=extractFunction(code,'getPaymentProofData');
 assert.ok(cashierProof.includes('FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN,FMART.ROLES.KASIR'));
 assert.ok(cashierProof.includes("session.role===FMART.ROLES.KASIR&&String(pay.values[2]||'').toUpperCase()!=='QRIS'"),'Cashier proof access must remain QRIS-only.');
});

test('All UI server endpoints resolve and have server-side authorization or explicit pre-auth safeguards',()=>{
 const literalNames=[...new Set([...index.matchAll(/runServer\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]))];
 assert.ok(literalNames.length>=75,'The UI server endpoint inventory must be comprehensive.');
 const deliveryMap=(index.match(/const endpoint=\{([^}]+)\}\[action\]/)||[])[1]||'';
 assert.ok(deliveryMap,'Delivery action endpoint mapping must be explicit.');
 const deliveryNames=[...new Set([...deliveryMap.matchAll(/:\s*'([A-Za-z0-9_]+)'/g)].map(m=>m[1]))];
 assert.deepEqual(deliveryNames,['respondDeliveryAssignment','startDeliveryTrip','updateDeliveryProgress','reportDeliveryFailure']);
 assert.ok(index.includes("runServer(action==='toggle'?'toggleFMartUser':'resetFMartUserPassword'"),'Wali management actions must use the fixed server endpoint allowlist.');
 const dynamicNames=[...deliveryNames,'toggleFMartUser','resetFMartUserPassword'];
 const names=[...new Set([...literalNames,...dynamicNames])];
 assert.ok(names.length>=83,'Literal and dynamic endpoint inventory must include all UI-exposed server methods.');
 for(const name of names){
  const start=code.indexOf('function '+name+'(');
  assert.ok(start>=0,'UI endpoint '+name+' must resolve to a backend function.');
  const end=code.indexOf('\nfunction ',start+10);
  const body=code.slice(start,end<0?code.length:end);
  if(['login','registerWaliSantri','verifyAdminLoginOtp'].includes(name))continue;
  assert.ok(body.includes('requireSession_(')||body.includes('requireRole_('),'Endpoint '+name+' must validate a server-side session or role.');
 }
 const login=extractFunction(code,'login');
 assert.ok(login.includes('LOGIN_MAX_FAILURES')&&login.includes('recordLoginFailure_')&&login.includes('verifyPassword_')&&login.includes('portalRoleAllowed_'),'Public login must retain rate limiting, password verification and portal-role checks.');
 const registration=extractFunction(code,'registerWaliSantri');
 assert.ok(registration.includes('LockService.getScriptLock()')&&registration.includes('PASSWORD_MIN_LENGTH')&&registration.includes('normalizePhone_'),'Public Wali registration must retain locking and input validation.');
 const otp=extractFunction(code,'verifyAdminLoginOtp');
 assert.ok(otp.includes("portalMode || '') !== 'ADMINFMART16720'")&&otp.includes('challenge.attempts>=5')&&otp.includes('constantTimeEqual_')&&otp.includes('cache.remove(key)'),'Pre-auth OTP must remain portal-bound, one-time and attempt-limited.');
 for(const name of dynamicNames){
  const start=code.indexOf('function '+name+'('),end=code.indexOf('\nfunction ',start+10),body=code.slice(start,end<0?code.length:end);
  assert.ok(body.includes('requireRole_('),'Dynamic endpoint '+name+' must enforce role authorization.');
 }
 for(const name of ['respondDeliveryAssignment','startDeliveryTrip','updateDeliveryProgress','reportDeliveryFailure']){
  const start=code.indexOf('function '+name+'('),end=code.indexOf('\nfunction ',start+10),body=code.slice(start,end<0?code.length:end);
  assert.ok(body.includes('FMART.ROLES.PETUGAS_PENGANTAR')&&body.includes('FMART.ROLES.GUDANG'),'Delivery endpoint '+name+' must retain the driver/Gudang role boundary.');
 }
 for(const name of ['toggleFMartUser','resetFMartUserPassword']){
  const start=code.indexOf('function '+name+'('),end=code.indexOf('\nfunction ',start+10),body=code.slice(start,end<0?code.length:end);
  assert.ok(body.includes('FMART.ROLES.SUPERADMIN'),'User administration endpoint '+name+' must remain Superadmin-only.');
 }
});

test('Wali delivery proof preview is restricted to owned orders and the private delivery proof folder',()=>{
 const fn=extractFunction(code,'getDeliveryProofImage');
 assert.ok(fn.includes('requireRole_(token,[FMART.ROLES.WALI_SANTRI])'),'Only Wali may retrieve delivery proof previews.');
 assert.ok(fn.includes("String(order.values[2])!==String(session.userId)"),'A Wali may only retrieve proof for their own order.');
 assert.ok(fn.includes("getProperty('FMART_DELIVERY_PROOF_FOLDER_ID')"),'Preview must use the dedicated delivery proof folder property.');
 assert.ok(fn.includes("getProperty('FMART_PAYMENT_PROOF_FOLDER_ID')")&&fn.includes('folderId===paymentFolderId'),'Delivery and payment proof folders must remain distinct.');
 assert.ok(fn.includes('file.getParents()')&&fn.includes('folder.getId()'),'The file must be a child of the configured delivery proof folder.');
 assert.ok(fn.includes('file.getSize())>10*1024*1024')&&fn.includes('bytes.length>10*1024*1024'),'Preview must enforce the 10 MB upload limit.');
 assert.ok(fn.includes("['image/jpeg','image/png','image/webp'].indexOf(mime)<0"),'Only supported image formats may be previewed.');
 assert.ok(fn.indexOf("String(order.values[2])!==String(session.userId)")<fn.indexOf('DriveApp.getFileById'),'Order ownership must be checked before reading a Drive file.');
});

test('Staff navigation role matrix matches backend portal roles and active state is singular',()=>{
 const navStart=index.indexOf('<nav class="bottom-nav hidden" id="staffNav"');
 const navEnd=index.indexOf('</nav>',navStart);
 assert.ok(navStart>=0&&navEnd>navStart,'Staff navigation root must exist.');
 const nav=index.slice(navStart,navEnd);
 const buttonIds=[...nav.matchAll(/<button\b[^>]*\bid="(staff[A-Za-z0-9]+)"/g)].map(m=>m[1]);
 assert.deepEqual(buttonIds,['staffDashboard','staffOrders','staffSalesHistory','staffPOS','staffPaymentVerification','staffCatalog','staffStock','staffReceiving','staffWarehouseReports','staffDeliveryAssign','staffDelivery','staffDeliveryComplaints','staffUsers','staffReports','staffPaymentSettings']);
 const configure=extractFunction(index,'configureStaffNavigation');
 const permissionBlock=(configure.match(/const permissions=\{([\s\S]*?)\n  \};/)||[])[1];
 assert.ok(permissionBlock,'Role navigation permission map must exist.');
 const permissionMap={};
 for(const match of permissionBlock.matchAll(/([A-Z_]+):\[([^\]]*)\]/g))permissionMap[match[1]]=[...match[2].matchAll(/'([^']+)'/g)].map(x=>x[1]);
 assert.deepEqual(Object.keys(permissionMap).sort(),['ADMIN','GUDANG','KASIR','PETUGAS_PENGANTAR','SUPERVISOR','SUPERADMIN'].sort());
 for(const [role,ids] of Object.entries(permissionMap)){
  assert.ok(ids.includes('staffDashboard'),role+' must have dashboard entry.');
  assert.ok(ids.every(id=>buttonIds.includes(id)),role+' contains an unknown navigation item.');
 }
 const roleBlock=(code.match(/ROLES: Object\.freeze\(\{([^}]+)\}\)/)||[])[1]||'';
 const backendRoles=[...roleBlock.matchAll(/([A-Z_]+):/g)].map(m=>m[1]).filter(role=>role!=='WALI_SANTRI');
 assert.deepEqual(backendRoles.sort(),Object.keys(permissionMap).sort(),'Every backend staff role must have exactly one navigation permission set.');
 const portal=(code.match(/function portalRoleAllowed_\(role, portalMode\)\s*\{([\s\S]*?)\n\}/)||[])[1]||'';
 for(const role of backendRoles)assert.ok(portal.includes("'"+role+"'"),'Staff role '+role+' must be accepted by the admin portal.');
 assert.ok(permissionBlock.includes('SUPERVISOR'),'Supervisor must have an explicit read-only navigation profile.');
 const helper=extractFunction(index,'setStaffActiveNavigation');
 assert.ok(helper.includes("nav.classList.contains('hidden')")&&helper.includes("target.classList.contains('hidden')"),'Hidden navigation items cannot become active.');
 assert.ok(helper.includes("setAttribute('aria-current','page')")&&helper.includes("removeAttribute('aria-current')"),'Only the active item must expose aria-current=page.');
 assert.ok(helper.includes("btn.classList.toggle('active',active)"),'One shared helper must enforce a single active navigation item.');
 assert.ok(configure.includes("btn.removeAttribute('aria-current')")&&configure.includes("setStaffActiveNavigation('staffDashboard')"));
 for(const id of buttonIds){
  if(id==='staffDashboard')continue;
  assert.ok(index.includes("setStaffActiveNavigation('"+id+"')"),'Menu '+id+' must use the shared active-state helper.');
 }
 const handlers={
  staffPOS:["KASIR","ADMIN","SUPERADMIN"],staffPaymentVerification:["KASIR"],staffOrders:["ADMIN","SUPERADMIN","GUDANG","SUPERVISOR"],staffSalesHistory:["SUPERVISOR"],
  staffCatalog:["ADMIN","SUPERADMIN","SUPERVISOR"],staffStock:["ADMIN","GUDANG","SUPERADMIN"],staffReceiving:["ADMIN","GUDANG","SUPERADMIN"],
  staffWarehouseReports:["ADMIN","GUDANG","SUPERADMIN"],staffDeliveryAssign:["ADMIN","GUDANG","SUPERADMIN"],
  staffDelivery:["PETUGAS_PENGANTAR","GUDANG"],staffDeliveryComplaints:["ADMIN","SUPERADMIN"],
  staffUsers:["ADMIN","SUPERADMIN"],staffReports:["ADMIN","SUPERADMIN","SUPERVISOR"],staffPaymentSettings:["SUPERADMIN"]
 };
 const eventPattern=/\$\('(staff[A-Za-z0-9]+)'\)\.addEventListener\('click'/g;
 const events=[...index.matchAll(eventPattern)].map(m=>({id:m[1],pos:m.index}));
 for(const [id,roles] of Object.entries(handlers)){
  const eventIndex=events.findIndex(e=>e.id===id);
  assert.ok(eventIndex>=0,'Missing click handler for '+id);
  const start=events[eventIndex].pos;
  const end=events[eventIndex+1]?.pos??index.length;
  const handler=index.slice(start,end);
  for(const role of roles)assert.ok(handler.includes("'"+role+"'"),id+' must preserve '+role+' authorization.');
  assert.ok(handler.includes("setStaffActiveNavigation('"+id+"')"),id+' must update active state through shared helper.');
 }
});

test('Desktop staff sidebar has balanced dimensions and clear active, inactive, hover and focus states',()=>{
 const marker='/* Tahap 38.34 — sidebar Desktop yang rapi, seimbang, dan konsisten. */';
 const start=index.indexOf(marker);
 const end=index.indexOf('</style>',start);
 assert.ok(start>=0&&end>start,'Desktop sidebar visual system must exist in the primary stylesheet.');
 const desktop=index.slice(start,end);
 assert.ok(desktop.includes('@media (min-width:901px)'));
 assert.ok(desktop.includes('--staff-sidebar-width:clamp(194px,17.8vw,244px)'));
 assert.ok(desktop.includes('background:linear-gradient(180deg,#fff 0%,#fdfafd 100%)'));
 assert.ok(desktop.includes('.nav-btn:not(.active):hover'),'Inactive items need a clear hover state.');
 assert.ok(desktop.includes('.nav-btn.active {')&&desktop.includes('background:linear-gradient(115deg,#702078 0%,#58145f 100%)'),'Active item needs a distinct selected state.');
 assert.ok(desktop.includes('.nav-btn:focus-visible'),'Keyboard focus must remain visible.');
 assert.ok(desktop.includes('overflow-y:auto')&&desktop.includes('overscroll-behavior-y:contain'),'Long role menus must remain vertically scrollable.');
 assert.ok(desktop.includes('padding-left:calc(var(--staff-sidebar-width) + 42px)'),'Header must align to the updated sidebar width.');
 assert.ok(desktop.includes('margin-left:calc(var(--staff-sidebar-width) + 42px)'),'Workspace must align to the updated sidebar width.');
 assert.ok(desktop.includes('@media (min-width:901px) and (max-height:640px)'),'Short desktop viewports need compact spacing.');
 const tabletStart=index.indexOf('/* Tahap F — tablet portrait');
 const tabletEnd=index.indexOf('/* Semua panel petugas',tabletStart);
 assert.ok(tabletStart>=0&&tabletEnd>tabletStart&&index.slice(tabletStart,tabletEnd).includes('overflow-x:auto'),'Tablet portrait bottom navigation must remain unchanged.');
});

test('Supervisor catalog is read-only and Drive QRIS uses an embeddable thumbnail',()=>{
 const catalogUi=extractFunction(index,'renderSupervisorCatalog');
 assert.ok(catalogUi.includes('getAdminCatalog')&&catalogUi.includes('getOperationsDashboard'));
 assert.ok(!catalogUi.includes('openProductForm')&&!catalogUi.includes('openCategoryForm'));
 const qrisHelper=extractFunction(index,'qrisDisplayImageUrl_');
 assert.ok(qrisHelper.includes('drive.google.com/thumbnail'));
 const paymentUi=extractFunction(index,'openPayment');
 assert.ok(paymentUi.includes('qrisImageSrc')&&paymentUi.includes('paymentQrisImage'));
});

test('Wali relationship guidance matches phone-match and pending-verification rules',()=>{
 const adminView=extractFunction(index,'renderWaliSantriManagementHtml');
 assert.ok(adminView.includes('nomor HP akun Wali cocok dengan nomor Wali pada master Santri'));
 assert.ok(adminView.includes('pengajuan menunggu verifikasi Admin'));
 assert.ok(!adminView.includes('langsung aktif tanpa persetujuan Admin'));
 assert.ok(index.includes('Hubungan aktif otomatis jika nomor HP akun Wali cocok dengan nomor Wali pada master Santri. Jika tidak cocok atau belum tersedia, pengajuan menunggu verifikasi Admin.'));
 const request=extractFunction(code,'requestWaliSantriLink');
 assert.ok(request.includes("const nextStatus=phoneMatched?'AKTIF':'MENUNGGU_VERIFIKASI'"));
});

test('Supervisor dashboard uses an oversight view and never routes to warehouse actions',()=>{
 const render=extractFunction(index,'renderOps');
 assert.ok(render.includes("role==='SUPERVISOR'")&&render.includes('renderSupervisorDashboard()'));
 const dashboard=extractFunction(index,'renderSupervisorDashboard');
 for(const id of ['supervisorOpenOrders','supervisorOpenSales','supervisorOpenCatalog','supervisorOpenReports'])assert.ok(dashboard.includes(id));
 for(const fn of ['renderOpsOrderList','renderSupervisorSalesHistory','renderSupervisorCatalog','renderOpsReports'])assert.ok(dashboard.includes(fn));
 assert.ok(!dashboard.includes('getStockManagement'));
 assert.ok(!dashboard.includes('renderOpsStock'));
 assert.ok(!dashboard.includes('renderOpsReceiving'));
 assert.ok(!dashboard.includes('renderOpsWarehouseReports'));
});

test('Supervisor can read all POS history without receiving POS mutation access',()=>{
 const history=extractFunction(code,'getCashierSalesHistory');
 assert.ok(history.includes('FMART.ROLES.SUPERVISOR'));
 assert.ok(history.includes("session.role===FMART.ROLES.KASIR&&x.cashierUserId!==String(session.userId)"));
 assert.ok(!/appendRow|setValues|deleteRow|createCashierSale|cancelCashierQrisSale|confirmCashierQrisPayment/.test(history));
 const configure=extractFunction(index,'configureStaffNavigation');
 const permissions=(configure.match(/const permissions=\{([\s\S]*?)\n  \};/)||[])[1]||'';
 assert.match(permissions,/SUPERVISOR:\[[^\]]*'staffSalesHistory'/);
 for(const role of ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR']){
  const roleLine=(permissions.match(new RegExp(role+':\\[([^\\]]*)\\]'))||[])[1]||'';
  assert.ok(!roleLine.includes('staffSalesHistory'),role+' must not receive the Supervisor transaction view.');
 }
 const view=extractFunction(index,'renderSupervisorSalesHistory');
 assert.ok(view.includes("state.data.user.role!=='SUPERVISOR'"));
 assert.ok(view.includes("runServer('getCashierSalesHistory'"));
 assert.ok(!/createCashierSale|verifyPayment|cancelCashierQrisSale|confirmCashierQrisPayment/.test(view));
 assert.ok(view.includes('hanya untuk melihat data'));
});

test('Supervisor transaction dashboard returns the complete order history',()=>{
 const dashboard=extractFunction(code,'getOperationsDashboard');
 assert.ok(dashboard.includes('session.role===FMART.ROLES.SUPERVISOR?orders.length:60'));
});


test('Weighted-average HPP and gross profit remain explicit for legacy transactions',()=>{
 const helper=extractFunction(code,'weightedAverageHpp_'),migration=extractFunction(code,'migrateFMartCostingSchema'),order=extractFunction(code,'applyOrderStockPlan_'),pos=extractFunction(code,'applyCashierSaleStock_'),report=extractFunction(code,'getFMartReports');
 assert.doesNotThrow(()=>new vm.Script(setup),'SetupDatabase schema must remain valid JavaScript');
 assert.ok(setup.includes('HargaPokokRataRata')&&setup.includes('HPPSubtotal'));
 assert.ok(extractFunction(code,'getAdminCatalog').includes('ensureFMartCostingSchema_'));
 assert.ok(extractFunction(code,'getStockCatalog').includes('ensureFMartCostingSchema_'));
 assert.ok(migration.includes('ensureFMartCostingSchema_'));
 assert.ok(helper.includes('beforeQty*beforeHpp+incomingTotalCost')&&helper.includes('beforeQty>0&&beforeHpp<=0'));
 assert.ok(order.includes("captureSaleDetailHpp_(ss,'DetailPesanan'")&&order.indexOf('if(mutation)')<order.indexOf("captureSaleDetailHpp_(ss,'DetailPesanan'")&&pos.includes("captureSaleDetailHpp_(ss,'DetailPenjualanToko'"));
 assert.ok(report.includes('hppMissingLines')&&report.includes('grossProfit:grossProfit'));
});


test('HPP entry is available on product, variation, receipt and stock-in forms',()=>{
 const product=index.slice(index.indexOf('function openProductForm(item)'),index.indexOf('function openStaffUserForm'));
 const variation=index.slice(index.indexOf('function openVariationForm(item)'),index.indexOf('async function openStockTransferForm'));
 const receipt=index.slice(index.indexOf('function openStockReceiptForm(products)'),index.indexOf('function openStockMinimumForm'));
 const adjustment=index.slice(index.indexOf('function openStockForm(productId,variationId)'),index.indexOf('async function advanceWarehouse'));
 assert.ok(product.includes('prdHpp')&&product.includes('hpp:$('));
 assert.ok(variation.includes('varHpp')&&variation.includes('hpp:$('));
 assert.ok(receipt.includes('receipt-cost')&&receipt.includes('unitCost'));
 assert.ok(adjustment.includes('stockUnitCost')&&adjustment.includes('unitCost'));
});


test('Recorded master HPP cannot be silently changed while inventory remains',()=>{
 const helper=extractFunction(code,'assertHppChangeAllowed_'),product=extractFunction(code,'saveProduct'),variation=extractFunction(code,'saveVariation'),sandbox={};
 vm.runInNewContext(helper+'\nthis.guard=assertHppChangeAllowed_;',sandbox);
 assert.equal(sandbox.guard(0,12500,8,'produk'),true,'opening HPP may be entered for stock that has not yet been valued');
 assert.equal(sandbox.guard(12500,12500,8,'produk'),true,'saving the same HPP must remain harmless');
 assert.equal(sandbox.guard(12500,15000,0,'produk'),true,'HPP may be revised after stock reaches zero');
 assert.throws(()=>sandbox.guard(12500,15000,8,'produk'),/HPP produk sudah menjadi dasar nilai persediaan/);
 assert.throws(()=>sandbox.guard(12500,0,8,'variasi'),/HPP variasi sudah menjadi dasar nilai persediaan/);
 assert.ok(product.includes('assertHppChangeAllowed_')&&product.includes('getTotalItemStock_'));
 assert.ok(variation.includes('assertHppChangeAllowed_')&&variation.includes('getTotalItemStock_'));
});

test('Legacy pending stock receipts can recover without inventing historical acquisition cost',()=>{
 const recovery=extractFunction(code,'recoverLegacyStockReceiptIfPending_');
 const receipt=extractFunction(code,'createStockReceipt');
 assert.ok(receipt.includes('recoverLegacyStockReceiptIfPending_'));
 assert.ok(recovery.includes('legacyFingerprint')&&recovery.includes('done.legacyCostNotRecorded=true'));
 assert.ok(index.includes('legacyReceiptSignature'));
});


test('Costing schema migration is append-only, canonical-positioned and fails closed on unknown columns',()=>{
 const migration=extractFunction(code,'ensureFMartCostingSchema_'),column=extractFunction(code,'getHeaderColumnIndex_');
 for(const [name,field,col] of [['Produk','HargaPokokRataRata',12],['VariasiProduk','HargaPokokRataRata',10],['MutasiStok','HPPSesudah',14],['DetailPesanan','HPPStatus',13],['DetailPenjualanToko','HPPStatus',13]])assert.ok(migration.includes(name)&&migration.includes(field)&&migration.includes(String(col)));
 assert.ok(migration.includes('sh.getLastColumn()>=column'),'Migration must stop rather than append HPP after an unknown/custom column.');
 assert.ok(migration.includes('matches[0]!==column'),'Existing costing columns in unexpected positions must not be silently accepted.');
 assert.ok(column.includes('matches.length!==1'),'Header lookup must reject missing or duplicate names.');
 assert.ok(!migration.includes('deleteColumn')&&!migration.includes('deleteRow')&&!migration.includes('clearContents'));
});

test('HPP master reads, writes and report snapshots resolve named columns instead of fixed offsets',()=>{
 const admin=extractFunction(code,'getAdminCatalog'),stock=extractFunction(code,'getStockCatalog'),product=extractFunction(code,'saveProduct'),variation=extractFunction(code,'saveVariation'),report=extractFunction(code,'getFMartReports');
 for(const fn of [admin,stock,product,variation])assert.ok(fn.includes('getHeaderColumnIndex_'),'Master HPP column must be resolved by header name.');
 assert.ok(report.includes('orderHppUnitIndex')&&report.includes('posHppUnitIndex'));
 assert.ok(report.includes('cost===unit*q'),'Report must reject a snapshot subtotal that does not equal HPP unit multiplied by quantity.');
 assert.ok(!admin.includes('Number(r[11])')&&!admin.includes('Number(r[9])'));
 assert.ok(!stock.includes('Number(p[11])')&&!stock.includes('Number(v[9])'));
});

test('Costing integrity audit is strictly read-only and reports stock, receipt and sales valuation gaps',()=>{
 const audit=extractFunction(code,'auditFMartCostingIntegrity_');
 assert.ok(audit.includes("mode:'READ_ONLY'")&&audit.includes('NO_SCHEMA_MIGRATION_NO_DATA_REPAIR'));
 assert.ok(audit.includes("addStock(warehouse,'Stok');addStock(cashier,'StokKasir')"));
 assert.ok(audit.includes('MASTER_HPP_MISSING_WITH_STOCK'));
 assert.ok(audit.includes('RECEIPT_COST_INVALID'));
 assert.ok(audit.includes('SALE_HPP_SNAPSHOT_INVALID'));
 assert.ok(audit.includes('MASTER_HPP_DIFFERS_FROM_LAST_INBOUND'));
 assert.ok(!/\.appendRow\s*\(|\.setValue\s*\(|\.setValues\s*\(|\.deleteRow\s*\(|\.insertSheet\s*\(|\.insertColumns/.test(audit),'Audit must not mutate spreadsheet data or schema.');
});

test('FMart replaces native browser dialogs with accessible branded dialogs',()=>{
 assert.ok(index.includes('id="fmartDialog"'),'The branded dialog root must exist.');
 assert.ok(index.includes('function showConfirmDialog('),'Confirmation flows must use the branded dialog helper.');
 assert.ok(index.includes('function showPromptDialog('),'Text input prompts must use the branded dialog helper.');
 assert.ok(index.includes('function showAppAlert('),'Informational alerts must use the branded dialog helper.');
 assert.ok(index.includes("if(e.key==='Tab')"),'Dialog keyboard focus must remain trapped while open.');
 assert.ok(index.includes("if(e.key==='Escape')"),'Dialog must support Escape dismissal.');
 assert.equal((index.match(/\bwindow\.confirm\s*\(/g)||[]).length,0,'Native window.confirm dialogs must not remain.');
 assert.equal((index.match(/\bwindow\.prompt\s*\(/g)||[]).length,0,'Native window.prompt dialogs must not remain.');
 assert.equal((index.match(/\bwindow\.alert\s*\(/g)||[]).length,0,'Native window.alert dialogs must not remain.');
});

test('Buyer and Admin PWA setup fallbacks use branded responsive surfaces',()=>{
 for(const source of [buyerShell,adminIndex]){
  assert.ok(source.includes('border-radius:26px'),'PWA setup fallback must use a designed card surface.');
  assert.ok(source.includes('linear-gradient(135deg,#702078,#a64ca6)'),'PWA setup mark must use FMart brand colors.');
  assert.ok(source.includes('box-shadow:0 12px 34px'),'PWA status feedback must have intentional elevation.');
 }
});

test('Operational loading and status elements use designed FMart surfaces',()=>{
 for(const selector of ['.panel-loading','.catalog-loading','.stock-loading','.loading-spinner','.status-pill','.product-load-status','.product-load-sentinel']){
  assert.ok(index.includes(selector),'Missing visual treatment for '+selector);
 }
 assert.ok(index.includes('linear-gradient(145deg,#fff,#fbf6fc)'));
 assert.ok(index.includes('border-radius:999px;background:#f6edf8;color:#68216f'));
});


test('Staff workspace header follows the active menu and hides stale dashboard summaries',()=>{
 assert.ok(index.includes('<div class="section-title" style="margin:0"><div><h2 id="opsTitle">Dashboard</h2></div>'),'Operational eyebrow is removed without leaving its top margin.');
 assert.ok(!index.includes('<div class="eyebrow">Operasional FMart</div>'));
 const navigation=extractFunction(index,'setStaffActiveNavigation');
 assert.ok(navigation.includes("const isDashboard=id==='staffDashboard'"));
 assert.ok(navigation.includes("$('opsStats').classList.toggle('hidden',!isDashboard||isDeliveryStaff)"));
 assert.ok(navigation.includes("$('opsRefresh').classList.toggle('hidden',!isDashboard||isDeliveryStaff)"));
 assert.ok(navigation.includes("id==='staffDeliveryComplaints'?'Komplain Pengantaran'"));
 assert.ok(navigation.includes("$('opsTitle').textContent=pageTitle"));
});


test('Desktop staff sidebar matches the Admin mobile navbar palette with clear active and inactive contrast',()=>{
 const start=index.lastIndexOf('/* FMart visual consistency: desktop staff sidebar follows the Admin mobile navbar palette. */');
 const style=index.slice(start,index.indexOf('</style>',start));
 assert.ok(start>=0,'Desktop sidebar palette override must exist.');
 assert.ok(style.includes('background:linear-gradient(110deg,#350038 0%,#650069 60%,#800080 100%)'),'Sidebar background must match the Admin mobile navbar gradient.');
 assert.ok(style.includes('background:#f5f0ff'),'Active menu must use a light lavender surface.');
 assert.ok(style.includes('color:#800080!important'),'Active menu label and icon must use Amethyst purple.');
 assert.ok(style.includes('color:#f1dff3'),'Inactive menu labels must remain legible in light lilac.');
 assert.ok(style.includes('color:#f4dff5!important'),'Inactive menu icons must remain legible in light lilac.');
 assert.ok(style.includes('background:rgba(255,255,255,.13)'),'Hover state must provide subtle contrast on the purple sidebar.');
 assert.ok(style.includes('@media (min-width:901px)'),'Sidebar palette override must be desktop-only.');
});
