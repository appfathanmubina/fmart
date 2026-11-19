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
 const setupEntry=extractFunction(setup,'setupFMartDatabase_'),readiness=extractFunction(code,'runFMartReadinessAudit_');
 assert.ok(!setup.includes('function setupFMartDatabase('),'Database setup must not be exposed as a browser endpoint.');
 assert.ok(!code.includes('function runFMartReadinessAudit('),'Readiness audit must not be exposed as a browser endpoint.');
 assert.ok(setupEntry.includes('SpreadsheetApp.getActiveSpreadsheet()'));
 assert.ok(setupEntry.includes('ensureSheet_'));
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
 const operations=extractFunction(code,'getOperationsDashboard');
 const recovery=extractFunction(code,'recoverFMartTransactions_');
 const reports=extractFunction(code,'getWarehouseHistoryReport');
 assert.ok(operations.includes('getOrderRecipientSnapshot_(ss,r)'));
 assert.ok(operations.includes('child=getOrderRecipientSnapshot_(ss,o)'),'Payment verification must display the saved recipient.');
 assert.ok(recovery.includes('p.recipientSnapshot?{userId:p.userId,recipient:p.recipientSnapshot'),'Transaction recovery must validate the new recipient fingerprint.');
 assert.ok(reports.includes('getOrderRecipientSnapshot_(ss,order.row)'),'Order and delivery history must show the saved recipient.');
 assert.ok(extractFunction(code,'auditFMartOperationalSync_').includes('ORDER_RECIPIENT_MISSING'));
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
 assert.ok(/!i\.available\?'<div class="danger-text">Produk tidak tersedia<\/div>/.test(cart),'Cart may only report inactive products, never stock shortages.');
 assert.ok(!detail.includes('p.stock')&&!detail.includes('p.minStock'));
});
