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


test('Wali-Santri relationship limits count distinct Wali accounts and block duplicate active links',()=>{
 const helper=extractFunction(code,'countDistinctActiveWaliForSantri_');
 assert.ok(helper.includes('activeWaliIds[waliId]=true'));
 assert.ok(helper.includes('Object.keys(activeWaliIds).length'));
 const self=extractFunction(code,'requestWaliSantriLink');
 assert.ok(self.includes('pairRows.some(function(item){return String(item.row[3]||\'\').toUpperCase()===\'AKTIF\';})'));
 assert.ok(self.includes('countDistinctActiveWaliForSantri_(relRows,santriId)'));
 const admin=extractFunction(code,'linkWaliSantri');
 assert.ok(admin.includes("String(wali.values[6]||'').toUpperCase()!=='AKTIF'"),'Admin cannot attach relationships to inactive Wali accounts.');
 assert.ok(admin.includes('activeOrPendingWaliIds'));
 const approve=extractFunction(code,'approveWaliSantriRequest');
 assert.ok(approve.includes('countDistinctActiveWaliForSantri_'));
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
  superadmin:['createStaffUser','savePaymentSettings','setStaffEmail','updateFMartUser','toggleFMartUser','resetFMartUserPassword']
 };
 const roleNames={wali:'WALI_SANTRI',kasir:'KASIR',gudang:'GUDANG',pengantar:'PETUGAS_PENGANTAR',admin:'ADMIN',superadmin:'SUPERADMIN'};
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

test('Wali self-link modal copy matches the direct active relationship flow',()=>{
 const start=index.indexOf('<div id="waliLinkModal"');
 const end=index.indexOf('<div id="changePasswordModal"',start);
 assert.ok(start>=0&&end>start,'Wali link modal must exist.');
 const modal=index.slice(start,end);
 assert.ok(modal.includes('Santri aktif dapat dihubungkan langsung oleh Wali tanpa persetujuan Admin.'));
 assert.ok(!modal.includes('Pengajuan akan diverifikasi Admin/Superadmin'));
 const submitStart=index.indexOf('function openWaliRequestForm(');
 const submitEnd=index.indexOf('function closeProfile(',submitStart);
 assert.ok(submitStart>=0&&submitEnd>submitStart,'Wali self-link action must exist.');
 const submit=index.slice(submitStart,submitEnd);
 assert.ok(submit.includes('Hubungan langsung aktif tanpa persetujuan Admin.'));
 assert.ok(submit.includes("runServer('requestWaliSantriLink'"));
});

test('Payment rejection note is semantically required only for rejection',()=>{
 const fn=extractFunction(index,'openVerifyPayment');
 assert.ok(fn.includes("maxlength=\"300\"'+(accepting?'':' required')+' placeholder=\"'+(accepting?'Catatan pemeriksaan (opsional)':'Jelaskan alasan penolakan')+'\""));
 assert.ok(fn.includes("if(!accepting&&!note)"),'Existing rejection validation must remain.');
 assert.ok(fn.includes("accepting?'Catatan pemeriksaan (opsional)':'Jelaskan alasan penolakan'"));
});

test('Empty Wali child picker copy and action match direct self-link behavior',()=>{
 const start=index.indexOf('function renderEmptyChildPicker(){');
 const end=index.indexOf('let childPickerSearchTimer',start);
 assert.ok(start>=0&&end>start,'Empty child picker renderer must exist.');
 const empty=index.slice(start,end);
 assert.ok(empty.includes('Cari Santri aktif di bawah ini lalu hubungkan langsung tanpa persetujuan Admin.'));
 assert.ok(!empty.includes('diverifikasi Admin'));
 const searchStart=index.indexOf('async function searchChildPickerDirectory(');
 const searchEnd=index.indexOf('function ',searchStart+10);
 const search=index.slice(searchStart,searchEnd>0?searchEnd:undefined);
 assert.ok(index.includes("data-picker-request=\"'+escapeHtml(c.id)+'\">Hubungkan</button>"));
 assert.ok(search.includes('openWaliLinkModal(c)'),'Selecting a Santri must continue to use the direct Wali self-link flow.');
});

test('Staff login OTP field exposes required six-digit semantics',()=>{
 const start=index.indexOf('id="loginOtpCode"');
 const inputStart=index.lastIndexOf('<input',start);
 const inputEnd=index.indexOf('>',start);
 assert.ok(start>=0&&inputStart>=0&&inputEnd>start,'OTP input must exist.');
 const input=index.slice(inputStart,inputEnd+1);
 assert.ok(input.includes('required'));
 assert.ok(input.includes('maxlength="6"'));
 assert.ok(input.includes('pattern="[0-9]{6}"'));
 assert.ok(input.includes('autocomplete="one-time-code"'));
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
