/**
 * FMart - Code.gs
 * Backend, autentikasi, otorisasi, dan API aplikasi.
 */

const FMART = Object.freeze({
  APP_NAME: 'FMart',
  SESSION_TTL_SECONDS: 21600,
  LOGIN_RATE_LIMIT_SECONDS: 300,
  LOGIN_MAX_FAILURES: 8,
  PASSWORD_MIN_LENGTH: 10,
  PASSWORD_HASH_MODE_PROPERTY: 'FMART_PASSWORD_HASH_MODE', // Default LEGACY sampai benchmark runtime Apps Script lulus.
  PASSWORD_HASH_ITERATIONS: 600000,
  SPREADSHEET_PROPERTY: 'FMART_SPREADSHEET_ID',
  ROLES: Object.freeze({ WALI_SANTRI:'WALI_SANTRI', ADMIN:'ADMIN', KASIR:'KASIR', GUDANG:'GUDANG', PETUGAS_PENGANTAR:'PETUGAS_PENGANTAR', SUPERVISOR:'SUPERVISOR', SUPERADMIN:'SUPERADMIN' })
});

function doGet(e) {
  const requestedPortal = e && e.parameter ? String(e.parameter.portal || '') : '';
  const portalMode = requestedPortal === 'ADMINFMART16720' ? 'ADMINFMART16720' : 'BUYER';
  const template = HtmlService.createTemplateFromFile('Index');
  template.portalMode = portalMode;
  return template.evaluate()
    .setTitle(portalMode === 'ADMINFMART16720' ? 'FMart Admin' : FMART.APP_NAME)
    .addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function portalRoleAllowed_(role, portalMode) {
  role = String(role || '').toUpperCase();
  if (portalMode === 'ADMINFMART16720') {
    return ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR'].indexOf(role) >= 0;
  }
  return role === FMART.ROLES.WALI_SANTRI;
}

function assertPortalRole_(role, portalMode) {
  if (!portalRoleAllowed_(role, portalMode)) {
    throw new Error(portalMode === 'ADMINFMART16720'
      ? 'Akun ini tidak memiliki akses ke jalur Admin FMart.'
      : 'Akun petugas tidak dapat digunakan di jalur Pembeli FMart.');
  }
}

function getSS_() {
  const id = PropertiesService.getScriptProperties().getProperty(FMART.SPREADSHEET_PROPERTY);
  if (!id) throw new Error('Database FMart belum dikonfigurasi. Jalankan setupFMartDatabase_() terlebih dahulu.');
  return SpreadsheetApp.openById(id);
}

function login(username, password, portalMode) {
  portalMode = String(portalMode || 'BUYER') === 'ADMINFMART16720' ? 'ADMINFMART16720' : 'BUYER';
  const rawLogin = String(username || '').trim();
  username = normalizeUsername_(rawLogin);
  if (!username || typeof password !== 'string' || !password) return {ok:false, message:portalMode === 'ADMINFMART16720' ? 'Email atau password tidak valid.' : 'Nomor HP atau password tidak valid.'};
  const phoneKeyForRate = normalizePhone_(rawLogin);
  const isWaliEmailLogin = portalMode !== 'ADMINFMART16720' && rawLogin.indexOf('@') >= 0;
  const rate = loginRateKey_(isWaliEmailLogin ? username : (phoneKeyForRate || username));
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get(rate) || 0);
  if (failures >= FMART.LOGIN_MAX_FAILURES) return {ok:false, message:'Terlalu banyak percobaan login. Silakan coba lagi beberapa menit kemudian.'};

  const ss = getSS_();
  const sheet = ss.getSheetByName('Users');
  if (!sheet || sheet.getLastRow() < 2) return {ok:false, message:'Belum ada akun FMart.'};
  const rows = sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues();

  // Wali Santri login menggunakan No. HP yang terdaftar pada WaliSantri.
  // Akun staff tetap login menggunakan Username biasa.
  let targetIndex = -1;
  for (let i=0;i<rows.length;i++) {
    const rowRole = String(rows[i][5] || '').toUpperCase();
    const loginValue = portalMode === 'ADMINFMART16720' || isWaliEmailLogin
      ? normalizeEmail_(rows[i][10])
      : normalizeUsername_(rows[i][1]);
    if (loginValue === username && (portalMode === 'ADMINFMART16720'
      ? ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR'].indexOf(rowRole) >= 0
      : rowRole === 'WALI_SANTRI')) {
      if (targetIndex !== -1) {
        recordLoginFailure_(rate);
        return {ok:false,message:'Email atau password tidak valid.'};
      }
      targetIndex=i;
    }
  }

  if (targetIndex === -1 && portalMode !== 'ADMINFMART16720') {
    const phoneKey = normalizePhone_(rawLogin);
    const waliRows = readRows_(ss.getSheetByName('WaliSantri'));
    const matches = waliRows.filter(function(r){
      const matchesIdentity = isWaliEmailLogin
        ? normalizeEmail_(r[4]) === username
        : (!!phoneKey && normalizePhone_(r[3]) === phoneKey);
      return matchesIdentity && String(r[6] || '').toUpperCase() === 'AKTIF';
    });
    if (matches.length > 1) {
      recordLoginFailure_(rate);
      return {ok:false, message:'Nomor HP/email atau password salah.'};
    }
    if (matches.length === 1) {
      const userId = String(matches[0][1] || '');
      for (let i=0;i<rows.length;i++) {
        if (String(rows[i][0] || '') === userId && String(rows[i][5] || '').toUpperCase() === 'WALI_SANTRI') { targetIndex=i; break; }
      }
    }
  }

  if (targetIndex === -1) {
    recordLoginFailure_(rate);
    return {ok:false, message:'Nomor HP/username atau password salah.'};
  }

  const r = rows[targetIndex];
  if (String(r[6]).toUpperCase() !== 'AKTIF') {
    recordLoginFailure_(rate);
    return {ok:false, message:'Nomor HP/username atau password salah.'};
  }
  if (!verifyPassword_(password, String(r[3]), String(r[2]))) {
    recordLoginFailure_(rate);
    return {ok:false, message:'Nomor HP/username atau password salah.'};
  }

  if (!portalRoleAllowed_(String(r[5] || ''), portalMode)) {
    return {ok:false, message:'Akun ini tidak dapat digunakan pada jalur FMart tersebut.'};
  }

  // Login staf wajib menyelesaikan OTP email sebelum sesi dibuat.
  // Password yang benar saja tidak pernah menghasilkan token sesi untuk portal petugas.

  // Migrasi hash lama hanya setelah password lama terbukti benar.
  if (passwordHashMode_() === 'PBKDF2' && isLegacyPasswordHash_(String(r[2] || ''))) {
    const migrationLock = LockService.getScriptLock();
    migrationLock.waitLock(15000);
    try {
      const latest = findRowById_(sheet, String(r[0]), 1);
      if (!latest || String(latest.values[6] || '').toUpperCase() !== 'AKTIF' ||
          !verifyPassword_(password, String(latest.values[3] || ''), String(latest.values[2] || ''))) {
        cache.put(rate, String(failures + 1), FMART.LOGIN_RATE_LIMIT_SECONDS);
        return {ok:false, message:'Nomor HP/username atau password salah.'};
      }
      for (let j = 0; j < latest.values.length; j++) r[j] = latest.values[j];
      if (isLegacyPasswordHash_(String(latest.values[2] || ''))) {
        const migratedSalt = Utilities.getUuid().replace(/-/g, '');
        const migratedHash = hashPassword_(password, migratedSalt);
        const migratedAt = new Date();
        sheet.getRange(latest.rowNumber, 3, 1, 2).setValues([[migratedHash, migratedSalt]]);
        sheet.getRange(latest.rowNumber, 9).setValue(migratedAt);
        SpreadsheetApp.flush();
        r[2] = migratedHash; r[3] = migratedSalt; r[8] = migratedAt;
      } else {
        for (let j = 0; j < latest.values.length; j++) r[j] = latest.values[j];
      }
    } finally { migrationLock.releaseLock(); }
  }

  if (portalMode === 'ADMINFMART16720') {
    const otpResult = issueAdminLoginOtp_(r, rate);
    if (!otpResult.ok) return otpResult;
    cache.remove(rate);
    writeAudit_(String(r[0]), String(r[5] || '').toUpperCase(), 'LOGIN_OTP_ISSUED', 'USER', String(r[0]), '', JSON.stringify({email:maskEmail_(r[10])}), 'Password benar; OTP email dikirim sebelum sesi dibuat');
    return otpResult;
  }

  const token = Utilities.getUuid() + '.' + Utilities.getUuid();
  const role = String(r[5]).toUpperCase();
  let sessionUsername = String(r[1] || '');
  if (role === FMART.ROLES.WALI_SANTRI) {
    const wali = findWaliByUserId_(ss, String(r[0]));
    if (!wali || !normalizePhone_(wali.noHp)) return {ok:false, message:'No. HP Wali Santri belum terdaftar. Hubungi Admin.'};
    sessionUsername = wali.noHp;
  }
  const updatedAt = r[8] instanceof Date ? r[8].getTime() : (new Date(r[8] || 0).getTime() || 0);
  const session = {userId:String(r[0]), username:sessionUsername, nama:String(r[4]), role:role, issuedAt:Date.now(), authUpdatedAt:updatedAt};
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(session), FMART.SESSION_TTL_SECONDS);
  sheet.getRange(targetIndex+2,10).setValue(new Date());
  cache.remove(rate);
  writeAudit_(session.userId, session.role, 'LOGIN_SUCCESS', 'USER', session.userId, '', JSON.stringify({username:session.username}), 'Login berhasil');
  return {ok:true, token:token, user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role}};
}


/** OTP login Admin: disimpan sebagai hash di cache selama 5 menit; sesi belum dibuat. */
function issueAdminLoginOtp_(userRow, rateKey) {
  const email = normalizeEmail_(userRow[10]);
  if (!isValidStaffEmail_(email)) return {ok:false,message:'Email akun staf belum valid. Minta Superadmin memperbarui email sebelum login.'};
  const cache = CacheService.getScriptCache();
  const userId = String(userRow[0] || '');
  const cooldownKey = adminOtpCooldownKey_(userId);
  const lock = LockService.getScriptLock();
  let code, challengeId;
  lock.waitLock(5000);
  try {
    if (cache.get(cooldownKey)) return {ok:false,message:'Kode OTP baru saja dikirim. Periksa email atau tunggu sebelum meminta kode baru.'};
    code = String(100000 + (parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16) % 900000));
    challengeId = Utilities.getUuid() + Utilities.getUuid();
    const challenge = {
      userId:userId, role:String(userRow[5] || '').toUpperCase(), email:email,
      authUpdatedAt:userRow[8] instanceof Date ? userRow[8].getTime() : (new Date(userRow[8] || 0).getTime() || 0),
      otpHash:adminOtpHash_(challengeId,code), attempts:0, createdAt:Date.now()
    };
    cache.put(adminOtpChallengeKey_(challengeId),JSON.stringify(challenge),300);
    cache.put(cooldownKey,'1',60);
  } finally {
    lock.releaseLock();
  }
  try {
    MailApp.sendEmail({
      to:email,
      subject:'Kode OTP Login FMart Admin',
      body:'Kode OTP login FMart Admin Anda adalah: '+code+'\n\nKode berlaku selama 5 menit dan hanya dapat digunakan satu kali. Jangan berikan kode ini kepada siapa pun.',
      name:'FMart'
    });
  } catch (err) {
    cache.remove(adminOtpChallengeKey_(challengeId));
    cache.remove(cooldownKey);
    console.error('Pengiriman OTP gagal:',err);
    return {ok:false,message:'Email OTP belum dapat dikirim. Periksa konfigurasi email aplikasi atau hubungi Superadmin.'};
  }
  return {ok:true,requiresOtp:true,challengeId:challengeId,maskedEmail:maskEmail_(email),message:'Kode OTP telah dikirim ke email terdaftar.'};
}

function verifyAdminLoginOtp(challengeId, code, portalMode) {
  if (String(portalMode || '') !== 'ADMINFMART16720') return {ok:false,message:'Permintaan login tidak valid.'};
  challengeId=String(challengeId || '').trim();
  code=String(code || '').trim();
  if (!/^[0-9]{6}(?![\s\S])/.test(code) || !challengeId) return {ok:false,message:'Kode OTP tidak valid.'};
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const cache=CacheService.getScriptCache(),key=adminOtpChallengeKey_(challengeId),raw=cache.get(key);
    if(!raw) return {ok:false,message:'Kode OTP kedaluwarsa atau sudah digunakan. Silakan login kembali.'};
    const challenge=JSON.parse(raw);
    if(challenge.attempts>=5){cache.remove(key);return {ok:false,message:'Batas percobaan OTP tercapai. Silakan login kembali.'};}
    if(!constantTimeEqual_(adminOtpHash_(challengeId,code),challenge.otpHash)){
      challenge.attempts++;
      if(challenge.attempts>=5) cache.remove(key); else cache.put(key,JSON.stringify(challenge),Math.max(1,300-Math.floor((Date.now()-challenge.createdAt)/1000)));
      return {ok:false,message:'Kode OTP salah. Sisa percobaan: '+Math.max(0,5-challenge.attempts)+'.'};
    }
    cache.remove(key);
    const sheet=getSS_().getSheetByName('Users');
    const user=findRowById_(sheet,challenge.userId,1);
    if(!user || String(user.values[6]||'').toUpperCase()!=='AKTIF' ||
       String(user.values[5]||'').toUpperCase()!==challenge.role ||
       normalizeEmail_(user.values[10])!==challenge.email || !isValidStaffEmail_(challenge.email)){
      return {ok:false,message:'Data akun berubah. Silakan mulai login kembali.'};
    }
    const updatedAt=user.values[8] instanceof Date?user.values[8].getTime():(new Date(user.values[8]||0).getTime()||0);
    if(updatedAt!==Number(challenge.authUpdatedAt)) return {ok:false,message:'Data keamanan akun berubah. Silakan mulai login kembali.'};
    const token=Utilities.getUuid()+'.'+Utilities.getUuid();
    const session={userId:String(user.values[0]),username:challenge.email,nama:String(user.values[4]),role:challenge.role,issuedAt:Date.now(),authUpdatedAt:updatedAt};
    cache.put(sessionKey_(token),JSON.stringify(session),FMART.SESSION_TTL_SECONDS);
    sheet.getRange(user.rowNumber,10).setValue(new Date());
    if (!(String(user.values[11]||'').toUpperCase()==='TRUE'||user.values[11]===true)) sheet.getRange(user.rowNumber,12).setValue(true);
    writeAudit_(session.userId,session.role,'LOGIN_SUCCESS_OTP','USER',session.userId,'',JSON.stringify({username:session.username}),'Login Admin berhasil setelah OTP email');
    return {ok:true,token:token,user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role}};
  } finally {lock.releaseLock();}
}

function setStaffEmail(token,userId,email) {
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  email=normalizeEmail_(email);
  if(!isValidStaffEmail_(email)) throw new Error('Alamat email tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const sheet=getSS_().getSheetByName('Users'),target=findRowById_(sheet,String(userId||''),1);
    if(!target) throw new Error('Akun staf tidak ditemukan.');
    const role=String(target.values[5]||'').toUpperCase();
    if(['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR'].indexOf(role)<0) throw new Error('Email hanya dapat diatur untuk akun staf.');
    const rows=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues():[];
    if(rows.some(function(r){return String(r[0]||'')!==String(userId)&&normalizeEmail_(r[10])===email;})) throw new Error('Email sudah digunakan akun lain.');

    // Kirim dan siapkan tantangan verifikasi sebelum mengubah email akun.
    // Jika layanan email gagal, email lama, status verifikasi, dan sesi tetap utuh.
    const code=String(100000+(parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16)%900000)),challengeId=Utilities.getUuid()+Utilities.getUuid();
    const challengeKey=staffEmailVerifyKey_(challengeId);
    CacheService.getScriptCache().put(challengeKey,JSON.stringify({userId:String(userId),email:email,hash:adminOtpHash_(challengeId,code),createdAt:Date.now(),attempts:0}),600);
    try {
      MailApp.sendEmail({to:email,subject:'Verifikasi Email Akun FMart',body:'Kode verifikasi email FMart Anda: '+code+'\n\nKode berlaku selama 10 menit.' ,name:'FMart'});
    } catch(sendError) {
      CacheService.getScriptCache().remove(challengeKey);
      console.error('Pengiriman verifikasi email staf gagal:',sendError);
      throw new Error('Email verifikasi belum dapat dikirim. Data email akun tidak diubah.');
    }

    try {
      sheet.getRange(target.rowNumber,11,1,2).setValues([[email,false]]);
      sheet.getRange(target.rowNumber,9).setValue(new Date());
      SpreadsheetApp.flush();
    } catch(updateError) {
      CacheService.getScriptCache().remove(challengeKey);
      console.error('Pembaruan email staf gagal:',updateError);
      throw new Error('Email verifikasi telah dikirim, tetapi data akun belum berhasil diperbarui. Silakan ulangi proses.');
    }
    writeAudit_(session.userId,session.role,'SET_STAFF_EMAIL','USER',String(userId),'',JSON.stringify({email:maskEmail_(email)}),'Email staf diatur; menunggu verifikasi');
    return {ok:true,challengeId:challengeId,maskedEmail:maskEmail_(email),message:'Kode verifikasi telah dikirim.'};
  } finally {lock.releaseLock();}
}

function verifyStaffEmail(token,challengeId,code) {
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  challengeId=String(challengeId||'');code=String(code||'').trim();
  if(!/^[0-9]{6}(?![\s\S])/.test(code)) throw new Error('Kode verifikasi tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const cache=CacheService.getScriptCache(),key=staffEmailVerifyKey_(challengeId),raw=cache.get(key);
    if(!raw) throw new Error('Kode verifikasi kedaluwarsa atau sudah digunakan.');
    const ch=JSON.parse(raw);
    if(ch.attempts>=5){cache.remove(key);throw new Error('Batas percobaan tercapai.');}
    if(!constantTimeEqual_(adminOtpHash_(challengeId,code),ch.hash)){
      ch.attempts++;if(ch.attempts>=5)cache.remove(key);else cache.put(key,JSON.stringify(ch),Math.max(1,600-Math.floor((Date.now()-ch.createdAt)/1000)));
      throw new Error('Kode verifikasi salah. Sisa percobaan: '+Math.max(0,5-ch.attempts)+'.');
    }
    const sheet=getSS_().getSheetByName('Users'),target=findRowById_(sheet,ch.userId,1);
    if(!target||normalizeEmail_(target.values[10])!==ch.email) throw new Error('Data email berubah. Ulangi proses.');
    sheet.getRange(target.rowNumber,12).setValue(true);
    sheet.getRange(target.rowNumber,9).setValue(new Date());
    cache.remove(key);
    writeAudit_(session.userId,session.role,'VERIFY_STAFF_EMAIL','USER',ch.userId,'',JSON.stringify({email:maskEmail_(ch.email)}),'Email staf berhasil diverifikasi');
    SpreadsheetApp.flush();
    return {ok:true,message:'Email staf berhasil diverifikasi.'};
  } finally {lock.releaseLock();}
}

function normalizeEmail_(value){return String(value||'').trim().toLowerCase();}
function isValidStaffEmail_(email){return /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(String(email||''));}
function maskEmail_(email){const p=String(email||'').split('@');if(p.length!==2)return '';const name=p[0];return (name.length<3?name.charAt(0)+'••':name.slice(0,2)+'•••')+'@'+p[1];}
function adminOtpHash_(challengeId,code){
  const props=PropertiesService.getScriptProperties();let secret=props.getProperty('FMART_OTP_PEPPER');
  if(!secret){secret=Utilities.getUuid()+Utilities.getUuid();props.setProperty('FMART_OTP_PEPPER',secret);}
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(challengeId)+'|'+String(code),secret));
}
function adminOtpChallengeKey_(id){return 'FMART_ADMIN_OTP_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(id))).slice(0,48);}
function staffEmailVerifyKey_(id){return 'FMART_STAFF_EMAIL_VERIFY_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(id))).slice(0,40);}
function adminOtpCooldownKey_(id){return 'FMART_ADMIN_OTP_COOLDOWN_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(id))).slice(0,40);}

function normalizePhone_(value) {
  let s = String(value == null ? '' : value).trim().replace(/[^0-9+]/g, '');
  if (!s) return '';
  if (s.indexOf('+62') === 0) s = '0' + s.slice(3);
  else if (s.indexOf('62') === 0) s = '0' + s.slice(2);
  else if (s.charAt(0) === '8') s = '0' + s;
  if (!/^08[0-9]{8,13}(?![\s\S])/.test(s)) return '';
  return s;
}

function phoneEquals_(a, b) {
  const na = normalizePhone_(a), nb = normalizePhone_(b);
  return !!na && !!nb && na === nb;
}

function waliEmailOtpKey_(id){return 'FMART_WALI_EMAIL_OTP_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(id))).slice(0,40);}
function sendWaliEmailVerification_(userId,email){
  email=normalizeEmail_(email);
  if(!isValidStaffEmail_(email)||email.length>160)throw new Error('Alamat email tidak valid.');
  const ss=getSS_(),users=ss.getSheetByName('Users'),waliSheet=ss.getSheetByName('WaliSantri'),user=findRowById_(users,String(userId),1);
  if(!user||String(user.values[5]||'').toUpperCase()!=='WALI_SANTRI')throw new Error('Akun Wali Santri tidak ditemukan.');
  const rows=readRows_(users),walis=readRows_(waliSheet),waliRecord=walis.find(function(r){return String(r[1]||'')===String(userId);});if(!waliRecord)throw new Error('Data Wali Santri tidak ditemukan.');
  if(rows.some(r=>String(r[0]||'')!==String(userId)&&String(r[5]||'').toUpperCase()==='WALI_SANTRI'&&normalizeEmail_(r[10])===email)||
     walis.some(r=>String(r[1]||'')!==String(userId)&&normalizeEmail_(r[4])===email))throw new Error('Email sudah digunakan akun Wali Santri lain.');
  const challengeId=Utilities.getUuid()+Utilities.getUuid(),code=String(100000+(parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16)%900000));
  const cache=CacheService.getScriptCache(),key=waliEmailOtpKey_(challengeId),rateKey='FMART_WALI_EMAIL_RATE_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(userId))).slice(0,36);
  if(cache.get(rateKey+'_COOLDOWN'))throw new Error('Kode verifikasi baru saja dikirim. Tunggu satu menit sebelum meminta kode lagi.');
  const rateCount=Number(cache.get(rateKey)||0);if(rateCount>=5)throw new Error('Batas pengiriman kode verifikasi tercapai. Coba kembali satu jam lagi.');
  cache.put(rateKey,String(rateCount+1),3600);cache.put(rateKey+'_COOLDOWN','1',60);
  cache.put(key,JSON.stringify({userId:String(userId),email:email,hash:adminOtpHash_(challengeId,code),createdAt:Date.now(),attempts:0}),600);
  try{MailApp.sendEmail({to:email,subject:'Verifikasi Email FMart',body:'Kode verifikasi email FMart Anda: '+code+'\\n\\nKode berlaku 10 menit dan hanya dapat digunakan satu kali. Jangan berikan kode ini kepada siapa pun.',name:'FMart'});}
  catch(err){cache.remove(key);cache.remove(rateKey+'_COOLDOWN');console.error('Pengiriman OTP Wali gagal:',err);throw new Error('Email verifikasi belum dapat dikirim. Data email akun tidak diubah.');}
  users.getRange(user.rowNumber,11,1,2).setValues([[email,false]]);
  users.getRange(user.rowNumber,9).setValue(new Date());
  const waliRow=findRowById_(waliSheet,String(waliRecord[0]),1);
  if(waliRow)waliSheet.getRange(waliRow.rowNumber,5).setValue(email);
  SpreadsheetApp.flush();
  return {ok:true,challengeId:challengeId,maskedEmail:maskEmail_(email),message:'Kode verifikasi telah dikirim. Email baru aktif setelah kode diverifikasi.'};
}
function verifyWaliEmail(challengeId,code){
  challengeId=String(challengeId||'').trim();code=String(code||'').trim();
  if(!challengeId||!/^[0-9]{6}$/.test(code))throw new Error('Kode verifikasi tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const cache=CacheService.getScriptCache(),key=waliEmailOtpKey_(challengeId),raw=cache.get(key);
    if(!raw)throw new Error('Kode verifikasi kedaluwarsa atau sudah digunakan.');
    const ch=JSON.parse(raw);
    if(ch.attempts>=5){cache.remove(key);throw new Error('Batas percobaan tercapai.');}
    if(!constantTimeEqual_(adminOtpHash_(challengeId,code),ch.hash)){
      ch.attempts++;if(ch.attempts>=5)cache.remove(key);else cache.put(key,JSON.stringify(ch),Math.max(1,600-Math.floor((Date.now()-ch.createdAt)/1000)));
      throw new Error('Kode verifikasi salah. Sisa percobaan: '+Math.max(0,5-ch.attempts)+'.');
    }
    const ss=getSS_(),users=ss.getSheetByName('Users'),user=findRowById_(users,ch.userId,1);
    if(!user||String(user.values[5]||'').toUpperCase()!=='WALI_SANTRI'||String(user.values[6]||'').toUpperCase()!=='AKTIF'||normalizeEmail_(user.values[10])!==ch.email)throw new Error('Data akun berubah. Silakan minta kode baru.');
    users.getRange(user.rowNumber,12).setValue(true);cache.remove(key);
    writeAudit_(ch.userId,'WALI_SANTRI','VERIFY_WALI_EMAIL','USER',ch.userId,'',JSON.stringify({email:maskEmail_(ch.email)}),'Email Wali Santri berhasil diverifikasi');
    SpreadsheetApp.flush();return {ok:true,message:'Email berhasil diverifikasi.'};
  }finally{lock.releaseLock();}
}
function verifyWaliRegistrationOtp(challengeId,code){
  challengeId=String(challengeId||'').trim();code=String(code||'').trim();
  if(!challengeId||!/^[0-9]{6}$/.test(code))throw new Error('Kode OTP tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const cache=CacheService.getScriptCache(),key=waliEmailOtpKey_('REGISTER_'+challengeId),raw=cache.get(key);
    if(!raw)throw new Error('Kode OTP kedaluwarsa atau sudah digunakan. Silakan daftar kembali.');
    const ch=JSON.parse(raw);
    if(ch.attempts>=5){cache.remove(key);throw new Error('Batas percobaan OTP tercapai. Silakan daftar kembali.');}
    if(!constantTimeEqual_(adminOtpHash_(challengeId,code),ch.hash)){
      ch.attempts++;if(ch.attempts>=5)cache.remove(key);else cache.put(key,JSON.stringify(ch),Math.max(1,600-Math.floor((Date.now()-ch.createdAt)/1000)));
      throw new Error('Kode OTP salah. Sisa percobaan: '+Math.max(0,5-ch.attempts)+'.');
    }
    const ss=getSS_(),users=ss.getSheetByName('Users'),waliSheet=ss.getSheetByName('WaliSantri'),userRows=readRows_(users),waliRows=readRows_(waliSheet);
    if(waliRows.some(r=>phoneEquals_(r[3],ch.noHp))||userRows.some(r=>String(r[1]||'').trim()===ch.noHp))throw new Error('Nomor HP sudah terdaftar. Silakan login atau gunakan nomor lain.');
    if(waliRows.some(r=>normalizeEmail_(r[4])===ch.email)||userRows.some(r=>String(r[5]||'').toUpperCase()==='WALI_SANTRI'&&normalizeEmail_(r[10])===ch.email))throw new Error('Email sudah digunakan akun Wali Santri lain.');
    const now=new Date(),userId=makeFMartId_('USR'),waliId=makeFMartId_('WAL');
    users.getRange(users.getLastRow()+1,1,1,12).setValues([[userId,ch.noHp,ch.hash,ch.salt,ch.nama,'WALI_SANTRI','AKTIF',now,now,'',ch.email,true]]);
    waliSheet.getRange(waliSheet.getLastRow()+1,1,1,9).setValues([[waliId,userId,ch.nama,ch.noHp,ch.email,ch.alamat,'AKTIF',now,now]]);
    users.getRange(users.getLastRow(),2).setNumberFormat('@');waliSheet.getRange(waliSheet.getLastRow(),4).setNumberFormat('@');
    cache.remove(key);SpreadsheetApp.flush();
    writeAudit_('','SYSTEM','REGISTER_WALI_SANTRI','USER',userId,'',JSON.stringify({username:ch.noHp,role:'WALI_SANTRI'}),'Pendaftaran Wali Santri selesai setelah OTP email');
    return {ok:true,userId:userId,waliId:waliId,message:'Email terverifikasi dan pendaftaran berhasil. Silakan login menggunakan nomor HP atau email.'};
  }finally{lock.releaseLock();}
}

/** Pendaftaran mandiri Wali Santri. Akun langsung AKTIF, tanpa relasi anak sampai ditambahkan. */
function registerWaliSantri(nama,noHp,password,email,alamat){
  nama=String(nama||'').trim();noHp=normalizePhone_(noHp);password=String(password||'');email=normalizeEmail_(email);alamat=String(alamat||'').trim();
  if(!nama)throw new Error('Nama wajib diisi.');
  if(!noHp)throw new Error('Nomor HP tidak valid. Gunakan format 08xxxxxxxxxx.');
  if(password.length<FMART.PASSWORD_MIN_LENGTH)throw new Error('Password minimal '+FMART.PASSWORD_MIN_LENGTH+' karakter.');
  if(!email||email.length>160||!isValidStaffEmail_(email))throw new Error('Email wajib diisi dengan format yang valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),users=ss.getSheetByName('Users'),waliSheet=ss.getSheetByName('WaliSantri');
    if(!users||!waliSheet)throw new Error('Database FMart belum siap.');
    const userRows=readRows_(users),waliRows=readRows_(waliSheet);
    if(waliRows.some(r=>phoneEquals_(r[3],noHp)))throw new Error('Nomor HP sudah terdaftar. Silakan gunakan nomor lain atau login.');
    if(userRows.some(r=>String(r[1]||'').trim()===noHp))throw new Error('Nomor HP sudah digunakan sebagai akun.');
    if(waliRows.some(r=>normalizeEmail_(r[4])===email)||userRows.some(r=>String(r[5]||'').toUpperCase()==='WALI_SANTRI'&&normalizeEmail_(r[10])===email))throw new Error('Email sudah digunakan oleh akun Wali Santri lain.');
    const salt=Utilities.getUuid().replace(/-/g,''),hash=hashPassword_(password,salt),challengeId=Utilities.getUuid()+Utilities.getUuid();
    const code=String(100000+(parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16)%900000)),key=waliEmailOtpKey_('REGISTER_'+challengeId),cache=CacheService.getScriptCache(),rateKey='FMART_WALI_REGISTER_RATE_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,email+'|'+noHp)).slice(0,36);
    if(cache.get(rateKey+'_COOLDOWN'))throw new Error('Kode OTP baru saja dikirim. Tunggu satu menit sebelum meminta kode lagi.');const rateCount=Number(cache.get(rateKey)||0);if(rateCount>=3)throw new Error('Batas pengiriman OTP tercapai. Coba kembali satu jam lagi.');cache.put(rateKey,String(rateCount+1),3600);cache.put(rateKey+'_COOLDOWN','1',60);
    cache.put(key,JSON.stringify({nama:nama,noHp:noHp,email:email,alamat:alamat,salt:salt,hash:hash,otpHash:adminOtpHash_(challengeId,code),attempts:0,createdAt:Date.now()}),600);
    try{MailApp.sendEmail({to:email,subject:'Verifikasi Pendaftaran FMart',body:'Kode OTP pendaftaran FMart Anda: '+code+'\\n\\nKode berlaku 10 menit. Masukkan kode ini untuk menyelesaikan pendaftaran.',name:'FMart'});}
    catch(err){cache.remove(key);cache.remove(rateKey+'_COOLDOWN');console.error('OTP pendaftaran Wali gagal:',err);throw new Error('Email OTP belum dapat dikirim. Pendaftaran belum disimpan. Periksa email atau coba kembali.');}
    return {ok:true,requiresOtp:true,challengeId:challengeId,maskedEmail:maskEmail_(email),message:'Kode OTP telah dikirim. Masukkan kode untuk menyelesaikan pendaftaran.'};
  }finally{lock.releaseLock();}
}



/** Mengirim tautan reset password hanya untuk akun Wali aktif; respons tidak membocorkan keberadaan email. */
function requestWaliPasswordReset(email) {
  email = normalizeEmail_(email);
  const generic = {ok:true,message:'Jika email terdaftar, tautan reset password akan dikirim.'};
  if (!isValidStaffEmail_(email)) return generic;
  const cache = CacheService.getScriptCache();
  const rateKey = waliPasswordResetRateKey_(email);
  const cooldownKey = rateKey + '_COOLDOWN';
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (cache.get(cooldownKey)) return generic;
    const attempts = Number(cache.get(rateKey) || 0);
    if (attempts >= 3) return generic;
    cache.put(rateKey, String(attempts + 1), 3600);
    cache.put(cooldownKey, '1', 60);
  } finally {
    lock.releaseLock();
  }

  const users = getSS_().getSheetByName('Users');
  if (!users) return generic;
  const matches = readRows_(users).filter(function(row) {
    return String(row[5] || '').toUpperCase() === 'WALI_SANTRI' &&
      String(row[6] || '').toUpperCase() === 'AKTIF' &&
      (String(row[11] || '').toUpperCase() === 'TRUE' || row[11] === true) && normalizeEmail_(row[10]) === email;
  });
  if (matches.length !== 1) return generic;

  const user = matches[0];
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const tokenKey = waliPasswordResetTokenKey_(token);
  const cachePayload = JSON.stringify({userId:String(user[0]),email:email});
  const serviceUrl = ScriptApp.getService().getUrl();
  if (!serviceUrl) return generic;
  cache.put(tokenKey, cachePayload, 1800);
  const resetUrl = serviceUrl + '?reset=' + encodeURIComponent(token);
  const body = 'Kami menerima permintaan reset password FMart. Buka tautan berikut dalam 30 menit untuk membuat password baru:\n\n' +
    resetUrl + '\n\nJika Anda tidak meminta reset password, abaikan email ini. Jangan bagikan tautan ini kepada siapa pun.';
  const htmlBody = '<p>Kami menerima permintaan reset password FMart.</p><p><a href="' +
    resetUrl + '">Buat password baru</a></p><p>Tautan berlaku 30 menit dan hanya dapat digunakan sekali. Jika Anda tidak meminta reset, abaikan email ini.</p>';
  try {
    MailApp.sendEmail({to:email,subject:'Reset password FMart',body:body,htmlBody:htmlBody});
    writeAudit_(String(user[0]),'WALI_SANTRI','REQUEST_PASSWORD_RESET','USER',String(user[0]),'',JSON.stringify({email:maskEmail_(email)}),'Permintaan tautan reset password');
  } catch (error) {
    cache.remove(tokenKey);
    console.warn('Pengiriman tautan reset password Wali gagal:', error);
  }
  return generic;
}

/** Mengganti password Wali dengan token email acak, berumur 30 menit dan sekali pakai. */
function resetWaliPassword(token, newPassword, confirmPassword) {
  token = String(token || '').trim();
  newPassword = String(newPassword || '');
  confirmPassword = String(confirmPassword || '');
  if (!token || token.length > 120) throw new Error('Tautan reset tidak valid atau sudah kedaluwarsa.');
  if (newPassword.length < FMART.PASSWORD_MIN_LENGTH) throw new Error('Password baru minimal ' + FMART.PASSWORD_MIN_LENGTH + ' karakter.');
  if (newPassword !== confirmPassword) throw new Error('Konfirmasi password baru tidak sama.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const cache = CacheService.getScriptCache();
    const key = waliPasswordResetTokenKey_(token);
    const payloadText = cache.get(key);
    if (!payloadText) throw new Error('Tautan reset tidak valid atau sudah kedaluwarsa.');
    let payload;
    try { payload = JSON.parse(payloadText); } catch (error) { cache.remove(key); throw new Error('Tautan reset tidak valid atau sudah kedaluwarsa.'); }
    const sheet = getSS_().getSheetByName('Users');
    const row = findRowById_(sheet, payload.userId, 1);
    if (!row || String(row.values[5] || '').toUpperCase() !== 'WALI_SANTRI' ||
        String(row.values[6] || '').toUpperCase() !== 'AKTIF' ||
        !(String(row.values[11] || '').toUpperCase() === 'TRUE' || row.values[11] === true) ||
        normalizeEmail_(row.values[10]) !== normalizeEmail_(payload.email)) {
      cache.remove(key);
      throw new Error('Tautan reset tidak valid atau sudah kedaluwarsa.');
    }
    const salt = Utilities.getUuid().replace(/-/g, '');
    const hash = hashPassword_(newPassword, salt);
    const now = new Date();
    sheet.getRange(row.rowNumber, 3, 1, 2).setValues([[hash,salt]]);
    sheet.getRange(row.rowNumber, 9).setValue(now);
    sheet.getRange(row.rowNumber, 12).setValue(true);
    SpreadsheetApp.flush();
    const saved = findRowById_(sheet, payload.userId, 1);
    if (!saved || String(saved.values[2] || '') !== hash || String(saved.values[3] || '') !== salt) {
      throw new Error('Password belum dapat disimpan. Silakan coba kembali.');
    }
    cache.remove(key);
    writeAudit_(String(payload.userId),'WALI_SANTRI','RESET_PASSWORD','USER',String(payload.userId),'',JSON.stringify({email:maskEmail_(payload.email)}),'Password direset melalui tautan email');
    return {ok:true,message:'Password berhasil diubah. Silakan login kembali.'};
  } finally {
    lock.releaseLock();
  }
}

function waliPasswordResetTokenKey_(token) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(token),Utilities.Charset.UTF_8);
  return 'FMART_WALI_RESET_TOKEN_' + Utilities.base64EncodeWebSafe(digest).slice(0,48);
}
function waliPasswordResetRateKey_(email) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,'WALI_RESET|' + normalizeEmail_(email),Utilities.Charset.UTF_8);
  return 'FMART_WALI_RESET_RATE_' + Utilities.base64EncodeWebSafe(digest).slice(0,42);
}


function logout(token) {
  if (token) {
    try { const s=requireSession_(token); writeAudit_(s.userId,s.role,'LOGOUT','USER',s.userId,'','', 'Logout'); } catch(e) {}
    CacheService.getScriptCache().remove(sessionKey_(token));
  }
  return {ok:true};
}

function changeMyPassword(token, currentPassword, newPassword, confirmPassword) {
  const session = requireSession_(token);
  currentPassword = String(currentPassword || '');
  newPassword = String(newPassword || '');
  confirmPassword = String(confirmPassword || '');
  if (!currentPassword || !newPassword || !confirmPassword) throw new Error('Semua kolom password wajib diisi.');
  if (newPassword.length < FMART.PASSWORD_MIN_LENGTH) throw new Error('Password baru minimal ' + FMART.PASSWORD_MIN_LENGTH + ' karakter.');
  if (newPassword !== confirmPassword) throw new Error('Konfirmasi password baru tidak sama.');
  if (currentPassword === newPassword) throw new Error('Password baru harus berbeda dari password lama.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSS_();
    const sheet = ss.getSheetByName('Users');
    const row = findRowById_(sheet, session.userId, 1);
    if (!row) throw new Error('Data akun tidak ditemukan.');
    if (String(row.values[6] || '').toUpperCase() !== 'AKTIF') throw new Error('Akun tidak aktif.');
    if (!verifyPassword_(currentPassword, String(row.values[3] || ''), String(row.values[2] || ''))) {
      throw new Error('Password lama tidak benar.');
    }

    const newSalt = Utilities.getUuid();
    const newHash = hashPassword_(newPassword, newSalt);
    const now = new Date();
    sheet.getRange(row.rowNumber, 3, 1, 2).setValues([[newHash, newSalt]]);
    sheet.getRange(row.rowNumber, 9).setValue(now);
    SpreadsheetApp.flush();

    const verify = findRowById_(sheet, session.userId, 1);
    if (!verify || String(verify.values[2] || '') !== newHash || String(verify.values[3] || '') !== newSalt) {
      throw new Error('Perubahan password tidak dapat diverifikasi. Sesi tetap perlu login ulang.');
    }
    session.authUpdatedAt = verify.values[8] instanceof Date ? verify.values[8].getTime() : (new Date(verify.values[8] || 0).getTime() || 0);
    CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(session), FMART.SESSION_TTL_SECONDS);
    writeAudit_(session.userId, session.role, 'CHANGE_PASSWORD', 'USER', session.userId, '', JSON.stringify({username:session.username}), 'Password berhasil diganti oleh pemilik akun');
    return {ok:true, message:'Password berhasil diganti.'};
  } finally {
    lock.releaseLock();
  }
}

function getSession(token, portalMode) {
  const s = requireSession_(token);
  portalMode = String(portalMode || 'BUYER') === 'ADMINFMART16720' ? 'ADMINFMART16720' : 'BUYER';
  assertPortalRole_(s.role, portalMode);
  return {ok:true,user:{userId:s.userId,username:s.username,nama:s.nama,role:s.role}};
}

/** Fase 1.1: profil akun dan daftar anak milik Wali Santri. */
function getMyProfile(token) {
  const session = requireSession_(token);
  const ss = getSS_();
  const users = ss.getSheetByName('Users');
  const row = findRowById_(users, session.userId, 1);
  if (!row) throw new Error('Data akun tidak ditemukan.');
  const r = row.values;
  const result = {
    userId: String(r[0] || ''),
    username: String(r[1] || ''),
    nama: String(r[4] || ''),
    role: String(r[5] || '').toUpperCase(),
    status: String(r[6] || '').toUpperCase()
  };
  if (session.role === FMART.ROLES.WALI_SANTRI) {
    const wali = findWaliByUserId_(ss, session.userId);
    result.wali = wali ? {waliId: wali.waliId, nama: wali.nama, noHp: wali.noHp, email: wali.email, alamat: wali.alamat} : null;
    result.children = getChildrenForWali_(ss, session.userId);
  } else {
    result.wali = null;
    result.children = [];
  }
  return {ok:true, profile:result};
}

/** Profil Wali dan status relasi santri. Identitas pengguna selalu berasal dari sesi. */
function getWaliProfileManagement(token){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]),ss=getSS_(),wali=findWaliByUserId_(ss,session.userId);
 if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');
 const sheet=ss.getSheetByName('Santri'),map=getSantriColumnMap_(sheet),byId={};
 readSantriRows_(sheet).forEach(r=>{const c=santriRecord_(r,map);byId[c.id]=c;});
 const relationships=readRows_(ss.getSheetByName('WaliSantriSantri')).filter(r=>String(r[1]||'')===String(wali.waliId)&&['AKTIF','ALAMAT_PESANAN','MENUNGGU_VERIFIKASI'].includes(String(r[3]||'').toUpperCase())).map(r=>{
  const c=byId[String(r[2]||'')];if(!c)return null;const status=String(r[3]||'').toUpperCase();
  return {relationId:String(r[0]||''),santriId:String(r[2]||''),name:c.name,className:c.className,asrama:c.asrama,nis:status==='AKTIF'?c.nis:maskNis_(c.nis),hubungan:String(r[5]||''),status:status,requestedAt:dateIso_(r[4]),active:['AKTIF','ALAMAT_PESANAN'].includes(status)&&c.status.toUpperCase()==='AKTIF'};
 }).filter(Boolean);
 const user=findRowById_(ss.getSheetByName('Users'),session.userId,1);
 return {ok:true,profile:{nama:wali.nama,noHp:wali.noHp,email:wali.email,alamat:wali.alamat,status:wali.status,username:user?String(user.values[1]||''):String(wali.noHp||'')},relationships:relationships,savedRecipients:relationships.filter(x=>x.active),pendingRelationships:relationships.filter(x=>x.status==='MENUNGGU_VERIFIKASI')};
}

/** Wali hanya dapat mengubah data kontak non-login miliknya sendiri. */
function updateMyWaliProfile(token,nama,email,alamat){
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);nama=String(nama||'').trim().slice(0,120);email=normalizeEmail_(email).slice(0,160);alamat=String(alamat||'').trim().slice(0,500);
  if(!nama)throw new Error('Nama wajib diisi.');if(email&&!isValidStaffEmail_(email))throw new Error('Format email tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),waliSheet=ss.getSheetByName('WaliSantri'),usersSheet=ss.getSheetByName('Users'),waliRows=readRows_(waliSheet);
    const index=waliRows.findIndex(r=>String(r[1]||'')===String(session.userId)&&String(r[6]||'').toUpperCase()==='AKTIF');
    if(index<0)throw new Error('Data Wali Santri tidak ditemukan atau tidak aktif.');
    const user=findRowById_(usersSheet,session.userId,1);if(!user||String(user.values[5]||'').toUpperCase()!=='WALI_SANTRI')throw new Error('Data akun pengguna tidak ditemukan.');
    const oldEmail=normalizeEmail_(user.values[10]);let verification=null;
    if(email!==oldEmail||normalizeEmail_(waliRows[index][4])!==email||!(String(user.values[11]||'').toUpperCase()==='TRUE'||user.values[11]===true)){if(!email)throw new Error('Email tidak boleh dikosongkan.');verification=sendWaliEmailVerification_(session.userId,email);}
    const rowNumber=index+2,before={nama:String(waliRows[index][2]||''),email:String(waliRows[index][4]||''),alamat:String(waliRows[index][5]||'')},now=new Date();
    waliSheet.getRange(rowNumber,3).setValue(nama);waliSheet.getRange(rowNumber,6).setValue(alamat);waliSheet.getRange(rowNumber,9).setValue(now);usersSheet.getRange(user.rowNumber,5).setValue(nama);
    writeAudit_(session.userId,session.role,'UPDATE_MY_WALI_PROFILE','WALI_SANTRI',String(waliRows[index][0]||''),JSON.stringify(before),JSON.stringify({nama:nama,email:email,alamat:alamat}),'Wali memperbarui profil pribadi');
    SpreadsheetApp.flush();return {ok:true,requiresEmailOtp:!!verification,challengeId:verification&&verification.challengeId,maskedEmail:verification&&verification.maskedEmail,message:verification?verification.message:'Profil berhasil diperbarui.',profile:{nama:nama,noHp:String(waliRows[index][3]||''),email:email,alamat:alamat,status:'AKTIF',username:String(user.values[1]||'')}};
  }finally{lock.releaseLock();}
}
function cancelMyWaliSantriRequest(token, relationId) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  relationId = String(relationId || '').trim();
  if (!relationId) throw new Error('Pengajuan tidak valid.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSS_();
    const wali = findWaliByUserId_(ss, session.userId);
    if (!wali) throw new Error('Data Wali Santri tidak ditemukan.');
    const sheet = ss.getSheetByName('WaliSantriSantri');
    const row = findRowById_(sheet, relationId, 1);
    if (!row || String(row.values[1] || '') !== String(wali.waliId)) throw new Error('Pengajuan tidak ditemukan.');
    if (String(row.values[3] || '').toUpperCase() !== 'MENUNGGU_VERIFIKASI') throw new Error('Hanya pengajuan yang masih menunggu verifikasi yang dapat dibatalkan.');
    sheet.getRange(row.rowNumber,4).setValue('NONAKTIF');
    writeAudit_(session.userId,session.role,'CANCEL_WALI_SANTRI_REQUEST','WALI_SANTRI_SANTRI',relationId,JSON.stringify({status:'MENUNGGU_VERIFIKASI'}),JSON.stringify({status:'NONAKTIF'}),'Wali membatalkan pengajuan hubungan santri');
    SpreadsheetApp.flush();
    return {ok:true,message:'Pengajuan berhasil dibatalkan.'};
  } finally {
    lock.releaseLock();
  }
}

/** Mengambil ulang daftar anak dari server. Tidak menerima UserId dari browser. */
function removeMyWaliSavedAddress(token,relationId){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);relationId=String(relationId||'').trim();if(!relationId)throw new Error('Alamat tidak valid.');
 const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{const ss=getSS_(),wali=findWaliByUserId_(ss,session.userId),sheet=ss.getSheetByName('WaliSantriSantri'),row=findRowById_(sheet,relationId,1);
  if(!wali||!row||String(row.values[1]||'')!==String(wali.waliId)||String(row.values[3]||'').toUpperCase()!=='ALAMAT_PESANAN')throw new Error('Alamat pemesanan tidak ditemukan.');
  sheet.getRange(row.rowNumber,4).setValue('NONAKTIF');writeAudit_(session.userId,session.role,'REMOVE_WALI_ORDER_RECIPIENT','WALI_SANTRI_SANTRI',relationId,JSON.stringify({status:'ALAMAT_PESANAN'}),JSON.stringify({status:'NONAKTIF'}),'Wali menghapus alamat pemesanan tersimpan');SpreadsheetApp.flush();return {ok:true,message:'Alamat pemesanan dihapus.'};
 }finally{lock.releaseLock();}
}
function getMyChildren(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  return {ok:true, children:getChildrenForWali_(getSS_(), session.userId)};
}

function findRowById_(sheet, id, idColumn) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const col = idColumn || 1;
  const values = sheet.getRange(2, 1, sheet.getLastRow()-1, sheet.getLastColumn()).getValues();
  for (let i=0; i<values.length; i++) {
    if (String(values[i][col-1]) === String(id)) return {rowNumber:i+2, values:values[i]};
  }
  return null;
}

function findWaliByUserId_(ss, userId) {
  const rows = readRows_(ss.getSheetByName('WaliSantri'));
  const r = rows.find(function(x){ return String(x[1]) === String(userId) && String(x[6]).toUpperCase() === 'AKTIF'; });
  if (!r) return null;
  return {waliId:String(r[0]), userId:String(r[1]), nama:String(r[2]||''), noHp:String(r[3]||''), email:String(r[4]||''), alamat:String(r[5]||'')};
}

function getInitialData(token) {
  const session = requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.GUDANG,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN]);
  const ss = getSS_();
  const result = {user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role},categories:[],products:[],children:[]};

  result.categories = readRows_(ss.getSheetByName('Kategori')).filter(function(r){return String(r[4]).toUpperCase()==='AKTIF';}).map(function(r){return {id:r[0],name:r[1],description:r[2],order:r[3]||0};});
  result.products = readRows_(ss.getSheetByName('Produk')).filter(function(r){return String(r[8]).toUpperCase()==='AKTIF';}).map(function(r){
    const product={id:r[0],categoryId:r[1],sku:r[2],name:r[3],description:r[4],price:Number(r[5])||0,photoUrl:r[7]||''};
    if(session.role!==FMART.ROLES.WALI_SANTRI) product.minStock=Number(r[6])||0;
    return product;
  });
  if (session.role === FMART.ROLES.WALI_SANTRI) result.children = getChildrenForWali_(ss, session.userId);
  return result;
}

function getChildrenForWali_(ss, userId) {
  const waliRows = readRows_(ss.getSheetByName('WaliSantri'));
  const wali = waliRows.find(function(r){return String(r[1])===String(userId) && String(r[6]).toUpperCase()==='AKTIF';});
  if (!wali) return [];
  const santriIds = readRows_(ss.getSheetByName('WaliSantriSantri')).filter(function(r){return String(r[1])===String(wali[0]) && String(r[3]).toUpperCase()==='AKTIF';}).map(function(r){return String(r[2]);});
  const santriSheet = ss.getSheetByName('Santri'), santriMap = getSantriColumnMap_(santriSheet);
  return readSantriRows_(santriSheet).map(function(r){return santriRecord_(r,santriMap);}).filter(function(r){return santriIds.indexOf(r.id)!==-1 && r.status.toUpperCase()==='AKTIF';});
}


/** Fase 2: katalog produk aktif. Harga/stok selalu dibaca dari server. */
function getProductDetail(token, productId) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.GUDANG,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN]);
  productId = String(productId || '').trim();
  if (!productId) throw new Error('Produk tidak valid.');
  const ss = getSS_();
  const productSheet = ss.getSheetByName('Produk');
  const categorySheet = ss.getSheetByName('Kategori');
  const row = findRowById_(productSheet, productId, 1);
  if (!row) throw new Error('Produk tidak ditemukan.');
  const r = row.values;
  if (String(r[8] || '').toUpperCase() !== 'AKTIF') throw new Error('Produk tidak tersedia.');
  const cat = findRowById_(categorySheet, String(r[1] || ''), 1);
  if (!cat || String(cat.values[4] || '').toUpperCase() !== 'AKTIF') throw new Error('Kategori produk tidak tersedia.');

  const reservedByKey=session.role===FMART.ROLES.WALI_SANTRI?getStockReservationMap_(ss,''):{};
  const variations = readRows_(ss.getSheetByName('VariasiProduk')).filter(function(v) {
    return String(v[1]) === productId && String(v[6] || '').toUpperCase() === 'AKTIF';
  }).map(function(v) {
    const vid=String(v[0]);return {id:vid, name:String(v[2] || ''), value:String(v[3] || ''), priceAddition:Number(v[4]) || 0, stock:0};
  });

  const stocks = readRows_(ss.getSheetByName('Stok')).filter(function(st) {
    return String(st[1]) === productId && (!st[2] || variations.some(function(v){return String(v.id)===String(st[2]);}));
  });
  const baseStockRows = stocks.filter(function(st){ return !st[2]; });
  const variationStock = {};
  stocks.forEach(function(st){ if(st[2]) variationStock[String(st[2])] = Number(st[3]) || 0; });
  variations.forEach(function(v){ if(Object.prototype.hasOwnProperty.call(variationStock,v.id)) v.stock=Math.max(0,variationStock[v.id]-(reservedByKey[productId+'|'+v.id]||0)); });
  const stock = variations.length ? variations.reduce(function(total,v){return total + Math.max(0,v.stock);},0) : (baseStockRows.length ? Math.max(0,(Number(baseStockRows[0][3])||0)-(reservedByKey[productId+'|']||0)) : 0);

  const productResult={
    id:String(r[0]), categoryId:String(r[1] || ''), categoryName:String(cat.values[1] || ''), sku:String(r[2] || ''),
    name:String(r[3] || ''), description:String(r[4] || ''), price:Number(r[5]) || 0, minStock:Number(r[6]) || 0,
    photoUrl:String(r[7] || ''), stock:Math.max(0,stock), variations:variations
  };
  if(session.role===FMART.ROLES.WALI_SANTRI){
    delete productResult.stock;
    delete productResult.minStock;
    productResult.variations=variations.map(function(v){return {id:v.id,name:v.name,value:v.value,priceAddition:v.priceAddition};});
  }
  return {ok:true,product:productResult};
}

function getCatalog(token) {
  const session = requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.GUDANG,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN]);
  const ss = getSS_();
  const categorySheet = ss.getSheetByName('Kategori');
  const productSheet = ss.getSheetByName('Produk');
  const stockSheet = ss.getSheetByName('Stok');
  const variationSheet = ss.getSheetByName('VariasiProduk');
  if (!categorySheet || !productSheet || !stockSheet || !variationSheet) {
    throw new Error('Database katalog FMart belum lengkap. Jalankan setupFMartDatabase_().');
  }

  // Baca masing-masing sheet satu kali. Hindari filter VariasiProduk berulang
  // untuk setiap produk karena dapat sangat lambat pada HP/Spreadsheet besar.
  const categoryRows = readRows_(categorySheet);
  const categories = categoryRows.filter(function(r){
    return String(r[4] || '').toUpperCase() === 'AKTIF';
  }).map(function(r){
    return {id:String(r[0]),name:String(r[1]||''),description:String(r[2]||''),order:Number(r[3])||0};
  });
  const activeCategoryIds = {};
  categories.forEach(function(c){ activeCategoryIds[c.id] = true; });

  if (session.role === FMART.ROLES.WALI_SANTRI) {
    const productCountsByCategory = {};
    let totalProducts = 0;
    readRows_(productSheet).forEach(function(r) {
      const categoryId = String(r[1] || '');
      if (String(r[8] || '').toUpperCase() !== 'AKTIF' || !activeCategoryIds[categoryId]) return;
      totalProducts++;
      productCountsByCategory[categoryId] = (productCountsByCategory[categoryId] || 0) + 1;
    });
    return {
      ok:true,
      user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role},
      categories:categories,
      products:[],
      productCountsByCategory:productCountsByCategory,
      totalProducts:totalProducts,
      children:getChildrenForWali_(ss,session.userId)
    };
  }

  const reservedByKey={};
  const products = readRows_(productSheet).filter(function(r){
    return String(r[8] || '').toUpperCase() === 'AKTIF' && activeCategoryIds[String(r[1] || '')];
  }).map(function(r){
    return {id:String(r[0]),categoryId:String(r[1]),sku:String(r[2]||''),name:String(r[3]||''),description:String(r[4]||''),price:Number(r[5])||0,minStock:Number(r[6])||0,photoUrl:String(r[7]||''),stock:0};
  });

  const productIds = {};
  products.forEach(function(p){ productIds[p.id] = true; });

  const stockByKey = {};
  readRows_(stockSheet).forEach(function(r){
    const pid = String(r[1] || '');
    if (!pid || !productIds[pid]) return;
    const vid = String(r[2] || '');
    stockByKey[pid + '|' + vid] = Math.max(0, Number(r[3]) || 0);
  });

  const variationRows = readRows_(variationSheet);
  const variationsByProduct = {};
  variationRows.forEach(function(r){
    if (String(r[6] || '').toUpperCase() !== 'AKTIF') return;
    const pid = String(r[1] || '');
    if (!productIds[pid]) return;
    if (!variationsByProduct[pid]) variationsByProduct[pid] = [];
    const vid = String(r[0]);
    const key = pid + '|' + vid;
    variationsByProduct[pid].push({
      id:vid,
      name:String(r[2] || ''),
      value:String(r[3] || ''),
      priceAddition:Number(r[4]) || 0,
      stock:Math.max(0,(Object.prototype.hasOwnProperty.call(stockByKey,key) ? stockByKey[key] : 0)-(reservedByKey[key]||0))
    });
  });

  products.forEach(function(p){
    const vars = variationsByProduct[p.id] || [];
    if (vars.length) {
      p.stock = vars.reduce(function(sum,v){ return sum + Math.max(0,v.stock); }, 0);
    } else {
      p.stock = Math.max(0,(Object.prototype.hasOwnProperty.call(stockByKey,p.id+'|') ? stockByKey[p.id+'|'] : 0)-(reservedByKey[p.id+'|']||0));
    }
  });

  // Wali hanya menerima katalog publik; jumlah stok dan ambang stok hanya untuk petugas.
  if (session.role === FMART.ROLES.WALI_SANTRI) {
    products.forEach(function(p){
      delete p.stock; delete p.minStock;
      p.variations = (variationsByProduct[p.id] || []).map(function(v){return {id:v.id,priceAddition:v.priceAddition};});
    });
  } else {
    products.forEach(function(p){p.variations=variationsByProduct[p.id]||[];});
  }
  // Daftar anak hanya untuk Wali Santri; akses tetap ditentukan server dari session.
  const children = session.role === FMART.ROLES.WALI_SANTRI ? getChildrenForWali_(ss, session.userId) : [];
  return {
    ok:true,
    user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role},
    categories:categories,
    products:products,
    children:children
  };
}

/**
 * Katalog Wali dengan pagination server-side. Filter, urutan, dan offset
 * diproses terhadap seluruh produk aktif sebelum batch dikirim ke browser.
 * Data stok tidak pernah dikirim ke akun Wali.
 */
function getBuyerProductBatch(token, options) {
  requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  options = options && typeof options === 'object' ? options : {};
  const offset = Math.max(0,Math.min(100000,Math.floor(Number(options.offset)||0)));
  const limit = Math.max(4,Math.min(24,Math.floor(Number(options.limit)||12)));
  const query = String(options.query||'').trim().toLowerCase().slice(0,100);
  const categoryId = String(options.categoryId||'').trim().slice(0,120);
  const sort = ['featured','name-asc','price-asc','price-desc'].indexOf(String(options.sort||'featured'))>=0 ? String(options.sort||'featured') : 'featured';
  const ss = getSS_(), categories = readRows_(ss.getSheetByName('Kategori'));
  const activeCategories = Object.create(null);
  categories.forEach(function(r){if(String(r[4]||'').toUpperCase()==='AKTIF')activeCategories[String(r[0])]=true;});
  if(categoryId&&!activeCategories[categoryId])throw new Error('Kategori produk tidak tersedia.');
  const all = readRows_(ss.getSheetByName('Produk')).filter(function(r){
    if(String(r[8]||'').toUpperCase()!=='AKTIF'||!activeCategories[String(r[1]||'')])return false;
    if(categoryId&&String(r[1]||'')!==categoryId)return false;
    return !query || (String(r[3]||'')+' '+String(r[4]||'')).toLowerCase().indexOf(query)>=0;
  });
  if(sort==='name-asc')all.sort(function(a,b){return String(a[3]||'').localeCompare(String(b[3]||''),'id');});
  else if(sort==='price-asc')all.sort(function(a,b){return (Number(a[5])||0)-(Number(b[5])||0)||String(a[3]||'').localeCompare(String(b[3]||''),'id');});
  else if(sort==='price-desc')all.sort(function(a,b){return (Number(b[5])||0)-(Number(a[5])||0)||String(a[3]||'').localeCompare(String(b[3]||''),'id');});
  const page = all.slice(offset,offset+limit);
  const pageIds = Object.create(null);
  page.forEach(function(r){pageIds[String(r[0])]=true;});
  const variationsByProduct = Object.create(null);
  readRows_(ss.getSheetByName('VariasiProduk')).forEach(function(r){
    const pid=String(r[1]||'');
    if(!pageIds[pid]||String(r[6]||'').toUpperCase()!=='AKTIF')return;
    if(!variationsByProduct[pid])variationsByProduct[pid]=[];
    variationsByProduct[pid].push({id:String(r[0]),priceAddition:Number(r[4])||0});
  });
  const items=page.map(function(r){
    const id=String(r[0]);
    return {id:id,categoryId:String(r[1]||''),sku:String(r[2]||''),name:String(r[3]||''),description:String(r[4]||''),price:Number(r[5])||0,photoUrl:String(r[7]||''),variations:variationsByProduct[id]||[]};
  });
  return {ok:true,items:items,offset:offset,limit:limit,total:all.length,hasMore:offset+items.length<all.length};
}

/** Tahap Wali: keranjang umum per akun. Santri dipilih saat checkout. */
function getCart(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const rows = readRows_(ss.getSheetByName('Keranjang'));
  const reservedByKey=getStockReservationMap_(ss,'');
  const items = [];
  let subtotal = 0;
  rows.forEach(function(r) {
    if (String(r[1]) !== String(session.userId)) return;
    const qty = Math.max(0, Math.floor(Number(r[5]) || 0));
    if (!qty) return;
    const snap = getProductSnapshot_(ss, r[3], r[4]);
    const reservationKey=String(r[3])+'|'+String(r[4]||'');
    const available = snap ? Math.max(0, snap.stock-(reservedByKey[reservationKey]||0)) : 0;
    const lineSubtotal = snap ? snap.unitPrice * qty : 0;
    subtotal += lineSubtotal;
    items.push({
      cartId:String(r[0]), productId:String(r[3]), variationId:String(r[4] || ''),
      name:snap ? snap.name : 'Produk tidak tersedia',
      variationName:snap ? snap.variationName : '', sku:snap ? snap.sku : '',
      photoUrl:snap ? snap.photoUrl : '', unitPrice:snap ? snap.unitPrice : 0,
      qty:qty, subtotal:lineSubtotal,
      available:snap ? snap.active : false
    });
  });
  return {ok:true,items:items,subtotal:subtotal,total:subtotal,
    canCheckout:items.length>0 && items.every(function(i){return i.available;})};
}

function addToCart(token, productId, variationId, qty) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  productId = String(productId || '').trim();
  variationId = String(variationId || '').trim();
  qty = Math.floor(Number(qty));
  if (!productId || !Number.isFinite(qty) || qty < 1) throw new Error('Data keranjang tidak valid.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSS_();
    const snap = getProductSnapshot_(ss, productId, variationId);
    if (!snap || !snap.active) throw new Error('Produk tidak tersedia.');
    const sheet = ss.getSheetByName('Keranjang');
    const rows = readRows_(sheet);
    const matchingRows = [];
    let currentQty = 0;
    for (let i=0;i<rows.length;i++) {
      const r = rows[i];
      if (String(r[1]) === session.userId && String(r[3]) === productId && String(r[4] || '') === variationId) {
        matchingRows.push(i + 2);
        currentQty += Math.max(0,Math.floor(Number(r[5]) || 0));
      }
    }
    const nextQty = currentQty + qty;
    if (!Number.isSafeInteger(nextQty) || nextQty > 10000) throw new Error('Jumlah pesanan maksimal 10.000 unit per produk.');
    const now = new Date();
    if (matchingRows.length) {
      const keepRow = matchingRows[0];
      sheet.getRange(keepRow, 3).clearContent();
      sheet.getRange(keepRow, 6, 1, 2).setValues([[nextQty, now]]);
      sheet.getRange(keepRow, 8).setValue(now);
      matchingRows.slice(1).sort(function(a,b){return b-a;}).forEach(function(rowNumber){sheet.deleteRow(rowNumber);});
    } else {
      sheet.appendRow([makeFMartId_('CRT'),session.userId,'',productId,variationId,nextQty,now,now]);
    }
    return getCart(token);
  } finally { lock.releaseLock(); }
}

function updateCartItem(token, cartId, qty) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  cartId = String(cartId || '').trim();
  qty = Math.floor(Number(qty));
  if (!cartId || !Number.isFinite(qty) || qty < 0) throw new Error('Data keranjang tidak valid.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const ss = getSS_();
    const sheet = ss.getSheetByName('Keranjang');
    const row = findRowById_(sheet, cartId, 1);
    if (!row || String(row.values[1]) !== session.userId) throw new Error('Item keranjang tidak ditemukan.');
    if (qty === 0) {
      sheet.deleteRow(row.rowNumber);
    } else {
      const snap = getProductSnapshot_(ss, row.values[3], row.values[4]);
      if (!snap || !snap.active) throw new Error('Produk sudah tidak tersedia.');
      if (qty > 10000) throw new Error('Jumlah pesanan maksimal 10.000 unit per produk.');
      
      sheet.getRange(row.rowNumber, 3).clearContent();
      sheet.getRange(row.rowNumber, 6, 1, 2).setValues([[qty,new Date()]]);
    }
    return getCart(token);
  } finally { lock.releaseLock(); }
}

function removeCartItem(token, cartId) { requireRole_(token,[FMART.ROLES.WALI_SANTRI]); return updateCartItem(token, cartId, 0); }


/** Hash deterministik untuk fingerprint payload transaksi dan bukti file. */
function sha256Hex_(value){const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value),Utilities.Charset.UTF_8);return digest.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
/** Memastikan MIME yang diklaim sesuai signature byte file. */
function validateUploadedFileSignature_(bytes,mimeType){
 const b=(bytes||[]).map(function(v){return v<0?v+256:v;}),mime=String(mimeType||'').toLowerCase();
 const starts=function(sig){return sig.every(function(v,i){return b[i]===v;});};let ok=false;
 if(mime==='image/jpeg')ok=b.length>=3&&starts([0xff,0xd8,0xff]);
 else if(mime==='image/png')ok=b.length>=8&&starts([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
 else if(mime==='image/webp')ok=b.length>=12&&starts([0x52,0x49,0x46,0x46])&&b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50;
 else if(mime==='image/gif')ok=b.length>=6&&(starts([0x47,0x49,0x46,0x38,0x37,0x61])||starts([0x47,0x49,0x46,0x38,0x39,0x61]));
 else if(mime==='application/pdf')ok=b.length>=5&&starts([0x25,0x50,0x44,0x46,0x2d]);
 if(!ok)throw new Error('Isi file tidak sesuai dengan format yang dipilih. Pilih ulang bukti yang valid.');return true;
}
/** Memakai kembali file Drive dari eksekusi sebelumnya yang terhenti. */
function getOrCreateTransactionProofFile_(folder,name,mime,bytes,marker){
 const it=folder.getFilesByName(name);while(it.hasNext()){const f=it.next();if(String(f.getDescription()||'')===String(marker))return f;}
 const file=folder.createFile(Utilities.newBlob(bytes,mime,name));file.setDescription(String(marker));return file;
}

function getHeaderColumnIndex_(sheet,header){
 if(!sheet)throw new Error('Sheet untuk kolom '+header+' tidak tersedia.');
 const width=Math.max(1,sheet.getLastColumn()),headers=sheet.getRange(1,1,1,width).getDisplayValues()[0].map(function(v){return String(v||'').trim();}),matches=[];
 headers.forEach(function(value,index){if(value===String(header))matches.push(index+1);});
 if(matches.length!==1)throw new Error('Header '+header+' pada sheet '+sheet.getName()+' '+(matches.length?'terduplikasi':'belum tersedia')+'. Jalankan audit skema sebelum melanjutkan.');
 return matches[0];
}
function ensureFMartCostingSchema_(ss){
 const defs=[
  {name:'Produk',base:FMART_DB.SHEETS.PRODUK.slice(0,11),fields:[['HargaPokokRataRata',12]]},
  {name:'VariasiProduk',base:FMART_DB.SHEETS.VARIASI_PRODUK.slice(0,9),fields:[['HargaPokokRataRata',10]]},
  {name:'MutasiStok',base:FMART_DB.SHEETS.MUTASI_STOK.slice(0,11),fields:[['BiayaPerUnit',12],['HPPSebelum',13],['HPPSesudah',14]]},
  {name:'DetailPenerimaanBarang',base:FMART_DB.SHEETS.DETAIL_PENERIMAAN_BARANG.slice(0,8),fields:[['BiayaPerUnit',9],['TotalBiaya',10]]},
  {name:'DetailPesanan',base:FMART_DB.SHEETS.DETAIL_PESANAN.slice(0,10),fields:[['HPPUnit',11],['HPPSubtotal',12],['HPPStatus',13]]},
  {name:'DetailPenjualanToko',base:FMART_DB.SHEETS.DETAIL_PENJUALAN_TOKO.slice(0,10),fields:[['HPPUnit',11],['HPPSubtotal',12],['HPPStatus',13]]}
 ];
 defs.forEach(function(def){
  const sh=ss.getSheetByName(def.name);if(!sh)throw new Error('Sheet '+def.name+' belum tersedia. Jalankan setupFMartDatabase_().');
  const baseActual=sh.getRange(1,1,1,def.base.length).getDisplayValues()[0].map(function(v){return String(v||'').trim();});
  def.base.forEach(function(header,index){if(baseActual[index]!==header)throw new Error('Header dasar '+def.name+' kolom '+(index+1)+' tidak sesuai skema. Migrasi HPP dihentikan tanpa mengubah data.');});
  def.fields.forEach(function(field){
   const header=field[0],column=field[1],width=Math.max(1,sh.getLastColumn()),headers=sh.getRange(1,1,1,width).getDisplayValues()[0].map(function(v){return String(v||'').trim();}),matches=[];
   headers.forEach(function(value,index){if(value===header)matches.push(index+1);});
   if(matches.length>1)throw new Error('Header '+header+' terduplikasi pada '+def.name+'. Migrasi dihentikan tanpa mengubah data.');
   if(matches.length===1){if(matches[0]!==column)throw new Error('Posisi kolom '+header+' pada '+def.name+' tidak sesuai skema FMart (seharusnya kolom '+column+'). Migrasi dihentikan agar data lain tidak tertimpa.');return;}
   if(sh.getLastColumn()>=column||String(headers[column-1]||'').trim())throw new Error('Kolom '+def.name+' memiliki struktur tambahan/tidak dikenal sebelum '+header+'. Migrasi otomatis dihentikan; periksa backup dan skema sheet terlebih dahulu.');
   if(sh.getMaxColumns()<column)sh.insertColumnsAfter(sh.getMaxColumns(),column-sh.getMaxColumns());
   sh.getRange(1,column).setValue(header);
  });
 });
}
function migrateFMartCostingSchema_(){const lock=LockService.getScriptLock();lock.waitLock(10000);try{const ss=getSS_();ensureFMartCostingSchema_(ss);SpreadsheetApp.flush();return 'Kolom HPP dan biaya perolehan FMart siap. Data transaksi lama tidak diubah.';}finally{lock.releaseLock();}}
function getItemHpp_(ss,pid,vid){const name=vid?'VariasiProduk':'Produk',row=findRowById_(ss.getSheetByName(name),vid||pid,1);if(!row)return 0;const sh=ss.getSheetByName(name),h=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0],c=h.indexOf('HargaPokokRataRata');return c<0?0:Math.max(0,Math.round(Number(row.values[c])||0));}
function setItemHpp_(ss,pid,vid,value){const name=vid?'VariasiProduk':'Produk',row=findRowById_(ss.getSheetByName(name),vid||pid,1);if(!row)throw new Error('Master produk/variasi tidak ditemukan saat menyimpan HPP.');const sh=ss.getSheetByName(name),h=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0],c=h.indexOf('HargaPokokRataRata');if(c<0)throw new Error('Kolom HPP belum tersedia. Jalankan migrasi skema HPP.');sh.getRange(row.rowNumber,c+1).setValue(Math.max(0,Math.round(Number(value)||0)));}
function getTotalItemStock_(ss,pid,vid){let total=0;['Stok','StokKasir'].forEach(function(name){const sh=ss.getSheetByName(name);if(!sh)return;const m=readRows_(sh).filter(function(r){return String(r[1])===String(pid)&&String(r[2]||'')===String(vid||'');});if(m.length>1)throw new Error('Saldo stok ganda pada '+name+' untuk produk '+pid+'.');if(m.length){const q=Number(m[0][3]);if(!Number.isSafeInteger(q)||q<0)throw new Error('Saldo stok tidak valid pada '+name+'.');total+=q;}});return total;}
function assertHppChangeAllowed_(currentHpp,nextHpp,totalStock,itemLabel){currentHpp=Number(currentHpp)||0;nextHpp=Number(nextHpp)||0;totalStock=Number(totalStock)||0;if(!Number.isSafeInteger(currentHpp)||currentHpp<0||!Number.isSafeInteger(nextHpp)||nextHpp<0||!Number.isSafeInteger(totalStock)||totalStock<0)throw new Error('Nilai HPP atau saldo stok tidak valid.');if(totalStock>0&&currentHpp>0&&nextHpp!==currentHpp)throw new Error('HPP '+(itemLabel||'produk')+' sudah menjadi dasar nilai persediaan. Perubahan ditolak selama stok masih tersedia; lakukan rekonsiliasi dan habiskan saldo stok terlebih dahulu.');return true;}
function weightedAverageHpp_(beforeQty,beforeHpp,incomingQty,incomingTotalCost){beforeQty=Number(beforeQty)||0;beforeHpp=Number(beforeHpp)||0;incomingQty=Number(incomingQty)||0;incomingTotalCost=Number(incomingTotalCost)||0;if(!Number.isSafeInteger(beforeQty)||beforeQty<0||!Number.isSafeInteger(incomingQty)||incomingQty<1||!Number.isSafeInteger(incomingTotalCost)||incomingTotalCost<1)throw new Error('Data perhitungan biaya persediaan tidak valid.');if(beforeQty>0&&beforeHpp<=0)throw new Error('HPP stok lama belum dicatat. Isi Harga Pokok Rata-rata pada master produk/variasi sebelum menambah stok.');return Math.round((beforeQty*beforeHpp+incomingTotalCost)/(beforeQty+incomingQty));}
function applyHppTransition_(ss,pid,vid,beforeHpp,afterHpp){if(afterHpp===null||afterHpp===undefined||!Number.isFinite(Number(afterHpp)))return;const live=getItemHpp_(ss,pid,vid),before=Math.max(0,Math.round(Number(beforeHpp)||0)),after=Math.max(0,Math.round(Number(afterHpp)||0));if(live===before)setItemHpp_(ss,pid,vid,after);else if(live!==after)throw new Error('HPP berubah sejak jurnal dibuat. Pemulihan dihentikan agar nilai persediaan tidak dihitung ganda.');}
function captureSaleDetailHpp_(ss,sheetName,transactionId,pid,vid){
 const sh=ss.getSheetByName(sheetName),rows=readRows_(sh),matches=[];
 rows.forEach(function(r,i){if(String(r[1])===String(transactionId)&&String(r[2])===String(pid)&&String(r[3]||'')===String(vid||''))matches.push({row:r,rowNumber:i+2});});
 if(!matches.length)throw new Error('Detail penjualan tidak ditemukan saat menyimpan snapshot HPP.');
 const hpp=getItemHpp_(ss,pid,vid),headers=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0],u=headers.indexOf('HPPUnit')+1,v=headers.indexOf('HPPSubtotal')+1,s=headers.indexOf('HPPStatus')+1;
 if(!u||!v||!s)throw new Error('Kolom snapshot HPP belum tersedia.');
 matches.forEach(function(d){if(String(d.row[s-1]||'')==='TERCATAT')return;const qty=Math.max(0,Number(d.row[8])||0);if(hpp>0)sh.getRange(d.rowNumber,u,1,3).setValues([[hpp,hpp*qty,'TERCATAT']]);else sh.getRange(d.rowNumber,u,1,3).setValues([['','','BELUM_DICATAT']]);});
}

/** Menyelesaikan detail, pengiriman, dan keranjang checkout; aman dipanggil ulang. */
function completeCheckoutOrder_(ss,order,payload,actor,actorRole){
 const id=String(order.values[0]),detailSheet=ss.getSheetByName('DetailPesanan'),details=readRows_(detailSheet),byId=Object.create(null);
 details.forEach(function(r){byId[String(r[0]||'')]=r;});
 payload.items.forEach(function(x){const old=byId[String(x.detailId)];if(old){if(String(old[1])!==id||String(old[2])!==String(x.productId)||String(old[3]||'')!==String(x.variationId||'')||Number(old[8])!==Number(x.qty)||Number(old[7])!==Number(x.unitPrice))throw new Error('Detail checkout tidak konsisten untuk pesanan '+id+'.');return;}detailSheet.appendRow([x.detailId,id,x.productId,x.variationId,x.sku,x.name,x.variationName,x.unitPrice,x.qty,x.unitPrice*x.qty]);});
 const shipSheet=ss.getSheetByName('Pengiriman'),ships=readRows_(shipSheet),ship=ships.find(function(r){return String(r[0]||'')===String(payload.shipmentId);});
 if(ship){if(String(ship[1])!==id||String(ship[2]).toUpperCase()!==String(payload.shippingMethod).toUpperCase())throw new Error('Identitas pengiriman checkout tidak konsisten.');}
 else{const prior=ships.find(function(r){return String(r[1]||'')===id;});if(prior){if(String(prior[2]).toUpperCase()!==String(payload.shippingMethod).toUpperCase()||String(prior[3]||'')!==String(payload.shippingDestination||''))throw new Error('Pengiriman pesanan memiliki tujuan berbeda.');}else shipSheet.appendRow([payload.shipmentId,id,payload.shippingMethod,payload.shippingDestination,'MENUNGGU','','',String(actor||''),new Date(payload.createdAt)]);}
 const cart=ss.getSheetByName('Keranjang'),rows=readRows_(cart),selected=Object.create(null),deletes=[];
 (payload.selectedCartIds||[]).forEach(function(x){selected[String(x)]=true;});
 rows.forEach(function(r,i){if(String(r[1])===String(payload.userId)&&selected[String(r[0])])deletes.push(i+2);});
 deletes.sort(function(a,b){return b-a;}).forEach(function(n){cart.deleteRow(n);});
 const audit=readRows_(ss.getSheetByName('AuditLog'));
 if(!audit.some(function(r){return String(r[3]).toUpperCase()==='CREATE_ORDER'&&String(r[4]).toUpperCase()==='PESANAN'&&String(r[5])===id;}))
  writeAudit_(actor||payload.userId,actorRole||'WALI_SANTRI','CREATE_ORDER','PESANAN',id,'',JSON.stringify({number:payload.orderNumber,santriId:payload.santriId,total:payload.total,itemCount:payload.items.length,shippingMethod:payload.shippingMethod}),'Checkout membuat pesanan dari item terpilih');
 SpreadsheetApp.flush();return {ok:true,orderId:id,nomorPesanan:String(order.values[1]),total:Number(order.values[7])||0,status:String(order.values[8]),itemCount:payload.items.length};
}
/** Menyelesaikan penerimaan tanpa menambah stok atau mutasi dua kali. */
function completeStockReceipt_(ss,receipt,payload,actor,actorRole){
 const receiptId=String(receipt.values[0]),stock=ss.getSheetByName('Stok'),vars=ss.getSheetByName('VariasiProduk');
 const detailSheet=ss.getSheetByName('DetailPenerimaanBarang'),mutationSheet=ss.getSheetByName('MutasiStok');
 const detailRows=readRows_(detailSheet),mutationRows=readRows_(mutationSheet);
 payload.items.forEach(function(x){
  const key=String(x.productId)+'|'+String(x.variationId||''),matches=[];
  readRows_(stock).forEach(function(r,i){if(String(r[1])===String(x.productId)&&String(r[2]||'')===String(x.variationId||''))matches.push({row:r,rowNumber:i+2});});
  if(matches.length>1)throw new Error('Baris stok ganda; pemulihan penerimaan dihentikan untuk '+key+'.');
  if(matches.length){
   const live=Number(matches[0].row[3]);
   if(live===Number(x.before)){stock.getRange(matches[0].rowNumber,4).setValue(x.after);stock.getRange(matches[0].rowNumber,6).setValue(new Date());}
   else if(live!==Number(x.after))throw new Error('Saldo stok berubah dari nilai sebelum/sesudah penerimaan; pemulihan dihentikan untuk '+key+'.');
  }else{if(x.stockRowExisted)throw new Error('Baris stok yang sebelumnya ada kini hilang. Pemulihan dihentikan untuk '+key+'.');stock.appendRow([x.stockId,x.productId,x.variationId,x.after,x.productMin,new Date()]);}
  if(x.variationId){const v=findRowById_(vars,String(x.variationId),1);if(!v)throw new Error('Variasi tidak ditemukan saat pemulihan penerimaan.');const mirror=Number(v.values[5]);if(mirror===Number(x.before))vars.getRange(v.rowNumber,6,1,3).setValues([[x.after,String(v.values[6]||'AKTIF'),new Date()]]);else if(mirror!==Number(x.after))throw new Error('Saldo mirror variasi berubah; pemulihan dihentikan untuk '+key+'.');}
  if(Number(x.unitCost)>0)applyHppTransition_(ss,x.productId,x.variationId,x.beforeHpp,x.afterHpp);
   const d=detailRows.find(function(r){return String(r[0])===String(x.detailId);});
  if(d){if(String(d[1])!==receiptId||String(d[2])!==String(x.productId)||String(d[3]||'')!==String(x.variationId||'')||Number(d[4])!==Number(x.qty))throw new Error('Detail penerimaan tidak cocok; pemulihan dihentikan.');if(Number(x.unitCost)>0)detailSheet.getRange(detailRows.indexOf(d)+2,9,1,2).setValues([[x.unitCost,x.totalCost]]);}
  else detailSheet.appendRow([x.detailId,receiptId,x.productId,x.variationId,x.qty,x.before,x.after,payload.note||'',x.unitCost||'',x.totalCost||'']);
  const m=mutationRows.find(function(r){return String(r[0])===String(x.mutationId);});
  if(m){if(String(m[7])!==receiptId||String(m[1])!==String(x.productId)||Number(m[4])!==Number(x.qty)||Number(m[5])!==Number(x.before)||Number(m[6])!==Number(x.after))throw new Error('Mutasi penerimaan tidak cocok; pemulihan dihentikan.');}
  else mutationSheet.appendRow([x.mutationId,x.productId,x.variationId,'MASUK',x.qty,x.before,x.after,receiptId,'Penerimaan '+payload.receiptNumber+(payload.note?' · '+payload.note:''),String(actor||'SYSTEM'),new Date(),x.unitCost||'',x.beforeHpp||0,x.afterHpp||'']);
 });
 const audit=readRows_(ss.getSheetByName('AuditLog'));
 if(!audit.some(function(r){return String(r[3]).toUpperCase()==='CREATE_STOCK_RECEIPT'&&String(r[4]).toUpperCase()==='PENERIMAAN_BARANG'&&String(r[5])===receiptId;}))
  writeAudit_(actor||payload.createdBy,actorRole||'GUDANG','CREATE_STOCK_RECEIPT','PENERIMAAN_BARANG',receiptId,'',JSON.stringify({receiptNumber:payload.receiptNumber,supplier:payload.supplier,reference:payload.reference,items:payload.items}),'Mencatat penerimaan barang');
 SpreadsheetApp.flush();return {ok:true,id:receiptId,number:payload.receiptNumber,totalLines:payload.items.length,totalQty:payload.items.reduce(function(n,x){return n+Number(x.qty);},0)};
}

/** Satu checkout menghasilkan satu pesanan untuk satu snapshot penerima dan hanya item terpilih. */
function checkoutCart(token,recipientData,selectedCartIds,catatan,metodePengiriman,tujuan,requestKey){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);recipientData=recipientData&&typeof recipientData==='object'?recipientData:{};
 const santriId=String(recipientData.santriId||'').trim();if(!santriId)throw new Error('Pilih Santri dari alamat pemesanan tersimpan.');
 const child=assertWaliSavedRecipient_(getSS_(),session.userId,santriId),extra=String(recipientData.address||'').trim().slice(0,300);
 const recipient={santriId:santriId,name:String(child.name||''),className:String(child.className||''),asrama:String(child.asrama||''),phone:'',address:[child.className?'Kelas '+child.className:'',child.asrama?'Asrama '+child.asrama:'',extra].filter(Boolean).join(' · ')};
 selectedCartIds=Array.isArray(selectedCartIds)?Array.from(new Set(selectedCartIds.map(x=>String(x||'').trim()).filter(Boolean))):[];
 catatan=String(catatan||'').trim().slice(0,500);metodePengiriman=String(metodePengiriman||'AMBIL_FMART').trim().toUpperCase();tujuan=String(tujuan||'').trim().slice(0,500);requestKey=String(requestKey||'').trim();
 if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci checkout tidak valid. Muat ulang checkout dan coba kembali.');
 if(!selectedCartIds.length)throw new Error('Pilih minimal satu barang untuk checkout.');
 if(!['AMBIL_FMART','ANTAR_PESANTREN'].includes(metodePengiriman))throw new Error('Metode pengiriman tidak valid.');
 if(metodePengiriman==='ANTAR_PESANTREN'&&!recipient.address&&!tujuan)throw new Error('Lokasi Santri belum tersedia. Tambahkan catatan titik penerimaan.');
 const fingerprint=sha256Hex_(JSON.stringify({userId:session.userId,recipient:recipient,selectedCartIds:selectedCartIds.slice().sort(),note:catatan,shippingMethod:metodePengiriman,requestedDestination:tujuan}));
 const lock=LockService.getScriptLock();lock.waitLock(15000);
 try{
  const ss=getSS_(),sheet=ss.getSheetByName('Pesanan'),rows=readRows_(sheet),prior=rows.map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[12]||'')===requestKey);
  if(prior){if(String(prior.values[2])!==String(session.userId))throw new Error('Kunci checkout sudah digunakan transaksi lain.');if(String(prior.values[13]||'')!==fingerprint)throw new Error('Kunci checkout pernah dipakai untuk rincian berbeda. Muat ulang keranjang.');let payload;try{payload=JSON.parse(String(prior.values[14]||'{}'));}catch(e){throw new Error('Payload pemulihan checkout tidak dapat dibaca. Hubungi Admin FMart.');}const result=completeCheckoutOrder_(ss,prior,payload,session.userId,session.role);result.child=payload.recipientSnapshot||recipient;result.recovered=true;return result;}
  expireStockReservations_(ss,new Date());const cart=ss.getSheetByName('Keranjang'),cartRows=readRows_(cart),wanted=Object.create(null),selected=[];selectedCartIds.forEach(x=>wanted[x]=true);cartRows.forEach(r=>{if(String(r[1])===session.userId&&wanted[String(r[0])])selected.push(r);});
  if(selected.length!==selectedCartIds.length)throw new Error('Sebagian barang keranjang tidak ditemukan. Muat ulang keranjang.');
  const items=selected.map(r=>{const qty=Math.max(0,Math.floor(Number(r[5])||0)),p=getProductSnapshot_(ss,r[3],r[4]);return {productId:String(r[3]),variationId:String(r[4]||''),qty:qty,active:!!(p&&p.active),unitPrice:p?p.unitPrice:0,sku:p?p.sku:'',name:p?p.name:'Produk tidak tersedia',variationName:p?p.variationName:''};});
  const invalid=items.find(x=>!x.active||x.qty<1);if(!items.length||invalid)throw new Error(invalid?'Produk "'+invalid.name+'" tidak tersedia. Silakan periksa keranjang.':'Barang yang dipilih tidak ditemukan di keranjang.');
  const subtotal=items.reduce((n,x)=>n+x.unitPrice*x.qty,0),ongkir=0,diskon=0,total=subtotal+ongkir-diskon,now=new Date(),id=makeFMartId_('ORD'),number='FM-'+Utilities.formatDate(now,FMART_DB.TIMEZONE,'yyyyMMdd-HHmmss')+'-'+Math.floor(1000+Math.random()*9000);
  const recipientAddress=[recipient.name,recipient.className?'Kelas '+recipient.className:'',recipient.asrama?'Asrama '+recipient.asrama:'',extra].filter(Boolean).join(' · '),destination=metodePengiriman==='ANTAR_PESANTREN'?[recipientAddress,tujuan?'Catatan titik penerimaan: '+tujuan:''].filter(Boolean).join(' — '):'Pengambilan langsung di FMart'+(tujuan?' — '+tujuan:'');
  const payload={userId:session.userId,santriId:santriId,recipientSnapshot:recipient,selectedCartIds:selectedCartIds,orderNumber:number,total:total,shippingMethod:metodePengiriman,shippingDestination:destination,requestedDestination:tujuan,createdAt:now.toISOString(),items:items.map(x=>({detailId:makeFMartId_('DTL'),productId:x.productId,variationId:x.variationId,qty:x.qty,unitPrice:x.unitPrice,sku:x.sku,name:x.name,variationName:x.variationName})),shipmentId:makeFMartId_('SHP')};
  const row=[id,number,session.userId,santriId,subtotal,ongkir,diskon,total,'MENUNGGU_PEMBAYARAN',catatan,now,now,requestKey,fingerprint,JSON.stringify(payload)];sheet.appendRow(row);
  const result=completeCheckoutOrder_(ss,{values:row,rowNumber:sheet.getLastRow()},payload,session.userId,session.role);result.child=recipient;return result;
 }finally{lock.releaseLock();}
}

function getMyNotifications(token) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.PETUGAS_PENGANTAR]);
  const rows=readRows_(getSS_().getSheetByName('Notifikasi')).filter(function(r){return String(r[1]||'')===String(session.userId);}).sort(function(a,b){return new Date(b[7]||0).getTime()-new Date(a[7]||0).getTime();});
  const waitingStockOrderIds={};
  if(session.role===FMART.ROLES.WALI_SANTRI){
    readRows_(getSS_().getSheetByName('Pesanan')).forEach(function(order){
      if(String(order[2]||'')===String(session.userId) && String(order[8]||'').toUpperCase()==='MENUNGGU_STOK') waitingStockOrderIds[String(order[0])]=true;
    });
  }
  const notifications=rows.slice(0,100).map(function(r){
    const orderId=String(r[2]||'');
    let title=String(r[3]||''),message=String(r[4]||'');
    const stockRelated=isWaliStockRelatedText_(title+' '+message);
    const redactStockDetails=session.role===FMART.ROLES.WALI_SANTRI && (waitingStockOrderIds[orderId]||stockRelated);
    if(redactStockDetails){
      title='Pesanan sedang diproses';
      message='Pesanan Anda sedang diproses. Informasi perkembangan berikutnya akan kami sampaikan melalui aplikasi.';
    }
    return{id:String(r[0]||''),orderId:orderId,title:title,message:message,type:redactStockDetails?'PESANAN':String(r[5]||''),isRead:r[6]===true||String(r[6]).toUpperCase()==='TRUE',createdAt:dateIso_(r[7])};
  });
  return {ok:true,notifications:notifications,unreadCount:notifications.filter(function(n){return !n.isRead;}).length};
}
function markMyNotificationRead(token, notificationId) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.PETUGAS_PENGANTAR]);notificationId=String(notificationId||'').trim();if(!notificationId)throw new Error('Notifikasi tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const sheet=getSS_().getSheetByName('Notifikasi');const row=findRowById_(sheet,notificationId,1);if(!row||String(row.values[1]||'')!==String(session.userId))throw new Error('Notifikasi tidak ditemukan.');if(row.values[6]!==true&&String(row.values[6]).toUpperCase()!=='TRUE')sheet.getRange(row.rowNumber,7).setValue(true);SpreadsheetApp.flush();return {ok:true};}finally{lock.releaseLock();}
}
function markAllMyNotificationsRead(token) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.PETUGAS_PENGANTAR]);const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const sheet=getSS_().getSheetByName('Notifikasi');const rows=readRows_(sheet);let changed=0;rows.forEach(function(r,i){if(String(r[1]||'')===String(session.userId)&&r[6]!==true&&String(r[6]).toUpperCase()!=='TRUE'){sheet.getRange(i+2,7).setValue(true);changed++;}});SpreadsheetApp.flush();return {ok:true,updated:changed};}finally{lock.releaseLock();}
}
/** Fase 4: pesanan dan pembayaran Wali Santri. */
/** Dashboard ringkas Wali: hanya membaca pesanan dan relasi milik sesi aktif. */
function sanitizeWaliOrderStatus_(status) {
  const value=String(status||'').toUpperCase();
  // MENUNGGU_STOK dan DIBAYAR adalah tahap internal pemenuhan; Wali melihat keduanya sebagai Diproses.
  return ['MENUNGGU_STOK','DIBAYAR'].indexOf(value)!==-1 ? 'DIPROSES' : value;
}

function getWaliDashboard(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const children = getChildrenForWali_(ss, session.userId);
  const childMap = {};
  children.forEach(function(child){ childMap[String(child.id)] = child; });

  const orderRows = readRows_(ss.getSheetByName('Pesanan'))
    .filter(function(row){ return String(row[2]) === String(session.userId); })
    .sort(function(a,b){ return new Date(b[10] || 0).getTime() - new Date(a[10] || 0).getTime(); });

  const ownedOrders = {};
  orderRows.forEach(function(row){ ownedOrders[String(row[0])] = true; });
  const paymentMap = {};
  readRows_(ss.getSheetByName('Pembayaran')).forEach(function(row){
    const orderId = String(row[1] || '');
    if (!ownedOrders[orderId]) return;
    const created = new Date(row[8] || 0).getTime() || 0;
    if (!paymentMap[orderId] || created >= paymentMap[orderId].created) {
      paymentMap[orderId] = {
        created:created,
        status:String(row[5] || ''),
        method:String(row[2] || ''),
        nominal:Number(row[3]) || 0
      };
    }
  });

  const summary = {
    totalOrders:orderRows.length,
    activeOrders:0,
    unpaidOrders:0,
    awaitingPaymentVerification:0,
    rejectedPayments:0,
    completedOrders:0,
    cancelledOrders:0
  };
  const recentOrders = orderRows.slice(0,5).map(function(row){
    const orderId = String(row[0]);
    const status = String(row[8] || '');
    const payment = paymentMap[orderId] || null;
    const child = getOrderRecipientSnapshot_(ss,row);
    return {
      orderId:orderId,
      number:String(row[1] || ''),
      childName:String(child.name || ''),
      className:String(child.className || ''),
      total:Number(row[7]) || 0,
      status:sanitizeWaliOrderStatus_(status),
      paymentStatus:payment ? payment.status : '',
      createdAt:dateIso_(row[10])
    };
  });

  // Hitung ringkasan seluruh pesanan, bukan hanya lima pesanan terbaru.
  summary.activeOrders = 0;
  delete summary.waitingStockOrders;
  summary.unpaidOrders = 0;
  summary.awaitingPaymentVerification = 0;
  summary.rejectedPayments = 0;
  summary.completedOrders = 0;
  summary.cancelledOrders = 0;
  orderRows.forEach(function(row){
    const status = String(row[8] || '');
    const payment = paymentMap[String(row[0])] || null;
    if (status === 'MENUNGGU_PEMBAYARAN' && (!payment || payment.status === 'DITOLAK')) summary.unpaidOrders++;
    if (['MENUNGGU_STOK','DIBAYAR','DIPROSES','DISIAPKAN','DIANTAR'].indexOf(status) !== -1) summary.activeOrders++;
    // Status antrean stok tidak diekspos pada dashboard Wali.
    if (status === 'DITERIMA') summary.completedOrders++;
    if (status === 'DIBATALKAN') summary.cancelledOrders++;
    if (payment && payment.status === 'MENUNGGU_VERIFIKASI') summary.awaitingPaymentVerification++;
    if (payment && payment.status === 'DITOLAK') summary.rejectedPayments++;
  });

  return {
    ok:true,
    account:{name:String(session.nama || ''),username:String(session.username || '')},
    children:children,
    summary:summary,
    recentOrders:recentOrders
  };
}

function isWaliStockRelatedText_(value) {
  return /stok|stock|restok|re[\s-]?stock|persediaan|inventory|ketersediaan|barang\s+(?:belum\s+)?(?:tersedia|lengkap|terpenuhi|habis)|kekurangan|kurang\s+stok|stok\s+kurang|antrean\s+gudang|gudang|warehouse|fulfillment|pemenuhan|belum\s+terpenuhi|belum\s+lengkap|menunggu\s+seluruh|reservasi|backorder|supply|tidak\s+mencukupi|tidak\s+cukup|sisa\s+stok|unit\s+tersedia/i.test(String(value||''));
}

function sanitizeWaliStockNote_(note, orderStatus) {
  const value=String(note||'').trim();
  const status=String(orderStatus||'').toUpperCase();
  // Status antrean dan catatan internal persediaan tidak boleh menjadi petunjuk stok bagi Wali.
  if(status==='MENUNGGU_STOK' || isWaliStockRelatedText_(value)) {
    return 'Pesanan sedang diproses. Informasi perkembangan akan disampaikan melalui aplikasi.';
  }
  return value;
}

function getMyOrders(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const orderRows = readRows_(ss.getSheetByName('Pesanan'))
    .filter(function(r){ return String(r[2]) === String(session.userId); })
    .sort(function(a,b){ return new Date(b[10] || 0).getTime() - new Date(a[10] || 0).getTime(); });
  const paymentRows = readRows_(ss.getSheetByName('Pembayaran'));
  const shipmentRows = readRows_(ss.getSheetByName('Pengiriman'));
  const result = orderRows.map(function(r){
    const payment = latestPaymentForOrder_(paymentRows, String(r[0]));
    const shipment = latestShipmentForOrder_(shipmentRows, String(r[0]));
    const child = getOrderRecipientSnapshot_(ss,r);
    return {
      orderId:String(r[0]), number:String(r[1]), santriId:String(r[3]||''), childName:String(child.name || ''), className:String(child.className || ''), recipient:child,
      subtotal:Number(r[4])||0, shipping:Number(r[5])||0, discount:Number(r[6])||0, total:Number(r[7])||0,
      status:sanitizeWaliOrderStatus_(r[8]), note:sanitizeWaliStockNote_(r[9],r[8]), createdAt:dateIso_(r[10]), updatedAt:dateIso_(r[11]),
      payment:payment ? {id:payment.id,method:payment.method,nominal:payment.nominal,status:payment.status,buktiUrl:payment.buktiUrl,buktiSumber:payment.buktiSumber,submittedBy:payment.submittedBy,catatan:sanitizeWaliStockNote_(payment.catatan,''),createdAt:dateIso_(payment.createdAt)} : null,
      shipment:shipment ? {id:shipment.id,method:shipment.method,destination:shipment.destination,status:sanitizeWaliOrderStatus_(shipment.status),updatedAt:dateIso_(shipment.updatedAt)} : null
    };
  });
  return {ok:true,orders:result};
}

function getOrderDetail(token, orderId) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  orderId = String(orderId || '').trim();
  if (!orderId) throw new Error('Pesanan tidak valid.');
  const ss = getSS_();
  const orderRow = findRowById_(ss.getSheetByName('Pesanan'), orderId, 1);
  if (!orderRow || String(orderRow.values[2]) !== String(session.userId)) throw new Error('Pesanan tidak ditemukan.');
  const r = orderRow.values;
  const child = getOrderRecipientSnapshot_(ss,r);
  const details = readRows_(ss.getSheetByName('DetailPesanan')).filter(function(d){ return String(d[1]) === orderId; }).map(function(d){
    return {id:String(d[0]),productId:String(d[2]),variationId:String(d[3]||''),sku:String(d[4]||''),name:String(d[5]||''),variationName:String(d[6]||''),price:Number(d[7])||0,qty:Number(d[8])||0,subtotal:Number(d[9])||0};
  });
  const paymentRows = readRows_(ss.getSheetByName('Pembayaran'));
  const shipmentRows = readRows_(ss.getSheetByName('Pengiriman'));
  const payment = latestPaymentForOrder_(paymentRows, orderId);
  const shipment = latestShipmentForOrder_(shipmentRows, orderId);
  const confirmationRows=readRows_(ss.getSheetByName('KonfirmasiPengantaran')).filter(function(x){return String(x[1]||'')===orderId;}).sort(function(a,b){return new Date(b[9]||0).getTime()-new Date(a[9]||0).getTime();});
  const confirmation=confirmationRows.length?confirmationRows[0]:null;
  const proofRows=readRows_(ss.getSheetByName('BuktiPengantaran')).filter(function(x){return String(x[1]||'')===orderId;}).sort(function(a,b){return new Date(b[10]||0).getTime()-new Date(a[10]||0).getTime();});
  const proof=proofRows.length?proofRows[0]:null;
  const complaintRows=readRows_(ss.getSheetByName('KomplainPengantaran')).filter(function(x){return String(x[1]||'')===orderId;}).sort(function(a,b){return new Date(b[7]||0).getTime()-new Date(a[7]||0).getTime();});
  const latestComplaint=complaintRows.length?complaintRows[0]:null;
  return {ok:true,order:{orderId:String(r[0]),number:String(r[1]),santriId:String(r[3]||''),childName:String(child.name||''),className:String(child.className||''),recipient:child,subtotal:Number(r[4])||0,shipping:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,status:sanitizeWaliOrderStatus_(r[8]),note:sanitizeWaliStockNote_(r[9],r[8]),createdAt:dateIso_(r[10]),updatedAt:dateIso_(r[11]),deliveryProof:proof?{proofId:String(proof[0]),uploadedAt:dateIso_(proof[10]),fileName:String(proof[5]||''),mimeType:String(proof[6]||''),note:String(proof[8]||'')}:null,deliveryConfirmation:confirmation?{id:String(confirmation[0]),uploadedAt:dateIso_(confirmation[2]),deadline:dateIso_(confirmation[3]),status:String(confirmation[4]||''),complaintActive:confirmation[8]===true||String(confirmation[8]).toUpperCase()==='TRUE'}:null,deliveryComplaint:latestComplaint?{type:String(latestComplaint[4]||''),description:String(latestComplaint[5]||''),status:String(latestComplaint[6]||''),reportedAt:dateIso_(latestComplaint[7])}:null,details:details,payment:payment?{id:payment.id,method:payment.method,nominal:payment.nominal,status:payment.status,buktiUrl:payment.buktiUrl,buktiSumber:payment.buktiSumber,submittedBy:payment.submittedBy,catatan:sanitizeWaliStockNote_(payment.catatan,''),createdAt:dateIso_(payment.createdAt),verifiedAt:dateIso_(payment.verifiedAt)}:null,shipment:shipment?{id:shipment.id,method:shipment.method,destination:shipment.destination,status:sanitizeWaliOrderStatus_(shipment.status),dikirimAt:dateIso_(shipment.dikirimAt),diterimaAt:dateIso_(shipment.diterimaAt),updatedAt:dateIso_(shipment.updatedAt)}:null}};
}


/** Detail pesanan untuk operasional internal. Tidak mengekspos bukti pembayaran ke role selain Kasir/Superadmin. */
function getOperationsOrderDetail(token, orderId) {
  const session = requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.GUDANG, FMART.ROLES.SUPERVISOR, FMART.ROLES.SUPERADMIN]);
  orderId = String(orderId || '').trim();
  if (!orderId) throw new Error('Pesanan tidak valid.');
  const ss = getSS_();
  const orderRow = findRowById_(ss.getSheetByName('Pesanan'), orderId, 1);
  if (!orderRow) throw new Error('Pesanan tidak ditemukan.');
  const r = orderRow.values;
  const details = readRows_(ss.getSheetByName('DetailPesanan')).filter(function(d){ return String(d[1]) === orderId; }).map(function(d){
    return {id:String(d[0]),productId:String(d[2]),variationId:String(d[3]||''),sku:String(d[4]||''),name:String(d[5]||''),variationName:String(d[6]||''),price:Number(d[7])||0,qty:Number(d[8])||0,subtotal:Number(d[9])||0};
  });
  const recipient = getOrderRecipientSnapshot_(ss,r);
  const visibleRecipient=session.role===FMART.ROLES.SUPERVISOR?{name:recipient.name,className:recipient.className,asrama:recipient.asrama,legacy:recipient.legacy}:recipient;
  const payments = readRows_(ss.getSheetByName('Pembayaran')).filter(function(p){return String(p[1])===orderId;}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();});
  const payment = payments.length ? {status:String(payments[0][5]||''),method:String(payments[0][2]||''),nominal:Number(payments[0][3])||0,verifiedAt:dateIso_(payments[0][7])} : null;
  const shipments = readRows_(ss.getSheetByName('Pengiriman')).filter(function(sh){return String(sh[1])===orderId;}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();});
  const shipment = shipments.length ? {status:String(shipments[0][4]||''),method:String(shipments[0][2]||''),destination:String(shipments[0][3]||'')} : null;
  return {ok:true,order:{orderId:String(r[0]),number:String(r[1]),santriId:session.role===FMART.ROLES.SUPERVISOR?'':String(r[3]),childName:recipient.name||'Santri',className:recipient.className||'',recipient:visibleRecipient,subtotal:Number(r[4])||0,shipping:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,status:String(r[8]||''),note:String(r[9]||''),createdAt:dateIso_(r[10]),updatedAt:dateIso_(r[11]),payment:payment,shipment:shipment,details:details}};
}

function submitPayment(token,orderId,method,nominal,fileName,mimeType,base64Data,requestKey){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);orderId=String(orderId||'').trim();method=String(method||'').trim().toUpperCase();nominal=Math.round(Number(nominal));requestKey=String(requestKey||'').trim();
 if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci pengajuan pembayaran tidak valid. Silakan coba kembali.');
 if(!orderId||method!=='QRIS'||!Number.isFinite(nominal)||nominal<1)throw new Error('FMart hanya menerima pembayaran QRIS.');if(!base64Data)throw new Error('Bukti pembayaran QRIS wajib diunggah.');
 const cleanName=sanitizeFileName_(fileName||'bukti-qris'),mime=String(mimeType||'').toLowerCase();if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime))throw new Error('Format bukti pembayaran harus JPG, PNG, WEBP, atau PDF.');
 const raw=String(base64Data).replace(/^data:[^;]+;base64,/,'');let bytes;try{bytes=Utilities.base64Decode(raw);}catch(e){throw new Error('Data bukti pembayaran tidak valid.');}
 if(!bytes.length||bytes.length>5*1024*1024)throw new Error('Ukuran bukti pembayaran maksimal 5 MB.');validateUploadedFileSignature_(bytes,mime);const proofHash=sha256Hex_(bytes.join(','));
 const lock=LockService.getScriptLock();lock.waitLock(15000);
 try{
  const ss=getSS_(),order=findRowById_(ss.getSheetByName('Pesanan'),orderId,1);if(!order||String(order.values[2])!==String(session.userId))throw new Error('Pesanan tidak ditemukan.');
  const ps=ss.getSheetByName('Pembayaran'),payments=readRows_(ps),same=payments.map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[13]||'')===requestKey);
  if(same){const p=same.values;if(String(p[1])!==orderId||String(p[11])!==String(session.userId)||Number(p[3])!==nominal||String(p[2]).toUpperCase()!=='QRIS'||String(p[14]||'')!==proofHash)throw new Error('Kunci pengajuan pembayaran pernah digunakan untuk data berbeda.');if(['MENUNGGU_VERIFIKASI','TERVERIFIKASI'].indexOf(String(p[5]||'').toUpperCase())<0)throw new Error('Pengajuan dengan kunci ini sudah ditolak. Buat pengajuan baru.');return getOrderDetail(token,orderId);}
  if(String(order.values[8]||'').toUpperCase()!=='MENUNGGU_PEMBAYARAN')throw new Error('Pesanan tidak sedang menunggu pembayaran.');
  if(!/^https:\/\//i.test(getSettingValue_('PAYMENT_QRIS_IMAGE_URL')))throw new Error('QRIS FMart belum dikonfigurasi.');
  const total=Math.round(Number(order.values[7])||0);if(nominal!==total)throw new Error('Nominal pembayaran harus tepat Rp '+total.toLocaleString('id-ID')+'.');
  const limit=Math.max(1,Number(getSettingValue_('PAYMENT_VERIFICATION_QUEUE_LIMIT'))||50);if(payments.filter(r=>String(r[5]||'').toUpperCase()==='MENUNGGU_VERIFIKASI').length>=limit)throw new Error('Antrean verifikasi pembayaran sedang penuh ('+limit+' pengajuan). Silakan coba kembali.');
  const prior=payments.filter(r=>String(r[1])===orderId).sort((a,b)=>new Date(b[8]||0)-new Date(a[8]||0))[0];if(prior&&['MENUNGGU_VERIFIKASI','TERVERIFIKASI'].indexOf(String(prior[5]||'').toUpperCase())>=0)throw new Error('Pembayaran untuk pesanan ini sudah diajukan.');
  const folder=getPaymentProofFolder_(),driveName=orderId+'-'+requestKey+'-'+cleanName,marker='FMART_PAYMENT|'+orderId+'|'+requestKey+'|'+proofHash,file=getOrCreateTransactionProofFile_(folder,driveName,mime,bytes,marker),now=new Date(),paymentId=makeFMartId_('PAY');
  ps.appendRow([paymentId,orderId,'QRIS',nominal,file.getUrl(),'MENUNGGU_VERIFIKASI','','',now,now,'APLIKASI',session.userId,'',requestKey,proofHash]);
  writeAudit_(session.userId,session.role,'SUBMIT_PAYMENT','PEMBAYARAN',paymentId,'',JSON.stringify({orderId:orderId,method:'QRIS',nominal:nominal,hasProof:true,proofHash:proofHash}),'Pengajuan pembayaran QRIS dengan bukti');
  SpreadsheetApp.flush();return getOrderDetail(token,orderId);
 }finally{lock.releaseLock();}
}

/** Resolve a private Drive QRIS image through Apps Script so the PWA does not depend on Drive thumbnail cookies/permissions. */
function extractQrisDriveFileId_(url){
  const value=String(url||'').trim();
  if(!/^https:\/\/(?:(?:www\.)?drive\.google\.com|drive\.usercontent\.google\.com|docs\.google\.com|lh3\.googleusercontent\.com)\//i.test(value))return '';
  const match=value.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/i)||value.match(/[?&]id=([A-Za-z0-9_-]{10,})/i);
  return match?match[1]:'';
}

/** Wali/Superadmin may read the configured merchant QRIS image; no Drive URL or file ID is exposed. */
function getQrisImageData(token){
  requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.SUPERADMIN]);
  const fileId=extractQrisDriveFileId_(getSettingValue_('PAYMENT_QRIS_IMAGE_URL'));
  if(!fileId)return {ok:false,reason:'NOT_DRIVE'};
  let file;try{file=DriveApp.getFileById(fileId);}catch(e){throw new Error('File QRIS di Google Drive tidak dapat diakses oleh aplikasi. Periksa ID file dan izin akun pemilik script.');}
  if(file.isTrashed())throw new Error('File QRIS di Google Drive sudah berada di Sampah.');
  if(Number(file.getSize())>5*1024*1024)throw new Error('Ukuran gambar QRIS maksimal 5 MB.');
  const blob=file.getBlob(),mime=String(blob.getContentType()||'').toLowerCase(),bytes=blob.getBytes();
  if(['image/jpeg','image/png','image/webp'].indexOf(mime)<0||!bytes.length||bytes.length>5*1024*1024)throw new Error('File QRIS harus berupa gambar JPG, PNG, atau WEBP maksimal 5 MB.');
  validateUploadedFileSignature_(bytes,mime);
  return {ok:true,mimeType:mime,dataUrl:'data:'+mime+';base64,'+Utilities.base64Encode(bytes),fileName:file.getName()};
}

function getPaymentSettings(token) {
  requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.SUPERADMIN]);
  return {ok:true,bankName:getSettingValue_('PAYMENT_BANK_NAME'),accountNumber:getSettingValue_('PAYMENT_ACCOUNT_NUMBER'),accountName:getSettingValue_('PAYMENT_ACCOUNT_NAME'),adminWhatsapp:getSettingValue_('PAYMENT_ADMIN_WHATSAPP'),qrisImageUrl:getSettingValue_('PAYMENT_QRIS_IMAGE_URL')};
}

function savePaymentSettings(token, bankName, accountNumber, accountName, adminWhatsapp, qrisImageUrl) {
  const session = requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  adminWhatsapp=normalizePhone_(adminWhatsapp);
  qrisImageUrl=String(qrisImageUrl||'').trim().slice(0,1000);
  if(!/^https:\/\//i.test(qrisImageUrl)) throw new Error('URL gambar QRIS wajib diisi dan harus menggunakan HTTPS.');
  if(adminWhatsapp && adminWhatsapp.length<10) throw new Error('Nomor WhatsApp Admin/Kasir tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const sheet=getSS_().getSheetByName('Pengaturan');
    const updates=[['PAYMENT_ADMIN_WHATSAPP',adminWhatsapp,'Nomor WhatsApp Admin/Kasir untuk konfirmasi pembayaran'],['PAYMENT_QRIS_IMAGE_URL',qrisImageUrl,'URL HTTPS gambar kode QRIS FMart']];
    updates.forEach(function(item){
      const rows=readRows_(sheet),idx=rows.findIndex(function(row){return String(row[0])===item[0];});
      if(idx<0) sheet.appendRow([item[0],item[1],item[2],new Date()]);
      else {sheet.getRange(idx+2,2).setValue(item[1]);sheet.getRange(idx+2,4).setValue(new Date());}
    });
    writeAudit_(session.userId,session.role,'UPDATE_PAYMENT_SETTINGS','PENGATURAN','PAYMENT','',JSON.stringify({hasWhatsapp:!!adminWhatsapp,hasQrisImage:true}),'Mengubah pengaturan QRIS FMart');
    SpreadsheetApp.flush();
    return getPaymentSettings(token);
  }finally{lock.releaseLock();}
}

function markOrderReceived(token, orderId) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  orderId=String(orderId||'').trim();if(!orderId)throw new Error('Pesanan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),orderSheet=ss.getSheetByName('Pesanan'),order=findRowById_(orderSheet,orderId,1);
    if(!order||String(order.values[2])!==String(session.userId))throw new Error('Pesanan tidak ditemukan.');
    const status=String(order.values[8]||'').toUpperCase(),shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    const method=String(shipment&&shipment.method||'').toUpperCase();
    if(method==='AMBIL_FMART'){
      if(status!=='SIAP_DIAMBIL'||String(shipment.status||'').toUpperCase()!=='SIAP_DIAMBIL')throw new Error('Pesanan belum siap diserahkan. Silakan tunggu notifikasi dari FMart.');
      const now=new Date(),shipSheet=ss.getSheetByName('Pengiriman'),shipRow=latestShipmentRow_(shipSheet,orderId);
      orderSheet.getRange(order.rowNumber,9,1,3).setValues([['DITERIMA',order.values[9],now]]);
      if(shipRow)shipSheet.getRange(shipRow,5,1,5).setValues([['DITERIMA',shipment.dikirimAt||now,now,session.userId,now]]);
      ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),session.userId,orderId,'Pengambilan dikonfirmasi','Pengambilan pesanan '+String(order.values[1])+' telah Anda konfirmasi diterima.','PESANAN',false,now]);
      writeAudit_(session.userId,session.role,'RECEIVE_PICKUP_ORDER','PESANAN',orderId,JSON.stringify({orderStatus:status,shipmentStatus:shipment.status}),JSON.stringify({orderStatus:'DITERIMA',shipmentStatus:'DITERIMA',method:'AMBIL_FMART'}),'Wali mengonfirmasi barang diambil dan diterima di FMart');
      SpreadsheetApp.flush();return getOrderDetail(token,orderId);
    }
    if(method!=='ANTAR_PESANTREN'||status!=='DIANTAR')throw new Error('Pesanan belum berada pada status dapat diterima.');
    const proof=readRows_(ss.getSheetByName('BuktiPengantaran')).filter(x=>String(x[1]||'')===orderId).sort((a,b)=>new Date(b[10]||0)-new Date(a[10]||0))[0];
    if(!proof)throw new Error('Bukti foto pengantaran belum tersedia. Anda belum dapat mengonfirmasi penerimaan.');
    const confirmationSheet=ss.getSheetByName('KonfirmasiPengantaran'),confirmationRows=readRows_(confirmationSheet);
    const confIndex=confirmationRows.map(x=>String(x[1]||'')).lastIndexOf(orderId);
    if(confIndex<0)throw new Error('Data konfirmasi pengantaran belum tersedia. Hubungi Admin FMart.');
    const conf=confirmationRows[confIndex],confRow=confIndex+2;
    if(String(conf[4]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI')throw new Error('Konfirmasi pengantaran sudah diproses atau sedang ditangani.');
    if(conf[8]===true||String(conf[8]).toUpperCase()==='TRUE')throw new Error('Pesanan memiliki komplain aktif. Tunggu penyelesaian Admin.');
    const now=new Date();
    orderSheet.getRange(order.rowNumber,9,1,3).setValues([['DITERIMA',order.values[9],now]]);
    const shipSheet=ss.getSheetByName('Pengiriman'),shipRow=latestShipmentRow_(shipSheet,orderId);
    if(shipRow)shipSheet.getRange(shipRow,5,1,5).setValues([['DITERIMA',shipment.dikirimAt||'',now,session.userId,now]]);
    confirmationSheet.getRange(confRow,5,1,6).setValues([['DIKONFIRMASI','MANUAL',now,session.userId,false,now]]);
    const assignments=readRows_(ss.getSheetByName('Pengantaran'));
    const active=assignments.map((x,i)=>({row:x,rowNumber:i+2})).filter(x=>String(x.row[1]||'')===orderId&&String(x.row[3]||'').toUpperCase()==='DALAM_PERJALANAN').pop();
    if(active){const assignmentSheet=ss.getSheetByName('Pengantaran');assignmentSheet.getRange(active.rowNumber,4).setValue('SELESAI');assignmentSheet.getRange(active.rowNumber,9).setValue(now);assignmentSheet.getRange(active.rowNumber,13).setValue(now);}
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),session.userId,orderId,'Pesanan diterima','Pesanan '+String(order.values[1])+' telah Anda konfirmasi diterima.','PESANAN',false,now]);
    writeAudit_(session.userId,session.role,'RECEIVE_ORDER','PESANAN',orderId,JSON.stringify({status:'DIANTAR',confirmationStatus:conf[4]}),JSON.stringify({status:'DITERIMA',confirmationMethod:'MANUAL'}),'Pesanan diterima dan dikonfirmasi Wali Santri');
    SpreadsheetApp.flush();return getOrderDetail(token,orderId);
  }finally{lock.releaseLock();}
}
function reportDeliveryComplaint(token,orderId,issueType,description) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  orderId=String(orderId||'').trim();issueType=String(issueType||'').trim().toUpperCase();description=String(description||'').trim().slice(0,1000);
  const allowed=['BARANG_KURANG','BARANG_RUSAK','PESANAN_TIDAK_SESUAI','BELUM_DITERIMA','MASALAH_PENGANTARAN','LAINNYA'];
  if(!orderId||allowed.indexOf(issueType)<0||description.length<5) throw new Error('Jenis masalah dan keterangan minimal 5 karakter wajib diisi.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try {
    const ss=getSS_(),order=findRowById_(ss.getSheetByName('Pesanan'),orderId,1);
    if(!order||String(order.values[2])!==String(session.userId)) throw new Error('Pesanan tidak ditemukan.');
    if(String(order.values[8]||'').toUpperCase()!=='DIANTAR') throw new Error('Komplain hanya dapat diajukan sebelum pesanan dikonfirmasi diterima.');
    const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    if(!shipment||String(shipment.method||'').toUpperCase()!=='ANTAR_PESANTREN') throw new Error('Komplain pengantaran hanya tersedia untuk pesanan Antar Pesantren.');
    const proof=readRows_(ss.getSheetByName('BuktiPengantaran')).filter(x=>String(x[1]||'')===orderId).sort((a,b)=>new Date(b[10]||0)-new Date(a[10]||0))[0];
    if(!proof) throw new Error('Bukti pengantaran belum tersedia.');
    const confSheet=ss.getSheetByName('KonfirmasiPengantaran'),confs=readRows_(confSheet);
    const index=confs.map(x=>String(x[1]||'')).lastIndexOf(orderId);
    if(index<0) throw new Error('Data konfirmasi pengantaran tidak ditemukan.');
    const conf=confs[index],confRow=index+2;
    if(String(conf[4]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI') throw new Error('Masa konfirmasi sudah ditutup atau sudah diproses.');
    if(conf[8]===true||String(conf[8]).toUpperCase()==='TRUE') throw new Error('Komplain untuk pesanan ini sudah aktif.');
    const now=new Date(),complaintId=makeFMartId_('KMP');
    ss.getSheetByName('KomplainPengantaran').appendRow([complaintId,orderId,String(conf[0]),session.userId,issueType,description,'MENUNGGU_PENANGANAN',now,'','','',now]);
    confSheet.getRange(confRow,5).setValue('KOMPLAIN_AKTIF');
    confSheet.getRange(confRow,9,1,2).setValues([[true,now]]);
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),session.userId,orderId,'Komplain pengantaran dicatat','Laporan Anda telah diterima. Konfirmasi otomatis dihentikan sementara sampai Admin menyelesaikan pemeriksaan.','PENGANTARAN',false,now]);
    const noticeSheet=ss.getSheetByName('Notifikasi'),orderNumber=String(order.values[1]||orderId),staffRows=readRows_(ss.getSheetByName('Users'));
    staffRows.filter(function(u){return ['ADMIN','SUPERADMIN'].indexOf(String(u[5]||'').toUpperCase())>=0&&String(u[6]||'').toUpperCase()==='AKTIF';}).forEach(function(u){noticeSheet.appendRow([makeFMartId_('NTF'),String(u[0]),orderId,'Komplain pengantaran baru','Komplain pesanan '+orderNumber+' menunggu penanganan Admin. Periksa menu Komplain Pengantaran.','PENGANTARAN',false,now]);});
    const activeAssignment=readRows_(ss.getSheetByName('Pengantaran')).filter(function(a){return String(a[1]||'')===orderId&&['DITUGASKAN','DITERIMA','DITERIMA_PETUGAS','DALAM_PERJALANAN'].indexOf(String(a[3]||'').toUpperCase())>=0;}).pop();
    if(activeAssignment&&String(activeAssignment[2]||''))noticeSheet.appendRow([makeFMartId_('NTF'),String(activeAssignment[2]),orderId,'Komplain pada pesanan yang ditangani','Wali melaporkan kendala pada pesanan '+orderNumber+'. Periksa pembaruan tugas melalui Admin.','PENGANTARAN',false,now]);
    recordDeliveryHistory_(ss,'',orderId,session,'KOMPLAIN_DIAJUKAN','MENUNGGU_KONFIRMASI','KOMPLAIN_AKTIF',description);
    writeAudit_(session.userId,session.role,'REPORT_DELIVERY_COMPLAINT','KOMPLAIN_PENGANTARAN',complaintId,'',JSON.stringify({orderId:orderId,type:issueType}),'Wali melaporkan masalah pengantaran');
    SpreadsheetApp.flush();
    return {ok:true,message:'Laporan berhasil dikirim. Konfirmasi otomatis ditahan sampai Admin menyelesaikan komplain.'};
  } finally {lock.releaseLock();}
}

/** Tahap 9: antrean komplain pengantaran untuk Admin/Superadmin. */
function getDeliveryComplaintWorkspace(token) {
  requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_(),complaints=readRows_(ss.getSheetByName('KomplainPengantaran'));
  const orders=readRows_(ss.getSheetByName('Pesanan')),users=readRows_(ss.getSheetByName('Users'));
  const confirmations=readRows_(ss.getSheetByName('KonfirmasiPengantaran'));
  const orderMap={},userMap={},waliByUserId={},confirmationMap={};
  orders.forEach(r=>orderMap[String(r[0]||'')]=r);
  users.forEach(r=>userMap[String(r[0]||'')]={name:String(r[4]||''),phone:String(r[1]||'')});
  readRows_(ss.getSheetByName('WaliSantri')).forEach(function(r){if(String(r[1]||''))waliByUserId[String(r[1])]={name:String(r[2]||''),phone:String(r[3]||'')};});
  confirmations.forEach(r=>confirmationMap[String(r[0]||'')]=r);
  const items=complaints.map(function(r){
    const order=orderMap[String(r[1]||'')]||[],wali=waliByUserId[String(r[3]||'')]||userMap[String(r[3]||'')]||{},conf=confirmationMap[String(r[2]||'')]||[];
    return {complaintId:String(r[0]||''),orderId:String(r[1]||''),orderNumber:String(order[1]||r[1]||''),orderStatus:String(order[8]||''),waliName:wali.name||'Wali Santri',waliPhone:wali.phone||'',issueType:String(r[4]||''),description:String(r[5]||''),status:String(r[6]||''),reportedAt:dateIso_(r[7]),confirmationDeadline:dateIso_(conf[3]),resolution:String(r[9]||''),handledBy:String(r[8]||'')};
  }).filter(x=>['MENUNGGU_PENANGANAN','DIPROSES'].indexOf(x.status.toUpperCase())>=0)
    .sort((a,b)=>new Date(a.reportedAt||0)-new Date(b.reportedAt||0));
  return {ok:true,items:items,updatedAt:new Date().toISOString()};
}

/** Penyelesaian komplain dengan opsi membuka kembali masa konfirmasi. */
function resolveDeliveryComplaint(token,complaintId,resolution,reopenConfirmation) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  complaintId=String(complaintId||'').trim();resolution=String(resolution||'').trim().slice(0,1000);
  if(!complaintId||resolution.length<5) throw new Error('Catatan penyelesaian minimal 5 karakter wajib diisi.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try {
    const ss=getSS_(),complaintSheet=ss.getSheetByName('KomplainPengantaran'),complaint=findRowById_(complaintSheet,complaintId,1);
    if(!complaint) throw new Error('Komplain tidak ditemukan.');
    if(['MENUNGGU_PENANGANAN','DIPROSES'].indexOf(String(complaint.values[6]||'').toUpperCase())<0) throw new Error('Komplain ini sudah diselesaikan.');
    const orderId=String(complaint.values[1]||''),confirmationId=String(complaint.values[2]||''),orderSheet=ss.getSheetByName('Pesanan'),order=findRowById_(orderSheet,orderId,1);
    if(!order) throw new Error('Pesanan terkait tidak ditemukan.');
    const confirmationSheet=ss.getSheetByName('KonfirmasiPengantaran'),confirmation=findRowById_(confirmationSheet,confirmationId,1);
    if(!confirmation) throw new Error('Data konfirmasi pengantaran tidak ditemukan.');
    const now=new Date(),reopen=reopenConfirmation===true||String(reopenConfirmation).toUpperCase()==='TRUE';
    if(reopen){
      if(String(order.values[8]||'').toUpperCase()!=='DIANTAR') throw new Error('Konfirmasi hanya dapat dibuka kembali jika pesanan masih berstatus DIANTAR.');
      if(!readRows_(ss.getSheetByName('BuktiPengantaran')).some(r=>String(r[1]||'')===orderId)) throw new Error('Bukti pengantaran tidak ditemukan; konfirmasi tidak dapat dibuka kembali.');
      const shipment=readRows_(ss.getSheetByName('Pengiriman')).filter(r=>String(r[1]||'')===orderId).sort((a,b)=>new Date(b[8]||0)-new Date(a[8]||0))[0];
      if(!shipment||String(shipment[2]||'').toUpperCase()!=='ANTAR_PESANTREN') throw new Error('Auto-konfirmasi hanya berlaku untuk metode ANTAR_PESANTREN.');
      confirmationSheet.getRange(confirmation.rowNumber,4).setValue(new Date(now.getTime()+7*86400000));
      confirmationSheet.getRange(confirmation.rowNumber,5,1,6).setValues([['MENUNGGU_KONFIRMASI','','','',false,now]]);
      PropertiesService.getScriptProperties().deleteProperty(deliveryNoticePropertyKey_(confirmationId));
    } else {
      confirmationSheet.getRange(confirmation.rowNumber,5,1,6).setValues([['MENUNGGU_KONFIRMASI',confirmation.values[5]||'',confirmation.values[6]||'',confirmation.values[7]||'',false,now]]);
    }
    complaintSheet.getRange(complaint.rowNumber,7,1,6).setValues([['SELESAI',complaint.values[7],session.userId,resolution,now,now]]);
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(complaint.values[3]||''),orderId,'Komplain pengantaran selesai',reopen?'Admin menyelesaikan pemeriksaan. Masa konfirmasi penerimaan dibuka kembali selama 7 hari.':'Admin menyelesaikan pemeriksaan. Proses konfirmasi dilanjutkan sesuai tenggat sebelumnya.','PENGANTARAN',false,now]);
    const assignedDriver=readRows_(ss.getSheetByName('Pengantaran')).filter(function(a){return String(a[1]||'')===orderId&&String(a[2]||'')&&['DITUGASKAN','DITERIMA','DITERIMA_PETUGAS','DALAM_PERJALANAN'].indexOf(String(a[3]||'').toUpperCase())>=0;}).pop();
    if(assignedDriver)ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(assignedDriver[2]),orderId,'Komplain pesanan diperbarui','Admin telah menyelesaikan komplain pesanan '+String(order.values[1]||orderId)+'. Periksa status tugas Anda.','PENGANTARAN',false,now]);
    ['24H','48H','72H'].forEach(function(stage){PropertiesService.getScriptProperties().deleteProperty(deliveryComplaintReminderKey_(complaintId,stage));});
    recordDeliveryHistory_(ss,'',orderId,session,'KOMPLAIN_DISELESAIKAN','KOMPLAIN_AKTIF','MENUNGGU_KONFIRMASI',resolution);
    writeAudit_(session.userId,session.role,'RESOLVE_DELIVERY_COMPLAINT','KOMPLAIN_PENGANTARAN',complaintId,JSON.stringify({status:complaint.values[6]}),JSON.stringify({status:'SELESAI',reopenConfirmation:reopen}),'Admin menyelesaikan komplain pengantaran');
    SpreadsheetApp.flush();
    return {ok:true,reopened:reopen,message:reopen?'Komplain selesai. Masa konfirmasi 7 hari dibuka kembali.':'Komplain selesai. Konfirmasi dilanjutkan sesuai tenggat sebelumnya.'};
  } finally {lock.releaseLock();}
}

function deliveryNoticePropertyKey_(confirmationId){return 'FMART_DELIVERY_NOTICE_'+String(confirmationId||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);}
function deliveryAutoConfirmEnabled_(){
  const rows=readRows_(getSS_().getSheetByName('Pengaturan'));
  const row=rows.filter(r=>String(r[0]||'').toUpperCase()==='DELIVERY_AUTO_CONFIRM_ENABLED').pop();
  return row?String(row[1]||'').toUpperCase()==='TRUE':true;
}

function deliveryComplaintReminderKey_(complaintId,stage){return 'FMART_COMPLAINT_REMINDER_'+String(complaintId||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,70)+'_'+stage;}
function processDeliveryComplaintReminders_(ss,now){
  const complaints=readRows_(ss.getSheetByName('KomplainPengantaran')),orders=readRows_(ss.getSheetByName('Pesanan')),users=readRows_(ss.getSheetByName('Users')),props=PropertiesService.getScriptProperties(),orderMap={},activeStaff=users.filter(function(u){return ['ADMIN','SUPERADMIN'].indexOf(String(u[5]||'').toUpperCase())>=0&&String(u[6]||'').toUpperCase()==='AKTIF';});
  orders.forEach(function(r){orderMap[String(r[0]||'')]=r;});
  const noticeSheet=ss.getSheetByName('Notifikasi');let sent=0,checked=0;
  complaints.forEach(function(r){
    const id=String(r[0]||''),orderId=String(r[1]||''),status=String(r[6]||'').toUpperCase();
    if(!id||['MENUNGGU_PENANGANAN','DIPROSES'].indexOf(status)<0)return;
    const reportedAt=new Date(r[7]||0).getTime();if(!Number.isFinite(reportedAt)||reportedAt<=0)return;
    const age=now.getTime()-reportedAt,order=orderMap[orderId]||[],number=String(order[1]||orderId),waliId=String(r[3]||'');checked++;
    if(age>=24*60*60*1000){const key=deliveryComplaintReminderKey_(id,'24H');if(props.getProperty(key)!=='1'){activeStaff.forEach(function(u){noticeSheet.appendRow([makeFMartId_('NTF'),String(u[0]),orderId,'Pengingat komplain belum ditangani','Komplain pesanan '+number+' telah menunggu lebih dari 24 jam. Mohon periksa dan tindak lanjuti.','PENGANTARAN',false,now]);});props.setProperty(key,'1');sent+=activeStaff.length;}}
    if(age>=48*60*60*1000){const key=deliveryComplaintReminderKey_(id,'48H');if(props.getProperty(key)!=='1'&&waliId){noticeSheet.appendRow([makeFMartId_('NTF'),waliId,orderId,'Pembaruan komplain','Komplain pesanan '+number+' masih dalam proses penanganan. Kami akan memberi tahu Anda setelah pemeriksaan selesai.','PENGANTARAN',false,now]);props.setProperty(key,'1');sent++;}}
    if(age>=72*60*60*1000){const key=deliveryComplaintReminderKey_(id,'72H');if(props.getProperty(key)!=='1'){activeStaff.forEach(function(u){noticeSheet.appendRow([makeFMartId_('NTF'),String(u[0]),orderId,'Eskalasi komplain','Komplain pesanan '+number+' belum diselesaikan setelah 72 jam. Mohon prioritaskan tindak lanjut.','PENGANTARAN',false,now]);});props.setProperty(key,'1');sent+=activeStaff.length;}}
  });
  return {checked:checked,sent:sent};
}

/** Handler trigger per jam; idempotent dan mengejar tenggat yang terlewat. */
function processDeliveryAutoConfirmation_() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(20000)) return {ok:false,skipped:'LOCKED'};
  try {
    const ss=getSS_(),now=new Date();
    const complaintReminderResult=processDeliveryComplaintReminders_(ss,now);
    if(!deliveryAutoConfirmEnabled_()) return {ok:true,disabled:true,complaintReminders:complaintReminderResult};
    const orders=readRows_(ss.getSheetByName('Pesanan')),proofs=readRows_(ss.getSheetByName('BuktiPengantaran'));
    const confirmations=readRows_(ss.getSheetByName('KonfirmasiPengantaran')),shipments=readRows_(ss.getSheetByName('Pengiriman'));
    const complaints=readRows_(ss.getSheetByName('KomplainPengantaran')),orderMap={},proofByOrder={},shipmentByOrder={},activeComplaint={};
    orders.forEach(r=>orderMap[String(r[0]||'')]=r);
    proofs.forEach(r=>{const id=String(r[1]||'');if(id&&(!proofByOrder[id]||new Date(r[10]||0)>new Date(proofByOrder[id][10]||0)))proofByOrder[id]=r;});
    shipments.forEach(r=>{const id=String(r[1]||'');if(id&&(!shipmentByOrder[id]||new Date(r[8]||0)>=new Date(shipmentByOrder[id][8]||0)))shipmentByOrder[id]=r;});
    complaints.forEach(r=>{if(['MENUNGGU_PENANGANAN','DIPROSES'].indexOf(String(r[6]||'').toUpperCase())>=0)activeComplaint[String(r[1]||'')]=true;});
    const props=PropertiesService.getScriptProperties();let reminders=0,autoConfirmed=0,skipped=0;
    confirmations.forEach(function(conf,index){
      const confId=String(conf[0]||''),orderId=String(conf[1]||'');
      if(!confId||String(conf[4]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI')return;
      const order=orderMap[orderId],proof=proofByOrder[orderId],shipment=shipmentByOrder[orderId];
      if(!order||String(order[8]||'').toUpperCase()!=='DIANTAR'||!proof||!shipment||String(shipment[2]||'').toUpperCase()!=='ANTAR_PESANTREN'||conf[8]===true||String(conf[8]).toUpperCase()==='TRUE'||activeComplaint[orderId]){skipped++;return;}
      const uploadedAt=new Date(conf[2]||proof[10]),deadline=new Date(conf[3]||uploadedAt.getTime()+7*86400000);
      if(isNaN(uploadedAt.getTime())||isNaN(deadline.getTime())){skipped++;return;}
      const elapsed=now.getTime()-uploadedAt.getTime(),key=deliveryNoticePropertyKey_(confId);
      let sent={};try{sent=JSON.parse(props.getProperty(key)||'{}')||{};}catch(e){sent={};}
      const waliId=String(order[2]||''),orderNumber=String(order[1]||orderId);
      if(elapsed>=5*86400000&&!sent.day5&&now<deadline){ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),waliId,orderId,'Pengingat konfirmasi penerimaan','Sudah 5 hari sejak bukti pengantaran diunggah. Periksa pesanan dan konfirmasi penerimaan jika barang telah diterima.','PENGANTARAN',false,now]);sent.day5=true;reminders++;}
      if(elapsed>=6*86400000&&!sent.day6&&now<deadline){ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),waliId,orderId,'Peringatan batas konfirmasi','Besok adalah batas akhir konfirmasi pesanan '+orderNumber+'. Laporkan komplain sebelum tenggat jika ada masalah.','PENGANTARAN',false,now]);sent.day6=true;reminders++;}
      if(elapsed>=7*86400000&&now.getTime()>=deadline.getTime()){
        const orderRow=findRowById_(ss.getSheetByName('Pesanan'),orderId,1);
        if(!orderRow||String(orderRow.values[8]||'').toUpperCase()!=='DIANTAR'){skipped++;return;}
        ss.getSheetByName('KonfirmasiPengantaran').getRange(index+2,5,1,6).setValues([['DIKONFIRMASI','OTOMATIS',now,'SYSTEM',false,now]]);
        const orderSheet=ss.getSheetByName('Pesanan');orderSheet.getRange(orderRow.rowNumber,9).setValue('DITERIMA');orderSheet.getRange(orderRow.rowNumber,12).setValue(now);
        const shipRow=shipments.indexOf(shipment)+2;if(shipRow>1)ss.getSheetByName('Pengiriman').getRange(shipRow,5,1,5).setValues([['DITERIMA',shipment[5]||'',now,'SYSTEM',now]]);
        const assignments=readRows_(ss.getSheetByName('Pengantaran'));
        const active=assignments.map((r,i)=>({r:r,n:i+2})).filter(x=>String(x.r[1]||'')===orderId&&String(x.r[3]||'').toUpperCase()==='DALAM_PERJALANAN').pop();
        if(active){const assignmentSheet=ss.getSheetByName('Pengantaran');assignmentSheet.getRange(active.n,4).setValue('SELESAI');assignmentSheet.getRange(active.n,9).setValue(now);assignmentSheet.getRange(active.n,13).setValue(now);}
        ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),waliId,orderId,'Pesanan dikonfirmasi otomatis','Batas 7 hari terlewati tanpa komplain aktif. Pesanan '+orderNumber+' otomatis ditandai diterima.','PENGANTARAN',false,now]);
        writeAudit_('SYSTEM','SYSTEM','AUTO_CONFIRM_DELIVERY','PESANAN',orderId,JSON.stringify({status:'DIANTAR'}),JSON.stringify({status:'DITERIMA',confirmationMethod:'OTOMATIS'}),'Auto-konfirmasi setelah 7x24 jam tanpa komplain aktif');
        sent.day7=true;autoConfirmed++;
      }
      props.setProperty(key,JSON.stringify(sent));
    });
    SpreadsheetApp.flush();
    return {ok:true,reminders:reminders,complaintReminders:complaintReminderResult,autoConfirmed:autoConfirmed,skipped:skipped,checkedAt:now.toISOString()};
  } finally {lock.releaseLock();}
}

/** Jalankan sekali dari Apps Script Editor untuk memasang trigger per jam. */
function installDeliveryAutomationTrigger_() {
  const handler='processDeliveryAutoConfirmation_';
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===handler).forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();
  return {ok:true,message:'Trigger auto-konfirmasi FMart dipasang setiap jam.'};
}

function getDeliveryProofImage(token,orderId) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  orderId=String(orderId||'').trim();
  const ss=getSS_(),order=findRowById_(ss.getSheetByName('Pesanan'),orderId,1);
  if(!order||String(order.values[2])!==String(session.userId)) throw new Error('Pesanan tidak ditemukan.');
  const proof=readRows_(ss.getSheetByName('BuktiPengantaran')).filter(x=>String(x[1]||'')===orderId).sort((a,b)=>new Date(b[10]||0)-new Date(a[10]||0))[0];
  if(!proof||!String(proof[3]||'')) throw new Error('Bukti foto pengantaran belum tersedia.');
  const props=PropertiesService.getScriptProperties();
  const folderId=String(props.getProperty('FMART_DELIVERY_PROOF_FOLDER_ID')||'').trim();
  const paymentFolderId=String(props.getProperty('FMART_PAYMENT_PROOF_FOLDER_ID')||'').trim();
  if(!folderId||folderId===paymentFolderId) throw new Error('Folder bukti pengantaran belum dikonfigurasi dengan benar.');
  let folder;
  try{folder=DriveApp.getFolderById(folderId);}catch(e){throw new Error('Folder bukti pengantaran tidak dapat diakses.');}
  const file=DriveApp.getFileById(String(proof[3]));
  if(Number(file.getSize())>10*1024*1024) throw new Error('Ukuran file bukti pengantaran melebihi batas 10 MB.');
  const parents=file.getParents();let trusted=false;
  while(parents.hasNext()){if(parents.next().getId()===folder.getId()){trusted=true;break;}}
  if(!trusted) throw new Error('File bukti pengantaran tidak berada pada folder FMart yang ditetapkan.');
  const blob=file.getBlob(),mime=String(blob.getContentType()||'').toLowerCase(),bytes=blob.getBytes();
  if(['image/jpeg','image/png','image/webp'].indexOf(mime)<0||bytes.length>10*1024*1024) throw new Error('File bukti pengantaran tidak memenuhi ketentuan pratinjau.');
  return {ok:true,mimeType:mime,data:'data:'+mime+';base64,'+Utilities.base64Encode(bytes),fileName:String(proof[5]||'Bukti pengantaran')};
}


/** Fase 5: operasi internal FMart. Semua otorisasi dilakukan di server. */
function getOperationsDashboard(token) {
  const session = requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.KASIR, FMART.ROLES.GUDANG, FMART.ROLES.SUPERVISOR, FMART.ROLES.SUPERADMIN]);
  const ss = getSS_();
  const orders = readRows_(ss.getSheetByName('Pesanan'));
  const payments = readRows_(ss.getSheetByName('Pembayaran'));
  const proofRows = readRows_(ss.getSheetByName('BuktiPengantaran'));
  const proofByAssignment = {};
  proofRows.forEach(function(p){ const key=String(p[2]||''); if(key) proofByAssignment[key]=p; });
  const shipments = readRows_(ss.getSheetByName('Pengiriman'));
  const santri = readSantriRows_(ss.getSheetByName('Santri'));
  const products = readRows_(ss.getSheetByName('Produk'));
  const stockRows = readRows_(ss.getSheetByName('Stok'));
  const cats = readRows_(ss.getSheetByName('Kategori'));
  const variationRows = readRows_(ss.getSheetByName('VariasiProduk'));
  const users = readRows_(ss.getSheetByName('Users'));
  const userMap = {}; users.forEach(r => userMap[String(r[0])] = {name:String(r[4]||''),username:String(r[1]||'')});
  const santriMap = getSantriColumnMap_(ss.getSheetByName('Santri'));
  const childMap = {}; santri.forEach(r => { const child = santriRecord_(r,santriMap); if(child.id) childMap[child.id] = {name:child.name,className:child.className}; });
  const paymentMap = {}; payments.forEach(r => { const id=String(r[1]); const old=paymentMap[id]; if(!old || new Date(r[8]||0).getTime()>new Date(old[8]||0).getTime()) paymentMap[id]=r; });
  const shipMap = {}; shipments.forEach(r => { const id=String(r[1]); const old=shipMap[id]; if(!old || new Date(r[8]||0).getTime()>new Date(old[8]||0).getTime()) shipMap[id]=r; });
  const stockMap = {};
  stockRows.forEach(r => { const key=String(r[1])+'|'+String(r[2]||''); if(stockMap[key]===undefined) stockMap[key]=Number(r[3])||0; });
  const productMap = {}; products.forEach(r => productMap[String(r[0])] = {id:String(r[0]),categoryId:String(r[1]||''),sku:String(r[2]||''),name:String(r[3]||''),price:Number(r[5])||0,status:String(r[8]||''),photoUrl:String(r[7]||'')});
  const categoryMap = {}; cats.forEach(r => categoryMap[String(r[0])] = String(r[1]||''));
  const resultOrders = orders.slice().sort((a,b)=>new Date(b[10]||0).getTime()-new Date(a[10]||0).getTime()).slice(0,session.role===FMART.ROLES.SUPERVISOR?orders.length:60).map(r => {
    const pay=paymentMap[String(r[0])], ship=shipMap[String(r[0])], child=getOrderRecipientSnapshot_(ss,r), wali=userMap[String(r[2])];
    return {orderId:String(r[0]),number:String(r[1]),waliName:wali?wali.name:'-',childName:child?child.name:'-',className:child?child.className:'-',total:Number(r[7])||0,status:String(r[8]||''),createdAt:dateIso_(r[10]),payment:pay?{id:String(pay[0]),method:String(pay[2]||''),nominal:Number(pay[3])||0,status:String(pay[5]||''),buktiUrl:''} : null,shipment:ship?{status:String(ship[4]||''),method:String(ship[2]||''),destination:String(ship[3]||'')} : null};
  });
  let lowStock=0;
  const productStock = products.map(r => {
    const pid=String(r[0]); const vars=variationRows.filter(v=>String(v[1])===pid && String(v[6]||'').toUpperCase()==='AKTIF');
    let qty=0; if(vars.length) vars.forEach(v=>qty += Math.max(0,Number(stockMap[pid+'|'+String(v[0])])||0)); else qty=Math.max(0,Number(stockMap[pid+'|'])||0);
    const min=Number(r[6])||0; if(qty<=min) lowStock++;
    return {id:pid,name:String(r[3]||''),sku:String(r[2]||''),categoryName:categoryMap[String(r[1])]||'-',stock:qty,minStock:min,status:String(r[8]||'')};
  });
  const pendingRows=payments.filter(r=>String(r[5]||'').toUpperCase()==='MENUNGGU_VERIFIKASI').sort((a,b)=>new Date(a[8]||0).getTime()-new Date(b[8]||0).getTime());
  const queueLimit=Math.max(1,Number(getSettingValue_('PAYMENT_VERIFICATION_QUEUE_LIMIT'))||50),pendingVerification=pendingRows.length,orderById={};orders.forEach(function(r){orderById[String(r[0])]=r;});
  const mapPendingPayment=function(p){const o=orderById[String(p[1])]||[],wali=userMap[String(o[2]||'')],child=getOrderRecipientSnapshot_(ss,o);return {orderId:String(p[1]),number:String(o[1]||p[1]),waliName:wali?wali.name:'-',childName:child.name||'Santri',className:child.className||'-',total:Number(o[7])||0,createdAt:dateIso_(p[8]),orderCreatedAt:dateIso_(o[10]),status:String(o[8]||''),payment:{id:String(p[0]),method:String(p[2]||''),nominal:Number(p[3])||0,status:String(p[5]||''),buktiUrl:'',createdAt:dateIso_(p[8]),catatan:String(p[12]||'')}};};
  const canViewWaliPaymentQueue=[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN].indexOf(session.role)>=0;
  const pendingPayments=canViewWaliPaymentQueue?pendingRows.slice(0,queueLimit).map(mapPendingPayment):[];
  const countStatus=st=>orders.filter(r=>String(r[8]||'').toUpperCase()===st).length;
  if(session.role===FMART.ROLES.KASIR){
    const ownSales=readRows_(ss.getSheetByName('PenjualanToko')).filter(function(r){return String(r[13]||'')===String(session.userId);});
    const todayKey=Utilities.formatDate(new Date(),Session.getScriptTimeZone()||'Asia/Jakarta','yyyy-MM-dd');
    const todaySales=ownSales.filter(function(r){const d=r[15] instanceof Date?r[15]:new Date(r[15]||0);return !isNaN(d.getTime())&&Utilities.formatDate(d,Session.getScriptTimeZone()||'Asia/Jakarta','yyyy-MM-dd')===todayKey;});
    const waliQrisQueue=pendingRows.filter(function(p){return String(p[2]||'').toUpperCase()==='QRIS';}).slice(0,queueLimit).map(mapPendingPayment);
    const waliQrisPending=pendingRows.filter(function(p){return String(p[2]||'').toUpperCase()==='QRIS';}).length;
    return {ok:true,user:{userId:session.userId,nama:session.nama,role:session.role},stats:{cashierPendingQris:ownSales.filter(function(r){return String(r[8]||'').toUpperCase()==='QRIS'&&String(r[11]||'').toUpperCase()==='MENUNGGU_KONFIRMASI';}).length,cashierSalesToday:todaySales.length,cashierPaidToday:todaySales.filter(function(r){return String(r[11]||'').toUpperCase()==='LUNAS';}).length,pendingVerification:waliQrisPending,paymentQueueLimit:queueLimit,paymentQueueShown:waliQrisQueue.length,paymentQueueRemaining:Math.max(0,waliQrisPending-waliQrisQueue.length)},orders:[],pendingPayments:waliQrisQueue,products:[],categories:[]};
  }
  return {ok:true,user:{userId:session.userId,nama:session.nama,role:session.role},stats:{pendingVerification:pendingVerification,paymentQueueLimit:queueLimit,paymentQueueShown:pendingPayments.length,paymentQueueRemaining:Math.max(0,pendingVerification-pendingPayments.length),menungguPembayaran:countStatus('MENUNGGU_PEMBAYARAN'),menungguStok:countStatus('MENUNGGU_STOK'),dibayar:countStatus('DIBAYAR'),diproses:countStatus('DIPROSES'),disiapkan:countStatus('DISIAPKAN'),diantar:countStatus('DIANTAR'),diterima:countStatus('DITERIMA'),siapDiambil:countStatus('SIAP_DIAMBIL'),activeProducts:products.filter(r=>String(r[8]||'').toUpperCase()==='AKTIF').length,lowStock:lowStock,categories:cats.filter(r=>String(r[4]||'').toUpperCase()==='AKTIF').length},categories:cats.map(r=>({id:String(r[0]),name:String(r[1]||''),description:String(r[2]||''),order:Number(r[3])||0,status:String(r[4]||'')})),orders:resultOrders,pendingPayments:pendingPayments,products:productStock};
}




function parseWarehouseDate_(value,endOfDay){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(text))throw new Error('Format tanggal laporan tidak valid. Gunakan YYYY-MM-DD.');
  const p=text.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2],endOfDay?23:0,endOfDay?59:0,endOfDay?59:0,endOfDay?999:0);
  if(!Number.isFinite(d.getTime())||d.getFullYear()!==p[0]||d.getMonth()!==p[1]-1||d.getDate()!==p[2])throw new Error('Tanggal laporan tidak valid.');
  return d;
}

/** Tahap 6: riwayat pemenuhan, mutasi stok, dan penerimaan khusus Gudang. */
function getWarehouseHistoryReport(token, startDate, endDate) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const parseDay=function(value,endOfDay){
    const text=String(value||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error('Format periode laporan tidak valid.');
    const p=text.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2],endOfDay?23:0,endOfDay?59:0,endOfDay?59:0,endOfDay?999:0);
    if(d.getFullYear()!==p[0]||d.getMonth()!==p[1]-1||d.getDate()!==p[2])throw new Error('Tanggal laporan tidak valid.');
    return d;
  };
  const start=parseWarehouseDate_(startDate,false),end=parseWarehouseDate_(endDate,true);
  if(end<start)throw new Error('Tanggal akhir tidak boleh lebih awal dari tanggal mulai.');
  const inRange=function(value){const d=value instanceof Date?value:new Date(value||0);const t=d.getTime();return Number.isFinite(t)&&t>=start.getTime()&&t<=end.getTime();};
  const ss=getSS_();
  const users=readRows_(ss.getSheetByName('Users')),userMap={};
  users.forEach(function(r){userMap[String(r[0])]=String(r[4]||r[1]||'-');});
  const orders=readRows_(ss.getSheetByName('Pesanan')),orderMap={};
  orders.forEach(function(r){orderMap[String(r[0])]={number:String(r[1]||r[0]),childId:String(r[3]||''),status:String(r[8]||''),row:r};});
  const santriSheet=ss.getSheetByName('Santri'),santriMap=getSantriColumnMap_(santriSheet),santriNames={};
  readSantriRows_(santriSheet).forEach(function(r){const c=santriRecord_(r,santriMap);if(c.id)santriNames[c.id]=c.name;});
  const auditRows=readRows_(ss.getSheetByName('AuditLog'));
  const orderHistory=auditRows.filter(function(r){return String(r[3]||'').toUpperCase()==='UPDATE_ORDER_STATUS'&&String(r[4]||'').toUpperCase()==='PESANAN'&&inRange(r[9]);}).map(function(r){
    let before={},after={};try{before=JSON.parse(String(r[6]||'{}'));}catch(e){}try{after=JSON.parse(String(r[7]||'{}'));}catch(e){}
    const order=orderMap[String(r[5]||'')]||{};
    return {id:String(r[0]||''),orderId:String(r[5]||''),orderNumber:order.number||String(r[5]||''),childName:order.row?getOrderRecipientSnapshot_(ss,order.row).name:'-',fromStatus:String(before.status||'-'),toStatus:String(after.status||'-'),note:String(after.note||r[8]||''),actor:userMap[String(r[1])]||'-',role:String(r[2]||'-'),createdAt:dateIso_(r[9]),sortAt:new Date(r[9]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;});
  const deliverySheet=ss.getSheetByName('RiwayatPengantaran'),deliveryRows=deliverySheet?readRows_(deliverySheet):[];
  const deliveryHistory=deliveryRows.filter(function(r){return inRange(r[9]);}).map(function(r){const order=orderMap[String(r[1]||'')]||{};return {id:String(r[0]||''),orderId:String(r[1]||''),orderNumber:order.number||String(r[1]||''),childName:(order.row?getOrderRecipientSnapshot_(ss,order.row).name:'-'),assignmentId:String(r[2]||''),action:String(r[5]||''),fromStatus:String(r[6]||'-'),toStatus:String(r[7]||'-'),note:String(r[8]||''),actor:userMap[String(r[3])]||'-',role:String(r[4]||'-'),createdAt:dateIso_(r[9]),sortAt:new Date(r[9]||0).getTime()};}).sort(function(a,b){return b.sortAt-a.sortAt;});
  const products=readRows_(ss.getSheetByName('Produk')),productMap={};
  products.forEach(function(r){productMap[String(r[0])]={name:String(r[3]||'Produk tidak ditemukan'),sku:String(r[2]||'-')};});
  const variations=readRows_(ss.getSheetByName('VariasiProduk')),variationMap={};
  variations.forEach(function(r){variationMap[String(r[0])]=[String(r[2]||''),String(r[3]||'')].filter(Boolean).join(': ');});
  const mutationRows=readRows_(ss.getSheetByName('MutasiStok'));
  const stockHistory=mutationRows.filter(function(r){return inRange(r[10]);}).map(function(r){
    const p=productMap[String(r[1])]||{};
    return {id:String(r[0]||''),productName:p.name||'Produk tidak ditemukan',sku:p.sku||'-',variationName:variationMap[String(r[2])]||'',type:String(r[3]||''),qty:Number(r[4])||0,before:Number(r[5])||0,after:Number(r[6])||0,referenceId:String(r[7]||''),note:String(r[8]||''),actor:userMap[String(r[9])]||'-',createdAt:dateIso_(r[10]),sortAt:new Date(r[10]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;});
  const receiptSheet=ss.getSheetByName('PenerimaanBarang');
  const receiptRows=receiptSheet?readRows_(receiptSheet):[];
  const receivingHistory=receiptRows.filter(function(r){return inRange(r[4]||r[9]);}).map(function(r){
    return {id:String(r[0]||''),number:String(r[1]||''),supplier:String(r[2]||''),reference:String(r[3]||''),receivedAt:dateIso_(r[4]||r[9]),lineCount:Number(r[6])||0,totalQty:Number(r[7])||0,actor:userMap[String(r[8])]||'-',note:String(r[5]||''),sortAt:new Date(r[4]||r[9]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;});
  const stockRows=readRows_(ss.getSheetByName('Stok')),stockByKey={},duplicateStockKeys={};
  stockRows.forEach(function(r){const k=String(r[1]||'')+'|'+String(r[2]||'');if(Object.prototype.hasOwnProperty.call(stockByKey,k))duplicateStockKeys[k]=true;stockByKey[k]=Number(r[3]);});
  const latestMutationByKey={};mutationRows.forEach(function(r){const k=String(r[1]||'')+'|'+String(r[2]||''),t=new Date(r[10]||0).getTime();if(!latestMutationByKey[k]||t>=latestMutationByKey[k].time)latestMutationByKey[k]={row:r,time:t};});
  const stockConsistency=[];Object.keys(latestMutationByKey).forEach(function(k){const r=latestMutationByKey[k].row,p=productMap[String(r[1])]||{},actual=stockByKey[k],expected=Number(r[6]),qty=Number(r[4]),before=Number(r[5]),type=String(r[3]||'').toUpperCase(),calc=type==='MASUK'?before+qty:type==='KELUAR'?before-qty:NaN,issues=[];if(!Number.isSafeInteger(qty)||qty<1)issues.push('Qty mutasi tidak valid');if(!Number.isSafeInteger(before)||!Number.isSafeInteger(expected)||calc!==expected)issues.push('Perhitungan sebelum/sesudah tidak sesuai');if(!Number.isFinite(actual)||actual!==expected)issues.push('Stok aktual berbeda dari mutasi terakhir');if(duplicateStockKeys[k])issues.push('Baris stok duplikat');if(issues.length)stockConsistency.push({key:k,productName:p.name||'Produk tidak ditemukan',sku:p.sku||'-',variationName:variationMap[String(r[2])]||'',expected:expected,actual:Number.isFinite(actual)?actual:null,referenceId:String(r[7]||''),issues:issues.join('; '),sortAt:latestMutationByKey[k].time});});
  Object.keys(duplicateStockKeys).forEach(function(k){if(!latestMutationByKey[k]){const p=productMap[k.split('|')[0]]||{};stockConsistency.push({key:k,productName:p.name||'Produk tidak ditemukan',sku:p.sku||'-',variationName:'',expected:null,actual:stockByKey[k],referenceId:'',issues:'Baris stok duplikat',sortAt:0});}});
  stockConsistency.sort(function(a,b){return b.sortAt-a.sortAt;});
  const inbound=stockHistory.filter(function(x){return x.type.toUpperCase()==='MASUK';}).reduce(function(n,x){return n+x.qty;},0);
  const outbound=stockHistory.filter(function(x){return x.type.toUpperCase()==='KELUAR';}).reduce(function(n,x){return n+x.qty;},0);
  const counts={};orderHistory.forEach(function(x){counts[x.toStatus]=(counts[x.toStatus]||0)+1;});
  const clean=function(rows){return rows.slice(0,500).map(function(x){delete x.sortAt;return x;});};
  return {ok:true,period:{start:startDate,end:endDate},summary:{orderChanges:orderHistory.length,deliveryEvents:deliveryHistory.length,receipts:receivingHistory.length,stockMutations:stockHistory.length,inboundQty:inbound,outboundQty:outbound,stockConsistencyIssues:stockConsistency.length,orderStageChanges:counts},orderHistory:clean(orderHistory),deliveryHistory:clean(deliveryHistory),stockHistory:clean(stockHistory),receivingHistory:clean(receivingHistory),stockConsistency:stockConsistency.slice(0,500).map(function(x){delete x.sortAt;return x;}),limits:{orderHistory:500,deliveryHistory:500,stockHistory:500,receivingHistory:500,stockConsistency:500}};
}

/**
 * Tahap 14 — Kartu persediaan per produk/variasi.
 * Saldo historis dibangun dari MutasiStok; sumber saldo fisik tetap sheet Stok.
 * READ-ONLY: endpoint ini tidak mengubah data.
 */
function getStockCardReport(token, productId, variationId, startDate, endDate) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  productId=String(productId||'').trim();variationId=String(variationId||'').trim();
  if(!productId)throw new Error('Pilih produk atau variasi untuk membuka kartu persediaan.');
  const start=parseWarehouseDate_(startDate,false),end=parseWarehouseDate_(endDate,true);
  if(end<start)throw new Error('Tanggal akhir tidak boleh lebih awal dari tanggal mulai.');
  const ss=getSS_(),products=readRows_(ss.getSheetByName('Produk')),variations=readRows_(ss.getSheetByName('VariasiProduk')),stocks=readRows_(ss.getSheetByName('Stok')),mutations=readRows_(ss.getSheetByName('MutasiStok')),users=readRows_(ss.getSheetByName('Users'));
  const productMap=Object.create(null),variationMap=Object.create(null),userMap=Object.create(null);
  products.forEach(function(r){productMap[String(r[0]||'')]=r;});
  variations.forEach(function(r){variationMap[String(r[0]||'')]=r;});
  users.forEach(function(r){userMap[String(r[0]||'')]=String(r[4]||r[1]||'-');});
  const selectedProduct=productMap[productId];
  if(!selectedProduct)throw new Error('Produk tidak ditemukan.');
  if(variationId&&(!variationMap[variationId]||String(variationMap[variationId][1]||'')!==productId))throw new Error('Variasi tidak ditemukan atau bukan milik produk tersebut.');
  const items=[];
  products.forEach(function(p){
    const pid=String(p[0]||'');if(!pid)return;
    const vars=variations.filter(function(v){return String(v[1]||'')===pid;});
    const candidates=vars.length?vars.map(function(v){return {variationId:String(v[0]||''),variationName:[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': ')};}):[{variationId:'',variationName:''}];
    candidates.forEach(function(v){
      const key=pid+'|'+v.variationId,stockMatches=stocks.filter(function(s){return String(s[1]||'')+'|'+String(s[2]||'')===key;});
      items.push({key:key,productId:pid,variationId:v.variationId,label:String(p[3]||'Produk')+(v.variationName?' · '+v.variationName:'')+' ('+String(p[2]||'-')+')',stock:stockMatches.length?Number(stockMatches[0][3]):null,duplicateStockRows:stockMatches.length});
    });
  });
  const key=productId+'|'+variationId,targetMutations=[],issues=[],mutationIdCounts=Object.create(null);
  mutations.forEach(function(m,index){
    if(String(m[1]||'')+'|'+String(m[2]||'')!==key)return;
    const dt=m[10] instanceof Date?m[10]:new Date(m[10]||0),time=dt.getTime(),id=String(m[0]||'');
    if(id)mutationIdCounts[id]=(mutationIdCounts[id]||0)+1;
    if(!Number.isFinite(time)){issues.push('Tanggal mutasi pada baris '+(index+2)+' tidak valid dan tidak dapat diurutkan.');return;}
    targetMutations.push({row:index+2,id:id,type:String(m[3]||'').toUpperCase(),qty:Number(m[4]),before:Number(m[5]),after:Number(m[6]),referenceId:String(m[7]||''),note:String(m[8]||''),actor:userMap[String(m[9]||'')]||'-',createdAt:dateIso_(m[10]),time:time});
  });
  targetMutations.sort(function(a,b){return a.time-b.time||a.row-b.row;});
  Object.keys(mutationIdCounts).forEach(function(id){if(mutationIdCounts[id]>1)issues.push('ID mutasi '+id+' tercatat lebih dari satu kali.');});
  if(!targetMutations.length)issues.push('Belum ada riwayat mutasi yang valid untuk item ini; saldo historis tidak dapat direkonstruksi.');
  let previous=null,openingBalance=null,lastBalance=null;
  const validated=targetMutations.map(function(m){
    const validType=m.type==='MASUK'||m.type==='KELUAR';
    const arithmetic=validType&&Number.isSafeInteger(m.qty)&&m.qty>0&&Number.isSafeInteger(m.before)&&Number.isSafeInteger(m.after)&&m.after===(m.type==='MASUK'?m.before+m.qty:m.before-m.qty)&&m.after>=0;
    const chain=previous===null||previous===m.before;
    if(!arithmetic)issues.push('Mutasi baris '+m.row+' memiliki aritmetika tidak valid.');
    if(!chain)issues.push('Rantai saldo terputus pada mutasi baris '+m.row+'.');
    previous=m.after;lastBalance=m.after;
    return {source:m,valid:arithmetic&&chain};
  });
  const prior=validated.filter(function(x){return x.source.time<start.getTime();}),period=validated.filter(function(x){return x.source.time>=start.getTime()&&x.source.time<=end.getTime();});
  if(prior.length)openingBalance=prior[prior.length-1].source.after;
  else if(period.length)openingBalance=period[0].source.before;
  const movements=period.map(function(x){const m=x.source;return {mutationId:m.id,createdAt:m.createdAt,type:m.type,qty:m.qty,before:m.before,after:m.after,referenceId:m.referenceId,actor:m.actor,note:m.note,valid:x.valid};});
  const selectedItem=items.find(function(x){return x.key===key;});
  if(selectedItem&&selectedItem.duplicateStockRows>1)issues.push('Ditemukan '+selectedItem.duplicateStockRows+' baris stok untuk item yang sama.');
  if(selectedItem&&selectedItem.stock===null)issues.push('Baris stok fisik belum tersedia.');
  if(selectedItem&&selectedItem.stock!==null&&(!Number.isSafeInteger(selectedItem.stock)||selectedItem.stock<0))issues.push('Saldo stok fisik bukan bilangan bulat nol atau lebih.');
  if(selectedItem&&targetMutations.length&&selectedItem.stock!==lastBalance)issues.push('Stok fisik saat ini berbeda dari saldo mutasi terakhir; periksa rekonsiliasi stok.');
  const inbound=movements.filter(function(m){return m.type==='MASUK';}).reduce(function(n,m){return n+(Number(m.qty)||0);},0);
  const outbound=movements.filter(function(m){return m.type==='KELUAR';}).reduce(function(n,m){return n+(Number(m.qty)||0);},0);
  return {
    ok:true,period:{start:startDate,end:endDate},
    item:{productId:productId,variationId:variationId,name:String(selectedProduct[3]||''),sku:String(selectedProduct[2]||''),variationName:variationId?[String(variationMap[variationId][2]||''),String(variationMap[variationId][3]||'')].filter(Boolean).join(': '):''},
    summary:{openingBalance:openingBalance,inboundQty:inbound,outboundQty:outbound,closingBalance:period.length?period[period.length-1].source.after:openingBalance,currentPhysicalStock:selectedItem?selectedItem.stock:null,duplicateStockRows:selectedItem?selectedItem.duplicateStockRows:0,movementCount:movements.length},
    movements:movements,items:items,issues:issues,issueCount:issues.length,
    valuation:{available:false,value:null,reason:'Skema FMart belum menyimpan harga pokok/biaya perolehan per produk atau variasi maupun biaya satuan pada dokumen penerimaan. Harga jual tidak digunakan sebagai pengganti harga pokok.'}
  };
}

/** Fase 6: laporan operasional terhitung dari data transaksi aktual. */
function getFMartReports(token,startDate,endDate){
 const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN]),ss=getSS_();if(session.role!==FMART.ROLES.SUPERVISOR)ensureFMartCostingSchema_(ss);
 const start=parseReportDate_(startDate,false),end=parseReportDate_(endDate,true);if(end<start)throw new Error('Periode laporan tidak valid.');
 const orderDetailSheet=ss.getSheetByName('DetailPesanan'),posDetailSheet=ss.getSheetByName('DetailPenjualanToko'),orderHppUnitIndex=getHeaderColumnIndex_(orderDetailSheet,'HPPUnit')-1,orderHppSubtotalIndex=getHeaderColumnIndex_(orderDetailSheet,'HPPSubtotal')-1,orderHppStatusIndex=getHeaderColumnIndex_(orderDetailSheet,'HPPStatus')-1,posHppUnitIndex=getHeaderColumnIndex_(posDetailSheet,'HPPUnit')-1,posHppSubtotalIndex=getHeaderColumnIndex_(posDetailSheet,'HPPSubtotal')-1,posHppStatusIndex=getHeaderColumnIndex_(posDetailSheet,'HPPStatus')-1;
 const orders=readRows_(ss.getSheetByName('Pesanan')).filter(r=>inReportRange_(r[10],start,end)),details=readRows_(orderDetailSheet),allPayments=readRows_(ss.getSheetByName('Pembayaran')),payments=allPayments.filter(r=>inReportRange_(r[8],start,end));
 const posSales=readRows_(ss.getSheetByName('PenjualanToko')).filter(r=>inReportRange_(r[15],start,end)&&String(r[12]||'').toUpperCase()!=='DIBATALKAN'),posDetails=readRows_(posDetailSheet);
 const products=readRows_(ss.getSheetByName('Produk')),cats=readRows_(ss.getSheetByName('Kategori')),warehouse=readRows_(ss.getSheetByName('MutasiStok')).filter(r=>inReportRange_(r[10],start,end)),cashier=readRows_(ss.getSheetByName('MutasiStokKasir')).filter(r=>inReportRange_(r[10],start,end));
 const pmap=Object.create(null),cmap=Object.create(null),pby=Object.create(null);products.forEach(r=>{pmap[String(r[0])]=String(r[3]||'');pby[String(r[0])]=r;});cats.forEach(r=>cmap[String(r[0])]=String(r[1]||''));
 const paidIds=Object.create(null);allPayments.forEach(r=>{if(String(r[5]||'').toUpperCase()==='TERVERIFIKASI')paidIds[String(r[1])]=true;});
 const status=Object.create(null);orders.forEach(r=>{const s=String(r[8]||'').toUpperCase();status[s]=(status[s]||0)+1;});
 const validOrders=orders.filter(r=>String(r[8]||'').toUpperCase()!=='DIBATALKAN'),gross=validOrders.reduce((n,r)=>n+(Number(r[7])||0),0),paid=validOrders.filter(r=>paidIds[String(r[0])]).reduce((n,r)=>n+(Number(r[7])||0),0);
 const posPaid=posSales.filter(r=>String(r[11]||'').toUpperCase()==='LUNAS'),posGross=posSales.reduce((n,r)=>n+(Number(r[7])||0),0),posPaidTotal=posPaid.reduce((n,r)=>n+(Number(r[7])||0),0);
 const categories=Object.create(null),productSales=Object.create(null),paidOrderIds=Object.create(null);validOrders.filter(r=>paidIds[String(r[0])]).forEach(r=>paidOrderIds[String(r[0])]=true);
 let profitRevenue=0,cogs=0,hppMissingLines=0,hppMissingQty=0,hppCostedLines=0;
 function addDetail(d,include,forProfit,unitIndex,subtotalIndex,statusIndex){if(!include)return;const q=Math.max(0,Number(d[8])||0),amount=Math.max(0,Number(d[9])||0),pid=String(d[2]||''),p=pby[pid],cat=p?String(p[1]||''):'';const cn=cmap[cat]||'Tanpa Kategori';categories[cn]=(categories[cn]||0)+amount;const name=pmap[pid]||String(d[5]||'Produk');if(!productSales[name])productSales[name]={name:name,qty:0,amount:0};productSales[name].qty+=q;productSales[name].amount+=amount;if(forProfit){profitRevenue+=amount;const hs=String(d[statusIndex]||'').toUpperCase(),unit=Number(d[unitIndex]),cost=Number(d[subtotalIndex]);if(hs==='TERCATAT'&&Number.isSafeInteger(unit)&&unit>0&&Number.isSafeInteger(cost)&&cost===unit*q){cogs+=cost;hppCostedLines++;}else{hppMissingLines++;hppMissingQty+=q;}}}
 const orderIds=Object.create(null);validOrders.forEach(r=>orderIds[String(r[0])]=true);details.forEach(d=>addDetail(d,!!orderIds[String(d[1])],!!paidOrderIds[String(d[1])],orderHppUnitIndex,orderHppSubtotalIndex,orderHppStatusIndex));
 const posIds=Object.create(null);posPaid.forEach(r=>posIds[String(r[0])]=true);posDetails.forEach(d=>addDetail(d,!!posIds[String(d[1])],!!posIds[String(d[1])],posHppUnitIndex,posHppSubtotalIndex,posHppStatusIndex));
 const profitDiscount=validOrders.filter(r=>paidIds[String(r[0])]).reduce((n,r)=>n+(Number(r[6])||0),0)+posPaid.reduce((n,r)=>n+(Number(r[6])||0),0);profitRevenue=Math.max(0,profitRevenue-profitDiscount);
 const hppComplete=hppMissingLines===0,grossProfit=hppComplete?profitRevenue-cogs:null,grossMarginPercent=hppComplete&&profitRevenue>0?Math.round(grossProfit/profitRevenue*10000)/100:null;
 const methods=Object.create(null);payments.filter(r=>String(r[5]||'').toUpperCase()==='TERVERIFIKASI').forEach(r=>{const m=String(r[2]||'Lainnya');methods[m]=(methods[m]||0)+(Number(r[3])||0);});posPaid.forEach(r=>{const m=String(r[8]||'Lainnya');methods[m]=(methods[m]||0)+(Number(r[7])||0);});
 const sum=(rows,type)=>rows.filter(r=>String(r[3]||'').toUpperCase()===type).reduce((n,r)=>n+(Number(r[4])||0),0),inWh=sum(warehouse,'MASUK'),outWh=sum(warehouse,'KELUAR'),inCash=sum(cashier,'MASUK'),outCash=sum(cashier,'KELUAR'),daily=Object.create(null);
 function addDay(date,amount,isPos){const key=formatReportDay_(date);if(!daily[key])daily[key]={date:key,orders:0,posSales:0,amount:0};if(isPos)daily[key].posSales++;else daily[key].orders++;daily[key].amount+=Number(amount)||0;}
 validOrders.forEach(r=>addDay(r[10],r[7],false));posPaid.forEach(r=>addDay(r[15],r[7],true));
 return {ok:true,period:{start:start.toISOString(),end:end.toISOString(),timezone:'Asia/Jakarta',dateField:'CreatedAt'},summary:{orders:orders.length,activeOrders:orders.filter(r=>!['DITERIMA','DIBATALKAN'].includes(String(r[8]||'').toUpperCase())).length,gross:gross,paid:paid,unpaid:Math.max(0,gross-paid),averageOrder:validOrders.length?Math.round(gross/validOrders.length):0,posSales:posSales.length,posGross:posGross,posPaid:posPaidTotal,stockIn:inWh+inCash,stockOut:outWh+outCash,stockInWarehouse:inWh,stockOutWarehouse:outWh,stockInCashier:inCash,stockOutCashier:outCash,costRevenue:profitRevenue,cogs:hppComplete?cogs:null,grossProfit:grossProfit,grossMarginPercent:grossMarginPercent,hppComplete:hppComplete,hppMissingLines:hppMissingLines,hppMissingQty:hppMissingQty,hppCostedLines:hppCostedLines},statusCounts:status,categorySales:Object.keys(categories).map(k=>({name:k,amount:categories[k]})).sort((a,b)=>b.amount-a.amount),paymentMethods:Object.keys(methods).map(k=>({name:k,amount:methods[k]})).sort((a,b)=>b.amount-a.amount),daily:Object.keys(daily).sort().map(k=>daily[k]),topProducts:Object.keys(productSales).map(k=>productSales[k]).sort((a,b)=>b.amount-a.amount).slice(0,10),generatedAt:new Date().toISOString(),generatedBy:{userId:session.userId,nama:session.nama}};
}
function getFMartAuditLog(token, startDate, endDate, roleFilter, actionFilter, searchText, limit) {
  requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const start=parseReportDate_(startDate,false), end=parseReportDate_(endDate,true);
  if(end<start) throw new Error('Periode audit tidak valid.');
  const role=String(roleFilter||'').trim().toUpperCase();
  const action=String(actionFilter||'').trim().toUpperCase();
  const query=String(searchText||'').trim().toLowerCase().slice(0,100);
  const max=Math.max(1,Math.min(200,Number(limit)||100));
  const ss=getSS_();
  const users=readRows_(ss.getSheetByName('Users'));
  const userMap={};
  users.forEach(r=>{userMap[String(r[0])]={name:String(r[4]||''),username:String(r[1]||'')};});
  const rows=readRows_(ss.getSheetByName('AuditLog')).filter(r=>{
    if(!inReportRange_(r[9],start,end)) return false;
    if(role && String(r[2]||'').toUpperCase()!==role) return false;
    if(action && String(r[3]||'').toUpperCase().indexOf(action)<0) return false;
    if(query){
      const actor=userMap[String(r[1])]||{};
      const hay=[r[0],r[1],r[2],r[3],r[4],r[5],r[8],actor.name,actor.username].join(' ').toLowerCase();
      if(hay.indexOf(query)<0) return false;
    }
    return true;
  }).sort((a,b)=>new Date(b[9]||0).getTime()-new Date(a[9]||0).getTime()).slice(0,max);
  return {ok:true,rows:rows.map(r=>{
    const actor=userMap[String(r[1])]||{};
    return {id:String(r[0]||''),actorId:String(r[1]||''),actorName:actor.name||actor.username||(String(r[2]||'')==='SYSTEM'?'Sistem':'Petugas'),role:String(r[2]||''),action:String(r[3]||''),entityType:String(r[4]||''),entityId:String(r[5]||''),note:String(r[8]||'').slice(0,300),createdAt:dateIso_(r[9])};
  }),count:rows.length,limit:max,generatedAt:new Date().toISOString()};
}

function parseReportDate_(value,endOfDay){
 const text=String(value||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error('Tanggal laporan tidak valid.');
 const p=text.split('-').map(Number),d=new Date(text+(endOfDay?'T23:59:59.999+07:00':'T00:00:00.000+07:00'));
 if(!Number.isFinite(d.getTime())||d.getUTCFullYear()!==p[0]||d.getUTCMonth()!==p[1]-1||d.getUTCDate()!==p[2])throw new Error('Tanggal laporan tidak valid.');return d;
}

function inReportRange_(value,start,end){if(!value)return false;const t=new Date(value).getTime();return isFinite(t)&&t>=start.getTime()&&t<=end.getTime();}
function formatReportDay_(value){return Utilities.formatDate(new Date(value),FMART_DB.TIMEZONE||'Asia/Jakarta','yyyy-MM-dd');}

function getFMartIntegrationStatus(token){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const id=PropertiesService.getScriptProperties().getProperty('FMART_INTEGRATION_TABUNGAN_SPREADSHEET_ID')||getSettingValue_('INTEGRATION_TABUNGAN_SPREADSHEET_ID')||'';
  let connected=false, name='';
  if(id){try{const ss=SpreadsheetApp.openById(id);connected=true;name=ss.getName();}catch(e){connected=false;}}
  return {ok:true,configured:!!id,connected:connected,spreadsheetName:name,readonly:true,user:{userId:session.userId,nama:session.nama}};
}
function setFMartIntegrationTabunganId(token, spreadsheetId){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const id=String(spreadsheetId||'').trim();
  if(id){try{SpreadsheetApp.openById(id);}catch(e){throw new Error('Spreadsheet integrasi tidak dapat diakses oleh akun aplikasi.');}}
  PropertiesService.getScriptProperties().setProperty('FMART_INTEGRATION_TABUNGAN_SPREADSHEET_ID',id);
  writeAudit_(session.userId,session.role,'CONFIGURE_INTEGRATION','INTEGRATION','TABUNGAN','',JSON.stringify({configured:!!id}),'Konfigurasi integrasi Tabungan (read-only)');
  return getFMartIntegrationStatus(token);
}
function getSettingValue_(key){const s=getSS_().getSheetByName('Pengaturan');const rows=readRows_(s);const r=rows.find(x=>String(x[0])===String(key));return r?String(r[1]||''):'';}

function getAdminCatalog(token) {
  const session=requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.SUPERVISOR, FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();if(session.role!==FMART.ROLES.SUPERVISOR)ensureFMartCostingSchema_(ss);
  const categories=readRows_(ss.getSheetByName('Kategori')).map(r=>({id:String(r[0]),name:String(r[1]||''),description:String(r[2]||''),order:Number(r[3])||0,status:String(r[4]||'')}));
  const productSheet=ss.getSheetByName('Produk'),variationSheet=ss.getSheetByName('VariasiProduk'),productHppIndex=getHeaderColumnIndex_(productSheet,'HargaPokokRataRata')-1,variationHppIndex=getHeaderColumnIndex_(variationSheet,'HargaPokokRataRata')-1;
  const products=readRows_(productSheet).map(r=>({id:String(r[0]),categoryId:String(r[1]||''),sku:String(r[2]||''),name:String(r[3]||''),description:String(r[4]||''),price:Number(r[5])||0,minStock:Number(r[6])||0,photoUrl:String(r[7]||''),status:String(r[8]||''),hpp:Math.max(0,Number(r[productHppIndex])||0)}));
  const stockRows=readRows_(ss.getSheetByName('Stok')),stockByKey=Object.create(null);
  stockRows.forEach(function(r){const key=String(r[1]||'')+'|'+String(r[2]||'');if(!Object.prototype.hasOwnProperty.call(stockByKey,key))stockByKey[key]=Math.max(0,Number(r[3])||0);});
  const variations=readRows_(variationSheet).map(r=>{const key=String(r[1]||'')+'|'+String(r[0]||'');return {id:String(r[0]),productId:String(r[1]),name:String(r[2]||''),value:String(r[3]||''),priceAddition:Number(r[4])||0,stock:Object.prototype.hasOwnProperty.call(stockByKey,key)?stockByKey[key]:0,stockRecordMissing:!Object.prototype.hasOwnProperty.call(stockByKey,key),status:String(r[6]||''),hpp:Math.max(0,Number(r[variationHppIndex])||0)};});
  return {ok:true,categories:categories,products:products,variations:variations};
}

function saveCategory(token, id, name, description, order, status) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    name=String(name||'').trim().slice(0,100); description=String(description||'').trim().slice(0,500); order=Number(order)||0; status=String(status||'AKTIF').toUpperCase();
    if(!name) throw new Error('Nama kategori wajib diisi.'); if(['AKTIF','NONAKTIF'].indexOf(status)<0) throw new Error('Status kategori tidak valid.');
    const sheet=getSS_().getSheetByName('Kategori'); const now=new Date();
    if(id){const row=findRowById_(sheet,String(id),1);if(!row)throw new Error('Kategori tidak ditemukan.');const before=JSON.stringify(row.values);sheet.getRange(row.rowNumber,2,1,5).setValues([[name,description,order,status,now]]);writeAudit_(session.userId,session.role,'UPDATE_CATEGORY','KATEGORI',String(id),before,JSON.stringify({name,description,order,status}),'Perubahan kategori');}
    else {const newId=makeFMartId_('CAT');sheet.appendRow([newId,name,description,order,status,now,now]);writeAudit_(session.userId,session.role,'CREATE_CATEGORY','KATEGORI',newId,'',JSON.stringify({name,description,order,status}),'Kategori baru');}
    SpreadsheetApp.flush(); return getAdminCatalog(token);
  } finally { lock.releaseLock(); }
}


function getProductPhotoFolder_() {
  const props=PropertiesService.getScriptProperties(),key='FMART_PRODUCT_PHOTO_FOLDER_ID';
  const id=props.getProperty(key);
  if(id) { try { return DriveApp.getFolderById(id); } catch(e) { props.deleteProperty(key); } }
  const folder=DriveApp.createFolder('FMart - Foto Produk');
  props.setProperty(key,folder.getId());
  return folder;
}

function uploadProductPhoto(token, payload) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  if(!payload||typeof payload!=='object')throw new Error('Data foto produk tidak valid.');
  const mimeType=String(payload.mimeType||'').toLowerCase();
  const allowed=['image/jpeg','image/png','image/webp','image/gif'];
  if(allowed.indexOf(mimeType)<0)throw new Error('Format foto harus JPG, PNG, WEBP, atau GIF.');
  const dataUrl=String(payload.dataUrl||'');
  const match=dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if(!match||String(match[1]).toLowerCase()!==mimeType)throw new Error('Isi foto tidak valid atau formatnya tidak cocok.');
  const bytes=Utilities.base64Decode(match[2]);
  if(!bytes.length||bytes.length>500*1024)throw new Error('Ukuran foto setelah kompresi maksimal 500 KB.');
  validateUploadedFileSignature_(bytes,mimeType);
  const original=String(payload.fileName||'foto-produk').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);
  const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[mimeType];
  const name='FMart-Produk-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+original.replace(/\.[^.]+$/,'')+'.'+ext;
  const folder=getProductPhotoFolder_();
  const file=folder.createFile(Utilities.newBlob(bytes,mimeType,name));
  writeAudit_(session.userId,session.role,'UPLOAD_PRODUCT_PHOTO','PRODUK',file.getId(),'','',JSON.stringify({fileName:name,mimeType:mimeType,sizeBytes:bytes.length}));
  return {fileId:file.getId(),fileName:name,photoUrl:'https://drive.google.com/thumbnail?id='+encodeURIComponent(file.getId())+'&sz=w1200'};
}

/** Mengirim foto produk melalui sesi Apps Script jika thumbnail Drive tidak dapat dimuat oleh PWA. */
function getProductPhotoData(token,fileId){
  requireRole_(token,[FMART.ROLES.WALI_SANTRI,FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.GUDANG,FMART.ROLES.SUPERVISOR,FMART.ROLES.SUPERADMIN]);
  fileId=String(fileId||'').trim();
  if(!/^[A-Za-z0-9_-]{10,}$/.test(fileId))throw new Error('ID foto produk tidak valid.');
  const rows=readRows_(getSS_().getSheetByName('Produk'));
  const referenced=rows.some(function(row){return extractQrisDriveFileId_(row[7])===fileId;});
  if(!referenced)throw new Error('Foto tidak terdaftar pada katalog FMart.');
  const folder=getProductPhotoFolder_(),file=DriveApp.getFileById(fileId),parents=file.getParents();
  let trusted=false;while(parents.hasNext()){if(parents.next().getId()===folder.getId()){trusted=true;break;}}
  if(!trusted)throw new Error('Foto tidak berada pada folder penyimpanan FMart.');
  if(file.isTrashed())throw new Error('Foto produk sudah berada di Sampah.');
  const blob=file.getBlob(),mime=String(blob.getContentType()||'').toLowerCase(),bytes=blob.getBytes();
  if(['image/jpeg','image/png','image/webp','image/gif'].indexOf(mime)<0||!bytes.length||bytes.length>500*1024)throw new Error('Foto produk tidak memenuhi ketentuan ukuran atau format.');
  validateUploadedFileSignature_(bytes,mime);
  return {ok:true,mimeType:mime,dataUrl:'data:'+mime+';base64,'+Utilities.base64Encode(bytes),fileName:file.getName()};
}

function saveProduct(token, data) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);const ss=getSS_();
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {ensureFMartCostingSchema_(ss);
  if(!data || typeof data!=='object') throw new Error('Data produk tidak valid.');
  const id=String(data.id||'').trim(), categoryId=String(data.categoryId||'').trim(), sku=String(data.sku||'').trim().slice(0,60), name=String(data.name||'').trim().slice(0,150), description=String(data.description||'').trim().slice(0,1000), price=Math.round(Number(data.price)), minStock=Math.max(0,Math.floor(Number(data.minStock)||0)), photoUrl=String(data.photoUrl||'').trim().slice(0,500), status=String(data.status||'AKTIF').toUpperCase(),hpp=data.hpp===undefined?null:(data.hpp===''?0:Math.round(Number(data.hpp)));
  if(!categoryId||!name||!sku||!Number.isFinite(price)||price<0||(hpp!==null&&(!Number.isSafeInteger(hpp)||hpp<0)))throw new Error('Data produk atau HPP belum valid.');
  if(!/^https?:\/\//i.test(photoUrl) && photoUrl) throw new Error('Foto produk harus berupa URL http/https.');
  const cat=findRowById_(getSS_().getSheetByName('Kategori'),categoryId,1); if(!cat || String(cat.values[4]).toUpperCase()!=='AKTIF') throw new Error('Kategori tidak tersedia.');
  if(['AKTIF','NONAKTIF'].indexOf(status)<0)throw new Error('Status produk tidak valid.');
  const sheet=ss.getSheetByName('Produk'); const now=new Date();
  const rows=readRows_(sheet); if(rows.some(r=>String(r[2]).toLowerCase()===sku.toLowerCase() && String(r[0])!==id))throw new Error('SKU sudah digunakan.');
  if(id){const row=findRowById_(sheet,id,1);if(!row)throw new Error('Produk tidak ditemukan.');if(hpp!==null)assertHppChangeAllowed_(getItemHpp_(ss,id,''),hpp,getTotalItemStock_(ss,id,''),'produk');const before=JSON.stringify(row.values);sheet.getRange(row.rowNumber,2,1,9).setValues([[categoryId,sku,name,description,price,minStock,photoUrl,status,now]]);if(hpp!==null)sheet.getRange(row.rowNumber,getHeaderColumnIndex_(sheet,'HargaPokokRataRata')).setValue(hpp);writeAudit_(session.userId,session.role,'UPDATE_PRODUCT','PRODUK',id,before,JSON.stringify({categoryId,sku,name,description,price,minStock,photoUrl,status,hpp:getItemHpp_(ss,id,'')}),'Perubahan produk');}
  else {const newId=makeFMartId_('PRD');sheet.appendRow([newId,categoryId,sku,name,description,price,minStock,photoUrl,status,now,now,hpp===null?0:hpp]);writeAudit_(session.userId,session.role,'CREATE_PRODUCT','PRODUK',newId,'',JSON.stringify({categoryId,sku,name,description,price,minStock,photoUrl,status,hpp:hpp===null?0:hpp}),'Produk baru');}
  SpreadsheetApp.flush(); return getAdminCatalog(token);
  } finally { lock.releaseLock(); }
}

function saveVariation(token, data) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    if(!data||typeof data!=='object')throw new Error('Data variasi tidak valid.');
    const id=String(data.id||'').trim(),productId=String(data.productId||'').trim(),name=String(data.name||'').trim().slice(0,80),value=String(data.value||'').trim().slice(0,100),addition=Math.round(Number(data.priceAddition)||0),requestedStock=Math.max(0,Math.floor(Number(data.stock)||0)),status=String(data.status||'AKTIF').toUpperCase(),hpp=data.hpp===undefined?null:(data.hpp===''?0:Math.round(Number(data.hpp)));
    if(!productId||!name||!value||addition<0||(hpp!==null&&(!Number.isSafeInteger(hpp)||hpp<0)))throw new Error('Data variasi atau HPP belum valid.');
    if(!Number.isSafeInteger(requestedStock)||requestedStock<0)throw new Error('Stok awal variasi tidak valid.');if(!id&&requestedStock>0&&!(hpp>0))throw new Error('HPP wajib diisi jika variasi dibuat dengan stok awal.');
    if(['AKTIF','NONAKTIF'].indexOf(status)<0)throw new Error('Status variasi tidak valid.');
    const ss=getSS_();ensureFMartCostingSchema_(ss);const product=findRowById_(ss.getSheetByName('Produk'),productId,1);
    if(!product)throw new Error('Produk tidak ditemukan.');
    const sheet=ss.getSheetByName('VariasiProduk'),stockSheet=ss.getSheetByName('Stok'),stockRows=readRows_(stockSheet),now=new Date();
    let variationId=id,stock=requestedStock,beforeData='',existingVariation=null;
    if(id){
      existingVariation=findRowById_(sheet,id,1);
      if(!existingVariation)throw new Error('Variasi tidak ditemukan.');
      if(String(existingVariation.values[1]||'')!==productId)throw new Error('Variasi tidak dapat dipindahkan ke produk lain. Buat variasi baru pada produk tujuan.');
      const matches=stockRows.filter(function(r){return String(r[1])===productId&&String(r[2]||'')===id;});
      if(matches.length!==1)throw new Error(matches.length?'Ditemukan baris stok ganda untuk variasi ini. Perbaiki data Gudang sebelum menyimpan variasi.':'Baris stok variasi tidak ditemukan. Jalankan audit Gudang sebelum mengubah variasi.');
      stock=Number(matches[0][3]);
      if(!Number.isSafeInteger(stock)||stock<0)throw new Error('Saldo stok kanonis variasi tidak valid.');if(hpp!==null)assertHppChangeAllowed_(getItemHpp_(ss,productId,id),hpp,getTotalItemStock_(ss,productId,id),'variasi');
      beforeData=JSON.stringify(existingVariation.values);
    }else{
      variationId=makeFMartId_('VAR');
      if(stockRows.some(function(r){return String(r[1])===productId&&String(r[2]||'')===variationId;}))throw new Error('ID variasi bentrok dengan data stok yang sudah ada.');
    }
    // Semua validasi selesai sebelum sheet master atau stok ditulis.
    if(existingVariation){sheet.getRange(existingVariation.rowNumber,2,1,7).setValues([[productId,name,value,addition,stock,status,now]]);if(hpp!==null)sheet.getRange(existingVariation.rowNumber,getHeaderColumnIndex_(sheet,'HargaPokokRataRata')).setValue(hpp);}
    else sheet.appendRow([variationId,productId,name,value,addition,stock,status,now,now,hpp===null?0:hpp]);
    if(!existingVariation)stockSheet.appendRow([makeFMartId_('STK'),productId,variationId,stock,Math.max(0,Number(product.values[6])||0),now]);
    else{
      const stockRowNumber=stockRows.findIndex(function(r){return String(r[1])===productId&&String(r[2]||'')===variationId;})+2;
      stockSheet.getRange(stockRowNumber,4).setValue(stock);
      stockSheet.getRange(stockRowNumber,6).setValue(now);
    }
    if(!existingVariation&&stock>0){
      const mutationSheet=ss.getSheetByName('MutasiStok');
      if(!mutationSheet)throw new Error('Sheet MutasiStok tidak tersedia untuk mencatat stok awal variasi.');
      mutationSheet.appendRow([makeFMartId_('MUT'),productId,variationId,'MASUK',stock,0,stock,variationId,'Stok awal saat variasi dibuat',session.userId,now,hpp||'',0,hpp||'']);
    }
    writeAudit_(session.userId,session.role,id?'UPDATE_VARIATION':'CREATE_VARIATION','VARIASI_PRODUK',variationId,beforeData,JSON.stringify({productId,name,value,addition,stock,status,hpp:getItemHpp_(ss,productId,variationId)}),'Perubahan variasi; saldo Stok menjadi sumber utama dan stok awal variasi baru dicatat sebagai mutasi MASUK');
    SpreadsheetApp.flush();const queueResult=(!existingVariation&&stock>0)?processPendingStockOrders_(ss,session.userId,'VARIASI_BARU',session.role):{processed:0};SpreadsheetApp.flush();const catalog=getAdminCatalog(token);catalog.stockQueueProcessed=queueResult.processed;return catalog;
  }finally{lock.releaseLock();}
}

function ensureReceivingSheets_(ss) {
  const definitions=[
    {name:'PenerimaanBarang',headers:['PenerimaanId','NomorPenerimaan','Pemasok','ReferensiDokumen','TanggalTerima','Catatan','JumlahBaris','TotalQty','CreatedBy','CreatedAt']},
    {name:'DetailPenerimaanBarang',headers:['DetailPenerimaanId','PenerimaanId','ProdukId','VariasiId','Qty','StokSebelum','StokSesudah','Catatan','BiayaPerUnit','TotalBiaya']}
  ];
  definitions.forEach(function(def){
    let sheet=ss.getSheetByName(def.name);
    if(!sheet)sheet=ss.insertSheet(def.name);
    if(sheet.getMaxColumns()<def.headers.length)sheet.insertColumnsAfter(sheet.getMaxColumns(),def.headers.length-sheet.getMaxColumns());
    const current=sheet.getRange(1,1,1,def.headers.length).getValues()[0];
    def.headers.forEach(function(header,i){if(!String(current[i]||'').trim())sheet.getRange(1,i+1).setValue(header);});
    sheet.setFrozenRows(1);
  });
}

function getStockReceivingData(token) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();ensureFMartCostingSchema_(ss);ensureReceivingSheets_(ss);
  const products=getStockCatalog(token).products;
  const productRows=readRows_(ss.getSheetByName('Produk')),variationRows=readRows_(ss.getSheetByName('VariasiProduk'));
  const userRows=readRows_(ss.getSheetByName('Users')),users={};
  userRows.forEach(function(r){users[String(r[0])]=String(r[4]||r[1]||'-');});
  const pmap={};productRows.forEach(function(r){pmap[String(r[0])]=r;});
  const receipts=readRows_(ss.getSheetByName('PenerimaanBarang')).slice(-50).reverse().map(function(r){
    const receiptId=String(r[0]||'');
    const details=readRows_(ss.getSheetByName('DetailPenerimaanBarang')).filter(function(d){return String(d[1])===receiptId;});
    return {id:receiptId,number:String(r[1]||''),supplier:String(r[2]||''),reference:String(r[3]||''),receivedAt:r[4] instanceof Date?r[4].toISOString():String(r[4]||''),note:String(r[5]||''),lineCount:Number(r[6])||details.length,totalQty:Number(r[7])||0,actor:users[String(r[8])]||'-',createdAt:r[9] instanceof Date?r[9].toISOString():String(r[9]||''),items:details.map(function(d){const p=pmap[String(d[2])],v=variationRows.find(function(x){return String(x[0])===String(d[3]);});return {productName:p?String(p[3]||''):'Produk tidak ditemukan',variationName:v?[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': '):'',qty:Number(d[4])||0,before:Number(d[5])||0,after:Number(d[6])||0,unitCost:Number(d[8])||0,totalCost:Number(d[9])||0,note:String(d[7]||'')};})};
  });
  return {ok:true,products:products,receipts:receipts};
}


function recoverLegacyStockReceiptIfPending_(session,supplier,reference,note,receivedDate,rawItems,requestKey){
 const lock=LockService.getScriptLock();lock.waitLock(15000);
 try{
  const ss=getSS_();ensureFMartCostingSchema_(ss);ensureReceivingSheets_(ss);const sheet=ss.getSheetByName('PenerimaanBarang'),existing=readRows_(sheet).map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[10]||'')===requestKey);
  if(!existing)return null;
  let saved;try{saved=JSON.parse(String(existing.values[12]||'{}'));}catch(e){throw new Error('Payload pemulihan penerimaan tidak dapat dibaca. Hubungi Admin.');}
  if(!Array.isArray(saved.items)||saved.items.every(x=>Number(x.unitCost)>0))return null;
  const grouped=Object.create(null);rawItems.forEach(function(x){const pid=String(x&&x.productId||'').trim(),vid=String(x&&x.variationId||'').trim(),qty=Number(x&&x.qty);if(!pid||!Number.isInteger(qty)||qty<1)throw new Error('Data pemulihan penerimaan lama tidak valid.');const k=pid+'|'+vid;if(!grouped[k])grouped[k]={productId:pid,variationId:vid,qty:0};grouped[k].qty+=qty;});
  const legacyInput={supplier:supplier,reference:reference,note:note,receivedDate:receivedDate,items:Object.keys(grouped).sort().map(k=>grouped[k])},legacyFingerprint=sha256Hex_(JSON.stringify(legacyInput));
  if(String(existing.values[11]||'')!==legacyFingerprint)throw new Error('Kunci penerimaan lama sudah terikat pada item berbeda. Jangan ulangi dengan data yang diubah.');
  const done=completeStockReceipt_(ss,existing,saved,session.userId,session.role),queued=processPendingStockOrders_(ss,session.userId,'PENERIMAAN_BARANG',session.role);done.ordersReleased=queued.processed;done.recovered=true;done.legacyCostNotRecorded=true;return done;
 }finally{lock.releaseLock();}
}

function createStockReceipt(token,payload){
 const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);payload=payload&&typeof payload==='object'?payload:{};
 const supplier=String(payload.supplier||'').trim().slice(0,120),reference=String(payload.reference||'').trim().slice(0,100),note=String(payload.note||'').trim().slice(0,500);
 const receivedDate=String(payload.receivedDate||'').trim(),rawItems=Array.isArray(payload.items)?payload.items:[],requestKey=String(payload.requestKey||'').trim();
 if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci penerimaan tidak valid. Muat ulang formulir dan coba kembali.');
 if(!supplier)throw new Error('Nama pemasok atau asal barang wajib diisi.');
 if(rawItems.length<1||rawItems.length>100)throw new Error('Tambahkan minimal satu item penerimaan dan maksimal 100 baris.');
 let receivedAt=new Date();if(receivedDate){if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate))throw new Error('Tanggal penerimaan tidak valid.');const p=receivedDate.split('-').map(Number);receivedAt=new Date(p[0],p[1]-1,p[2],12);if(isNaN(receivedAt.getTime())||receivedAt.getFullYear()!==p[0]||receivedAt.getMonth()!==p[1]-1||receivedAt.getDate()!==p[2])throw new Error('Tanggal penerimaan tidak valid.');}
 const legacyRecovery=recoverLegacyStockReceiptIfPending_(session,supplier,reference,note,receivedDate,rawItems,requestKey);if(legacyRecovery)return legacyRecovery;
 const grouped=Object.create(null);rawItems.forEach(x=>{const pid=String(x&&x.productId||'').trim(),vid=String(x&&x.variationId||'').trim(),qty=Number(x&&x.qty),unitCost=Number(x&&x.unitCost);if(!pid||!Number.isInteger(qty)||qty<1||!Number.isSafeInteger(unitCost)||unitCost<1)throw new Error('Setiap item harus memiliki produk, jumlah, dan biaya perolehan per unit yang valid.');const k=pid+'|'+vid;if(!grouped[k])grouped[k]={productId:pid,variationId:vid,qty:0,totalCost:0};grouped[k].qty+=qty;grouped[k].totalCost+=qty*unitCost;if(!Number.isSafeInteger(grouped[k].qty)||!Number.isSafeInteger(grouped[k].totalCost))throw new Error('Jumlah atau nilai biaya penerimaan terlalu besar.');});
 const input={supplier:supplier,reference:reference,note:note,receivedDate:receivedDate,items:Object.keys(grouped).sort().map(k=>({productId:grouped[k].productId,variationId:grouped[k].variationId,qty:grouped[k].qty,totalCost:grouped[k].totalCost,unitCost:Math.round(grouped[k].totalCost/grouped[k].qty)}))},fingerprint=sha256Hex_(JSON.stringify(input));
 const lock=LockService.getScriptLock();lock.waitLock(15000);
 try{
  const ss=getSS_();ensureFMartCostingSchema_(ss);ensureReceivingSheets_(ss);const receiptSheet=ss.getSheetByName('PenerimaanBarang'),existing=readRows_(receiptSheet).map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[10]||'')===requestKey);
  if(existing){if(String(existing.values[11]||'')!==fingerprint)throw new Error('Kunci penerimaan pernah dipakai untuk data berbeda. Buat permintaan baru.');let saved;try{saved=JSON.parse(String(existing.values[12]||'{}'));}catch(e){throw new Error('Payload pemulihan penerimaan tidak dapat dibaca. Hubungi Admin.');}const done=completeStockReceipt_(ss,existing,saved,session.userId,session.role);const queued=processPendingStockOrders_(ss,session.userId,'PENERIMAAN_BARANG',session.role);done.ordersReleased=queued.processed;done.recovered=true;return done;}
  const products=readRows_(ss.getSheetByName('Produk')),variations=readRows_(ss.getSheetByName('VariasiProduk')),stocks=readRows_(ss.getSheetByName('Stok'));
  const prepared=input.items.map(item=>{
   const p=products.find(r=>String(r[0])===item.productId);if(!p||String(p[8]||'').toUpperCase()!=='AKTIF')throw new Error('Produk tidak ditemukan atau tidak aktif.');
   const activeVars=variations.filter(v=>String(v[1])===item.productId&&String(v[6]||'').toUpperCase()==='AKTIF');if(activeVars.length&&!item.variationId)throw new Error('Pilih variasi untuk produk '+String(p[3]||'')+'.');
   let v=null;if(item.variationId){v=variations.find(x=>String(x[0])===item.variationId&&String(x[1])===item.productId);if(!v||String(v[6]||'').toUpperCase()!=='AKTIF')throw new Error('Variasi tidak valid atau tidak aktif.');}
   const matches=stocks.filter(r=>String(r[1])===item.productId&&String(r[2]||'')===item.variationId);if(matches.length>1)throw new Error('Ditemukan baris stok ganda. Penerimaan dihentikan.');
   const before=matches.length?Number(matches[0][3]):(v?Number(v[5]):0);if(!Number.isSafeInteger(before)||before<0)throw new Error('Saldo stok awal tidak valid.');
   const after=before+item.qty;if(!Number.isSafeInteger(after))throw new Error('Hasil stok terlalu besar.');
   const beforeQty=getTotalItemStock_(ss,item.productId,item.variationId),beforeHpp=getItemHpp_(ss,item.productId,item.variationId),afterHpp=weightedAverageHpp_(beforeQty,beforeHpp,item.qty,item.totalCost);
   return {productId:item.productId,variationId:item.variationId,qty:item.qty,before:before,after:after,unitCost:item.unitCost,totalCost:item.totalCost,beforeHpp:beforeHpp,afterHpp:afterHpp,productMin:Math.max(0,Number(p[6])||0),stockRowExisted:matches.length>0,detailId:makeFMartId_('DRC'),mutationId:makeFMartId_('MUT'),stockId:makeFMartId_('STK')};
  });
  stocks.forEach((r)=>{});const now=new Date(),receiptId=makeFMartId_('RCV'),receiptNumber='PN-'+Utilities.formatDate(now,FMART_DB.TIMEZONE,'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase();
  const saved={supplier:supplier,reference:reference,note:note,receivedDateInput:receivedDate,receivedAt:receivedAt.toISOString(),createdAt:now.toISOString(),createdBy:session.userId,receiptNumber:receiptNumber,items:prepared};
  const totalQty=prepared.reduce((n,x)=>n+x.qty,0);if(!Number.isSafeInteger(totalQty))throw new Error('Total jumlah penerimaan terlalu besar.');
  const row=[receiptId,receiptNumber,supplier,reference,receivedAt,note,prepared.length,totalQty,session.userId,now,requestKey,fingerprint,JSON.stringify(saved)];
  receiptSheet.appendRow(row);const result=completeStockReceipt_(ss,{values:row,rowNumber:receiptSheet.getLastRow()},saved,session.userId,session.role);
  const queued=processPendingStockOrders_(ss,session.userId,'PENERIMAAN_BARANG',session.role);result.ordersReleased=queued.processed;return result;
 }finally{lock.releaseLock();}
}

function getStockCatalog(token) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();ensureFMartCostingSchema_(ss);const productSheet=ss.getSheetByName('Produk'),variationSheet=ss.getSheetByName('VariasiProduk'),productHppIndex=getHeaderColumnIndex_(productSheet,'HargaPokokRataRata')-1,variationHppIndex=getHeaderColumnIndex_(variationSheet,'HargaPokokRataRata')-1,products=readRows_(productSheet).filter(function(r){return String(r[8]||'').toUpperCase()==='AKTIF';}),vars=readRows_(variationSheet).filter(function(r){return String(r[6]||'').toUpperCase()==='AKTIF';}),stocks=readRows_(ss.getSheetByName('Stok'));
  const stockMap=Object.create(null);stocks.forEach(function(r){const key=String(r[1])+'|'+String(r[2]||'');if(!Object.prototype.hasOwnProperty.call(stockMap,key))stockMap[key]=Math.max(0,Number(r[3])||0);});
  return {ok:true,products:products.map(function(p){const pid=String(p[0]),vs=vars.filter(function(v){return String(v[1])===pid;}).map(function(v){const key=pid+'|'+String(v[0]);return {id:String(v[0]),name:String(v[2]||''),value:String(v[3]||''),stock:Object.prototype.hasOwnProperty.call(stockMap,key)?stockMap[key]:0,stockRecordMissing:!Object.prototype.hasOwnProperty.call(stockMap,key),hpp:Math.max(0,Number(v[variationHppIndex])||0)};}),baseKey=pid+'|';return {id:pid,name:String(p[3]||''),sku:String(p[2]||''),stock:Object.prototype.hasOwnProperty.call(stockMap,baseKey)?stockMap[baseKey]:0,stockRecordMissing:!Object.prototype.hasOwnProperty.call(stockMap,baseKey),hpp:Math.max(0,Number(p[productHppIndex])||0),variations:vs};})};
}


/** Data persediaan lengkap untuk panel Admin dan Gudang. Endpoint ini hanya membaca database. */
function getStockManagement(token) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const productRows=readRows_(ss.getSheetByName('Produk'));
  const categoryRows=readRows_(ss.getSheetByName('Kategori'));
  const variationRows=readRows_(ss.getSheetByName('VariasiProduk'));
  const stockRows=readRows_(ss.getSheetByName('Stok'));
  const mutationRows=readRows_(ss.getSheetByName('MutasiStok'));
  const userRows=readRows_(ss.getSheetByName('Users'));
  const categoryMap={};categoryRows.forEach(function(r){categoryMap[String(r[0])]=String(r[1]||'-');});
  const userMap={};userRows.forEach(function(r){userMap[String(r[0])]=String(r[4]||r[1]||'-');});
  const stockMap=Object.create(null);stockRows.forEach(function(r){const key=String(r[1])+'|'+String(r[2]||'');if(!Object.prototype.hasOwnProperty.call(stockMap,key))stockMap[key]=r;});
  const variationsByProduct={};
  variationRows.forEach(function(r){const pid=String(r[1]);if(!variationsByProduct[pid])variationsByProduct[pid]=[];variationsByProduct[pid].push(r);});
  const items=[];
  productRows.forEach(function(p){
    const pid=String(p[0]||'');if(!pid)return;
    const vars=variationsByProduct[pid]||[];
    const baseMin=Math.max(0,Number(p[6])||0);
    if(vars.length){
      vars.forEach(function(v){
        const vid=String(v[0]||'');const sr=stockMap[pid+'|'+vid];
        const qty=sr?Math.max(0,Number(sr[3])||0):0;
        const min=sr&&!(sr[4] instanceof Date)&&String(sr[4]||'').trim()!==''&&Number.isFinite(Number(sr[4]))?Math.max(0,Number(sr[4])||0):baseMin;
        items.push({key:pid+'|'+vid,productId:pid,variationId:vid,name:String(p[3]||''),sku:String(p[2]||''),categoryName:categoryMap[String(p[1])]||'-',variationName:[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': '),stock:qty,stockRecordMissing:!sr,minStock:min,productStatus:String(p[8]||''),variationStatus:String(v[6]||'')});
      });
    }else{
      const sr=stockMap[pid+'|'];const qty=sr?Math.max(0,Number(sr[3])||0):0;const min=sr&&!(sr[4] instanceof Date)&&String(sr[4]||'').trim()!==''&&Number.isFinite(Number(sr[4]))?Math.max(0,Number(sr[4])||0):baseMin;
      items.push({key:pid+'|',productId:pid,variationId:'',name:String(p[3]||''),sku:String(p[2]||''),categoryName:categoryMap[String(p[1])]||'-',variationName:'',stock:qty,stockRecordMissing:!sr,minStock:min,productStatus:String(p[8]||''),variationStatus:''});
    }
  });
  const history=mutationRows.map(function(m){
    const pid=String(m[1]||'');const vid=String(m[2]||'');const product=productRows.find(function(p){return String(p[0])===pid;});const variation=vid?variationRows.find(function(v){return String(v[0])===vid;}):null;
    return {id:String(m[0]||''),productName:product?String(product[3]||''):'Produk tidak ditemukan',sku:product?String(product[2]||''):'-',variationName:variation?[String(variation[2]||''),String(variation[3]||'')].filter(Boolean).join(': '):'',type:String(m[3]||''),qty:Number(m[4])||0,before:Number(m[5])||0,after:Number(m[6])||0,referenceId:String(m[7]||''),note:String(m[8]||''),actor:userMap[String(m[9])]||'-',createdAt:dateIso_(m[10]),sortAt:m[10] instanceof Date?m[10].getTime():new Date(m[10]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;}).slice(0,100).map(function(x){delete x.sortAt;return x;});
  let totalUnits=0,lowStock=0,outOfStock=0,missingStockRows=0;
  items.forEach(function(x){totalUnits+=x.stock;if(x.stockRecordMissing)missingStockRows++;if(x.stock<=0)outOfStock++;else if(x.stock<=x.minStock)lowStock++;});
  return {ok:true,summary:{totalItems:items.length,totalUnits:totalUnits,lowStock:lowStock,outOfStock:outOfStock,missingStockRows:missingStockRows},items:items,history:history};
}

function setStockMinimum(token, productId, variationId, minStock) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  productId=String(productId||'').trim();variationId=String(variationId||'').trim();minStock=Number(minStock);
  if(!productId||!Number.isInteger(minStock)||minStock<0)throw new Error('Batas stok minimum harus berupa bilangan bulat nol atau lebih.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),product=findRowById_(ss.getSheetByName('Produk'),productId,1);
    if(!product)throw new Error('Produk tidak ditemukan.');
    if(String(product.values[8]||'').toUpperCase()!=='AKTIF')throw new Error('Produk nonaktif tidak dapat diubah batas stoknya.');
    let variation=null;
    if(variationId){variation=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(!variation||String(variation.values[1])!==productId||String(variation.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Variasi tidak valid atau tidak aktif.');}
    const stockSheet=ss.getSheetByName('Stok'),stockRows=readRows_(stockSheet),index=stockRows.findIndex(r=>String(r[1])===productId&&String(r[2]||'')===variationId);
    const now=new Date(),before=index>=0?(Number(stockRows[index][4])||0):(Number(product.values[6])||0);
    if(index>=0)stockSheet.getRange(index+2,5,1,2).setValues([[minStock,now]]);
    else {if(variation&&Math.max(0,Number(variation.values[5])||0)>0)throw new Error('Baris saldo Gudang variasi belum tercatat. Jalankan audit dan rekonsiliasi stok sebelum mengatur batas minimum.');stockSheet.appendRow([makeFMartId_('STK'),productId,variationId,0,minStock,now]);}
    if(!variationId)ss.getSheetByName('Produk').getRange(product.rowNumber,7).setValue(minStock);
    writeAudit_(session.userId,session.role,'SET_STOCK_MINIMUM','STOK',productId,JSON.stringify({variationId:variationId,minStock:before}),JSON.stringify({variationId:variationId,minStock:minStock}),'Perubahan batas stok minimum');
    SpreadsheetApp.flush();return getStockManagement(token);
  }finally{lock.releaseLock();}
}

function adjustStock(token, productId, variationId, type, qty, note, requestKey, unitCost) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  productId=String(productId||'').trim();variationId=String(variationId||'').trim();type=String(type||'').toUpperCase();qty=Number(qty);note=String(note||'').trim().slice(0,300);requestKey=String(requestKey||'').trim();unitCost=unitCost===''||unitCost===null||unitCost===undefined?0:Number(unitCost);
  if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci mutasi tidak valid. Muat ulang formulir dan coba kembali.');
  if(!productId||!Number.isSafeInteger(qty)||qty<1||['MASUK','KELUAR'].indexOf(type)<0||(type==='MASUK'&&(!Number.isSafeInteger(unitCost)||unitCost<1)))throw new Error('Jumlah mutasi harus valid. Untuk stok masuk, isi biaya perolehan per unit.');
  const fingerprint=sha256Hex_(JSON.stringify({productId:productId,variationId:variationId,type:type,qty:qty,note:note,unitCost:unitCost}));
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_();ensureFMartCostingSchema_(ss);const product=findRowById_(ss.getSheetByName('Produk'),productId,1);if(!product)throw new Error('Produk tidak ditemukan.');
    const activeVariations=readRows_(ss.getSheetByName('VariasiProduk')).filter(v=>String(v[1])===productId&&String(v[6]||'').toUpperCase()==='AKTIF');if(activeVariations.length&&!variationId)throw new Error('Pilih variasi produk yang akan dimutasi.');
    let variationRow=null;if(variationId){variationRow=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(!variationRow||String(variationRow.values[1])!==productId||String(variationRow.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Variasi tidak valid atau tidak aktif.');}
    if(String(product.values[8]||'').toUpperCase()!=='AKTIF')throw new Error('Produk nonaktif tidak dapat dimutasi.');
    const sheet=ss.getSheetByName('Stok'),mutationSheet=ss.getSheetByName('MutasiStok'),currentStockRows=readRows_(sheet),stockMatches=[];
    currentStockRows.forEach(function(r,index){if(String(r[1])===productId&&String(r[2]||'')===variationId)stockMatches.push(index);});
    if(stockMatches.length>1)throw new Error('Ditemukan baris stok ganda. Mutasi dihentikan sampai data diperiksa.');
    const row=stockMatches.length?stockMatches[0]:-1,rawBefore=row>=0?Number(currentStockRows[row][3]):(variationRow?Number(variationRow.values[5]):0);
    if(!Number.isSafeInteger(rawBefore)||rawBefore<0)throw new Error('Saldo stok saat ini tidak valid.');
    const before=rawBefore,after=type==='MASUK'?before+qty:before-qty,reservedNow=(getStockReservationMap_(ss,'')[productId+'|'+variationId]||0),beforeQty=getTotalItemStock_(ss,productId,variationId),beforeHpp=getItemHpp_(ss,productId,variationId),afterHpp=type==='MASUK'?weightedAverageHpp_(beforeQty,beforeHpp,qty,qty*unitCost):beforeHpp;
    if(type==='KELUAR'&&after<reservedNow)throw new Error('Stok tidak dapat dikurangi di bawah jumlah yang sedang direservasi ('+reservedNow+' unit).');
    if(!Number.isSafeInteger(after)||after<0)throw new Error('Hasil stok tidak valid atau stok tidak mencukupi.');
    const existing=readRows_(mutationSheet).map((r,i)=>({values:r,rowNumber:i+2})).filter(x=>String(x.values[7]||'')===requestKey);
    if(existing.length>1)throw new Error('Kunci mutasi memiliki lebih dari satu catatan. Hubungi Admin untuk rekonsiliasi.');
    if(existing.length){
      const m=existing[0].values;
      if(String(m[1])!==productId||String(m[2]||'')!==variationId||String(m[3]).toUpperCase()!==type||Number(m[4])!==qty||String(m[8]||'')!==note||String(m[9]||'')!==session.userId||(type==='MASUK'&&Number(m[11])!==unitCost))throw new Error('Kunci mutasi sudah digunakan untuk transaksi berbeda.');
      const savedBefore=Number(m[5]),savedAfter=Number(m[6]);if(!Number.isSafeInteger(savedBefore)||!Number.isSafeInteger(savedAfter)||savedAfter!==(type==='MASUK'?savedBefore+qty:savedBefore-qty)||savedAfter<0)throw new Error('Jurnal mutasi tidak valid; pemulihan dihentikan.');
      const live=row>=0?Number(sheet.getRange(row+2,4).getValue()):null;
      if(live===null){if(savedBefore!==0)throw new Error('Baris saldo stok hilang; pemulihan dihentikan.');sheet.appendRow([makeFMartId_('STK'),productId,variationId,savedAfter,Number(product.values[6])||0,new Date()]);}
      else if(live===savedBefore){sheet.getRange(row+2,4).setValue(savedAfter);sheet.getRange(row+2,6).setValue(new Date());}
      else if(live!==savedAfter)throw new Error('Saldo stok tidak cocok dengan jurnal mutasi; pemulihan dihentikan.');
      if(variationId&&variationRow){const mirror=Number(variationRow.values[5]);if(mirror===savedBefore)ss.getSheetByName('VariasiProduk').getRange(variationRow.rowNumber,6,1,3).setValues([[savedAfter,String(variationRow.values[6]||'AKTIF'),new Date()]]);else if(mirror!==savedAfter)throw new Error('Saldo variasi tidak cocok dengan jurnal mutasi.');}
      if(type==='MASUK')applyHppTransition_(ss,productId,variationId,Number(m[12])||0,Number(m[13])||afterHpp);
      SpreadsheetApp.flush();const queue=type==='MASUK'?processPendingStockOrders_(ss,session.userId,'PENYESUAIAN_STOK',session.role):{processed:0};const dashboard=getOperationsDashboard(token);dashboard.stockQueueProcessed=queue.processed;dashboard.duplicate=true;return dashboard;
    }
    const now=new Date(),mutationId=makeFMartId_('MUT');
    mutationSheet.appendRow([mutationId,productId,variationId,type,qty,before,after,requestKey,note,session.userId,now,type==='MASUK'?unitCost:'',type==='MASUK'?beforeHpp:'',type==='MASUK'?afterHpp:'']);
    SpreadsheetApp.flush();
    if(row>=0){const live=Number(sheet.getRange(row+2,4).getValue());if(live!==before)throw new Error('Saldo stok berubah atau tidak valid. Muat ulang data Gudang.');sheet.getRange(row+2,4).setValue(after);sheet.getRange(row+2,6).setValue(now);}
    else sheet.appendRow([makeFMartId_('STK'),productId,variationId,after,Number(product.values[6])||0,now]);
    if(variationId&&variationRow)ss.getSheetByName('VariasiProduk').getRange(variationRow.rowNumber,6,1,3).setValues([[after,String(variationRow.values[6]||'AKTIF'),now]]);
    if(type==='MASUK')applyHppTransition_(ss,productId,variationId,beforeHpp,afterHpp);
    writeAudit_(session.userId,session.role,'ADJUST_STOCK','STOK',requestKey,'',JSON.stringify({productId:productId,variationId:variationId,stockBefore:before,stockAfter:after,type:type,qty:qty}),'Mutasi stok manual',now);
    SpreadsheetApp.flush();const queue=type==='MASUK'?processPendingStockOrders_(ss,session.userId,'PENYESUAIAN_STOK',session.role):{processed:0};SpreadsheetApp.flush();const dashboard=getOperationsDashboard(token);dashboard.stockQueueProcessed=queue.processed;return dashboard;
  }finally{lock.releaseLock();}
}

function buildOrderStockPlan_(ss,orderId){
 const details=readRows_(ss.getSheetByName('DetailPesanan')).filter(r=>String(r[1])===String(orderId));
 if(!details.length)throw new Error('Detail pesanan tidak ditemukan.');
 const grouped=Object.create(null),reserved=getStockReservationMap_(ss,String(orderId)),stocks=readRows_(ss.getSheetByName('Stok'));
 const orderMutations=readRows_(ss.getSheetByName('MutasiStok')).filter(r=>String(r[7]||'')===String(orderId)&&String(r[3]||'').toUpperCase()==='KELUAR');
 details.forEach(d=>{const pid=String(d[2]||''),vid=String(d[3]||''),qty=Number(d[8]),key=pid+'|'+vid;if(!pid||!Number.isSafeInteger(qty)||qty<1)throw new Error('Jumlah barang pada pesanan tidak valid.');if(!grouped[key])grouped[key]={pid:pid,vid:vid,qty:0};grouped[key].qty+=qty;});
 const plan=[],missing=[];
 Object.keys(grouped).forEach(key=>{
  const x=grouped[key],snap=getProductSnapshot_(ss,x.pid,x.vid,'GUDANG'),matches=[];
  stocks.forEach((r,i)=>{if(String(r[1])===x.pid&&String(r[2]||'')===x.vid)matches.push(i);});
  if(matches.length>1)throw new Error('Baris stok Gudang ganda ditemukan.');
  const prior=orderMutations.filter(m=>String(m[1])===x.pid&&String(m[2]||'')===x.vid);
  if(prior.length>1)throw new Error('Mutasi keluar pesanan ganda ditemukan. Rekonsiliasi diperlukan sebelum melanjutkan.');
  if(prior.length){
   const m=prior[0],qty=Number(m[4]),before=Number(m[5]),after=Number(m[6]),current=matches.length?Number(stocks[matches[0]][3]):Number(snap&&snap.stock);
   if(qty!==x.qty||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after!==before-qty||after<0)throw new Error('Mutasi stok pesanan tidak konsisten.');
   if(!Number.isSafeInteger(current)||(current!==before&&current!==after))throw new Error('Saldo stok tidak cocok dengan mutasi pesanan; pemulihan dihentikan.');
   plan.push({pid:x.pid,vid:x.vid,qty:x.qty,before:before,after:after,index:matches.length?matches[0]:-1,existingMutation:true});
   return;
  }
  const before=matches.length?Number(stocks[matches[0]][3]):Number(snap&&snap.stock||0),other=Number(reserved[key]||0);
  if(!snap||!snap.active||!Number.isSafeInteger(before)||before<0||x.qty+other>before){missing.push({key:key,requested:x.qty,available:Math.max(0,(Number.isSafeInteger(before)?before:0)-other)});return;}
  plan.push({pid:x.pid,vid:x.vid,qty:x.qty,before:before,after:before-x.qty,index:matches.length?matches[0]:-1,existingMutation:false});
 });
 return {available:missing.length===0,plan:plan,missing:missing};
}

function applyOrderStockPlan_(ss,orderId,plan,actor,now,finalizeReservations){
 ensureFMartCostingSchema_(ss);
 const stock=ss.getSheetByName('Stok'),vars=ss.getSheetByName('VariasiProduk'),mut=ss.getSheetByName('MutasiStok');
 plan.forEach(x=>{
  const matches=readRows_(mut).map((r,i)=>({row:r,rowNumber:i+2})).filter(m=>String(m.row[7]||'')===String(orderId)&&String(m.row[1]||'')===String(x.pid)&&String(m.row[2]||'')===String(x.vid||'')&&String(m.row[3]||'').toUpperCase()==='KELUAR');
  if(matches.length>1)throw new Error('Mutasi stok ganda untuk pesanan '+orderId+'.');
  const mutation=matches[0]||null;
  if(mutation){const m=mutation.row;if(Number(m[4])!==Number(x.qty)||Number(m[5])!==Number(x.before)||Number(m[6])!==Number(x.after))throw new Error('Mutasi stok pesanan tidak sesuai dengan detail.');}
  else {captureSaleDetailHpp_(ss,'DetailPesanan',orderId,x.pid,x.vid);mut.appendRow([makeFMartId_('MUT'),x.pid,x.vid,'KELUAR',x.qty,x.before,x.after,String(orderId),'Penjualan '+orderId,String(actor||'SYSTEM'),now]);}
  const liveRow=x.index>=0?stock.getRange(x.index+2,1,1,6).getValues()[0]:null;
  const live=liveRow?Number(liveRow[3]):Number((getProductSnapshot_(ss,x.pid,x.vid,'GUDANG')||{}).stock);
  if(live===Number(x.before)){
   if(liveRow){stock.getRange(x.index+2,4).setValue(x.after);stock.getRange(x.index+2,6).setValue(now);}
   else{const p=findRowById_(ss.getSheetByName('Produk'),x.pid,1);stock.appendRow([makeFMartId_('STK'),x.pid,x.vid,x.after,p?Math.max(0,Number(p.values[6])||0):0,now]);}
  }else if(live!==Number(x.after))throw new Error('Saldo stok berubah. Pemulihan transaksi dihentikan.');
  if(x.vid){const v=findRowById_(vars,x.vid,1);if(v){const mirror=Number(v.values[5]);if(mirror===Number(x.before))vars.getRange(v.rowNumber,6,1,3).setValues([[x.after,String(v.values[6]||'AKTIF'),now]]);else if(mirror!==Number(x.after))throw new Error('Saldo variasi tidak cocok dengan mutasi pesanan.');}}
 });
 if(finalizeReservations!==false)setOrderReservationStatus_(ss,orderId,'DIGUNAKAN');
}

function setOrderFulfillmentStatus_(ss,order,status,actor,note,now){
 ss.getSheetByName('Pesanan').getRange(order.rowNumber,9,1,3).setValues([[status,String(note||order.values[9]||''),now]]);
 const sh=ss.getSheetByName('Pengiriman'),row=latestShipmentRow_(sh,String(order.values[0]));if(row)sh.getRange(row,5,1,5).setValues([[status,'','',String(actor||'SYSTEM'),now]]);
}
function processPendingStockOrders_(ss,actor,source,actorRole){
 const sheet=ss.getSheetByName('Pesanan'),payments=readRows_(ss.getSheetByName('Pembayaran'));
 const orders=readRows_(sheet).map((r,i)=>({values:r,rowNumber:i+2})).filter(o=>String(o.values[8]||'').toUpperCase()==='MENUNGGU_STOK').sort((a,b)=>new Date(a.values[10]||0)-new Date(b.values[10]||0));
 const blocked=Object.create(null),done=[];
 orders.forEach(order=>{
  const id=String(order.values[0]),pay=latestPaymentForOrder_(payments,id);if(!pay||String(pay.status).toUpperCase()!=='TERVERIFIKASI')return;
  const plan=buildOrderStockPlan_(ss,id),recovery=plan.plan.filter(x=>x.existingMutation);
  // Pulihkan lebih dulu item yang sudah memiliki jejak mutasi, walaupun item lain masih kekurangan stok.
  if(recovery.length)applyOrderStockPlan_(ss,id,recovery,actor||'SYSTEM',new Date(),false);
  if(plan.missing.some(m=>blocked[m.key]))return;
  if(!plan.available){plan.missing.forEach(m=>blocked[m.key]=true);return;}
  const now=new Date(),fresh=buildOrderStockPlan_(ss,id);
  if(!fresh.available){fresh.missing.forEach(m=>blocked[m.key]=true);return;}
  applyOrderStockPlan_(ss,id,fresh.plan,actor||'SYSTEM',now,true);
  setOrderFulfillmentStatus_(ss,order,'DIBAYAR',actor||'SYSTEM','Stok lengkap. Pesanan siap diproses Gudang.',now);
  writeAudit_(actor||'SYSTEM',actorRole||(actor==='SYSTEM'?'SYSTEM':'GUDANG'),'UPDATE_ORDER_STATUS','PESANAN',id,JSON.stringify({status:'MENUNGGU_STOK'}),JSON.stringify({status:'DIBAYAR'}),'Stok pesanan lengkap; siap diproses',now);
  ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),id,'Pesanan sedang diproses','Pesanan Anda sedang diproses. Kami akan menginformasikan perkembangan selanjutnya melalui aplikasi.','PESANAN',false,now]);
  writeAudit_(actor||'SYSTEM',actorRole||(actor==='SYSTEM'?'SYSTEM':'GUDANG'),'FULFILL_WAITING_STOCK_ORDER','PESANAN',id,JSON.stringify({status:'MENUNGGU_STOK'}),JSON.stringify({status:'DIBAYAR',source:String(source||'STOCK_IN')}),'Stok lengkap; pesanan masuk antrean pemenuhan',now);
  done.push(id);
 });
 return {processed:done.length,orderIds:done};
}

function validateQrisPaymentForApproval_(payment, order) {
  if (!payment || !order) throw new Error('Data pembayaran atau pesanan tidak lengkap.');
  if (String(payment[1] || '') !== String(order[0] || '')) throw new Error('Identitas pesanan pada pembayaran tidak cocok.');
  if (String(payment[11] || '') !== String(order[2] || '')) throw new Error('Identitas Wali pengaju pembayaran tidak cocok dengan pemilik pesanan.');
  if (String(payment[2] || '').trim().toUpperCase() !== 'QRIS') throw new Error('Persetujuan hanya dapat diberikan untuk pembayaran QRIS.');
  const nominal = Number(payment[3]), total = Number(order[7]);
  if (!Number.isSafeInteger(nominal) || nominal < 1 || !Number.isSafeInteger(total) || total < 1 || nominal !== total) throw new Error('Nominal pembayaran QRIS tidak sama dengan total pesanan. Periksa kembali sebelum menyetujui.');
  return true;
}

function verifyPayment(token,paymentId,decision,note){
 const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN,FMART.ROLES.KASIR]);paymentId=String(paymentId||'').trim();decision=String(decision||'').toUpperCase();note=String(note||'').trim().slice(0,300);if(!paymentId||['TERIMA','TOLAK'].indexOf(decision)<0)throw new Error('Keputusan pembayaran tidak valid.');
 const lock=LockService.getScriptLock();lock.waitLock(15000);
 try{
  const ss=getSS_();expireStockReservations_(ss,new Date());
  const ps=ss.getSheetByName('Pembayaran'),pay=findRowById_(ps,paymentId,1);if(!pay)throw new Error('Pengajuan pembayaran tidak ditemukan.');
  const os=ss.getSheetByName('Pesanan'),order=findRowById_(os,String(pay.values[1]),1);if(!order)throw new Error('Pesanan terkait tidak ditemukan.');
  const paymentStatus=String(pay.values[5]||'').toUpperCase(),orderStatus=String(order.values[8]||'').toUpperCase(),paymentMethod=String(pay.values[2]||'').trim().toUpperCase(),id=String(order.values[0]);
  if(session.role===FMART.ROLES.KASIR && paymentMethod!=='QRIS')throw new Error('Kasir hanya berwenang memproses pembayaran QRIS Wali Santri.');

  // Jika proses sebelumnya terputus setelah pembayaran ditandai terverifikasi,
  // izinkan Admin melanjutkan tahap pemenuhan tanpa memverifikasi/mengurangi stok dua kali.
  if(paymentStatus==='TERVERIFIKASI'){
   if(decision!=='TERIMA')throw new Error('Pembayaran sudah terverifikasi dan tidak dapat ditolak.');
   validateQrisPaymentForApproval_(pay.values,order.values);
   const paidStatuses=['DIBAYAR','DIPROSES','DISIAPKAN','SIAP_DIAMBIL','DIANTAR','DITERIMA'];
   if(orderStatus==='MENUNGGU_PEMBAYARAN'){
    const now=new Date();
    setOrderReservationStatus_(ss,id,'MENUNGGU_STOK');
    setOrderFulfillmentStatus_(ss,order,'MENUNGGU_STOK','SYSTEM','Pembayaran terverifikasi. Menunggu seluruh jumlah barang tersedia di Gudang.',now);
    SpreadsheetApp.flush();
    const auditRows=readRows_(ss.getSheetByName('AuditLog'));
    if(!auditRows.some(function(r){return String(r[3]||'').toUpperCase()==='UPDATE_ORDER_STATUS'&&String(r[4]||'').toUpperCase()==='PESANAN'&&String(r[5]||'')===id&&String(r[7]||'').indexOf('MENUNGGU_STOK')>=0;}))
     writeAudit_(session.userId,session.role,'UPDATE_ORDER_STATUS','PESANAN',id,JSON.stringify({status:'MENUNGGU_PEMBAYARAN'}),JSON.stringify({status:'MENUNGGU_STOK'}),'Pemulihan: pembayaran terverifikasi; menunggu stok Gudang',now);
   }else if(orderStatus!=='MENUNGGU_STOK'&&paidStatuses.indexOf(orderStatus)<0){
    throw new Error('Status pesanan tidak dapat melanjutkan pemulihan pembayaran terverifikasi.');
   }
   if(orderStatus==='MENUNGGU_PEMBAYARAN'||orderStatus==='MENUNGGU_STOK')processPendingStockOrders_(ss,session.userId,'PEMULIHAN_VERIFIKASI_PEMBAYARAN',session.role);
   const notifications=readRows_(ss.getSheetByName('Notifikasi'));
   if(!notifications.some(function(r){return String(r[2]||'')===id&&String(r[3]||'')==='Pembayaran terverifikasi';})){
    const message='Pembayaran pesanan '+String(order.values[1])+' telah diverifikasi. Pesanan sedang diproses dan perkembangan berikutnya akan diinformasikan melalui aplikasi.';
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),id,'Pembayaran terverifikasi',message,'PEMBAYARAN',false,new Date()]);
   }
   const auditRows=readRows_(ss.getSheetByName('AuditLog'));
   if(!auditRows.some(function(r){return String(r[3]||'').toUpperCase()==='VERIFY_PAYMENT'&&String(r[5]||'')===paymentId;}))
    writeAudit_(session.userId,session.role,'VERIFY_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI',orderId:id}),JSON.stringify({status:'TERVERIFIKASI',orderStatus:orderStatus}),'Pemulihan efek samping verifikasi pembayaran');
   SpreadsheetApp.flush();return getOperationsDashboard(token);
  }

  if(paymentStatus!=='MENUNGGU_VERIFIKASI')throw new Error('Pembayaran sudah diproses.');
  if(orderStatus!=='MENUNGGU_PEMBAYARAN')throw new Error('Status pesanan tidak sesuai.');
  const now=new Date();
  if(decision==='TOLAK'){
   setOrderReservationStatus_(ss,id,'DILEPAS');ps.getRange(pay.rowNumber,6,1,3).setValues([['DITOLAK','','']]);ps.getRange(pay.rowNumber,10).setValue(now);
   if(note)ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),id,'Pembayaran ditolak',note,'PEMBAYARAN',false,now]);
   writeAudit_(session.userId,session.role,'REJECT_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI'}),JSON.stringify({status:'DITOLAK',note:note}),'Pembayaran ditolak');SpreadsheetApp.flush();return getOperationsDashboard(token);
  }
  validateQrisPaymentForApproval_(pay.values,order.values);
  ps.getRange(pay.rowNumber,6,1,3).setValues([['TERVERIFIKASI',session.userId,now]]);ps.getRange(pay.rowNumber,10).setValue(now);
  setOrderReservationStatus_(ss,id,'MENUNGGU_STOK');
  setOrderFulfillmentStatus_(ss,order,'MENUNGGU_STOK','SYSTEM','Pembayaran terverifikasi. Menunggu seluruh jumlah barang tersedia di Gudang.',now);SpreadsheetApp.flush();
  writeAudit_(session.userId,session.role,'UPDATE_ORDER_STATUS','PESANAN',id,JSON.stringify({status:'MENUNGGU_PEMBAYARAN'}),JSON.stringify({status:'MENUNGGU_STOK'}),'Pembayaran terverifikasi; menunggu stok Gudang lengkap',now);
  processPendingStockOrders_(ss,session.userId,'VERIFIKASI_PEMBAYARAN',session.role);
  const refreshed=findRowById_(os,id,1),nextStatus=refreshed?String(refreshed.values[8]||'MENUNGGU_STOK'):'MENUNGGU_STOK';
  const notifications=readRows_(ss.getSheetByName('Notifikasi'));
  if(!notifications.some(function(r){return String(r[2]||'')===id&&String(r[3]||'')==='Pembayaran terverifikasi';})){
   const message='Pembayaran pesanan '+String(order.values[1])+' telah diverifikasi. Pesanan sedang diproses dan perkembangan berikutnya akan diinformasikan melalui aplikasi.';
   ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),id,'Pembayaran terverifikasi',message,'PEMBAYARAN',false,now]);
  }
  const auditRows=readRows_(ss.getSheetByName('AuditLog'));
  if(!auditRows.some(function(r){return String(r[3]||'').toUpperCase()==='VERIFY_PAYMENT'&&String(r[5]||'')===paymentId;}))
   writeAudit_(session.userId,session.role,'VERIFY_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI',orderId:id}),JSON.stringify({status:'TERVERIFIKASI',orderStatus:nextStatus}),'Pembayaran diverifikasi; alokasi mengikuti antrean stok FIFO');
  SpreadsheetApp.flush();return getOperationsDashboard(token);
 }finally{lock.releaseLock();}
}

function updateOrderOperation(token, orderId, nextStatus, shipmentStatus, note) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  orderId=String(orderId||'').trim();nextStatus=String(nextStatus||'').toUpperCase();note=String(note||'').trim().slice(0,300);
  if(!orderId)throw new Error('Pesanan tidak valid.');
  if(nextStatus==='DIBATALKAN' && session.role==='GUDANG')throw new Error('Gudang tidak berwenang membatalkan pesanan.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),orderSheet=ss.getSheetByName('Pesanan'),row=findRowById_(orderSheet,orderId,1);
    if(!row)throw new Error('Pesanan tidak ditemukan.');
    const current=String(row.values[8]||'').toUpperCase();
    const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    const method=String(shipment&&shipment.method||'').toUpperCase();
    const isPickup=method==='AMBIL_FMART';
    const allowed=['DIBAYAR','DIPROSES','DISIAPKAN','SIAP_DIAMBIL','DIANTAR','DIBATALKAN'];
    if(allowed.indexOf(nextStatus)<0)throw new Error('Status pesanan tidak valid.');
    if(method==='ANTAR_PESANTREN'&&(nextStatus==='SIAP_DIAMBIL'||nextStatus==='DIANTAR'))throw new Error('Pesanan Antar Pesantren hanya dapat menjadi DIANTAR melalui Petugas Pengantar.');
    if(isPickup&&(nextStatus==='DIANTAR'||nextStatus==='SIAP_DIAMBIL'&&current!=='DISIAPKAN'))throw new Error('Pesanan Ambil di FMart hanya dapat menjadi SIAP_DIAMBIL setelah disiapkan Gudang.');
    if(isPickup&&nextStatus==='DITERIMA')throw new Error('Penerimaan Ambil di FMart harus dikonfirmasi oleh Wali setelah barang diserahkan.');
    const orderFlow={DIBAYAR:['DIPROSES'],DIPROSES:['DISIAPKAN'],DISIAPKAN:isPickup?['SIAP_DIAMBIL']:[],SIAP_DIAMBIL:['DITERIMA'],DIANTAR:['DITERIMA'],DITERIMA:[],MENUNGGU_PEMBAYARAN:['DIBATALKAN'],DIBATALKAN:[]};
    if(!orderFlow[current]||orderFlow[current].indexOf(nextStatus)<0)throw new Error('Perubahan status '+current+' ke '+nextStatus+' tidak diperbolehkan.');
    if(session.role==='GUDANG'){
      const paidRows=readRows_(ss.getSheetByName('Pembayaran')).filter(p=>String(p[1])===orderId).sort((a,b)=>new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime());
      if(!paidRows.length||String(paidRows[0][5]||'').toUpperCase()!=='TERVERIFIKASI')throw new Error('Pesanan belum memiliki pembayaran terverifikasi. Gudang belum dapat memproses pesanan ini.');
      if(['DIPROSES','DISIAPKAN','SIAP_DIAMBIL'].indexOf(nextStatus)<0)throw new Error('Gudang hanya dapat menjalankan tahapan pemenuhan pesanan.');
    }
    if(nextStatus==='SIAP_DIAMBIL'&&!isPickup)throw new Error('Status SIAP_DIAMBIL hanya berlaku untuk metode Ambil di FMart.');
    const now=new Date();
    orderSheet.getRange(row.rowNumber,9,1,3).setValues([[nextStatus,note||row.values[9],now]]);
    if(nextStatus==='DIBATALKAN'){setOrderReservationStatus_(ss,orderId,'DILEPAS');const paymentSheet=ss.getSheetByName('Pembayaran');readRows_(paymentSheet).forEach(function(p){if(String(p[1])===orderId&&String(p[5]||'').toUpperCase()==='MENUNGGU_VERIFIKASI'){const pr=findRowById_(paymentSheet,String(p[0]),1);if(pr)paymentSheet.getRange(pr.rowNumber,6,1,3).setValues([['DITOLAK',session.userId,now]]);}});}
    const shipSheet=ss.getSheetByName('Pengiriman'),shipRow=latestShipmentRow_(shipSheet,orderId);
    const shipStatus=nextStatus;
    if(shipRow)shipSheet.getRange(shipRow,5,1,5).setValues([[shipStatus,nextStatus==='SIAP_DIAMBIL'?now:(shipment&&shipment.dikirimAt||''),shipment&&shipment.diterimaAt||'',session.userId,now]]);
    else shipSheet.appendRow([makeFMartId_('SHP'),orderId,method,'',shipStatus,'','',session.userId,now]);
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(row.values[2]),orderId,nextStatus==='SIAP_DIAMBIL'?'Pesanan siap diambil':'Status pesanan diperbarui',nextStatus==='SIAP_DIAMBIL'?'Pesanan '+String(row.values[1])+' sudah siap diambil di FMart. Silakan datang ke lokasi pengambilan.':'Pesanan '+String(row.values[1])+' sekarang '+nextStatus+'.','PESANAN',false,now]);
    writeAudit_(session.userId,session.role,'UPDATE_ORDER_STATUS','PESANAN',orderId,JSON.stringify({status:current,shipmentStatus:shipment&&shipment.status||''}),JSON.stringify({status:nextStatus,shipmentStatus:shipStatus,note:note}),'Perubahan status pesanan dan pemenuhan');
    SpreadsheetApp.flush();return getOperationsDashboard(token);
  }finally{lock.releaseLock();}
}
function createStaffUser(token, username, password, nama, role, email) {
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    email=normalizeEmail_(email);
    if(!isValidStaffEmail_(email)) throw new Error('Email staf wajib diisi dengan format yang valid.');
    username=email;
    role=String(role||'').trim().toUpperCase();
    if(['ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR'].indexOf(role)<0) throw new Error('Peran petugas tidak valid.');
    const result=createFMartUser_(username,password,nama,role,email);
    writeAudit_(session.userId,session.role,'CREATE_USER','USER',result.userId,'',JSON.stringify({username:result.username,role:result.role}),'Membuat pengguna');
    SpreadsheetApp.flush();
    return getOperationsDashboard(token);
  } finally { lock.releaseLock(); }
}

function upsertStockRow_(ss,productId,variationId,qty,userId){const sheet=ss.getSheetByName('Stok');const rows=readRows_(sheet);const idx=rows.findIndex(r=>String(r[1])===String(productId)&&String(r[2]||'')===String(variationId||''));const now=new Date();if(idx>=0){sheet.getRange(idx+2,4).setValue(Math.max(0,Number(qty)||0));sheet.getRange(idx+2,6).setValue(now);}else{const product=findRowById_(ss.getSheetByName('Produk'),productId,1);const minimum=product?Math.max(0,Number(product.values[6])||0):0;sheet.appendRow([makeFMartId_('STK'),productId,variationId,Math.max(0,Number(qty)||0),minimum,now]);}}

/** Tahap 4: daftar akun petugas; data sensitif autentikasi tidak pernah dikirim ke browser. */
function getStaffUserManagement(token) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const rows=readRows_(getSS_().getSheetByName('Users'));
  const users=rows.map(function(r){
    const user={userId:String(r[0]||''),username:String(r[1]||''),email:String(r[10]||r[1]||''),nama:String(r[4]||''),role:String(r[5]||''),status:String(r[6]||''),createdAt:dateIso_(r[7]),lastLoginAt:dateIso_(r[9])};
    if(session.role===FMART.ROLES.SUPERADMIN) user.emailVerified=String(r[11]||'').toUpperCase()==='TRUE'||r[11]===true;
    return user;
  }).filter(function(u){return u.userId && ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR'].indexOf(u.role)>=0;});
  return {ok:true,users:users,canManage:session.role==='SUPERADMIN',currentUserId:session.userId};
}

/** Fase 8.8/8.12.1: Manajemen pengguna dan verifikasi relasi Wali Santri. */
function getUserManagement(token) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const usersSheet=ss.getSheetByName('Users');
  const waliSheet=ss.getSheetByName('WaliSantri');
  const relSheet=ss.getSheetByName('WaliSantriSantri');
  if(!usersSheet) throw new Error('Data pengguna belum siap. Sheet Users tidak ditemukan.');
  if(!waliSheet) throw new Error('Data Wali Santri belum siap. Sheet WaliSantri tidak ditemukan.');
  const santriSheet=ss.getSheetByName('Santri'), santriColumnMap=getSantriColumnMap_(santriSheet);
  const userRows=readRows_(usersSheet), waliRows=readRows_(waliSheet), relRows=relSheet?readRows_(relSheet):[], santriRows=readSantriRows_(santriSheet);
  const userMap={};
  userRows.forEach(function(r){const uid=String(r[0]||'');if(uid) userMap[uid]={userId:uid,username:String(r[1]||''),nama:String(r[4]||''),role:String(r[5]||''),status:String(r[6]||''),emailVerified:(String(r[11]||'').toUpperCase()==='TRUE'||r[11]===true),createdAt:dateIso_(r[7]),lastLoginAt:dateIso_(r[9])};});
  const santriMap={};
  santriRows.forEach(function(r){const child=santriRecord_(r,santriColumnMap);if(child.id)santriMap[child.id]=child;});
  const waliSantri=waliRows.map(function(r){
    const waliId=String(r[0]||''), userId=String(r[1]||''), u=userMap[userId]||{};
    const own=relRows.filter(function(x){return String(x[1]||'')===waliId;});
    const children=own.filter(function(x){return String(x[3]||'').toUpperCase()==='AKTIF';}).map(function(x){const c=santriMap[String(x[2]||'')];return c?{id:c.id,nis:c.nis,name:c.name,className:c.className,hubungan:String(x[5]||'')} : null;}).filter(Boolean);
    const pendingRequests=own.filter(function(x){return String(x[3]||'').toUpperCase()==='MENUNGGU_VERIFIKASI';}).map(function(x){const c=santriMap[String(x[2]||'')];return c?{relasiId:String(x[0]||''),id:c.id,nis:c.nis,name:c.name,className:c.className,hubungan:String(x[5]||'')} : null;}).filter(Boolean);
    const savedAddresses=own.filter(function(x){return String(x[3]||'').toUpperCase()==='ALAMAT_PESANAN';}).map(function(x){const c=santriMap[String(x[2]||'')];return c?{relasiId:String(x[0]||''),id:c.id,nis:c.nis,name:c.name,className:c.className,hubungan:String(x[5]||'')} : null;}).filter(Boolean);
    return {waliId:waliId,userId:userId,username:String(u.username||''),nama:String(r[2]||u.nama||''),noHp:String(r[3]||''),email:String(r[4]||''),alamat:String(r[5]||''),status:String(r[6]||u.status||''),createdAt:dateIso_(r[7]),updatedAt:dateIso_(r[8]),lastLoginAt:dateIso_(u.lastLoginAt),emailVerified:!!u.emailVerified,children:children,pendingRequests:pendingRequests,savedAddresses:savedAddresses};
  }).filter(function(w){return w.waliId;});
  return {ok:true,waliSantri:waliSantri,canManage:['ADMIN','SUPERADMIN'].indexOf(session.role)!==-1,canEditAccount:session.role==='SUPERADMIN'};
}

function maskNis_(nis){const s=String(nis||'').trim();if(!s)return '-';if(s.length<=4)return '••••';return '••••'+s.slice(-4);}
function relationLabel_(v){const x=String(v||'').toUpperCase();return ({AYAH:'Ayah',IBU:'Ibu',WALI:'Wali',LAINNYA:'Lainnya'})[x]||'Wali';}

/** Fase 8.12.1: Wali Santri mencari calon anak berdasarkan Nama/Kelas. Tidak langsung memberi akses. */
function getSantriClassesForWaliSelf(token){
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  const ss=getSS_(), wali=findWaliByUserId_(ss,session.userId);
  if(!wali) throw new Error('Data Wali Santri tidak ditemukan.');
  const relRows=readRows_(ss.getSheetByName('WaliSantriSantri'));
  const blocked={};
  relRows.forEach(function(r){if(String(r[1]||'')===String(wali.waliId) && ['AKTIF','ALAMAT_PESANAN','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0) blocked[String(r[2]||'')]=true;});
  const santriSheet=ss.getSheetByName('Santri'), santriMap=getSantriColumnMap_(santriSheet), rows=readSantriRows_(santriSheet), classes={};
  rows.forEach(function(r){const child=santriRecord_(r,santriMap),id=child.id,cls=child.className.trim();if(!id||!cls||child.status.toUpperCase()!=='AKTIF'||blocked[id])return;classes[cls]=true;});
  return {ok:true,classes:Object.keys(classes).sort(function(a,b){return a.localeCompare(b,'id',{numeric:true,sensitivity:'base'});})};
}

/** Fase 8.12.3: pencarian Wali real-time, opsional filter kelas. */
function searchSantriForWaliSelf(token,query,className){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);query=String(query||'').trim().toLowerCase();className=String(className||'').trim().toLowerCase();
 if(query.length<3)throw new Error('Ketik minimal 3 huruf nama Santri untuk mulai mencari.');
 const cache=CacheService.getScriptCache(),key='FMART_WALI_SANTRI_SEARCH_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(session.userId))).slice(0,40),count=Number(cache.get(key)||0);
 if(count>=30)throw new Error('Pencarian terlalu sering. Silakan tunggu sekitar satu menit sebelum mencoba lagi.');cache.put(key,String(count+1),60);
 const ss=getSS_(),wali=findWaliByUserId_(ss,session.userId);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');
 const blocked={};readRows_(ss.getSheetByName('WaliSantriSantri')).forEach(r=>{if(String(r[1]||'')===String(wali.waliId)&&['AKTIF','ALAMAT_PESANAN','MENUNGGU_VERIFIKASI'].includes(String(r[3]||'').toUpperCase()))blocked[String(r[2]||'')]=true;});
 const sheet=ss.getSheetByName('Santri'),map=getSantriColumnMap_(sheet),result=[];
 readSantriRows_(sheet).forEach(r=>{const c=santriRecord_(r,map);if(!c.id||c.status.toUpperCase()!=='AKTIF'||blocked[c.id])return;if(className&&c.className.toLowerCase()!==className)return;if(query&&(c.name+' '+c.className).toLowerCase().indexOf(query)===-1)return;result.push({id:c.id,name:c.name,className:c.className,nisMasked:maskNis_(c.nis)});});
 return {ok:true,santri:result.slice(0,30),searched:query,className:className};
}

/** Fase 8.12.1: Wali dapat self-link bila no_wa_wali cocok; selain itu pengajuan menunggu Admin. */
function countDistinctActiveWaliForSantri_(relationRows,santriId){
  const activeWaliIds={};
  (relationRows||[]).forEach(function(row){
    if(String(row[2]||'')===String(santriId||'')&&String(row[3]||'').toUpperCase()==='AKTIF'){
      const waliId=String(row[1]||'');
      if(waliId)activeWaliIds[waliId]=true;
    }
  });
  return Object.keys(activeWaliIds).length;
}

function countDistinctActiveOrPendingWaliForSantri_(relationRows,santriId){
  const waliIds={};
  (relationRows||[]).forEach(function(row){
    if(String(row[2]||'')===String(santriId||'')&&['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(row[3]||'').toUpperCase())>=0){
      const waliId=String(row[1]||'');
      if(waliId)waliIds[waliId]=true;
    }
  });
  return Object.keys(waliIds).length;
}

function requestWaliSantriLink(token,santriId,hubungan){
 const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);santriId=String(santriId||'').trim();if(!santriId)throw new Error('Santri tidak valid.');
 const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{
  const ss=getSS_(),rs=ss.getSheetByName('WaliSantriSantri'),sheet=ss.getSheetByName('Santri'),wali=findWaliByUserId_(ss,session.userId);
  if(!rs||!sheet||!wali)throw new Error('Data alamat Santri belum siap.');
  const found=findSantriRowById_(sheet,santriId);if(!found||santriRecord_(found.values,getSantriColumnMap_(sheet)).status.toUpperCase()!=='AKTIF')throw new Error('Data Santri tidak ditemukan atau tidak aktif.');
  const rows=readRows_(rs),pairs=rows.map((r,i)=>({r:r,i:i})).filter(x=>String(x.r[1]||'')===String(wali.waliId)&&String(x.r[2]||'')===santriId);
  if(pairs.some(x=>['AKTIF','ALAMAT_PESANAN'].includes(String(x.r[3]||'').toUpperCase())))throw new Error('Santri sudah tersimpan di alamat pemesanan Anda.');
  const prev=pairs[pairs.length-1],now=new Date();
  if(prev)rs.getRange(prev.i+2,4,1,3).setValues([['ALAMAT_PESANAN',now,'ALAMAT_PESANAN']]);
  else rs.appendRow([makeFMartId_('REL'),wali.waliId,santriId,'ALAMAT_PESANAN',now,'ALAMAT_PESANAN']);
  writeAudit_(session.userId,session.role,'SAVE_WALI_ORDER_RECIPIENT','WALI_SANTRI_SANTRI',wali.waliId,'',JSON.stringify({santriId:santriId,status:'ALAMAT_PESANAN'}),'Wali menyimpan alamat pemesanan tanpa persetujuan Admin');
  SpreadsheetApp.flush();return {ok:true,status:'ALAMAT_PESANAN',message:'Santri berhasil disimpan sebagai alamat pemesanan.'};
 }finally{lock.releaseLock();}
}


/** Fase 8.12.1: Admin/Superadmin mencari Santri untuk relasi manual. */
function searchSantriForWali(token,waliId,query){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  waliId=String(waliId||'').trim();query=String(query||'').trim().toLowerCase();if(!waliId)throw new Error('Wali Santri tidak valid.');
  const ss=getSS_(),wali=findRowById_(ss.getSheetByName('WaliSantri'),waliId,1);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');
  const relRows=readRows_(ss.getSheetByName('WaliSantriSantri')),linked={};relRows.forEach(function(r){if(String(r[1]||'')===waliId&&['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0)linked[String(r[2]||'')]=true;});
  const santriSheet=ss.getSheetByName('Santri'),santriMap=getSantriColumnMap_(santriSheet),rows=readSantriRows_(santriSheet),result=[];rows.forEach(function(r){const child=santriRecord_(r,santriMap),id=child.id,nis=child.nis,name=child.name,cls=child.className;if(!id||child.status.toUpperCase()!=='AKTIF'||linked[id])return;const hay=(nis+' '+name+' '+cls).toLowerCase();if(query&&hay.indexOf(query)===-1)return;result.push({id:id,nis:nis,name:name,className:cls});});
  return {ok:true,santri:result.slice(0,50),searched:query};
}

/** Fase 8.12.1: Admin/Superadmin langsung menghubungkan Santri. Multi-Wali tetap diperbolehkan. */
function linkWaliSantri(token,waliId,santriId,hubungan){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  waliId=String(waliId||'').trim();santriId=String(santriId||'').trim();hubungan=String(hubungan||'WALI').trim().toUpperCase();
  if(!waliId||!santriId)throw new Error('Wali Santri dan Santri wajib dipilih.');if(['AYAH','IBU','WALI','LAINNYA'].indexOf(hubungan)===-1)hubungan='WALI';
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{
    const ss=getSS_(),ws=ss.getSheetByName('WaliSantri'),ssheet=ss.getSheetByName('Santri'),rs=ss.getSheetByName('WaliSantriSantri');if(!ws||!ssheet||!rs)throw new Error('Database relasi Wali Santri belum siap. Jalankan setupFMartDatabase_().');
    const wali=findRowById_(ws,waliId,1),santri=findSantriRowById_(ssheet,santriId),santriMap=getSantriColumnMap_(ssheet);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');if(!santri||santriRecord_(santri.values,santriMap).status.toUpperCase()!=='AKTIF')throw new Error('Santri tidak ditemukan atau tidak aktif.');
    if(String(wali.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Akun Wali Santri tidak aktif.');
    const relRows=readRows_(rs),pairRows=relRows.map(function(row,index){return {row:row,index:index};}).filter(function(item){return String(item.row[1]||'')===waliId&&String(item.row[2]||'')===santriId;}),duplicate=pairRows.some(function(item){return String(item.row[3]||'').toUpperCase()==='AKTIF';});
    const activeOrPendingWaliIds={};relRows.forEach(function(row){if(String(row[2]||'')===santriId&&['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(row[3]||'').toUpperCase())>=0&&String(row[1]||''))activeOrPendingWaliIds[String(row[1])]=true;});
    if(!duplicate&&!activeOrPendingWaliIds[waliId]&&Object.keys(activeOrPendingWaliIds).length>=2)throw new Error('Santri ini sudah memiliki maksimal 2 Wali Santri aktif/pending.');
    if(duplicate)throw new Error('Santri sudah terhubung dengan Wali Santri ini.');
    const existing=pairRows.length?pairRows[pairRows.length-1].row:null,now=new Date();
    if(existing){const rowNum=relRows.indexOf(existing)+2;rs.getRange(rowNum,4,1,3).setValues([['AKTIF',now,hubungan]]);}else rs.appendRow([makeFMartId_('REL'),waliId,santriId,'AKTIF',now,hubungan]);
    writeAudit_(session.userId,session.role,'LINK_WALI_SANTRI','WALI_SANTRI_SANTRI',waliId,'',JSON.stringify({waliId:waliId,santriId:santriId,status:'AKTIF',hubungan:hubungan}),'Menghubungkan Wali Santri dengan Santri');SpreadsheetApp.flush();return {ok:true};
  }finally{lock.releaseLock();}
}

function approveWaliSantriRequest(token,relasiId){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);relasiId=String(relasiId||'').trim();if(!relasiId)throw new Error('Pengajuan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{const ss=getSS_(),rs=ss.getSheetByName('WaliSantriSantri'),row=findRowById_(rs,relasiId,1);if(!row)throw new Error('Pengajuan tidak ditemukan.');if(String(row.values[3]||'').toUpperCase()!=='MENUNGGU_VERIFIKASI')throw new Error('Pengajuan ini sudah diproses.');
    const santriSheet=ss.getSheetByName('Santri'),santri=findSantriRowById_(santriSheet,String(row.values[2])),santriMap=getSantriColumnMap_(santriSheet);
    const wali=findRowById_(ss.getSheetByName('WaliSantri'),String(row.values[1]),1);if(!wali||String(wali.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Akun Wali Santri tidak aktif.');if(!santri||santriRecord_(santri.values,santriMap).status.toUpperCase()!=='AKTIF')throw new Error('Santri tidak aktif.');
    const relationRows=readRows_(rs);
    const activeOrPendingCount=countDistinctActiveOrPendingWaliForSantri_(relationRows,String(row.values[2]||''));
    if(activeOrPendingCount>2) throw new Error('Santri ini sudah memiliki lebih dari 2 Wali Santri aktif/pengajuan. Periksa relasi lain sebelum menyetujui.');
    rs.getRange(row.rowNumber,4).setValue('AKTIF');writeAudit_(session.userId,session.role,'APPROVE_WALI_SANTRI_REQUEST','WALI_SANTRI_SANTRI',relasiId,'',JSON.stringify({status:'AKTIF'}),'Menyetujui pengajuan hubungan Wali Santri');SpreadsheetApp.flush();return {ok:true,message:'Pengajuan disetujui.'};
  }finally{lock.releaseLock();}
}
function rejectWaliSantriRequest(token,relasiId){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);relasiId=String(relasiId||'').trim();if(!relasiId)throw new Error('Pengajuan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{const rs=getSS_().getSheetByName('WaliSantriSantri'),row=findRowById_(rs,relasiId,1);if(!row)throw new Error('Pengajuan tidak ditemukan.');if(String(row.values[3]||'').toUpperCase()!=='MENUNGGU_VERIFIKASI')throw new Error('Pengajuan ini sudah diproses.');rs.getRange(row.rowNumber,4).setValue('NONAKTIF');writeAudit_(session.userId,session.role,'REJECT_WALI_SANTRI_REQUEST','WALI_SANTRI_SANTRI',relasiId,'',JSON.stringify({status:'NONAKTIF'}),'Menolak pengajuan hubungan Wali Santri');SpreadsheetApp.flush();return {ok:true,message:'Pengajuan ditolak.'};}finally{lock.releaseLock();}
}

function unlinkWaliSantri(token,waliId,santriId){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);waliId=String(waliId||'').trim();santriId=String(santriId||'').trim();if(!waliId||!santriId)throw new Error('Relasi tidak valid.');const lock=LockService.getScriptLock();lock.waitLock(10000);try{const rs=getSS_().getSheetByName('WaliSantriSantri');if(!rs)throw new Error('Sheet WaliSantriSantri tidak ditemukan.');const rows=readRows_(rs),index=rows.findIndex(function(r){return String(r[1]||'')===waliId&&String(r[2]||'')===santriId&&String(r[3]||'').toUpperCase()==='AKTIF';});if(index<0)throw new Error('Relasi Wali Santri dan Santri tidak ditemukan.');rs.getRange(index+2,4).setValue('NONAKTIF');writeAudit_(session.userId,session.role,'UNLINK_WALI_SANTRI','WALI_SANTRI_SANTRI',waliId,'',JSON.stringify({waliId:waliId,santriId:santriId,status:'NONAKTIF'}),'Melepas hubungan Wali Santri dengan Santri');SpreadsheetApp.flush();return {ok:true};}finally{lock.releaseLock();}}

function updateWaliSantri(token,waliId,nama,noHp,email,alamat){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);waliId=String(waliId||'').trim();nama=String(nama||'').trim().slice(0,120);noHp=normalizePhone_(noHp);email=normalizeEmail_(email).slice(0,160);alamat=String(alamat||'').trim().slice(0,300);
  if(!waliId)throw new Error('Wali Santri tidak valid.');if(!nama)throw new Error('Nama wajib diisi.');if(!noHp)throw new Error('No. HP tidak valid.');if(email&&!isValidStaffEmail_(email))throw new Error('Format email tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),ws=ss.getSheetByName('WaliSantri'),us=ss.getSheetByName('Users'),row=findRowById_(ws,waliId,1);if(!row)throw new Error('Data Wali Santri tidak ditemukan.');
    const userId=String(row.values[1]||''),user=findRowById_(us,userId,1);if(!user||String(user.values[5]||'').toUpperCase()!=='WALI_SANTRI')throw new Error('Akun pengguna Wali Santri tidak ditemukan.');
    const walis=readRows_(ws);if(walis.some(r=>String(r[0]||'')!==waliId&&phoneEquals_(r[3],noHp)))throw new Error('No. HP sudah digunakan oleh Wali Santri lain.');
    const allUsers=readRows_(us);if(allUsers.some(u=>String(u[0]||'')!==userId&&(String(u[1]||'').trim()===noHp||normalizePhone_(u[1])===noHp)))throw new Error('Nomor HP sudah digunakan sebagai username akun lain.');
    let verification=null;if(email!==normalizeEmail_(user.values[10])||normalizeEmail_(row.values[4])!==email||!(String(user.values[11]||'').toUpperCase()==='TRUE'||user.values[11]===true)){if(!email)throw new Error('Email tidak boleh dikosongkan.');verification=sendWaliEmailVerification_(userId,email);}
    const now=new Date();ws.getRange(row.rowNumber,3).setValue(nama);ws.getRange(row.rowNumber,4).setNumberFormat('@');ws.getRange(row.rowNumber,4).setValue(noHp);ws.getRange(row.rowNumber,6,1,4).setValues([[alamat,String(row.values[6]||'AKTIF'),row.values[7]||now,now]]);
    us.getRange(user.rowNumber,2).setNumberFormat('@');us.getRange(user.rowNumber,2).setValue(noHp);us.getRange(user.rowNumber,5).setValue(nama);us.getRange(user.rowNumber,9).setValue(now);
    writeAudit_(session.userId,session.role,'UPDATE_WALI_SANTRI','WALI_SANTRI',waliId,JSON.stringify({nama:String(row.values[2]||''),noHp:String(row.values[3]||''),email:String(row.values[4]||''),alamat:String(row.values[5]||'')}),JSON.stringify({nama:nama,noHp:noHp,username:noHp,email:email,alamat:alamat}),'Memperbarui data Wali Santri');
    SpreadsheetApp.flush();return {ok:true,requiresEmailOtp:!!verification,challengeId:verification&&verification.challengeId,maskedEmail:verification&&verification.maskedEmail,message:verification?verification.message:'Data Wali Santri berhasil diperbarui.'};
  }finally{lock.releaseLock();}
}
function toggleFMartUser(token,userId){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const sheet=getSS_().getSheetByName('Users'),row=findRowById_(sheet,String(userId||''),1);
    if(!row) throw new Error('Pengguna tidak ditemukan.');
    const role=String(row.values[5]||'').toUpperCase();
    if(role==='SUPERADMIN') throw new Error('Status Superadmin tidak dapat diubah dari menu ini.');
    const current=String(row.values[6]||'AKTIF').toUpperCase(),next=current==='AKTIF'?'NONAKTIF':'AKTIF',now=new Date();
    sheet.getRange(row.rowNumber,7).setValue(next);sheet.getRange(row.rowNumber,9).setValue(now);
    writeAudit_(session.userId,session.role,'TOGGLE_USER','USER',String(userId),JSON.stringify({status:current}),JSON.stringify({status:next}),'Mengubah status pengguna');SpreadsheetApp.flush();
    return {ok:true,status:next};
  }finally{lock.releaseLock();}
}

function resetFMartUserPassword(token,userId){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const sheet=getSS_().getSheetByName('Users'),row=findRowById_(sheet,String(userId||''),1);
    if(!row) throw new Error('Pengguna tidak ditemukan.');
    const role=String(row.values[5]||'').toUpperCase();if(role==='SUPERADMIN') throw new Error('Password Superadmin tidak dapat direset dari menu ini.');
    const randomHex=Utilities.getUuid().replace(/-/g,'').toUpperCase();
    const tempPassword='FM!'+randomHex.slice(0,20);
    const salt=Utilities.getUuid().replace(/-/g,'');const hash=hashPassword_(tempPassword,salt),now=new Date();
    sheet.getRange(row.rowNumber,3,1,2).setValues([[hash,salt]]);sheet.getRange(row.rowNumber,9).setValue(now);
    writeAudit_(session.userId,session.role,'RESET_USER_PASSWORD','USER',String(userId),'',JSON.stringify({username:String(row.values[1]||''),role:role}),'Reset password pengguna');SpreadsheetApp.flush();
    return {ok:true,tempPassword:tempPassword,username:String(row.values[1]||'')};
  }finally{lock.releaseLock();}
}

function updateFMartUser(token,userId,nama,role){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const sheet=getSS_().getSheetByName('Users'),row=findRowById_(sheet,String(userId||''),1);if(!row)throw new Error('Pengguna tidak ditemukan.');
    const targetRole=String(row.values[5]||'').toUpperCase();if(targetRole==='SUPERADMIN')throw new Error('Data Superadmin tidak dapat diubah dari menu ini.');
    nama=String(nama||'').trim().slice(0,120);role=String(role||'').toUpperCase();
    if(!nama)throw new Error('Nama wajib diisi.');if(['ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR','WALI_SANTRI'].indexOf(role)<0)throw new Error('Role tidak valid.');
    const before={nama:String(row.values[4]||''),role:targetRole},now=new Date();
    sheet.getRange(row.rowNumber,5,1,2).setValues([[nama,role]]);sheet.getRange(row.rowNumber,9).setValue(now);
    writeAudit_(session.userId,session.role,'UPDATE_USER','USER',String(userId),JSON.stringify(before),JSON.stringify({nama:nama,role:role}),'Mengubah data pengguna');SpreadsheetApp.flush();
    return {ok:true};
  }finally{lock.releaseLock();}
}

function sessionUserId_(token){return requireSession_(token).userId;}
function sessionToken_(session){return session && session._token ? session._token : null;}

function latestPaymentForOrder_(rows, orderId) {
  const found = rows.filter(function(r){return String(r[1])===String(orderId);}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();})[0];
  return found ? {id:String(found[0]),orderId:String(found[1]),method:String(found[2]||''),nominal:Number(found[3])||0,buktiUrl:String(found[4]||''),status:String(found[5]||''),verifiedBy:String(found[6]||''),verifiedAt:found[7],createdAt:found[8],updatedAt:found[9],buktiSumber:String(found[10]||''),submittedBy:String(found[11]||''),catatan:String(found[12]||'')} : null;
}
/**
 * Tahap 4: Dashboard dan antrean khusus Petugas Pengantar.
 * Hanya mengembalikan penugasan milik sesi aktif; endpoint bersifat read-only.
 */
function getDeliveryDashboard(token) {
  const session = requireRole_(token, [FMART.ROLES.PETUGAS_PENGANTAR, FMART.ROLES.GUDANG]);
  const ss = getSS_();
  const assignmentSheet = ss.getSheetByName('Pengantaran');
  if (!assignmentSheet) throw new Error('Struktur Pengantaran belum tersedia. Jalankan setupFMartDatabase_() terlebih dahulu.');
  const assignments = readRows_(assignmentSheet);
  const orders = readRows_(ss.getSheetByName('Pesanan'));
  const santriSheet = ss.getSheetByName('Santri');
  const santriMap = getSantriColumnMap_(santriSheet);
  const santriRows = readSantriRows_(santriSheet);
  const santriById = {};
  santriRows.forEach(function(row) {
    const child = santriRecord_(row, santriMap);
    if (child.id) santriById[child.id] = child;
  });
  const orderById = {};
  orders.forEach(function(row) {
    const id = String(row[0] || '');
    if (id) orderById[id] = row;
  });
  const shipments = readRows_(ss.getSheetByName('Pengiriman'));
  const proofByAssignment = {};
  readRows_(ss.getSheetByName('BuktiPengantaran')).forEach(function(row) {
    const assignmentId=String(row[2]||'');
    if(!assignmentId)return;
    const previous=proofByAssignment[assignmentId];
    if(!previous||new Date(row[10]||0).getTime()>=new Date(previous[10]||0).getTime())proofByAssignment[assignmentId]=row;
  });
  const shipmentByOrder = {};
  shipments.forEach(function(row) {
    const id = String(row[1] || '');
    if (id) {
      const previous = shipmentByOrder[id];
      if (!previous || new Date(row[8] || 0).getTime() >= new Date(previous[8] || 0).getTime()) shipmentByOrder[id] = row;
    }
  });
  const tasks = assignments.filter(function(row) {
    return String(row[2] || '') === String(session.userId);
  }).map(function(row) {
    const orderId = String(row[1] || '');
    const order = orderById[orderId];
    if (!order) return null;
    const child = getOrderRecipientSnapshot_(ss,order);
    const shipment = shipmentByOrder[orderId] || [];
    const proof = proofByAssignment[String(row[0]||'')] || [];
    return {
      assignmentId:String(row[0] || ''),
      orderId:orderId,
      orderNumber:String(order[1] || orderId),
      assignmentStatus:String(row[3] || 'DITUGASKAN').toUpperCase(),
      assignedAt:dateIso_(row[5]),
      acceptedAt:dateIso_(row[6]),
      startedAt:dateIso_(row[7]),
      completedAt:dateIso_(row[8]),
      failureReason:String(row[10] || ''),
      notes:String(row[11] || ''),
      progressUpdatedAt:dateIso_(row[12]),
      hasProof:!!String(proof[0]||''),
      proofUploadedAt:dateIso_(proof[10]),
      orderStatus:String(order[8] || '').toUpperCase(),
      childName:String(child.name || 'Santri'),
      className:String(child.className || ''),
      recipientName:String(child.name || 'Santri'),
      recipientContact:String(child.phone || ''),
      destination:String(shipment[3] || ''),
      shipmentStatus:String(shipment[4] || '')
    };
  }).filter(Boolean).sort(function(a,b) {
    return new Date(b.assignedAt || 0).getTime() - new Date(a.assignedAt || 0).getTime();
  }).slice(0,200);
  const summary = {total:tasks.length,newTasks:0,accepted:0,inProgress:0,completed:0,failed:0};
  tasks.forEach(function(task) {
    if (['DITUGASKAN','BARU','MENUNGGU_KONFIRMASI'].indexOf(task.assignmentStatus) >= 0) summary.newTasks++;
    else if (['DITERIMA','DITERIMA_PETUGAS'].indexOf(task.assignmentStatus) >= 0) summary.accepted++;
    else if (['DALAM_PERJALANAN','DIANTAR'].indexOf(task.assignmentStatus) >= 0) summary.inProgress++;
    else if (['SELESAI','DITERIMA_WALI'].indexOf(task.assignmentStatus) >= 0) summary.completed++;
    else if (['GAGAL','DITOLAK'].indexOf(task.assignmentStatus) >= 0) summary.failed++;
  });
  const notificationRows=readRows_(ss.getSheetByName('Notifikasi')).filter(function(r){return String(r[1]||'')===String(session.userId);}).sort(function(a,b){return new Date(b[7]||0).getTime()-new Date(a[7]||0).getTime();}).slice(0,30).map(function(r){return{id:String(r[0]||''),orderId:String(r[2]||''),title:String(r[3]||''),message:String(r[4]||''),type:String(r[5]||''),isRead:r[6]===true||String(r[6]).toUpperCase()==='TRUE',createdAt:dateIso_(r[7])};});
  return {ok:true,summary:summary,tasks:tasks,notifications:notificationRows,unreadCount:notificationRows.filter(function(n){return !n.isRead;}).length,updatedAt:new Date().toISOString()};
}


/** Tahap 6: tindakan operasional Petugas Pengantar. */
function recordDeliveryHistory_(ss, assignmentId, orderId, session, action, beforeStatus, afterStatus, note) {
  const sheet=ss.getSheetByName('RiwayatPengantaran');
  if(!sheet) throw new Error('Sheet RiwayatPengantaran belum tersedia. Jalankan setupFMartDatabase_() terlebih dahulu.');
  sheet.appendRow([makeFMartId_('RPD'),orderId,assignmentId,session.userId,session.role,action,beforeStatus,afterStatus,String(note||'').slice(0,500),new Date()]);
}
function respondDeliveryAssignment(token, assignmentId, decision, reason) {
  const session=requireRole_(token,[FMART.ROLES.PETUGAS_PENGANTAR,FMART.ROLES.GUDANG]);
  assignmentId=String(assignmentId||'').trim();decision=String(decision||'').toUpperCase();reason=String(reason||'').trim().slice(0,300);
  if(!assignmentId||['DITERIMA','DITOLAK'].indexOf(decision)<0) throw new Error('Respons penugasan tidak valid.');
  if(decision==='DITOLAK'&&!reason) throw new Error('Alasan penolakan wajib diisi.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try {
    const ss=getSS_(),sheet=ss.getSheetByName('Pengantaran'),found=findRowById_(sheet,assignmentId,1);
    if(!found) throw new Error('Penugasan tidak ditemukan.');
    const row=found.values,owner=String(row[2]||''),before=String(row[3]||'').toUpperCase();
    if(owner!==session.userId) throw new Error('Penugasan ini bukan milik akun Anda.');
    if(before!=='DITUGASKAN'&&before!=='BARU'&&before!=='MENUNGGU_KONFIRMASI') throw new Error('Tugas ini sudah direspons atau tidak lagi aktif.');
    const now=new Date(),after=decision;
    sheet.getRange(found.rowNumber,4).setValue(after);
    if(decision==='DITERIMA') sheet.getRange(found.rowNumber,7).setValue(now);
    else {sheet.getRange(found.rowNumber,11,1,2).setValues([['DITOLAK',reason]]);}
    sheet.getRange(found.rowNumber,13).setValue(now);
    recordDeliveryHistory_(ss,assignmentId,String(row[1]),session,'RESPONS_'+decision,before,after,reason||'Petugas menerima tugas');
    if(decision==='DITOLAK'&&String(row[4]||'')) ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(row[4]),String(row[1]),'Penugasan ditolak','Petugas menolak tugas pengantaran. Alasan: '+reason,'PENGANTARAN',false,now]);
    if(decision==='DITERIMA'&&String(row[4]||''))ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(row[4]),String(row[1]),'Tugas pengantaran diterima','Petugas telah menerima tugas pengantaran.','PENGANTARAN',false,now]);
    writeAudit_(session.userId,session.role,'DELIVERY_'+decision,'PENGANTARAN',assignmentId,JSON.stringify({status:before}),JSON.stringify({status:after,reason:reason}),'Respons penugasan pengantaran');
    SpreadsheetApp.flush();
    return {ok:true,message:decision==='DITERIMA'?'Tugas berhasil diterima.':'Tugas ditolak dan dikembalikan ke antrean Distribusi.'};
  } finally {lock.releaseLock();}
}
function startDeliveryTrip(token, assignmentId) {
  const session=requireRole_(token,[FMART.ROLES.PETUGAS_PENGANTAR,FMART.ROLES.GUDANG]);
  assignmentId=String(assignmentId||'').trim();
  if(!assignmentId)throw new Error('Penugasan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try {
    const ss=getSS_(),as=ss.getSheetByName('Pengantaran'),found=findRowById_(as,assignmentId,1);
    if(!found)throw new Error('Penugasan tidak ditemukan.');
    const row=found.values,orderId=String(row[1]||''),before=String(row[3]||'').toUpperCase();
    if(String(row[2]||'')!==session.userId)throw new Error('Penugasan ini bukan milik akun Anda.');
    const recovering=before==='DALAM_PERJALANAN';
    if(!recovering&&before!=='DITERIMA'&&before!=='DITERIMA_PETUGAS')throw new Error('Terima tugas terlebih dahulu sebelum memulai pengantaran.');
    const os=ss.getSheetByName('Pesanan'),order=findRowById_(os,orderId,1);
    if(!order)throw new Error('Pesanan tidak ditemukan.');
    const orderStatus=String(order.values[8]||'').toUpperCase();
    if(orderStatus!=='DISIAPKAN'&&!(recovering&&orderStatus==='DIANTAR'))throw new Error('Pesanan tidak lagi berada pada status yang dapat memulai atau memulihkan pengantaran.');
    const payments=readRows_(ss.getSheetByName('Pembayaran')).filter(r=>String(r[1]||'')===orderId).sort((a,b)=>new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime());
    if(!payments.length||String(payments[0][5]||'').toUpperCase()!=='TERVERIFIKASI')throw new Error('Pembayaran pesanan belum terverifikasi.');
    const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    if(!shipment||String(shipment.method||'').toUpperCase()!=='ANTAR_PESANTREN')throw new Error('Metode pesanan bukan Antar Pesantren.');
    const shipmentStatus=String(shipment.status||'').toUpperCase();
    if(shipmentStatus!=='DISIAPKAN'&&!(recovering&&shipmentStatus==='DIANTAR'))throw new Error('Status pengiriman tidak dapat dimulai atau dipulihkan.');
    const now=new Date(),startedAt=row[7] instanceof Date?row[7]:now;
    if(!recovering){as.getRange(found.rowNumber,4).setValue('DALAM_PERJALANAN');as.getRange(found.rowNumber,8).setValue(startedAt);}
    as.getRange(found.rowNumber,13).setValue(now);
    if(orderStatus==='DISIAPKAN'){os.getRange(order.rowNumber,9,1,3).setValues([['DIANTAR',String(order.values[9]||''),now]]);}
    const shipSheet=ss.getSheetByName('Pengiriman'),shipRow=latestShipmentRow_(shipSheet,orderId);
    if(shipRow&&shipmentStatus==='DISIAPKAN')shipSheet.getRange(shipRow,5,1,5).setValues([['DIANTAR',startedAt,'',session.userId,now]]);
    const noticeSheet=ss.getSheetByName('Notifikasi'),waliId=String(order.values[2]||'');
    if(waliId&&!readRows_(noticeSheet).some(n=>String(n[1])===waliId&&String(n[2])===orderId&&String(n[3])==='Pesanan sedang diantar'))noticeSheet.appendRow([makeFMartId_('NTF'),waliId,orderId,'Pesanan sedang diantar','Pesanan '+String(order.values[1]||orderId)+' sedang dalam perjalanan menuju tujuan.','PESANAN',false,now]);
    const history=readRows_(ss.getSheetByName('RiwayatPengantaran'));
    if(!history.some(r=>String(r[2]||'')===assignmentId&&String(r[5]||'').toUpperCase()==='MULAI_PENGANTARAN'))recordDeliveryHistory_(ss,assignmentId,orderId,session,'MULAI_PENGANTARAN',recovering?'DALAM_PERJALANAN':before,'DALAM_PERJALANAN','Petugas memulai perjalanan');
    const audit=readRows_(ss.getSheetByName('AuditLog'));
    if(!audit.some(r=>String(r[3]||'').toUpperCase()==='START_DELIVERY'&&String(r[5]||'')===assignmentId))writeAudit_(session.userId,session.role,'START_DELIVERY','PENGANTARAN',assignmentId,JSON.stringify({assignmentStatus:before,orderStatus:orderStatus}),JSON.stringify({assignmentStatus:'DALAM_PERJALANAN',orderStatus:'DIANTAR'}),'Petugas memulai atau memulihkan pengantaran',now);
    SpreadsheetApp.flush();
    return {ok:true,recovered:recovering,message:recovering?'Pencatatan pengantaran yang terputus berhasil dipulihkan.':'Pengantaran dimulai. Status pesanan sekarang DIANTAR.'};
  } finally {lock.releaseLock();}
}
function reportDeliveryFailure(token, assignmentId, reason) {
  const session=requireRole_(token,[FMART.ROLES.PETUGAS_PENGANTAR,FMART.ROLES.GUDANG]);
  assignmentId=String(assignmentId||'').trim();reason=String(reason||'').trim().slice(0,500);
  if(!assignmentId||reason.length<5)throw new Error('Alasan pengantaran gagal minimal 5 karakter wajib diisi.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),assignmentSheet=ss.getSheetByName('Pengantaran'),found=findRowById_(assignmentSheet,assignmentId,1);
    if(!found)throw new Error('Penugasan tidak ditemukan.');
    const row=found.values,orderId=String(row[1]||''),before=String(row[3]||'').toUpperCase();
    if(String(row[2]||'')!==session.userId)throw new Error('Penugasan ini bukan milik akun Anda.');
    const recovering=before==='GAGAL';
    if(!recovering&&before!=='DALAM_PERJALANAN')throw new Error('Pengantaran gagal hanya dapat dilaporkan saat perjalanan berlangsung.');
    if(recovering&&String(row[11]||'').indexOf('[GAGAL] '+reason)<0)throw new Error('Alasan tidak cocok dengan laporan kegagalan yang sudah dicatat.');
    if(readRows_(ss.getSheetByName('BuktiPengantaran')).some(r=>String(r[2]||'')===assignmentId))throw new Error('Bukti pengantaran sudah diunggah. Hubungi Admin untuk penanganan lanjutan.');
    const orderSheet=ss.getSheetByName('Pesanan'),order=findRowById_(orderSheet,orderId,1);
    if(!order)throw new Error('Pesanan terkait tidak ditemukan.');
    const orderStatus=String(order.values[8]||'').toUpperCase();
    if(orderStatus!=='DIANTAR'&&!(recovering&&orderStatus==='DISIAPKAN'))throw new Error('Status pesanan tidak sesuai untuk pelaporan atau pemulihan kegagalan.');
    const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    if(!shipment||String(shipment.method||'').toUpperCase()!=='ANTAR_PESANTREN')throw new Error('Fitur ini hanya berlaku untuk Antar Pesantren.');
    const shipmentStatus=String(shipment.status||'').toUpperCase();
    if(shipmentStatus!=='DIANTAR'&&shipmentStatus!=='DISIAPKAN')throw new Error('Status pengiriman tidak sesuai untuk pemulihan kegagalan.');
    const now=new Date(),combined=recovering?String(row[11]||''):((String(row[11]||'').trim()?String(row[11]).trim()+'\\n':'')+'[GAGAL] '+reason).slice(-2000);
    if(!recovering){assignmentSheet.getRange(found.rowNumber,4).setValue('GAGAL');assignmentSheet.getRange(found.rowNumber,10).setValue(now);assignmentSheet.getRange(found.rowNumber,11,1,2).setValues([['GAGAL_PENGANTARAN',combined]]);}
    assignmentSheet.getRange(found.rowNumber,13).setValue(now);
    if(orderStatus==='DIANTAR'){orderSheet.getRange(order.rowNumber,9).setValue('DISIAPKAN');orderSheet.getRange(order.rowNumber,12).setValue(now);}
    const shipSheet=ss.getSheetByName('Pengiriman'),shipRow=latestShipmentRow_(shipSheet,orderId);
    if(shipRow&&shipmentStatus==='DIANTAR')shipSheet.getRange(shipRow,5,1,5).setValues([['DISIAPKAN','','',session.userId,now]]);
    const noticeSheet=ss.getSheetByName('Notifikasi'),waliId=String(order.values[2]||''),orderNumber=String(order.values[1]||orderId),notices=readRows_(noticeSheet);
    if(waliId&&!notices.some(r=>String(r[1])===waliId&&String(r[2])===orderId&&String(r[3])==='Pengantaran belum berhasil'))noticeSheet.appendRow([makeFMartId_('NTF'),waliId,orderId,'Pengantaran belum berhasil','Pengantaran pesanan '+orderNumber+' belum berhasil. Pesanan dikembalikan ke antrean untuk penugasan ulang.','PENGANTARAN',false,now]);
    const staff=readRows_(ss.getSheetByName('Users')).filter(u=>['ADMIN','GUDANG','SUPERADMIN'].indexOf(String(u[5]||'').toUpperCase())>=0&&String(u[6]||'').toUpperCase()==='AKTIF');
    staff.forEach(function(u){if(!readRows_(noticeSheet).some(function(r){return String(r[1])===String(u[0])&&String(r[2])===orderId&&String(r[3])==='Pengantaran gagal - perlu penugasan ulang';}))noticeSheet.appendRow([makeFMartId_('NTF'),String(u[0]),orderId,'Pengantaran gagal - perlu penugasan ulang','Pesanan '+orderNumber+' dikembalikan ke antrean Distribusi. Alasan: '+reason,'PENGANTARAN',false,now]);});
    const history=readRows_(ss.getSheetByName('RiwayatPengantaran'));
    if(!history.some(r=>String(r[2]||'')===assignmentId&&String(r[5]||'').toUpperCase()==='PENGANTARAN_GAGAL'))recordDeliveryHistory_(ss,assignmentId,orderId,session,'PENGANTARAN_GAGAL',recovering?'GAGAL':before,'GAGAL',reason);
    const audit=readRows_(ss.getSheetByName('AuditLog'));
    if(!audit.some(r=>String(r[3]||'').toUpperCase()==='DELIVERY_FAILED'&&String(r[5]||'')===assignmentId))writeAudit_(session.userId,session.role,'DELIVERY_FAILED','PENGANTARAN',assignmentId,JSON.stringify({assignmentStatus:before,orderStatus:orderStatus}),JSON.stringify({assignmentStatus:'GAGAL',orderStatus:'DISIAPKAN',reason:reason}),'Pengantaran gagal dan dikembalikan ke antrean Distribusi',now);
    SpreadsheetApp.flush();
    return {ok:true,recovered:recovering,message:'Pengantaran gagal dicatat. Pesanan dikembalikan ke antrean Distribusi untuk ditugaskan ulang.'};
  }finally{lock.releaseLock();}
}

function updateDeliveryProgress(token, assignmentId, note) {
  const session=requireRole_(token,[FMART.ROLES.PETUGAS_PENGANTAR,FMART.ROLES.GUDANG]);
  assignmentId=String(assignmentId||'').trim();note=String(note||'').trim().slice(0,500);
  if(!note) throw new Error('Catatan perkembangan wajib diisi.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const ss=getSS_(),sheet=ss.getSheetByName('Pengantaran'),found=findRowById_(sheet,assignmentId,1);
    if(!found) throw new Error('Penugasan tidak ditemukan.');
    const row=found.values,status=String(row[3]||'').toUpperCase();
    if(String(row[2]||'')!==session.userId) throw new Error('Penugasan ini bukan milik akun Anda.');
    if(status!=='DALAM_PERJALANAN') throw new Error('Catatan hanya dapat ditambahkan saat pengantaran berlangsung.');
    const now=new Date(),combined=(String(row[11]||'').trim()?String(row[11]).trim()+'\n':'')+'['+Utilities.formatDate(now,Session.getScriptTimeZone(),'dd/MM/yyyy HH:mm')+'] '+note;
    sheet.getRange(found.rowNumber,12).setValue(combined.slice(-2000));
    sheet.getRange(found.rowNumber,13).setValue(now);
    recordDeliveryHistory_(ss,assignmentId,String(row[1]),session,'UPDATE_PERKEMBANGAN','DALAM_PERJALANAN','DALAM_PERJALANAN',note);
    writeAudit_(session.userId,session.role,'UPDATE_DELIVERY_PROGRESS','PENGANTARAN',assignmentId,'',JSON.stringify({note:note}),'Memperbarui perkembangan pengantaran');
    SpreadsheetApp.flush();
    return {ok:true,message:'Perkembangan pengantaran berhasil dicatat.'};
  } finally {lock.releaseLock();}
}


/**
 * Tahap 7: unggah bukti foto pengantaran. File disimpan privat di Drive;
 * tenggat konfirmasi Wali dimulai dari waktu unggah yang tercatat server.
 */
function submitDeliveryProof(token,assignmentId,fileName,mimeType,dataUrl,note){
 const session=requireRole_(token,[FMART.ROLES.PETUGAS_PENGANTAR,FMART.ROLES.GUDANG]);assignmentId=String(assignmentId||'').trim();fileName=sanitizeFileName_(fileName||'bukti-pengantaran');mimeType=String(mimeType||'').toLowerCase().trim();note=String(note||'').trim().slice(0,300);
 if(!assignmentId||!dataUrl)throw new Error('Foto bukti pengantaran wajib dipilih.');if(['image/jpeg','image/png','image/webp'].indexOf(mimeType)<0)throw new Error('Format foto harus JPG, PNG, atau WEBP.');
 const raw=String(dataUrl).replace(/^data:[^;]+;base64,/,'');if(!raw||raw.length>14*1024*1024)throw new Error('Data foto tidak valid atau terlalu besar.');
 let bytes;try{bytes=Utilities.base64Decode(raw);}catch(e){throw new Error('Data foto tidak valid.');}if(!bytes.length||bytes.length>10*1024*1024)throw new Error('Ukuran foto maksimal 10 MB.');
 validateUploadedFileSignature_(bytes,mimeType);const hash=sha256Hex_(bytes.join(',')),lock=LockService.getScriptLock();lock.waitLock(20000);
 try{
  const ss=getSS_(),found=findRowById_(ss.getSheetByName('Pengantaran'),assignmentId,1);if(!found)throw new Error('Penugasan tidak ditemukan.');
  const row=found.values,orderId=String(row[1]||''),status=String(row[3]||'').toUpperCase();if(String(row[2]||'')!==String(session.userId))throw new Error('Anda tidak berhak mengunggah bukti untuk tugas ini.');
  const proofSheet=ss.getSheetByName('BuktiPengantaran'),confSheet=ss.getSheetByName('KonfirmasiPengantaran');if(!proofSheet||!confSheet)throw new Error('Database bukti pengantaran belum tersedia. Jalankan setupFMartDatabase_().');
  const old=readRows_(proofSheet).map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[2]||'')===assignmentId);
  if(old&&(String(old.values[9]||'')!==String(session.userId)||String(old.values[11]||'')!==hash))throw new Error('Bukti untuk penugasan ini sudah ada dengan file berbeda. Hubungi Admin.');
  if(status!=='DALAM_PERJALANAN'&&!old)throw new Error('Bukti hanya dapat diunggah saat pengantaran berlangsung.');
  const order=findRowById_(ss.getSheetByName('Pesanan'),orderId,1),orderStatus=String(order&&order.values[8]||'').toUpperCase();
  if(!order||(orderStatus!=='DIANTAR'&&!(old&&orderStatus==='DITERIMA')))throw new Error('Pesanan tidak berada dalam status pengantaran yang dapat dipulihkan.');
  const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);if(!shipment||String(shipment.method||'').toUpperCase()!=='ANTAR_PESANTREN')throw new Error('Bukti foto hanya berlaku untuk pesanan Antar Pesantren.');
  const folder=getDeliveryProofFolder_(),name=orderId+'-'+assignmentId+'-'+hash.slice(0,16),marker='FMART_DELIVERY|'+orderId+'|'+assignmentId+'|'+hash,file=getOrCreateTransactionProofFile_(folder,name,mimeType,bytes,marker),now=new Date(),deadlineDefault=new Date(now.getTime()+7*86400000);
  let proofId;if(old){proofId=String(old.values[0]);proofSheet.getRange(old.rowNumber,4,1,2).setValues([[file.getId(),file.getUrl()]]);}else{proofId=makeFMartId_('BPD');proofSheet.appendRow([proofId,orderId,assignmentId,file.getId(),file.getUrl(),fileName,mimeType,bytes.length,note,session.userId,now,hash]);}
  const confRows=readRows_(confSheet),conf=confRows.map((r,i)=>({values:r,rowNumber:i+2})).find(x=>String(x.values[1]||'')===orderId);
  if(!conf)confSheet.appendRow([makeFMartId_('KPG'),orderId,now,deadlineDefault,'MENUNGGU_KONFIRMASI','','','',false,now]);
  const deadline=conf?conf.values[3]:deadlineDefault,waliId=String(order.values[2]||''),notifications=ss.getSheetByName('Notifikasi');
  if(waliId&&!readRows_(notifications).some(n=>String(n[1])===waliId&&String(n[2])===orderId&&String(n[3])==='Bukti pengantaran tersedia'))notifications.appendRow([makeFMartId_('NTF'),waliId,orderId,'Bukti pengantaran tersedia','Petugas telah mengunggah foto bukti pengantaran untuk pesanan '+String(order.values[1]||orderId)+'. Bukti akan ditampilkan pada detail pesanan.','PENGANTARAN',false,now]);
  if(!readRows_(ss.getSheetByName('RiwayatPengantaran')).some(r=>String(r[1])===orderId&&String(r[2])===assignmentId&&String(r[5]).toUpperCase()==='UNGGAH_BUKTI'))recordDeliveryHistory_(ss,assignmentId,orderId,session,'UNGGAH_BUKTI','DALAM_PERJALANAN','MENUNGGU_KONFIRMASI',note||'Bukti foto pengantaran diunggah');
  if(!readRows_(ss.getSheetByName('AuditLog')).some(a=>String(a[3]).toUpperCase()==='UPLOAD_DELIVERY_PROOF'&&String(a[5])===proofId))writeAudit_(session.userId,session.role,'UPLOAD_DELIVERY_PROOF','BUKTI_PENGANTARAN',proofId,'',JSON.stringify({orderId:orderId,assignmentId:assignmentId,mimeType:mimeType,sizeBytes:bytes.length,proofHash:hash,confirmationDeadline:new Date(deadline).toISOString()}),'Mengunggah bukti foto pengantaran');
  SpreadsheetApp.flush();return {ok:true,message:old?'Bukti sebelumnya sudah tersimpan. Pemulihan pencatatan selesai.':'Bukti pengantaran berhasil diunggah.',uploadedAt:(old?new Date(old.values[10]):now).toISOString(),confirmationDeadline:new Date(deadline).toISOString(),recovered:!!old};
 }finally{lock.releaseLock();}
}

function getDeliveryProofFolder_() {
  const props=PropertiesService.getScriptProperties(),key='FMART_DELIVERY_PROOF_FOLDER_ID';
  const id=props.getProperty(key),paymentId=props.getProperty('FMART_PAYMENT_PROOF_FOLDER_ID');
  if(id&&paymentId&&id===paymentId)throw new Error('Folder bukti pengantaran harus berbeda dari folder bukti pembayaran. Periksa Script Property FMART_DELIVERY_PROOF_FOLDER_ID.');
  if(id) { try { return DriveApp.getFolderById(id); } catch(e) {} }
  const folder=DriveApp.createFolder('FMart - Bukti Pengantaran');
  props.setProperty(key,folder.getId());
  return folder;
}

function getDeliveryAssignmentWorkspace(token) {
  requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.GUDANG,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_(), userRows=readRows_(ss.getSheetByName('Users'));
  const drivers=userRows.filter(r=>['PETUGAS_PENGANTAR','GUDANG'].indexOf(String(r[5]||'').toUpperCase())>=0&&String(r[6]||'').toUpperCase()==='AKTIF').map(r=>({userId:String(r[0]),name:String(r[4]||r[1]||'Petugas'),username:String(r[1]||''),role:String(r[5]||'').toUpperCase()}));
  const orders=readRows_(ss.getSheetByName('Pesanan')),payments=readRows_(ss.getSheetByName('Pembayaran')),shipments=readRows_(ss.getSheetByName('Pengiriman')),assignments=readRows_(ss.getSheetByName('Pengantaran'));
  const latestPayment={},latestShipment={},activeAssignment={};
  payments.forEach(r=>{const id=String(r[1]||''),old=latestPayment[id];if(id&&(!old||new Date(r[8]||0).getTime()>=new Date(old[8]||0).getTime()))latestPayment[id]=r;});
  shipments.forEach(r=>{const id=String(r[1]||''),old=latestShipment[id];if(id&&(!old||new Date(r[8]||0).getTime()>=new Date(old[8]||0).getTime()))latestShipment[id]=r;});
  assignments.forEach(r=>{const id=String(r[1]||''),st=String(r[3]||'').toUpperCase();if(id&&['DITUGASKAN','BARU','MENUNGGU_KONFIRMASI','DITERIMA','DITERIMA_PETUGAS','DALAM_PERJALANAN','DIANTAR'].indexOf(st)>=0)activeAssignment[id]=r;});
  const santriSheet=ss.getSheetByName('Santri'),santriMap=getSantriColumnMap_(santriSheet),santriById={};
  readSantriRows_(santriSheet).forEach(r=>{const x=santriRecord_(r,santriMap);if(x.id)santriById[x.id]=x;});
  const userById={};userRows.forEach(r=>{userById[String(r[0]||'')]={name:String(r[4]||'Wali Santri'),username:String(r[1]||'')};});
  const waliByUserId={};readRows_(ss.getSheetByName('WaliSantri')).forEach(function(r){if(String(r[1]||''))waliByUserId[String(r[1])]={name:String(r[2]||''),phone:String(r[3]||'')};});
  const ready=[],assigned=[];
  orders.forEach(r=>{
    const id=String(r[0]||''),status=String(r[8]||'').toUpperCase();if(!id||['DISIAPKAN','DIANTAR'].indexOf(status)<0)return;
    const pay=latestPayment[id],ship=latestShipment[id]||[];
    if(String(pay&&pay[5]||'').toUpperCase()!=='TERVERIFIKASI'||String(ship[2]||'').toUpperCase()!=='ANTAR_PESANTREN')return;
    const child=getOrderRecipientSnapshot_(ss,r),wali=waliByUserId[String(r[2]||'')]||userById[String(r[2]||'')]||{};
    const task={orderId:id,number:String(r[1]||id),status:status,total:Number(r[7])||0,childName:String(child.name||'Santri'),className:String(child.className||''),waliName:String(wali.name||'Wali Santri'),waliContact:String(wali.phone||wali.username||''),destination:String(ship[3]||''),shipmentStatus:String(ship[4]||'')};
    const current=activeAssignment[id];
    if(current){const driver=userById[String(current[2]||'')]||{};task.assignedAt=dateIso_(current[5]);task.driverName=String(driver.name||'Petugas');task.driverId=String(current[2]||'');task.assignmentStatus=String(current[3]||'');assigned.push(task);}
    else if(status==='DISIAPKAN')ready.push(task);
  });
  ready.sort((a,b)=>a.number.localeCompare(b.number));assigned.sort((a,b)=>String(b.assignedAt||'').localeCompare(String(a.assignedAt||'')));
  return {ok:true,drivers:drivers,ready:ready,assigned:assigned,updatedAt:new Date().toISOString()};
}
function assignDeliveryOrder(token,orderId,petugasUserId,note){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.GUDANG,FMART.ROLES.SUPERADMIN]);
  orderId=String(orderId||'').trim();petugasUserId=String(petugasUserId||'').trim();note=String(note||'').trim().slice(0,300);
  if(!orderId||!petugasUserId)throw new Error('Pesanan dan petugas pengantar wajib dipilih.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),order=findRowById_(ss.getSheetByName('Pesanan'),orderId,1),assignmentSheet=ss.getSheetByName('Pengantaran');
    if(!order)throw new Error('Pesanan tidak ditemukan.');
    if(String(order.values[8]||'').toUpperCase()!=='DISIAPKAN')throw new Error('Pesanan harus berstatus DISIAPKAN sebelum ditugaskan.');
    if(!assignmentSheet)throw new Error('Sheet Pengantaran belum tersedia. Jalankan setupFMartDatabase_() terlebih dahulu.');
    const users=readRows_(ss.getSheetByName('Users')),driver=users.find(r=>String(r[0]||'')===petugasUserId);
    if(!driver||['PETUGAS_PENGANTAR','GUDANG'].indexOf(String(driver[5]||'').toUpperCase())<0||String(driver[6]||'').toUpperCase()!=='AKTIF')throw new Error('Akun pelaksana pengantaran tidak ditemukan atau tidak aktif.');
    const payment=readRows_(ss.getSheetByName('Pembayaran')).filter(r=>String(r[1]||'')===orderId).sort((a,b)=>new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime())[0];
    if(!payment||String(payment[5]||'').toUpperCase()!=='TERVERIFIKASI')throw new Error('Pembayaran pesanan belum terverifikasi.');
    const shipment=latestShipmentForOrder_(readRows_(ss.getSheetByName('Pengiriman')),orderId);
    if(!shipment||String(shipment.method||'').toUpperCase()!=='ANTAR_PESANTREN')throw new Error('Pesanan ini bukan pesanan dengan metode Antar Pesantren.');
    const active=readRows_(assignmentSheet).find(r=>String(r[1]||'')===orderId&&['DITUGASKAN','BARU','MENUNGGU_KONFIRMASI','DITERIMA','DITERIMA_PETUGAS','DALAM_PERJALANAN','DIANTAR'].indexOf(String(r[3]||'').toUpperCase())>=0);
    if(active)throw new Error('Pesanan sudah memiliki penugasan aktif. Muat ulang antrean.');
    const now=new Date(),id=makeFMartId_('DLV');
    assignmentSheet.appendRow([id,orderId,petugasUserId,'DITUGASKAN',session.userId,now,'','','','','',note,now]);
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),petugasUserId,orderId,'Tugas pengantaran baru','Anda mendapat tugas pengantaran pesanan '+String(order.values[1]||orderId)+'.','PENGANTARAN',false,now]);
    writeAudit_(session.userId,session.role,'ASSIGN_DELIVERY','PENGANTARAN',id,'',JSON.stringify({orderId:orderId,petugasUserId:petugasUserId,status:'DITUGASKAN'}),note||'Menugaskan pesanan kepada petugas pengantar');
    SpreadsheetApp.flush();return {ok:true,assignmentId:id,message:'Pesanan berhasil ditugaskan.'};
  }finally{lock.releaseLock();}
}

function latestShipmentForOrder_(rows, orderId) {
  const found = rows.filter(function(r){return String(r[1])===String(orderId);}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();})[0];
  return found ? {id:String(found[0]),orderId:String(found[1]),method:String(found[2]||''),destination:String(found[3]||''),status:String(found[4]||''),dikirimAt:found[5],diterimaAt:found[6],updatedBy:String(found[7]||''),updatedAt:found[8]} : null;
}
function latestShipmentRow_(sheet, orderId) {
  const rows = readRows_(sheet); let found = null;
  rows.forEach(function(r,i){ if(String(r[1])===String(orderId)) found=i+2; });
  return found;
}
function dateIso_(value) { return value ? new Date(value).toISOString() : ''; }
function sanitizeFileName_(name) { return String(name||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,100); }
function ensureStockReservationSheet_(ss){let sh=ss.getSheetByName('ReservasiStok');if(!sh){sh=ss.insertSheet('ReservasiStok');sh.appendRow(['ReservasiId','PesananId','ProdukId','VariasiId','Qty','Status','CreatedAt','ExpiresAt','UpdatedAt']);}return sh;}
function getStockReservationMap_(ss,excludeOrderId){const rows=readRows_(ensureStockReservationSheet_(ss)),now=Date.now(),map={};rows.forEach(function(r){const expiry=new Date(r[7]||0).getTime();if(String(r[5]||'').toUpperCase()!=='AKTIF'||!Number.isFinite(expiry)||expiry<=now||String(r[1]||'')===String(excludeOrderId||''))return;const k=String(r[2]||'')+'|'+String(r[3]||'');map[k]=(map[k]||0)+Math.max(0,Number(r[4])||0);});return map;}
function setOrderReservationStatus_(ss,orderId,status,expiresAt){const sh=ensureStockReservationSheet_(ss),rows=readRows_(sh),now=new Date();rows.forEach(function(r,i){if(String(r[1]||'')!==String(orderId)||String(r[5]||'').toUpperCase()!=='AKTIF')return;sh.getRange(i+2,6).setValue(status);if(expiresAt)sh.getRange(i+2,8).setValue(expiresAt);sh.getRange(i+2,9).setValue(now);});}
function reserveOrderStock_(ss,orderId,items,minutes){
  const sh=ensureStockReservationSheet_(ss),now=new Date(),expires=new Date(now.getTime()+Math.max(1,Number(minutes)||30)*60000),reserved=getStockReservationMap_(ss,orderId),totals={};
  items.forEach(function(i){const k=String(i.productId)+'|'+String(i.variationId||'');totals[k]=(totals[k]||0)+Number(i.qty||0);});
  Object.keys(totals).forEach(function(k){const p=k.split('|'),snap=getProductSnapshot_(ss,p[0],p[1],'GUDANG');if(!snap||!snap.active||totals[k]+(reserved[k]||0)>snap.stock)throw new Error('Stok Gudang tidak mencukupi setelah memperhitungkan reservasi pesanan lain: '+(snap?snap.name:'produk')+'.');});
  Object.keys(totals).forEach(function(k){const p=k.split('|');sh.appendRow([makeFMartId_('RSV'),orderId,p[0],p[1],totals[k],'AKTIF',now,expires,now]);});return expires;
}
function expireStockReservations_(ss,now){now=now||new Date();const sh=ensureStockReservationSheet_(ss),rows=readRows_(sh),expired={};rows.forEach(function(r,i){if(String(r[5]||'').toUpperCase()!=='AKTIF'||!r[7]||new Date(r[7]).getTime()>now.getTime())return;expired[String(r[1]||'')]=true;sh.getRange(i+2,6).setValue('KEDALUWARSA');sh.getRange(i+2,9).setValue(now);});Object.keys(expired).forEach(function(id){const o=findRowById_(ss.getSheetByName('Pesanan'),id,1);if(!o||String(o.values[8]||'').toUpperCase()!=='MENUNGGU_PEMBAYARAN')return;const ps=ss.getSheetByName('Pembayaran'),pending=readRows_(ps).filter(function(p){return String(p[1])===id&&String(p[5]||'').toUpperCase()==='MENUNGGU_VERIFIKASI';});pending.forEach(function(p){const pr=findRowById_(ps,String(p[0]),1);if(pr)ps.getRange(pr.rowNumber,6,1,3).setValues([['DITOLAK','','']]);});ss.getSheetByName('Pesanan').getRange(o.rowNumber,9,1,3).setValues([['DIBATALKAN','Reservasi stok kedaluwarsa sebelum pembayaran selesai.',now]]);const sr=latestShipmentRow_(ss.getSheetByName('Pengiriman'),id);if(sr)ss.getSheetByName('Pengiriman').getRange(sr,5,1,5).setValues([['DIBATALKAN','','','SYSTEM',now]]);ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(o.values[2]),id,'Reservasi stok berakhir','Batas waktu reservasi stok pesanan telah berakhir. Silakan buat pesanan baru.','PESANAN',false,now]);writeAudit_('SYSTEM','SYSTEM','EXPIRE_STOCK_RESERVATION','PESANAN',id,JSON.stringify({status:'MENUNGGU_PEMBAYARAN'}),JSON.stringify({status:'DIBATALKAN'}),'Reservasi stok kedaluwarsa');});}
function getPaymentProofData(token,paymentId){const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN,FMART.ROLES.KASIR]);paymentId=String(paymentId||'').trim();const pay=findRowById_(getSS_().getSheetByName('Pembayaran'),paymentId,1);if(!pay)throw new Error('Data pembayaran tidak ditemukan.');if(session.role===FMART.ROLES.KASIR&&String(pay.values[2]||'').toUpperCase()!=='QRIS')throw new Error('Kasir hanya dapat melihat bukti pembayaran QRIS Wali Santri.');const m=String(pay.values[4]||'').match(/[-\w]{25,}/);if(!m)throw new Error('ID file bukti tidak valid.');const file=DriveApp.getFileById(m[0]),folder=getPaymentProofFolder_(),parents=file.getParents();let trusted=false;while(parents.hasNext()){if(parents.next().getId()===folder.getId()){trusted=true;break;}}if(!trusted)throw new Error('File bukti tidak berada pada folder FMart.');const blob=file.getBlob(),mime=String(blob.getContentType()||'').toLowerCase(),bytes=blob.getBytes();if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)||bytes.length>5*1024*1024)throw new Error('File bukti tidak memenuhi ketentuan.');return {ok:true,fileName:file.getName(),mimeType:mime,base64:Utilities.base64Encode(bytes)};}

function getPaymentProofFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(FMART_DB.PROPERTY_PAYMENT_PROOF_FOLDER_ID);
  if (id) { try { return DriveApp.getFolderById(id); } catch(e) {} }
  const folder = DriveApp.createFolder('FMart - Bukti Pembayaran');
  props.setProperty(FMART_DB.PROPERTY_PAYMENT_PROOF_FOLDER_ID, folder.getId());
  return folder;
}

function buildCartSnapshot_(ss, userId, santriId) {
  const rows = readRows_(ss.getSheetByName('Keranjang')); const items=[];
  rows.forEach(function(r){
    if(String(r[1])!==String(userId)||String(r[2])!==String(santriId))return;
    const qty=Math.max(0,Math.floor(Number(r[5])||0)); if(!qty)return;
    const snap=getProductSnapshot_(ss,r[3],r[4]);
    items.push({cartId:String(r[0]),productId:String(r[3]),variationId:String(r[4]||''),qty:qty,active:!!(snap&&snap.active),stock:snap?snap.stock:0,name:snap?snap.name:'Produk tidak tersedia',sku:snap?snap.sku:'',variationName:snap?snap.variationName:'',unitPrice:snap?snap.unitPrice:0});
  });
  return {items:items};
}

function normalizeOrderRecipient_(data, shippingMethod, note) {
  data=data&&typeof data==='object'?data:{};
  const recipient={name:String(data.name||'').trim().replace(/\s+/g,' ').slice(0,120),className:String(data.className||'').trim().slice(0,80),asrama:String(data.asrama||'').trim().slice(0,100),phone:String(data.phone||'').trim().slice(0,30),address:String(data.address||'').trim().slice(0,300)};
  if(recipient.name.length<2)throw new Error('Nama Santri/penerima wajib diisi.');
  if(String(shippingMethod||'').toUpperCase()==='ANTAR_PESANTREN'&&!recipient.address)throw new Error('Alamat atau lokasi pengiriman wajib diisi.');
  if(recipient.phone&&!/^[0-9+() .-]{8,30}$/.test(recipient.phone))throw new Error('Nomor kontak penerima tidak valid.');
  return recipient;
}

function assertWaliSavedRecipient_(ss,userId,santriId){
 const wali=findWaliByUserId_(ss,userId);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');
 const rel=readRows_(ss.getSheetByName('WaliSantriSantri')).find(r=>String(r[1]||'')===String(wali.waliId)&&String(r[2]||'')===String(santriId)&&['AKTIF','ALAMAT_PESANAN'].includes(String(r[3]||'').toUpperCase()));
 if(!rel)throw new Error('Santri belum tersimpan sebagai alamat pemesanan pada akun Anda.');
 const sheet=ss.getSheetByName('Santri'),found=findSantriRowById_(sheet,santriId);if(!found)throw new Error('Data Santri tidak ditemukan.');
 const child=santriRecord_(found.values,getSantriColumnMap_(sheet));if(child.status.toUpperCase()!=='AKTIF')throw new Error('Santri tidak aktif dan tidak dapat dipilih.');return child;
}
function getOrderRecipientSnapshot_(ss, orderRow) {
  const row=orderRow&&orderRow.values?orderRow.values:orderRow||[];
  let payload={};try{payload=JSON.parse(String(row[14]||'{}'));}catch(e){}
  const snap=payload&&payload.recipientSnapshot;
  if(snap&&String(snap.name||'').trim())return {name:String(snap.name||''),className:String(snap.className||''),asrama:String(snap.asrama||''),phone:String(snap.phone||''),address:String(snap.address||''),legacy:false};
  const sid=String(row[3]||'');
  if(sid){const sheet=ss.getSheetByName('Santri'),found=findSantriRowById_(sheet,sid);if(found){const data=santriRecord_(found.values,getSantriColumnMap_(sheet));return {id:data.id,name:data.name,className:data.className,asrama:data.asrama||'',phone:'',address:'',legacy:true};}}
  return {name:'Santri',className:'',asrama:'',phone:'',address:'',legacy:false};
}

function assertWaliChild_(ss, userId, santriId) {
  santriId = String(santriId || '').trim();
  if (!santriId) throw new Error('Anak belum dipilih.');
  const children = getChildrenForWali_(ss, userId);
  const child = children.find(function(c){return String(c.id)===santriId;});
  if (!child) throw new Error('Anak tidak terhubung ke akun Wali Santri.');
  return child;
}

function getProductSnapshot_(ss, productId, variationId, stockLocation) {
  productId=String(productId||'').trim();variationId=String(variationId||'').trim();stockLocation=String(stockLocation||'GUDANG').toUpperCase();
  if(!productId)return null;if(['GUDANG','KASIR'].indexOf(stockLocation)<0)throw new Error('Lokasi stok tidak valid.');
  const productRow=findRowById_(ss.getSheetByName('Produk'),productId,1);if(!productRow)return null;const p=productRow.values;
  if(String(p[8]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};const cat=findRowById_(ss.getSheetByName('Kategori'),String(p[1]||''),1);if(!cat||String(cat.values[4]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};
  let addition=0,variationName='';if(variationId){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(!vr||String(vr.values[1])!==productId||String(vr.values[6]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};addition=Number(vr.values[4])||0;variationName=String(vr.values[2]||'')+(vr.values[3]?': '+String(vr.values[3]):'');}
  const sheetName=stockLocation==='KASIR'?'StokKasir':'Stok',sheet=ss.getSheetByName(sheetName);if(!sheet)throw new Error('Sheet '+sheetName+' belum tersedia. Jalankan setupFMartDatabase_().');
  const matches=readRows_(sheet).filter(function(r){return String(r[1])===productId&&String(r[2]||'')===variationId;});if(matches.length>1)throw new Error('Ditemukan baris stok ganda pada lokasi '+stockLocation+'.');
  const sr=matches.length?matches[0]:null;const stock=sr?Number(sr[3]):0;
  if(!Number.isSafeInteger(stock)||stock<0)throw new Error('Saldo stok '+stockLocation+' tidak valid.');
  return {active:true,id:productId,name:String(p[3]||''),sku:String(p[2]||''),photoUrl:String(p[7]||''),unitPrice:Math.max(0,(Number(p[5])||0)+addition),stock:stock,variationId:variationId,variationName:variationName,stockLocation:stockLocation};
}

/** Pemetaan master Santri bersama FMart/FMPay berdasarkan nama header, bukan posisi kolom. */
function getSantriColumnMap_(sheet) {
  if (!sheet || sheet.getLastColumn() < 1) throw new Error('Sheet Santri tidak ditemukan atau belum memiliki header.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const map = {};
  headers.forEach(function(value, index) {
    const key = String(value || '').trim().toLowerCase();
    if (key) map[key] = index;
  });
  const required = ['nis', 'nama_santri', 'kelas', 'santriid', 'status'];
  const missing = required.filter(function(key) { return map[key] === undefined; });
  if (missing.length) throw new Error('Struktur master Santri belum lengkap. Header belum tersedia: ' + missing.join(', ') + '. Jalankan setupFMartDatabase_() dan migrasi master Santri terlebih dahulu.');
  return map;
}

function santriField_(row, map, key) {
  const index = map[String(key || '').toLowerCase()];
  return index === undefined ? '' : row[index];
}

function readSantriRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
}

function santriRecord_(row, map) {
  return {
    id: String(santriField_(row, map, 'SantriId') || ''),
    nis: String(santriField_(row, map, 'nis') || ''),
    name: String(santriField_(row, map, 'nama_santri') || ''),
    className: String(santriField_(row, map, 'kelas') || ''),
    asrama: String(santriField_(row, map, 'asrama') || ''),
    status: String(santriField_(row, map, 'Status') || '')
  };
}

function findSantriRowById_(sheet, santriId) {
  const map = getSantriColumnMap_(sheet);
  const idColumn = map.santriid + 1;
  if (sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '') === String(santriId || '')) {
      const rowNumber = i + 2;
      return { rowNumber: rowNumber, values: sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] };
    }
  }
  return null;
}

function makeFMartId_(prefix){ return prefix + '-' + Utilities.getUuid().replace(/-/g,'').slice(0,18).toUpperCase(); }

function requireSession_(token) {
  if (!token || typeof token !== 'string') throw new Error('Sesi tidak valid. Silakan login kembali.');
  const cache=CacheService.getScriptCache(),key=sessionKey_(token),raw=cache.get(key);
  if(!raw) throw new Error('Sesi telah berakhir. Silakan login kembali.');
  let s;
  try{s=JSON.parse(raw);}catch(e){cache.remove(key);throw new Error('Sesi tidak valid. Silakan login kembali.');}
  if(!s.userId||!s.role||!Number.isFinite(Number(s.authUpdatedAt))){cache.remove(key);throw new Error('Sesi perlu diperbarui. Silakan login kembali.');}
  const user=findRowById_(getSS_().getSheetByName('Users'),String(s.userId),1);
  if(!user){cache.remove(key);throw new Error('Akun tidak ditemukan. Silakan login kembali.');}
  const role=String(user.values[5]||'').toUpperCase(),status=String(user.values[6]||'').toUpperCase();
  const updatedAt=user.values[8] instanceof Date?user.values[8].getTime():(new Date(user.values[8]||0).getTime()||0);
  if(status!=='AKTIF'||role!==String(s.role).toUpperCase()||updatedAt!==Number(s.authUpdatedAt)){
    cache.remove(key);throw new Error('Akses akun telah berubah. Silakan login kembali.');
  }
  s.nama=String(user.values[4]||s.nama||'');
  return s;
}

function requireRole_(token, allowedRoles) {
  const s = requireSession_(token);
  if (allowedRoles.indexOf(s.role) === -1) throw new Error('Anda tidak memiliki izin untuk tindakan ini.');
  return s;
}

function normalizeUsername_(value) {
  return String(value || '').trim().toLowerCase();
}

function sessionKey_(token) {
  return 'FMART_SESSION_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0,80);
}

function passwordHashMode_() {
  const configured = PropertiesService.getScriptProperties().getProperty(FMART.PASSWORD_HASH_MODE_PROPERTY);
  return String(configured || 'LEGACY').toUpperCase() === 'PBKDF2' ? 'PBKDF2' : 'LEGACY';
}

function hashPassword_(password, salt) {
  if (passwordHashMode_() === 'PBKDF2') {
    return 'pbkdf2-sha256:' + FMART.PASSWORD_HASH_ITERATIONS + ':' + pbkdf2HmacSha256_(password, salt, FMART.PASSWORD_HASH_ITERATIONS);
  }
  return legacyHashPassword_(password, salt);
}

function verifyPassword_(password, salt, expectedHash) {
  expectedHash = String(expectedHash || '');
  if (expectedHash.indexOf('pbkdf2-sha256:') === 0) {
    const parts = expectedHash.split(':');
    const iterations = Number(parts[1]);
    if (parts.length !== 3 || !Number.isInteger(iterations) || iterations < 100000 || iterations > 600000) return false;
    const actual = 'pbkdf2-sha256:' + iterations + ':' + pbkdf2HmacSha256_(password, salt, iterations);
    return constantTimeEqual_(actual, expectedHash);
  }
  return constantTimeEqual_(legacyHashPassword_(password, salt), expectedHash);
}

function legacyHashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + String(password), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes);
}

function isLegacyPasswordHash_(hash) {
  return String(hash || '').indexOf('pbkdf2-sha256:') !== 0;
}

/** PBKDF2-HMAC-SHA256 RFC 8018, satu blok keluaran 32 byte. */
function pbkdf2HmacSha256_(password, salt, iterations) {
  iterations = Number(iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 600000) throw new Error('Parameter PBKDF2 tidak valid.');
  const passwordBytes = Utilities.newBlob(String(password), 'text/plain').getBytes();
  const saltBytes = Utilities.newBlob(String(salt), 'text/plain').getBytes();
  const block = saltBytes.concat([0, 0, 0, 1]);
  let u = Utilities.computeHmacSha256Signature(block, passwordBytes);
  const derived = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, passwordBytes);
    for (let j = 0; j < derived.length; j++) derived[j] = derived[j] ^ u[j];
  }
  return Utilities.base64EncodeWebSafe(derived);
}

/** Jalankan manual dari editor Apps Script untuk memeriksa vektor RFC 8018. */
function testPbkdf2Implementation_() {
  const actual = pbkdf2HmacSha256_('password', 'salt', 1);
  const expected = 'Eg-2z_z4syxD5yJSVsT4N6hlSMkszDVICAWYfLcL4Xs=';
  if (actual !== expected) throw new Error('Uji PBKDF2 gagal: ' + actual);
  return 'Uji PBKDF2 RFC 8018 berhasil.';
}

/** Benchmark awal 10.000 iterasi; ukur sebelum mengaktifkan mode PBKDF2. */
function benchmarkPbkdf2_() {
  const start = Date.now();
  pbkdf2HmacSha256_('benchmark-password', 'fmart-benchmark-salt', 10000);
  const elapsed = Date.now() - start;
  Logger.log('PBKDF2 10.000 iterasi: ' + elapsed + ' ms; estimasi kasar 600.000 iterasi: ' + (elapsed * 60) + ' ms.');
  return {iterations:10000,elapsedMs:elapsed,estimated600kMs:elapsed*60};
}

function activatePbkdf2PasswordHashing_() {
  testPbkdf2Implementation_();
  const start = Date.now();
  pbkdf2HmacSha256_('FMart-runtime-benchmark', 'FMart-runtime-benchmark-salt', FMART.PASSWORD_HASH_ITERATIONS);
  const elapsedMs = Date.now() - start;
  const maxLoginHashMs = 1500;
  if (elapsedMs > maxLoginHashMs) return {ok:false,enabled:false,iterations:FMART.PASSWORD_HASH_ITERATIONS,elapsedMs:elapsedMs,message:'PBKDF2 belum diaktifkan karena benchmark melebihi batas login '+maxLoginHashMs+' ms. Mode lama tetap berjalan.'};
  PropertiesService.getScriptProperties().setProperty(FMART.PASSWORD_HASH_MODE_PROPERTY, 'PBKDF2');
  return {ok:true,enabled:true,iterations:FMART.PASSWORD_HASH_ITERATIONS,elapsedMs:elapsedMs,message:'PBKDF2 aktif. Akun lama akan dimigrasikan setelah login berhasil.'};
}

function constantTimeEqual_(a,b) {
  a=String(a||''); b=String(b||'');
  let diff=a.length^b.length;
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++) diff |= (a.charCodeAt(i)||0) ^ (b.charCodeAt(i)||0);
  return diff===0;
}


function loginRateKey_(username) {
  const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,'LOGIN|'+normalizeUsername_(username),Utilities.Charset.UTF_8);
  return 'FMART_LOGIN_RATE_'+Utilities.base64EncodeWebSafe(digest).slice(0,50);
}

/** Menambah hitungan gagal login secara serial agar percobaan bersamaan tidak saling menimpa. */
function recordLoginFailure_(rateKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const current = Number(cache.get(rateKey) || 0);
    cache.put(rateKey, String(Math.min(FMART.LOGIN_MAX_FAILURES, current + 1)), FMART.LOGIN_RATE_LIMIT_SECONDS);
  } finally {
    lock.releaseLock();
  }
}

function writeAudit_(userId, role, action, entityType, entityId, beforeData, afterData, note, createdAt) {
  try {
    const sheet=getSS_().getSheetByName('AuditLog');
    if(!sheet) return;
    const safe=function(v){return String(v||'').slice(0,5000);};
    sheet.appendRow([makeFMartId_('AUD'),String(userId||''),String(role||''),String(action||''),String(entityType||''),String(entityId||''),safe(beforeData),safe(afterData),safe(note),createdAt instanceof Date?createdAt:new Date()]);
  } catch(e) { console.warn('Audit log gagal dicatat:', e); }
}

function readRows_(sheet) {
  if (!sheet || sheet.getLastRow()<2) return [];
  return sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
}



/**
 * Audit runtime FMart bersifat read-only.
 * Memeriksa database aktif, jumlah akun per role, ringkasan status transaksi,
 * izin folder bukti Drive, dan keberadaan trigger otomatis.
 * Jalankan manual dari Apps Script Editor: auditFMartRuntime_()
 * Tidak membuat folder/trigger, tidak mengubah data, dan tidak mengirim notifikasi.
 */
function auditFMartRuntime_() {
  const result = {
    checkedAt: new Date().toISOString(),
    mode: 'READ_ONLY',
    database: { ok: false },
    sheets: {},
    activeUsersByRole: {},
    transactionSummary: {},
    driveFolders: {},
    triggers: [],
    issues: []
  };
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty(FMART.SPREADSHEET_PROPERTY);

  if (!spreadsheetId) {
    result.issues.push({ code: 'DATABASE_ID_MISSING', detail: 'Script Property FMART_SPREADSHEET_ID belum diisi.' });
    return result;
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
    result.database = {
      ok: true,
      name: ss.getName(),
      timeZone: ss.getSpreadsheetTimeZone(),
      sheetCount: ss.getSheets().length
    };
  } catch (err) {
    result.issues.push({ code: 'DATABASE_UNAVAILABLE', detail: String(err && err.message || err) });
    return result;
  }

  const names = ['Users','WaliSantri','Santri','Produk','Stok','MutasiStok','StokKasir','MutasiStokKasir','Pesanan','DetailPesanan','Pembayaran','Pengiriman','Pengantaran','BuktiPengantaran','KonfirmasiPengantaran','KomplainPengantaran','ReservasiStok','PenjualanToko','DetailPenjualanToko','ReservasiStokToko','Notifikasi','AuditLog'];
  names.forEach(function(name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      result.sheets[name] = { exists: false, rows: 0 };
      result.issues.push({ code: 'MISSING_SHEET', detail: 'Sheet ' + name + ' tidak ditemukan.' });
      return;
    }
    result.sheets[name] = { exists: true, rows: Math.max(0, sheet.getLastRow() - 1) };
  });

  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet && usersSheet.getLastRow() > 1) {
    usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, 12).getValues().forEach(function(row) {
      const role = String(row[5] || '').trim().toUpperCase();
      const status = String(row[6] || '').trim().toUpperCase();
      if (status === 'AKTIF' && role) result.activeUsersByRole[role] = (result.activeUsersByRole[role] || 0) + 1;
    });
    ['SUPERADMIN','ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERVISOR','WALI_SANTRI'].forEach(function(role) {
      if (!result.activeUsersByRole[role]) result.issues.push({ code: 'NO_ACTIVE_ROLE_ACCOUNT', detail: 'Tidak ditemukan akun aktif untuk role ' + role + '.' });
    });
  } else {
    result.issues.push({ code: 'USERS_EMPTY', detail: 'Sheet Users belum memiliki akun.' });
  }

  function countStatuses_(sheetName, columnIndex) {
    const sheet = ss.getSheetByName(sheetName), counts = {};
    if (!sheet || sheet.getLastRow() < 2) return counts;
    sheet.getRange(2, columnIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) {
      const status = String(row[0] || '').trim().toUpperCase();
      if (status) counts[status] = (counts[status] || 0) + 1;
    });
    return counts;
  }
  result.transactionSummary = {
    ordersByStatus: countStatuses_('Pesanan', 8),
    paymentsByStatus: countStatuses_('Pembayaran', 5),
    shipmentsByStatus: countStatuses_('Pengiriman', 4),
    deliveryAssignmentsByStatus: countStatuses_('Pengantaran', 3),
    complaintsByStatus: countStatuses_('KomplainPengantaran', 6),
    storeSalesByStatus: countStatuses_('PenjualanToko', 12),
    storeSalesPaymentByStatus: countStatuses_('PenjualanToko', 11)
  };

  const proofFolderIds = {};
  [
    { key: 'FMART_PAYMENT_PROOF_FOLDER_ID', label: 'paymentProof' },
    { key: 'FMART_DELIVERY_PROOF_FOLDER_ID', label: 'deliveryProof' }
  ].forEach(function(item) {
    const folderId = props.getProperty(item.key);
    if (folderId) proofFolderIds[item.label] = String(folderId);
    if (!folderId) {
      result.driveFolders[item.label] = { configured: false, accessible: false };
      result.issues.push({ code: 'DRIVE_FOLDER_NOT_CONFIGURED', detail: 'Folder ' + item.label + ' belum dikonfigurasi.' });
      return;
    }
    try {
      const folder = DriveApp.getFolderById(folderId);
      const access = String(folder.getSharingAccess());
      const permission = String(folder.getSharingPermission());
      result.driveFolders[item.label] = {
        configured: true,
        accessible: true,
        name: folder.getName(),
        sharingAccess: access,
        sharingPermission: permission
      };
      if (access.indexOf('ANYONE') >= 0) {
        result.issues.push({ code: 'DRIVE_FOLDER_PUBLIC', detail: 'Folder ' + item.label + ' memiliki akses berbagi publik: ' + access + '.' });
      }
    } catch (err) {
      result.driveFolders[item.label] = { configured: true, accessible: false };
      result.issues.push({ code: 'DRIVE_FOLDER_INACCESSIBLE', detail: 'Folder ' + item.label + ' tidak dapat diakses oleh akun eksekusi: ' + String(err && err.message || err) });
    }
  });

  if (proofFolderIds.paymentProof && proofFolderIds.deliveryProof &&
      proofFolderIds.paymentProof === proofFolderIds.deliveryProof) {
    result.issues.push({
      code: 'DRIVE_PROOF_FOLDERS_REUSED',
      detail: 'Folder bukti pembayaran dan bukti pengantaran menggunakan folder Drive yang sama. Pisahkan kedua folder.'
    });
  }

  try {
    result.triggers = ScriptApp.getProjectTriggers().map(function(trigger) {
      return {
        handler: trigger.getHandlerFunction(),
        eventType: String(trigger.getEventType()),
        triggerSource: String(trigger.getTriggerSource())
      };
    });
    const hasDeliveryAutomation = result.triggers.some(function(trigger) {
      return trigger.handler === 'processDeliveryAutoConfirmation_';
    });
    if (!hasDeliveryAutomation) {
      result.issues.push({ code: 'DELIVERY_TRIGGER_MISSING', detail: 'Trigger processDeliveryAutoConfirmation_ belum terpasang.' });
    }
  } catch (err) {
    result.issues.push({ code: 'TRIGGER_AUDIT_FAILED', detail: String(err && err.message || err) });
  }

  result.ok = result.issues.length === 0;
  return result;
}



function transferWarehouseStockToCashier(token,productId,variationId,qty,note,requestKey){
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);productId=String(productId||'').trim();variationId=String(variationId||'').trim();qty=Number(qty);note=String(note||'').trim().slice(0,300);requestKey=String(requestKey||'').trim();
  if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci pemindahan tidak valid. Muat ulang formulir dan coba kembali.');
  if(!productId||!Number.isSafeInteger(qty)||qty<1)throw new Error('Produk dan jumlah pemindahan harus valid.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),warehouse=ss.getSheetByName('Stok'),cashier=ss.getSheetByName('StokKasir'),wm=ss.getSheetByName('MutasiStok'),cm=ss.getSheetByName('MutasiStokKasir');
    if(!warehouse||!cashier||!wm||!cm)throw new Error('Struktur stok terpisah belum tersedia. Jalankan setupFMartDatabase_().');
    const wr=readRows_(warehouse),cr=readRows_(cashier),wMatches=[],cMatches=[];
    wr.forEach((r,i)=>{if(String(r[1])===productId&&String(r[2]||'')===variationId)wMatches.push({row:r,index:i});});
    cr.forEach((r,i)=>{if(String(r[1])===productId&&String(r[2]||'')===variationId)cMatches.push({row:r,index:i});});
    if(wMatches.length>1)throw new Error('Saldo Gudang ganda.');if(cMatches.length>1)throw new Error('Saldo Kasir ganda.');
    const priorW=readRows_(wm).filter(r=>String(r[7]||'')===requestKey),priorC=readRows_(cm).filter(r=>String(r[7]||'')===requestKey);
    let beforeW,beforeC,afterW,afterC,transferId=requestKey,now=new Date(),duplicate=priorW.length>0||priorC.length>0;
    if(duplicate){
      const valid=(r,type,before,after)=>String(r[1])===productId&&String(r[2]||'')===variationId&&String(r[3]).toUpperCase()===type&&Number(r[4])===qty&&String(r[8]||'')==='Transfer Gudang ke Kasir'+(note?' · '+note:'')&&String(r[9]||'')===session.userId&&Number(r[6])===Number(r[5])+(type==='MASUK'?qty:-qty);
      if(!priorW.length)throw new Error('Jurnal Gudang transfer tidak ditemukan. Pemulihan dihentikan agar saldo tidak ditebak.');
      if(priorW.length>1||priorC.length>1)throw new Error('Jurnal transfer ganda; pemulihan dihentikan.');
      if(!valid(priorW[0],'KELUAR'))throw new Error('Jurnal Gudang tidak cocok dengan permintaan transfer.');
      beforeW=Number(priorW[0][5]);afterW=Number(priorW[0][6]);
      if(!Number.isSafeInteger(beforeW)||!Number.isSafeInteger(afterW)||afterW!==beforeW-qty||afterW<0)throw new Error('Saldo sebelum/sesudah pada jurnal Gudang tidak valid.');
      if(priorC.length){
        if(!valid(priorC[0],'MASUK')||Number(priorC[0][6])!==Number(priorC[0][5])+qty)throw new Error('Jurnal Kasir tidak cocok dengan permintaan transfer.');
        beforeC=Number(priorC[0][5]);afterC=Number(priorC[0][6]);
      }else{
        beforeC=cMatches.length?Number(cMatches[0].row[3]):0;
        if(!Number.isSafeInteger(beforeC)||beforeC<0)throw new Error('Saldo Kasir tidak valid untuk pemulihan transfer.');
        afterC=beforeC+qty;
        if(!Number.isSafeInteger(afterC))throw new Error('Saldo Kasir melebihi batas angka yang aman.');
      }
      if(priorC.length&&(!valid(priorC[0],'MASUK')||Number(priorC[0][5])!==beforeC||Number(priorC[0][6])!==afterC))throw new Error('Jurnal Kasir tidak cocok.');
      if(!priorC.length)cm.appendRow([makeFMartId_('MCK'),productId,variationId,'MASUK',qty,beforeC,afterC,transferId,'Transfer Gudang ke Kasir'+(note?' · '+note:''),session.userId,now]);
    }else{
      const snap=getProductSnapshot_(ss,productId,variationId,'GUDANG');if(!snap||!snap.active)throw new Error('Produk atau variasi tidak aktif.');
      beforeW=wMatches.length?Number(wMatches[0].row[3]):Number(snap.stock);beforeC=cMatches.length?Number(cMatches[0].row[3]):0;
      if(!Number.isSafeInteger(beforeW)||beforeW<0||!Number.isSafeInteger(beforeC)||beforeC<0)throw new Error('Saldo stok tidak valid.');
      const reserved=getStockReservationMap_(ss,'')[productId+'|'+variationId]||0;
      if(beforeW-qty<reserved)throw new Error('Pemindahan akan mengurangi stok Gudang di bawah reservasi pesanan Wali ('+reserved+' unit).');
      if(beforeW<qty)throw new Error('Stok Gudang tidak mencukupi.');
      afterW=beforeW-qty;afterC=beforeC+qty;if(!Number.isSafeInteger(afterC))throw new Error('Saldo Kasir melebihi batas angka yang aman.');
      const desc='Transfer Gudang ke Kasir'+(note?' · '+note:'');
      wm.appendRow([makeFMartId_('MUT'),productId,variationId,'KELUAR',qty,beforeW,afterW,transferId,desc,session.userId,now]);
      cm.appendRow([makeFMartId_('MCK'),productId,variationId,'MASUK',qty,beforeC,afterC,transferId,desc,session.userId,now]);
      SpreadsheetApp.flush();
    }
    function reconcileBalance(sheet,matches,kind,before,after,minStock){
      if(matches.length){const live=Number(sheet.getRange(matches[0].index+2,4).getValue());if(live===before){sheet.getRange(matches[0].index+2,4,1,3).setValues([[after,minStock||0,now]]);}else if(live!==after)throw new Error('Saldo '+kind+' tidak cocok dengan jurnal transfer; pemulihan dihentikan.');}
      else {if(before!==0)throw new Error('Baris saldo '+kind+' hilang; pemulihan dihentikan.');sheet.appendRow([makeFMartId_('STK'),productId,variationId,after,minStock||0,now]);}
    }
    reconcileBalance(warehouse,wMatches,'Gudang',beforeW,afterW,wMatches.length?Number(wMatches[0].row[4])||0:Number(findRowById_(ss.getSheetByName('Produk'),productId,1).values[6])||0);
    reconcileBalance(cashier,cMatches,'Kasir',beforeC,afterC,cMatches.length?Number(cMatches[0].row[4])||0:0);
    const vr=variationId?findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1):null;if(variationId&&vr){const mirror=Number(vr.values[5]);if(mirror===beforeW)ss.getSheetByName('VariasiProduk').getRange(vr.rowNumber,6,1,3).setValues([[afterW,String(vr.values[6]||'AKTIF'),now]]);else if(mirror!==afterW)throw new Error('Saldo mirror variasi tidak cocok dengan jurnal transfer.');}
    const audit=readRows_(ss.getSheetByName('AuditLog'));if(!audit.some(r=>String(r[3]).toUpperCase()==='TRANSFER_STOCK_TO_CASHIER'&&String(r[5])===transferId))writeAudit_(session.userId,session.role,'TRANSFER_STOCK_TO_CASHIER','STOK',transferId,JSON.stringify({productId:productId,variationId:variationId,warehouse:beforeW,cashier:beforeC}),JSON.stringify({qty:qty,warehouse:afterW,cashier:afterC}),note||'Pemindahan stok Gudang ke Kasir',now);
    SpreadsheetApp.flush();return {ok:true,duplicate:duplicate,transferId:transferId,productId:productId,variationId:variationId,qty:qty,warehouseStock:afterW,cashierStock:afterC};
  }finally{lock.releaseLock();}
}
function getCashierStockManagement(token){requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);const ss=getSS_(),products=readRows_(ss.getSheetByName('Produk')),vars=readRows_(ss.getSheetByName('VariasiProduk')),stocks=readRows_(ss.getSheetByName('StokKasir')),pm={},vm={};products.forEach(function(p){pm[String(p[0])]=p;});vars.forEach(function(v){vm[String(v[0])]=v;});const items=stocks.map(function(r){const p=pm[String(r[1])],v=String(r[2]||'')?vm[String(r[2])]:null;return {productId:String(r[1]),variationId:String(r[2]||''),name:p?String(p[3]||'Produk tidak ditemukan'):'Produk tidak ditemukan',sku:p?String(p[2]||''):'',variationName:v?[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': '):'',stock:Number(r[3])||0,minStock:Number(r[4])||0,updatedAt:dateIso_(r[5])};});return {ok:true,stockLocation:'KASIR',items:items,summary:{totalItems:items.length,totalUnits:items.reduce(function(n,x){return n+x.stock;},0)}};}

/* =========================
 * POS KASIR — PENJUALAN TOKO
 * ========================= */

function getCashierPOSData(token, searchText) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]),ss=getSS_(),query=String(searchText||'').trim().toLowerCase().slice(0,80);
  const products=readRows_(ss.getSheetByName('Produk')),categories=readRows_(ss.getSheetByName('Kategori')),variations=readRows_(ss.getSheetByName('VariasiProduk')),stocks=readRows_(ss.getSheetByName('StokKasir')),reservedStore=getStoreSaleReservationMap_(ss);
  const categoryMap={};categories.forEach(function(r){categoryMap[String(r[0])]=String(r[4]||'').toUpperCase();});const variationMap={};variations.forEach(function(r){if(String(r[6]||'').toUpperCase()!=='AKTIF')return;const pid=String(r[1]);if(!variationMap[pid])variationMap[pid]=[];variationMap[pid].push(r);});
  const stockMap=Object.create(null);stocks.forEach(function(r){const key=String(r[1])+'|'+String(r[2]||'');if(Object.prototype.hasOwnProperty.call(stockMap,key))throw new Error('Ditemukan saldo Kasir ganda untuk '+key+'.');const qty=Number(r[3]);if(!Number.isSafeInteger(qty)||qty<0)throw new Error('Saldo Kasir tidak valid untuk '+key+'.');stockMap[key]=qty;});
  const items=[];products.forEach(function(p){const pid=String(p[0]||''),name=String(p[3]||''),sku=String(p[2]||'');if(!pid||String(p[8]||'').toUpperCase()!=='AKTIF'||categoryMap[String(p[1])]!=='AKTIF')return;const vars=variationMap[pid]||[],targets=vars.length?vars:[null];targets.forEach(function(v){const vid=v?String(v[0]):'',hay=(name+' '+sku+' '+(v?String(v[2]||'')+' '+String(v[3]||''):'')).toLowerCase();if(query&&hay.indexOf(query)<0)return;const key=pid+'|'+vid,physical=stockMap[key]||0,reserved=reservedStore[key]||0;items.push({productId:pid,variationId:vid,sku:sku,name:name,variationName:v?String(v[2]||'')+(v[3]?': '+String(v[3]):''):'',unitPrice:Math.max(0,(Number(p[5])||0)+(v?Number(v[4])||0:0)),stock:physical,reserved:reserved,available:Math.max(0,physical-reserved),photoUrl:String(p[7]||'')});});});
  items.sort(function(a,b){return a.name.localeCompare(b.name,'id');});const sales=readRows_(ss.getSheetByName('PenjualanToko')).filter(function(r){return session.role!==FMART.ROLES.KASIR||String(r[13]||'')===String(session.userId);}).slice(-12).reverse().map(function(r){return {id:String(r[0]||''),number:String(r[1]||''),buyerType:String(r[2]||''),buyerName:String(r[3]||''),total:Number(r[7])||0,paymentMethod:String(r[8]||''),paymentStatus:String(r[11]||''),status:String(r[12]||''),createdAt:r[15] instanceof Date?r[15].toISOString():String(r[15]||'')};});
  return {ok:true,products:items.slice(0,250),recentSales:sales,serverTime:new Date().toISOString(),stockLocation:'KASIR'};
}

/** Pencarian santri opsional untuk identitas pembeli POS. */
function searchCashierSantri(token, searchText) {
  requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const q=String(searchText||'').trim().toLowerCase();
  if(q.length<2)return {ok:true,students:[]};
  const sheet=getSS_().getSheetByName('Santri'),map=getSantriColumnMap_(sheet);
  const rows=readSantriRows_(sheet),result=[];
  for(let i=0;i<rows.length&&result.length<20;i++){
    const record=santriRecord_(rows[i],map);
    if(!record.id||String(record.status||'').toUpperCase()!=='AKTIF')continue;
    if((record.name+' '+record.nis+' '+record.className).toLowerCase().indexOf(q)<0)continue;
    result.push({id:record.id,name:record.name,nis:record.nis,className:record.className});
  }
  return {ok:true,students:result};
}

/**
 * Membuat penjualan langsung. TUNAI langsung membukukan stok; QRIS menahan stok
 * sampai kasir mengonfirmasi dana benar-benar diterima.
 */
function createCashierSale(token,payload) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  payload=payload&&typeof payload==='object'?payload:{};
  const requestKey=String(payload.requestKey||'').trim();
  if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))throw new Error('Kunci transaksi tidak valid. Silakan ulangi dari keranjang kasir.');
  const buyerType=String(payload.buyerType||'UMUM').toUpperCase();
  const buyerName=String(payload.buyerName||'').trim().slice(0,120);
  const santriId=String(payload.santriId||'').trim();
  const method=String(payload.paymentMethod||'').toUpperCase();
  const note=String(payload.note||'').trim().slice(0,300);
  const received=Number(payload.amountReceived||0);
  const rawItems=Array.isArray(payload.items)?payload.items:[];
  if(['UMUM','NAMA','SANTRI'].indexOf(buyerType)<0)throw new Error('Jenis pembeli tidak valid.');
  if(buyerType==='NAMA'&&!buyerName)throw new Error('Nama pembeli wajib diisi.');
  if(buyerType==='SANTRI'&&!santriId)throw new Error('Pilih santri terlebih dahulu.');
  if(buyerType!=='SANTRI'&&santriId)throw new Error('Identitas santri tidak sesuai jenis pembeli.');
  if(['TUNAI','QRIS'].indexOf(method)<0)throw new Error('Metode pembayaran tidak valid.');
  if(rawItems.length<1||rawItems.length>50)throw new Error('Keranjang harus berisi 1 sampai 50 jenis barang.');
  if(method==='TUNAI'&&(!Number.isSafeInteger(received)||received<0))throw new Error('Nominal uang diterima tidak valid.');
  const grouped={};
  rawItems.forEach(function(item){
    const pid=String(item&&item.productId||'').trim(),vid=String(item&&item.variationId||'').trim(),qty=Number(item&&item.qty);
    if(!pid||!Number.isSafeInteger(qty)||qty<1||qty>999)throw new Error('Item keranjang tidak valid.');
    const key=pid+'|'+vid;
    if(!grouped[key])grouped[key]={productId:pid,variationId:vid,qty:0};
    grouped[key].qty+=qty;
    if(!Number.isSafeInteger(grouped[key].qty)||grouped[key].qty>999)throw new Error('Jumlah item terlalu besar.');
  });
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),salesSheet=ss.getSheetByName('PenjualanToko'),detailSheet=ss.getSheetByName('DetailPenjualanToko'),reservationSheet=ss.getSheetByName('ReservasiStokToko');
    if(!salesSheet||!detailSheet||!reservationSheet)throw new Error('Struktur POS belum lengkap. Sinkronkan SetupDatabase.gs dan jalankan setupFMartDatabase_().');
    let resolvedBuyerName=buyerType==='NAMA'?buyerName:'';
    if(buyerType==='SANTRI'){
      const student=findSantriRowById_(ss.getSheetByName('Santri'),santriId);
      if(!student||String(santriField_(student.values,getSantriColumnMap_(ss.getSheetByName('Santri')),'Status')||'').toUpperCase()!=='AKTIF')throw new Error('Santri tidak ditemukan atau tidak aktif.');
      resolvedBuyerName=String(santriField_(student.values,getSantriColumnMap_(ss.getSheetByName('Santri')),'nama_santri')||'');
      if(!resolvedBuyerName)throw new Error('Nama santri tidak tersedia.');
    }
    // Retry dengan requestKey yang sama hanya boleh mengembalikan transaksi
    // bila payload bisnisnya identik; perubahan keranjang/pembeli/metode ditolak.
    const existing=readRows_(salesSheet).find(function(r){return String(r[17]||'')===requestKey;});
    if(existing){
      if(String(existing[13]||'')!==String(session.userId))throw new Error('Kunci transaksi sudah pernah digunakan. Muat ulang kasir dan buat transaksi baru.');
      const savedDetails=readRows_(detailSheet).filter(function(r){return String(r[1]||'')===String(existing[0]||'');});
      const savedItems={};
      savedDetails.forEach(function(r){const key=String(r[2]||'')+'|'+String(r[3]||'');savedItems[key]=(savedItems[key]||0)+(Number(r[8])||0);});
      const requestedKeys=Object.keys(grouped).sort(),savedKeys=Object.keys(savedItems).sort();
      const sameItems=requestedKeys.length===savedKeys.length&&requestedKeys.every(function(key,index){return key===savedKeys[index]&&grouped[key].qty===savedItems[key];});
      const sameBuyer=String(existing[2]||'')===buyerType&&String(existing[3]||'')===resolvedBuyerName&&String(existing[4]||'')===santriId;
      const samePayment=String(existing[8]||'').toUpperCase()===method&&(method!=='TUNAI'||Number(existing[9]||0)===received);
      const sameNote=String(existing[14]||'')===note;
      if(!sameItems||!sameBuyer||!samePayment||!sameNote)throw new Error('Kunci transaksi ini sudah terikat pada data transaksi sebelumnya. Jangan ubah keranjang atau pembayaran saat mengulang proses; muat ulang kasir untuk membuat transaksi baru.');
      return {ok:true,duplicate:true,saleId:String(existing[0]),number:String(existing[1]),total:Number(existing[7])||0,paymentStatus:String(existing[11]||''),status:String(existing[12]||'')};
    }
    const storeReserved=getStoreSaleReservationMap_(ss);
    const stockSheet=ss.getSheetByName('StokKasir'),stockRows=readRows_(stockSheet),plan=[];
    let subtotal=0;
    Object.keys(grouped).forEach(function(key){
      const item=grouped[key],snap=getProductSnapshot_(ss,item.productId,item.variationId,'KASIR');
      if(!snap||!snap.active)throw new Error('Produk atau variasi sudah tidak aktif.');
      const stockMatches=[];stockRows.forEach(function(r,index){if(String(r[1])===item.productId&&String(r[2]||'')===item.variationId)stockMatches.push(index);});
      if(!stockMatches.length)throw new Error('Data stok produk belum tersedia untuk '+snap.name+'. Hubungi bagian Gudang.');
      if(stockMatches.length!==1)throw new Error('Ditemukan data stok ganda untuk '+snap.name+'. Transaksi dihentikan; hubungi bagian Gudang.');
      const stockIndex=stockMatches[0],physicalStock=Number(stockRows[stockIndex][3]);
      if(!Number.isSafeInteger(physicalStock)||physicalStock<0)throw new Error('Nilai stok tidak valid untuk '+snap.name+'. Hubungi bagian Gudang.');
      const reservedQty=(storeReserved[key]||0);
      if(!Number.isSafeInteger(reservedQty)||reservedQty<0)throw new Error('Data reservasi stok tidak valid untuk '+snap.name+'.');
      const available=physicalStock-reservedQty;
      if(item.qty>available)throw new Error('Stok tersedia untuk '+snap.name+' hanya '+Math.max(0,available)+' unit.');
      const lineTotal=snap.unitPrice*item.qty;
      if(!Number.isSafeInteger(lineTotal))throw new Error('Nilai transaksi tidak valid.');
      subtotal+=lineTotal;
      plan.push({productId:item.productId,variationId:item.variationId,sku:snap.sku,name:snap.name,variationName:snap.variationName,unitPrice:snap.unitPrice,qty:item.qty,lineTotal:lineTotal,stockRow:stockIndex,before:physicalStock});
    });
    if(!Number.isSafeInteger(subtotal)||subtotal<1)throw new Error('Total transaksi tidak valid.');
    const discount=0,total=subtotal-discount;
    if(method==='TUNAI'&&received<total)throw new Error('Uang yang diterima kurang dari total belanja.');
    const now=new Date(),saleId=makeFMartId_('SLT'),number='FM-'+Utilities.formatDate(now,Session.getScriptTimeZone()||'Asia/Jakarta','yyMMdd-HHmmss')+'-'+saleId.slice(-5);
    const pending=method==='QRIS';
    salesSheet.appendRow([saleId,number,buyerType,resolvedBuyerName,santriId,subtotal,discount,total,method,method==='TUNAI'?received:0,method==='TUNAI'?received-total:0,pending?'MENUNGGU_KONFIRMASI':'LUNAS',pending?'MENUNGGU_PEMBAYARAN':'SELESAI',session.userId,note,now,now,requestKey,'']);
    plan.forEach(function(item){
      detailSheet.appendRow([makeFMartId_('DSL'),saleId,item.productId,item.variationId,item.sku,item.name,item.variationName,item.unitPrice,item.qty,item.lineTotal]);
    });
    if(pending){
      const expiry=new Date(now.getTime()+15*60000);
      plan.forEach(function(item){reservationSheet.appendRow([makeFMartId_('RSV'),saleId,item.productId,item.variationId,item.qty,'AKTIF',now,expiry,now]);});
    }else{
      applyCashierSaleStock_(ss,saleId,plan,session,now);
    }
    writeAudit_(session.userId,session.role,pending?'CREATE_CASHIER_QRIS_PENDING':'CREATE_CASHIER_CASH_SALE','PENJUALAN_TOKO',saleId,'',JSON.stringify({number:number,total:total,method:method,buyerType:buyerType,itemCount:plan.length}),pending?'Menunggu konfirmasi pembayaran QRIS':'Penjualan tunai selesai');
    SpreadsheetApp.flush();
    return {ok:true,saleId:saleId,number:number,total:total,paymentMethod:method,paymentStatus:pending?'MENUNGGU_KONFIRMASI':'LUNAS',status:pending?'MENUNGGU_PEMBAYARAN':'SELESAI',amountReceived:method==='TUNAI'?received:0,change:method==='TUNAI'?received-total:0};
  }finally{lock.releaseLock();}
}



/** Riwayat dan detail ringkas penjualan toko; Supervisor hanya memperoleh akses baca-saja. */
function getCashierSalesHistory(token,filters) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN,FMART.ROLES.SUPERVISOR]);
  filters=filters&&typeof filters==='object'?filters:{};
  const query=String(filters.query||'').trim().toLowerCase().slice(0,100);
  const from=String(filters.from||'').trim(),to=String(filters.to||'').trim();
  const fromTime=from?new Date(from+'T00:00:00').getTime():0;
  const toTime=to?new Date(to+'T23:59:59.999').getTime():Infinity;
  if(from&&(!Number.isFinite(fromTime))||to&&(!Number.isFinite(toTime)))throw new Error('Rentang tanggal tidak valid.');
  if(from&&to&&from>to)throw new Error('Tanggal awal tidak boleh melewati tanggal akhir.');
  const ss=getSS_(),sales=readRows_(ss.getSheetByName('PenjualanToko'));
  const details=readRows_(ss.getSheetByName('DetailPenjualanToko'));
  const users=readRows_(ss.getSheetByName('Users')),userMap={};
  users.forEach(function(r){userMap[String(r[0])]=String(r[4]||'');});
  const detailMap={};
  details.forEach(function(r){
    const id=String(r[1]||'');if(!detailMap[id])detailMap[id]=[];
    detailMap[id].push({sku:String(r[4]||''),name:String(r[5]||''),variationName:String(r[6]||''),unitPrice:Number(r[7])||0,qty:Number(r[8])||0,subtotal:Number(r[9])||0});
  });
  const rows=sales.map(function(r){
    const created=r[15] instanceof Date?r[15].getTime():new Date(r[15]||0).getTime();
    return {saleId:String(r[0]||''),number:String(r[1]||''),buyerType:String(r[2]||'UMUM'),buyerName:String(r[3]||''),santriId:String(r[4]||''),subtotal:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,paymentMethod:String(r[8]||''),amountReceived:Number(r[9])||0,change:Number(r[10])||0,paymentStatus:String(r[11]||''),status:String(r[12]||''),cashierUserId:String(r[13]||''),cashierName:userMap[String(r[13]||'')]||'Kasir',note:String(r[14]||''),createdAt:Number.isFinite(created)?new Date(created).toISOString():'',updatedAt:r[16] instanceof Date?r[16].toISOString():String(r[16]||''),paymentReference:String(r[18]||''),items:detailMap[String(r[0]||'')]||[]};
  }).filter(function(x){
    const time=x.createdAt?new Date(x.createdAt).getTime():0;
    if(time<fromTime||time>toTime)return false;
    if(session.role===FMART.ROLES.KASIR&&x.cashierUserId!==String(session.userId))return false;
    if(!query)return true;
    return [x.number,x.buyerName,x.cashierName,x.paymentMethod,x.paymentStatus].concat(x.items.map(function(it){return it.name+' '+it.sku+' '+it.variationName;})).join(' ').toLowerCase().indexOf(query)>=0;
  }).sort(function(a,b){return new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime();}).slice(0,150);
  return {ok:true,rows:rows,limit:150,serverTime:new Date().toISOString()};
}

/** Antrean QRIS penjualan toko; menampilkan detail dan masa berlaku reservasi. */
function getCashierQrisQueue(token) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_(),sales=readRows_(ss.getSheetByName('PenjualanToko'));
  const details=readRows_(ss.getSheetByName('DetailPenjualanToko'));
  const reservations=readRows_(ss.getSheetByName('ReservasiStokToko'));
  const users=readRows_(ss.getSheetByName('Users')),userMap={};
  users.forEach(function(r){userMap[String(r[0])]=String(r[4]||'');});
  const detailMap={},reservationMap={};
  details.forEach(function(r){
    const saleId=String(r[1]||'');
    if(!detailMap[saleId])detailMap[saleId]=[];
    detailMap[saleId].push({productId:String(r[2]||''),variationId:String(r[3]||''),sku:String(r[4]||''),name:String(r[5]||''),variationName:String(r[6]||''),unitPrice:Number(r[7])||0,qty:Number(r[8])||0,subtotal:Number(r[9])||0});
  });
  reservations.forEach(function(r){
    const saleId=String(r[1]||'');
    if(!reservationMap[saleId])reservationMap[saleId]=[];
    reservationMap[saleId].push(r);
  });
  const now=Date.now(),queue=[];
  sales.forEach(function(r){
    if(session.role===FMART.ROLES.KASIR&&String(r[13]||'')!==String(session.userId))return;
    if(String(r[8]||'').toUpperCase()!=='QRIS'||String(r[11]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI')return;
    const saleId=String(r[0]||''),saleReservations=reservationMap[saleId]||[];
    const active=saleReservations.filter(function(x){return String(x[5]||'').toUpperCase()==='AKTIF';});
    const expiries=active.map(function(x){return new Date(x[7]||0).getTime();}).filter(function(x){return Number.isFinite(x)&&x>0;});
    const expiresAt=expiries.length?Math.min.apply(null,expiries):0;
    const validReservation=active.some(function(x){const expiry=new Date(x[7]||0).getTime();return Number.isFinite(expiry)&&expiry>now;});
    queue.push({
      saleId:saleId,number:String(r[1]||''),buyerType:String(r[2]||''),buyerName:String(r[3]||'Umum'),
      total:Number(r[7])||0,status:String(r[12]||''),createdAt:r[15] instanceof Date?r[15].toISOString():String(r[15]||''),
      cashierName:userMap[String(r[13]||'')]||'Kasir',note:String(r[14]||''),expiresAt:expiresAt?new Date(expiresAt).toISOString():'',
      remainingMs:expiresAt?expiresAt-now:0,expired:!validReservation,
      items:detailMap[saleId]||[],reservationCount:active.length
    });
  });
  queue.sort(function(a,b){return new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime();});
  return {ok:true,queue:queue,serverTime:new Date(now).toISOString()};
}

/** Konfirmasi QRIS hanya setelah kasir memeriksa dana masuk pada aplikasi/bank merchant. */
function confirmCashierQrisPayment(token,saleId,reference) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  saleId=String(saleId||'').trim();reference=String(reference||'').trim().slice(0,100);
  if(!saleId)throw new Error('Transaksi tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    const ss=getSS_(),salesSheet=ss.getSheetByName('PenjualanToko'),sale=findRowById_(salesSheet,saleId,1);
    if(!sale)throw new Error('Transaksi toko tidak ditemukan.');
    if(session.role===FMART.ROLES.KASIR&&String(sale.values[13]||'')!==String(session.userId))throw new Error('Kasir hanya dapat mengonfirmasi transaksi QRIS yang dibuat oleh akunnya. Hubungi Admin jika perlu bantuan.');
    if(String(sale.values[8]||'').toUpperCase()!=='QRIS')throw new Error('Konfirmasi ini hanya berlaku untuk transaksi QRIS.');
    if(String(sale.values[11]||'').toUpperCase()==='LUNAS'){
      if(String(sale.values[12]||'').toUpperCase()!=='SELESAI')throw new Error('Status pembayaran dan transaksi tidak konsisten. Hubungi Admin untuk pemeriksaan.');
      return {ok:true,duplicate:true,saleId:saleId,number:String(sale.values[1]),status:'SELESAI',paymentStatus:'LUNAS'};
    }
    if(String(sale.values[11]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI'||String(sale.values[12]||'').toUpperCase()!=='MENUNGGU_PEMBAYARAN')throw new Error('Transaksi ini tidak berada pada status menunggu konfirmasi QRIS.');
    const reservationSheet=ss.getSheetByName('ReservasiStokToko'),reservations=readRows_(reservationSheet),active=reservations.filter(function(r){return String(r[1])===saleId&&String(r[5]||'').toUpperCase()==='AKTIF'&&new Date(r[7]||0).getTime()>Date.now();});
    if(!active.length)throw new Error('Reservasi stok transaksi sudah berakhir. Batalkan transaksi ini dan buat transaksi baru.');
    const details=readRows_(ss.getSheetByName('DetailPenjualanToko')).filter(function(r){return String(r[1])===saleId;});
    if(!details.length)throw new Error('Rincian transaksi tidak ditemukan.');
    const reservedForSale={},groupedDetails={};
    active.forEach(function(r){
      const key=String(r[2]||'')+'|'+String(r[3]||''),qty=Number(r[4]);
      if(!Number.isSafeInteger(qty)||qty<1)throw new Error('Jumlah reservasi QRIS tidak valid. Hubungi Admin untuk pemeriksaan.');
      reservedForSale[key]=(reservedForSale[key]||0)+qty;
      if(!Number.isSafeInteger(reservedForSale[key]))throw new Error('Total reservasi QRIS tidak valid.');
    });
    details.forEach(function(d){
      const pid=String(d[2]||''),vid=String(d[3]||''),qty=Number(d[8]),key=pid+'|'+vid;
      if(!pid||!Number.isSafeInteger(qty)||qty<1)throw new Error('Jumlah produk pada transaksi tidak valid.');
      if(!groupedDetails[key])groupedDetails[key]={productId:pid,variationId:vid,qty:0};
      groupedDetails[key].qty+=qty;
      if(!Number.isSafeInteger(groupedDetails[key].qty))throw new Error('Jumlah produk pada transaksi terlalu besar.');
    });
    const stockRows=readRows_(ss.getSheetByName('StokKasir')),plan=[];
    Object.keys(groupedDetails).forEach(function(key){
      const item=groupedDetails[key],pid=item.productId,vid=item.variationId,qty=item.qty;
      if((reservedForSale[key]||0)!==qty)throw new Error('Jumlah reservasi tidak sama dengan rincian transaksi untuk salah satu barang. Transaksi ditahan untuk pemeriksaan Admin.');
      const stockMatches=[];stockRows.forEach(function(r,index){if(String(r[1])===pid&&String(r[2]||'')===vid)stockMatches.push(index);});
      if(stockMatches.length!==1)throw new Error(stockMatches.length?'Data stok ganda ditemukan. Konfirmasi QRIS dihentikan.':'Data stok produk tidak ditemukan.');
      const idx=stockMatches[0],physicalStock=Number(stockRows[idx][3]);
      const snap=getProductSnapshot_(ss,pid,vid,'KASIR');
      if(!snap||!snap.active||!Number.isSafeInteger(physicalStock)||physicalStock<qty)throw new Error('Stok fisik tidak mencukupi atau tidak valid untuk menyelesaikan transaksi.');
      plan.push({productId:pid,variationId:vid,qty:qty,stockRow:idx,before:physicalStock});
    });
    Object.keys(reservedForSale).forEach(function(key){
      if(!Object.prototype.hasOwnProperty.call(groupedDetails,key))throw new Error('Ditemukan reservasi QRIS yang tidak tercantum pada rincian transaksi. Konfirmasi dihentikan.');
    });
    const now=new Date();
    applyCashierSaleStock_(ss,saleId,plan,session,now);
    salesSheet.getRange(sale.rowNumber,12,1,8).setValues([['LUNAS','SELESAI',String(sale.values[13]||''),String(sale.values[14]||''),sale.values[15]||now,now,String(sale.values[17]||''),reference]]);
    active.forEach(function(r){const row=findRowById_(reservationSheet,String(r[0]),1);if(row)reservationSheet.getRange(row.rowNumber,6,1,4).setValues([['DIGUNAKAN',row.values[6],row.values[7],now]]);});
    writeAudit_(session.userId,session.role,'CONFIRM_CASHIER_QRIS','PENJUALAN_TOKO',saleId,JSON.stringify({paymentStatus:'MENUNGGU_KONFIRMASI'}),JSON.stringify({paymentStatus:'LUNAS',reference:reference}),'Pembayaran QRIS diperiksa dan dikonfirmasi kasir');
    SpreadsheetApp.flush();
    return {ok:true,saleId:saleId,number:String(sale.values[1]),status:'SELESAI',paymentStatus:'LUNAS'};
  }finally{lock.releaseLock();}
}

/** Membatalkan QRIS yang belum dibayar dan melepaskan reservasi stoknya. */
function cancelCashierQrisSale(token,saleId,reason) {
  const session=requireRole_(token,[FMART.ROLES.KASIR,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  saleId=String(saleId||'').trim();reason=String(reason||'').trim().slice(0,200);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(),sheet=ss.getSheetByName('PenjualanToko'),sale=findRowById_(sheet,saleId,1);
    if(!sale)throw new Error('Transaksi toko tidak ditemukan.');
    if(String(sale.values[8]||'').toUpperCase()!=='QRIS'||String(sale.values[11]||'').toUpperCase()!=='MENUNGGU_KONFIRMASI')throw new Error('Hanya transaksi QRIS yang belum dibayar dapat dibatalkan.');
    if(session.role===FMART.ROLES.KASIR&&String(sale.values[13]||'')!==String(session.userId))throw new Error('Kasir hanya dapat membatalkan transaksi QRIS yang dibuat oleh akunnya. Hubungi Admin jika perlu bantuan.');
    const now=new Date(),reservations=readRows_(ss.getSheetByName('ReservasiStokToko'));
    reservations.forEach(function(r,i){if(String(r[1])===saleId&&String(r[5]||'').toUpperCase()==='AKTIF')ss.getSheetByName('ReservasiStokToko').getRange(i+2,6,1,4).setValues([['DILEPAS',r[6],r[7],now]]);});
    sheet.getRange(sale.rowNumber,12,1,6).setValues([['DIBATALKAN','DIBATALKAN',String(sale.values[13]||''),reason||String(sale.values[14]||''),sale.values[15]||now,now]]);
    writeAudit_(session.userId,session.role,'CANCEL_CASHIER_QRIS','PENJUALAN_TOKO',saleId,JSON.stringify({paymentStatus:'MENUNGGU_KONFIRMASI'}),JSON.stringify({paymentStatus:'DIBATALKAN',reason:reason}),'Transaksi QRIS dibatalkan sebelum pembayaran');
    SpreadsheetApp.flush();
    return {ok:true,saleId:saleId,status:'DIBATALKAN'};
  }finally{lock.releaseLock();}
}

/**
 * Audit integritas POS toko. Read-only; tidak mengubah transaksi, stok, atau reservasi.
 * Jalankan manual dari Apps Script Editor: auditCashierPOSIntegrity_()
 */
function auditCashierPOSIntegrity_() {
  const ss=getSS_(),sales=readRows_(ss.getSheetByName('PenjualanToko'));
  const details=readRows_(ss.getSheetByName('DetailPenjualanToko'));
  const reservations=readRows_(ss.getSheetByName('ReservasiStokToko'));
  const mutations=readRows_(ss.getSheetByName('MutasiStokKasir'));
  const issues=[],saleIds=Object.create(null),requestKeys=Object.create(null);
  const detailMap=Object.create(null),reservationMap=Object.create(null),mutationMap=Object.create(null);
  function issue(code,saleId,detail){if(issues.length<500)issues.push({code:code,saleId:saleId||'',detail:detail||''});}
  details.forEach(function(r){const id=String(r[1]||'');if(!detailMap[id])detailMap[id]=[];detailMap[id].push(r);});
  reservations.forEach(function(r){const id=String(r[1]||'');if(!reservationMap[id])reservationMap[id]=[];reservationMap[id].push(r);});
  mutations.forEach(function(r){const id=String(r[7]||'');if(!id||String(r[3]||'').toUpperCase()!=='KELUAR')return;if(!mutationMap[id])mutationMap[id]=[];mutationMap[id].push(r);});
  const now=Date.now();
  sales.forEach(function(s){
    const id=String(s[0]||''),requestKey=String(s[17]||''),method=String(s[8]||'').toUpperCase();
    const payment=String(s[11]||'').toUpperCase(),status=String(s[12]||'').toUpperCase();
    if(!id){issue('SALE_ID_EMPTY','', 'ID penjualan kosong.');return;}
    if(saleIds[id])issue('DUPLICATE_SALE_ID',id,'ID penjualan muncul lebih dari satu kali.');
    saleIds[id]=true;
    if(requestKey){if(requestKeys[requestKey])issue('DUPLICATE_REQUEST_KEY',id,'RequestKey juga digunakan oleh transaksi '+requestKeys[requestKey]+'.');else requestKeys[requestKey]=id;}
    const lines=detailMap[id]||[];
    if(!lines.length)issue('SALE_DETAIL_MISSING',id,'Transaksi tidak memiliki rincian barang.');
    const itemTotal=lines.reduce(function(sum,r){return sum+(Number(r[9])||0);},0);
    lines.forEach(function(r){
      const price=Number(r[7]),qty=Number(r[8]),lineSubtotal=Number(r[9]);
      if(!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(qty)||qty<1||!Number.isSafeInteger(lineSubtotal)||lineSubtotal!==price*qty)issue('SALE_DETAIL_VALUE_INVALID',id,'Harga, jumlah, atau subtotal salah satu rincian tidak valid.');
    });
    if(lines.length&&itemTotal!==Number(s[5]||0))issue('SALE_SUBTOTAL_MISMATCH',id,'Jumlah subtotal detail berbeda dari subtotal transaksi.');
    if(Number(s[5]||0)-Number(s[6]||0)!==Number(s[7]||0))issue('SALE_TOTAL_MISMATCH',id,'Subtotal dikurangi diskon tidak sama dengan total.');
    if(['TUNAI','QRIS'].indexOf(method)<0)issue('SALE_METHOD_INVALID',id,'Metode pembayaran tidak dikenal.');
    if(method==='TUNAI'&&(payment!=='LUNAS'||status!=='SELESAI'))issue('CASH_STATUS_INVALID',id,'Transaksi tunai seharusnya LUNAS dan SELESAI.');
    if(method==='QRIS'&&payment==='MENUNGGU_KONFIRMASI'&&status!=='MENUNGGU_PEMBAYARAN')issue('QRIS_PENDING_STATUS_INVALID',id,'Status transaksi QRIS menunggu tidak konsisten.');
    if(method==='QRIS'&&payment==='LUNAS'&&status!=='SELESAI')issue('QRIS_PAID_STATUS_INVALID',id,'QRIS LUNAS tidak berstatus SELESAI.');
    if(payment==='LUNAS'&&status!=='SELESAI')issue('PAID_STATUS_INVALID',id,'Pembayaran LUNAS tidak berstatus SELESAI.');
    if(payment==='DIBATALKAN'&&status!=='DIBATALKAN')issue('CANCEL_STATUS_INVALID',id,'Status pembayaran dan transaksi batal tidak konsisten.');
    const saleReservations=reservationMap[id]||[];
    const active=saleReservations.filter(function(r){return String(r[5]||'').toUpperCase()==='AKTIF';});
    if(payment==='MENUNGGU_KONFIRMASI'){
      const valid=active.filter(function(r){const t=new Date(r[7]||0).getTime();return Number.isFinite(t)&&t>now;});
      const reserved=Object.create(null),expected=Object.create(null);
      valid.forEach(function(r){
        const key=String(r[2]||'')+'|'+String(r[3]||''),qty=Number(r[4]);
        if(!Number.isSafeInteger(qty)||qty<1)issue('QRIS_RESERVATION_QTY_INVALID',id,'Jumlah reservasi aktif tidak valid.');
        reserved[key]=(reserved[key]||0)+(Number.isSafeInteger(qty)&&qty>0?qty:0);
      });
      lines.forEach(function(r){
        const key=String(r[2]||'')+'|'+String(r[3]||''),qty=Number(r[8]);
        expected[key]=(expected[key]||0)+(Number.isSafeInteger(qty)&&qty>0?qty:0);
      });
      Object.keys(expected).forEach(function(key){
        if((reserved[key]||0)!==expected[key])issue('QRIS_RESERVATION_QTY_MISMATCH',id,'Jumlah reservasi tidak sama dengan rincian transaksi untuk '+key+'.');
      });
      Object.keys(reserved).forEach(function(key){
        if(!Object.prototype.hasOwnProperty.call(expected,key))issue('QRIS_RESERVATION_UNEXPECTED_ITEM',id,'Reservasi mencakup item yang tidak ada pada detail transaksi: '+key+'.');
      });
      if(!valid.length)issue('QRIS_RESERVATION_EXPIRED',id,'Transaksi masih menunggu konfirmasi tetapi tidak memiliki reservasi yang berlaku.');
    }else if(active.length){
      issue('UNEXPECTED_ACTIVE_RESERVATION',id,'Transaksi bukan QRIS pending tetapi masih memiliki reservasi berstatus AKTIF.');
    }
    if(payment==='LUNAS'){
      const saleMutations=mutationMap[id]||[],seen=Object.create(null),expected=Object.create(null);
      saleMutations.forEach(function(m){const key=String(m[1]||'')+'|'+String(m[2]||'');if(!seen[key])seen[key]={count:0,qty:0};seen[key].count++;seen[key].qty+=Number(m[4])||0;});
      lines.forEach(function(r){const key=String(r[2]||'')+'|'+String(r[3]||'');expected[key]=(expected[key]||0)+(Number(r[8])||0);});
      Object.keys(expected).forEach(function(key){const actual=seen[key];if(!actual)issue('SALE_STOCK_MUTATION_MISSING',id,'Mutasi stok keluar tidak ditemukan untuk '+key+'.');else if(actual.count>1)issue('SALE_STOCK_MUTATION_DUPLICATE',id,'Mutasi stok keluar ganda untuk '+key+'.');else if(actual.qty!==expected[key])issue('SALE_STOCK_MUTATION_QTY_MISMATCH',id,'Jumlah mutasi stok tidak sama dengan jumlah barang terjual untuk '+key+'.');});
      Object.keys(seen).forEach(function(key){if(!Object.prototype.hasOwnProperty.call(expected,key))issue('UNEXPECTED_SALE_STOCK_MUTATION',id,'Mutasi stok keluar tidak cocok dengan detail penjualan: '+key+'.');});
    }
  });
  return {checkedAt:new Date().toISOString(),mode:'READ_ONLY',salesChecked:sales.length,detailsChecked:details.length,reservationsChecked:reservations.length,issues:issues,issueCount:issues.length,truncated:issues.length>=500};
}

function getStoreSaleReservationMap_(ss) {
  const sheet=ss.getSheetByName('ReservasiStokToko');
  if(!sheet)return {};
  const now=Date.now(),map={};
  readRows_(sheet).forEach(function(r){
    const expiry=new Date(r[7]||0).getTime();
    if(String(r[5]||'').toUpperCase()!=='AKTIF'||!Number.isFinite(expiry)||expiry<=now)return;
    const key=String(r[2]||'')+'|'+String(r[3]||'');
    map[key]=(map[key]||0)+Math.max(0,Number(r[4])||0);
  });
  return map;
}

function applyCashierSaleStock_(ss,saleId,items,session,now) {
  ensureFMartCostingSchema_(ss);
  const stockSheet=ss.getSheetByName('StokKasir'),mutationSheet=ss.getSheetByName('MutasiStokKasir');if(!stockSheet||!mutationSheet)throw new Error('Sheet StokKasir atau MutasiStokKasir belum tersedia. Jalankan setupFMartDatabase_().');
  const prepared=[],seen=Object.create(null);items.forEach(function(item){const idx=Number(item.stockRow),before=Number(item.before),qty=Number(item.qty),key=String(item.productId)+'|'+String(item.variationId||'');if(!Number.isInteger(idx)||idx<0||!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(qty)||qty<1||before<qty||seen[key])throw new Error('Rencana pengurangan stok Kasir tidak valid atau memuat item ganda.');seen[key]=true;const live=Number(stockSheet.getRange(idx+2,4).getValue());if(!Number.isSafeInteger(live)||live!==before)throw new Error('Stok Kasir berubah saat transaksi diproses. Muat ulang POS sebelum mencoba kembali.');prepared.push({item:item,idx:idx,before:before,after:before-qty,qty:qty});});
  prepared.forEach(function(x){captureSaleDetailHpp_(ss,'DetailPenjualanToko',saleId,x.item.productId,x.item.variationId);stockSheet.getRange(x.idx+2,4,1,3).setValues([[x.after,Number(stockSheet.getRange(x.idx+2,5).getValue())||0,now]]);mutationSheet.appendRow([makeFMartId_('MCK'),x.item.productId,x.item.variationId,'KELUAR',x.qty,x.before,x.after,saleId,'Penjualan langsung toko FMart',session.userId,now]);});
}



/**
 * Tahap 8 — audit sinkronisasi operasional lintas master, stok, mutasi, dan POS.
 * Read-only: tidak memperbaiki atau mengubah data apa pun.
 * Jalankan dari Apps Script Editor: auditFMartOperationalSync_()
 */
function auditFMartOperationalSync_() {
  const ss=getSS_(),issues=[],maxIssues=500;
  function issue(code,sheet,row,detail){if(issues.length<maxIssues)issues.push({code:code,sheet:sheet,row:row||'',detail:detail||''});}
  function rows(name){const sh=ss.getSheetByName(name);return sh?readRows_(sh):[];}
  const products=rows('Produk'),categories=rows('Kategori'),variations=rows('VariasiProduk'),stocks=rows('Stok'),mutations=rows('MutasiStok'),santriSheet=ss.getSheetByName('Santri');
  const productById=Object.create(null),categoryById=Object.create(null),variationById=Object.create(null),stockByKey=Object.create(null),santriById=Object.create(null),santriMap=getSantriColumnMap_(santriSheet);
  const productSku=Object.create(null),variationKeys=Object.create(null),stockKeys=Object.create(null),mutationIds=Object.create(null),nisKeys=Object.create(null);
  categories.forEach(function(r){categoryById[String(r[0]||'')]=r;});
  products.forEach(function(r,i){
    const id=String(r[0]||''),sku=String(r[2]||'').trim().toUpperCase();
    if(!id)issue('PRODUCT_ID_EMPTY','Produk',i+2,'Produk tidak memiliki ProdukId.');
    else if(productById[id])issue('PRODUCT_ID_DUPLICATE','Produk',i+2,'ProdukId duplikat: '+id+'.');
    else productById[id]=r;
    if(sku){if(productSku[sku])issue('PRODUCT_SKU_DUPLICATE','Produk',i+2,'SKU duplikat dengan baris '+productSku[sku]+'.');else productSku[sku]=i+2;}
    if(!categoryById[String(r[1]||'')])issue('PRODUCT_CATEGORY_MISSING','Produk',i+2,'Kategori produk tidak ditemukan.');
  });
  variations.forEach(function(r,i){
    const id=String(r[0]||''),pid=String(r[1]||''),key=pid+'|'+id;
    if(!id)issue('VARIATION_ID_EMPTY','VariasiProduk',i+2,'VariasiId kosong.');
    else if(variationById[id])issue('VARIATION_ID_DUPLICATE','VariasiProduk',i+2,'VariasiId duplikat: '+id+'.');
    else variationById[id]=r;
    if(!productById[pid])issue('VARIATION_PRODUCT_MISSING','VariasiProduk',i+2,'Produk induk variasi tidak ditemukan.');
    if(variationKeys[key])issue('VARIATION_KEY_DUPLICATE','VariasiProduk',i+2,'Kombinasi ProdukId dan VariasiId duplikat.');
    variationKeys[key]=true;
  });
  stocks.forEach(function(r,i){
    const pid=String(r[1]||''),vid=String(r[2]||''),key=pid+'|'+vid,qty=Number(r[3]);
    if(!productById[pid])issue('STOCK_PRODUCT_MISSING','Stok',i+2,'Produk pada baris stok tidak ditemukan.');
    if(vid&&(!variationById[vid]||String(variationById[vid][1])!==pid))issue('STOCK_VARIATION_MISMATCH','Stok',i+2,'Variasi tidak ditemukan atau bukan milik produk tersebut.');
    if(stockKeys[key])issue('STOCK_KEY_DUPLICATE','Stok',i+2,'Kunci stok ganda; baris pertama '+stockKeys[key]+'.');
    else {stockKeys[key]=i+2;stockByKey[key]=r;}
    if(!Number.isSafeInteger(qty)||qty<0)issue('STOCK_QTY_INVALID','Stok',i+2,'Stok harus bilangan bulat nol atau lebih.');
  });
  variations.forEach(function(v,i){
    const pid=String(v[1]||''),vid=String(v[0]||''),sr=stockByKey[pid+'|'+vid];
    if(!sr)issue('VARIATION_STOCK_ROW_MISSING','VariasiProduk',i+2,'Baris stok kanonis belum tersedia untuk variasi.');
    else if(Number(sr[3])!==Number(v[5]))issue('VARIATION_STOCK_MIRROR_MISMATCH','VariasiProduk',i+2,'Kolom Stok pada variasi berbeda dari sheet Stok; sheet Stok adalah sumber utama.');
  });
  const productsWithVariations=Object.create(null);
  variations.forEach(function(v){if(String(v[6]||'').toUpperCase()==='AKTIF')productsWithVariations[String(v[1]||'')]=true;});
  products.forEach(function(p,i){
    const id=String(p[0]||''),status=String(p[8]||'').toUpperCase();
    if(id&&status==='AKTIF'&&!productsWithVariations[id]&&!stockByKey[id+'|']){
      issue('PRODUCT_STOCK_ROW_MISSING','Produk',i+2,'Produk aktif tanpa variasi belum memiliki baris saldo kanonis pada sheet Stok.');
    }
  });
  mutations.forEach(function(m,i){
    const id=String(m[0]||''),pid=String(m[1]||''),vid=String(m[2]||''),type=String(m[3]||'').toUpperCase(),qty=Number(m[4]),before=Number(m[5]),after=Number(m[6]);
    if(!id)issue('MUTATION_ID_EMPTY','MutasiStok',i+2,'MutasiId kosong.');
    else if(mutationIds[id])issue('MUTATION_ID_DUPLICATE','MutasiStok',i+2,'MutasiId duplikat.');
    mutationIds[id]=true;
    if(!productById[pid])issue('MUTATION_PRODUCT_MISSING','MutasiStok',i+2,'Produk mutasi tidak ditemukan.');
    if(vid&&(!variationById[vid]||String(variationById[vid][1])!==pid))issue('MUTATION_VARIATION_MISMATCH','MutasiStok',i+2,'Variasi mutasi tidak cocok dengan produk.');
    if(['MASUK','KELUAR'].indexOf(type)<0||!Number.isSafeInteger(qty)||qty<1||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after!==(type==='MASUK'?before+qty:before-qty)||after<0)issue('MUTATION_ARITHMETIC_INVALID','MutasiStok',i+2,'Jenis, qty, stok sebelum, dan stok sesudah tidak membentuk mutasi yang valid.');
  });
  const santriRows=readSantriRows_(santriSheet);
  santriRows.forEach(function(r,i){
    const rec=santriRecord_(r,santriMap),nis=rec.nis.trim().toUpperCase();
    if(!rec.id)issue('SANTRI_ID_EMPTY','Santri',i+2,'SantriId kosong.');
    else if(santriById[rec.id])issue('SANTRI_ID_DUPLICATE','Santri',i+2,'SantriId duplikat.');
    else santriById[rec.id]=rec;
    if(nis){if(nisKeys[nis])issue('SANTRI_NIS_DUPLICATE','Santri',i+2,'NIS duplikat dengan baris '+nisKeys[nis]+'.');else nisKeys[nis]=i+2;}
  });
  rows('PenjualanToko').forEach(function(r,i){const sid=String(r[4]||'');if(sid&&!santriById[sid])issue('POS_SANTRI_REFERENCE_MISSING','PenjualanToko',i+2,'SantriId pembeli tidak ditemukan pada master Santri.');});
  rows('Pesanan').forEach(function(r,i){const sid=String(r[3]||'');let payload={};try{payload=JSON.parse(String(r[14]||'{}'));}catch(e){}const hasManualRecipient=!!(payload.recipientSnapshot&&String(payload.recipientSnapshot.name||'').trim());if(sid&&!santriById[sid])issue('ORDER_SANTRI_REFERENCE_MISSING','Pesanan',i+2,'SantriId pesanan tidak ditemukan pada master Santri.');if(!sid&&!hasManualRecipient)issue('ORDER_RECIPIENT_MISSING','Pesanan',i+2,'Pesanan tidak memiliki snapshot penerima maupun referensi Santri.');});
  return {checkedAt:new Date().toISOString(),mode:'READ_ONLY',counts:{products:products.length,variations:variations.length,stockRows:stocks.length,mutations:mutations.length,santri:santriRows.length},issues:issues,issueCount:issues.length,truncated:issues.length>=maxIssues,stockAuthority:'Stok'};
}


/**
 * Tahap 12 — Rekonsiliasi stok dan daftar kandidat pemulihan.
 * READ-ONLY: tidak mengubah stok, mutasi, transaksi, reservasi, atau audit log.
 * Riwayat MutasiStok dibaca sesuai urutan baris sheet sebagai urutan pencatatan.
 */
function auditFMartStockReconciliation_() {
  const ss=getSS_(),issues=[],recoveryCandidates=[],maxIssues=1000;
  function issue(code,key,detail,severity){
    const item={code:code,stockKey:key||'',detail:detail||'',severity:severity||'ERROR'};
    if(issues.length<maxIssues)issues.push(item);
    recoveryCandidates.push({code:code,stockKey:key||'',recommendedAction:recoveryAction(code),automaticRepair:false});
  }
  function recoveryAction(code){
    const guidance={
      STOCK_MUTATION_CHAIN_BREAK:'Periksa baris MutasiStok yang berurutan untuk produk/variasi ini dan cocokkan dengan dokumen penerimaan/penjualan. Jangan mengubah saldo sebelum sumber selisih diketahui.',
      STOCK_CURRENT_BALANCE_MISMATCH:'Cocokkan stok fisik melalui stock opname, lalu telusuri mutasi terakhir. Koreksi hanya melalui prosedur penyesuaian stok resmi dengan bukti dan AuditLog.',
      STOCK_ROW_MISSING:'Periksa master Produk/VariasiProduk dan riwayat penerimaan. Buat baris stok hanya setelah saldo awal dapat dibuktikan.',
      STOCK_ROW_DUPLICATE:'Hentikan transaksi pada item ini dan tentukan baris stok kanonis. Jangan menghapus baris sebelum referensi mutasi dan variasi diperiksa.',
      STOCK_RESERVATION_OVERCOMMITTED:'Periksa reservasi pesanan dan QRIS yang masih aktif, status transaksi, serta masa berlakunya. Jangan mengurangi reservasi secara manual tanpa memeriksa transaksi asal.',
      POS_SALE_MUTATION_INCOMPLETE:'Periksa PenjualanToko, DetailPenjualanToko, MutasiStok, dan saldo fisik. Jangan menambahkan mutasi atau mengurangi stok ulang hanya berdasarkan status penjualan.',
      ORDER_STOCK_MUTATION_INCOMPLETE:'Periksa Pesanan, DetailPesanan, Pembayaran, MutasiStok, dan saldo fisik. Pastikan pembayaran terverifikasi serta pengurangan stok belum terjadi sebelum tindakan pemulihan.',
      MUTATION_ID_DUPLICATE:'Telusuri referensi dokumen sumber. Mutasi tanpa dokumen sumber harus diperiksa sebelum dilakukan koreksi.',
      MUTATION_ARITHMETIC_INVALID:'Bandingkan kuantitas, saldo sebelum/sesudah, dan dokumen sumber. Jangan mengedit histori mutasi langsung.'
    };
    return guidance[code]||'Lakukan pemeriksaan manual terhadap dokumen sumber dan stok fisik. Tidak ada perbaikan otomatis.';
  }
  const stockSheet=ss.getSheetByName('Stok'),mutationSheet=ss.getSheetByName('MutasiStok'),cashierStockSheet=ss.getSheetByName('StokKasir'),cashierMutationSheet=ss.getSheetByName('MutasiStokKasir');
  const stocks=readRows_(stockSheet),mutations=readRows_(mutationSheet),cashierStocks=readRows_(cashierStockSheet),cashierMutations=readRows_(cashierMutationSheet);
  const stockRowsByKey=Object.create(null),mutationRowsByKey=Object.create(null),mutationIds=Object.create(null);
  stocks.forEach(function(r,i){
    const key=String(r[1]||'')+'|'+String(r[2]||'');
    if(!stockRowsByKey[key])stockRowsByKey[key]=[];
    stockRowsByKey[key].push({row:i+2,qty:Number(r[3])});
  });
  mutations.forEach(function(r,i){
    const id=String(r[0]||''),key=String(r[1]||'')+'|'+String(r[2]||''),type=String(r[3]||'').toUpperCase();
    if(id){if(mutationIds[id])issue('MUTATION_ID_DUPLICATE',key,'MutasiId duplikat pada baris '+(i+2)+'.');else mutationIds[id]=i+2;}
    if(!mutationRowsByKey[key])mutationRowsByKey[key]=[];
    mutationRowsByKey[key].push({row:i+2,id:id,ref:String(r[7]||''),type:type,qty:Number(r[4]),before:Number(r[5]),after:Number(r[6])});
    if(!Number.isSafeInteger(Number(r[4]))||Number(r[4])<1||!Number.isSafeInteger(Number(r[5]))||!Number.isSafeInteger(Number(r[6]))||
      (type==='MASUK'&&Number(r[6])!==Number(r[5])+Number(r[4]))||
      (type==='KELUAR'&&Number(r[6])!==Number(r[5])-Number(r[4]))||
      ['MASUK','KELUAR'].indexOf(type)<0||Number(r[6])<0){
      issue('MUTATION_ARITHMETIC_INVALID',key,'MutasiStok baris '+(i+2)+' memiliki jenis, kuantitas, atau saldo sebelum/sesudah yang tidak konsisten.');
    }
  });
  const keys=Object.create(null);
  Object.keys(stockRowsByKey).forEach(function(k){keys[k]=true;});
  Object.keys(mutationRowsByKey).forEach(function(k){keys[k]=true;});
  Object.keys(keys).forEach(function(key){
    const stockMatches=stockRowsByKey[key]||[],history=mutationRowsByKey[key]||[];
    if(!stockMatches.length){issue('STOCK_ROW_MISSING',key,'Ada histori mutasi tetapi baris saldo stok tidak ditemukan.');return;}
    if(stockMatches.length>1){issue('STOCK_ROW_DUPLICATE',key,'Ditemukan '+stockMatches.length+' baris stok untuk satu kombinasi produk/variasi.');return;}
    const current=stockMatches[0].qty;
    if(!Number.isSafeInteger(current)||current<0)issue('STOCK_CURRENT_BALANCE_MISMATCH',key,'Saldo stok saat ini bukan bilangan bulat nol atau lebih.');
    if(!history.length)return;
    let previousAfter=null;
    history.forEach(function(m){
      if(previousAfter!==null&&m.before!==previousAfter){
        issue('STOCK_MUTATION_CHAIN_BREAK',key,'Rantai saldo terputus pada MutasiStok baris '+m.row+'. Saldo sebelumnya '+previousAfter+', tetapi saldo sebelum mutasi tercatat '+m.before+'.');
      }
      previousAfter=m.after;
    });
    const last=history[history.length-1];
    if(Number.isSafeInteger(current)&&current!==last.after){
      issue('STOCK_CURRENT_BALANCE_MISMATCH',key,'Saldo Stok saat ini '+current+' berbeda dari saldo sesudah mutasi terakhir '+last.after+' (baris '+last.row+').');
    }
  });

  const activeReservations=readRows_(ss.getSheetByName('ReservasiStok')).filter(function(r){
    const expiry=new Date(r[7]||0).getTime();
    return String(r[5]||'').toUpperCase()==='AKTIF'&&Number.isFinite(expiry)&&expiry>Date.now();
  });
  const activeStoreReservations=readRows_(ss.getSheetByName('ReservasiStokToko')).filter(function(r){
    const expiry=new Date(r[7]||0).getTime();
    return String(r[5]||'').toUpperCase()==='AKTIF'&&Number.isFinite(expiry)&&expiry>Date.now();
  });
  function checkReservations_(rows,stockMap,label){const reserved=Object.create(null);rows.forEach(function(r){const key=String(r[2]||'')+'|'+String(r[3]||''),qty=Number(r[4]);if(Number.isSafeInteger(qty)&&qty>0)reserved[key]=(reserved[key]||0)+qty;});Object.keys(reserved).forEach(function(key){const matches=stockMap[key]||[];if(matches.length===1&&Number.isSafeInteger(matches[0].qty)&&reserved[key]>matches[0].qty)issue('STOCK_RESERVATION_OVERCOMMITTED',key,'Reservasi '+label+' aktif '+reserved[key]+' unit melebihi stok '+label+' '+matches[0].qty+' unit.');});}
  const cashierStockRowsByKey=Object.create(null);cashierStocks.forEach(function(r,i){const key=String(r[1]||'')+'|'+String(r[2]||'');if(!cashierStockRowsByKey[key])cashierStockRowsByKey[key]=[];cashierStockRowsByKey[key].push({row:i+2,qty:Number(r[3])});if(!Number.isSafeInteger(Number(r[3]))||Number(r[3])<0)issue('CASHIER_STOCK_QTY_INVALID',key,'Saldo StokKasir harus bilangan bulat nol atau lebih.');if(cashierStockRowsByKey[key].length>1)issue('CASHIER_STOCK_ROW_DUPLICATE',key,'Ditemukan lebih dari satu baris StokKasir untuk item ini.');});
  const cashierMutationRowsByKey=Object.create(null);cashierMutations.forEach(function(r,i){const key=String(r[1]||'')+'|'+String(r[2]||''),type=String(r[3]||'').toUpperCase(),qty=Number(r[4]),before=Number(r[5]),after=Number(r[6]);if(!cashierMutationRowsByKey[key])cashierMutationRowsByKey[key]=[];cashierMutationRowsByKey[key].push({row:i+2,type:type,qty:qty,before:before,after:after});if(['MASUK','KELUAR'].indexOf(type)<0||!Number.isSafeInteger(qty)||qty<1||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after!==(type==='MASUK'?before+qty:before-qty)||after<0)issue('CASHIER_MUTATION_ARITHMETIC_INVALID',key,'MutasiStokKasir baris '+(i+2)+' memiliki aritmetika tidak valid.');});
  const cashierKeys=Object.create(null);Object.keys(cashierStockRowsByKey).concat(Object.keys(cashierMutationRowsByKey)).forEach(function(k){cashierKeys[k]=true;});Object.keys(cashierKeys).forEach(function(key){const sr=cashierStockRowsByKey[key]||[],history=cashierMutationRowsByKey[key]||[];if(sr.length>1)return;if(!sr.length&&history.length){issue('CASHIER_STOCK_ROW_MISSING',key,'Mutasi Kasir ditemukan tetapi saldo StokKasir tidak tersedia.');return;}let previous=null;history.forEach(function(m){if(previous!==null&&m.before!==previous)issue('CASHIER_MUTATION_CHAIN_BREAK',key,'Rantai saldo Kasir terputus pada MutasiStokKasir baris '+m.row+'.');previous=m.after;});if(history.length&&sr.length===1&&Number.isSafeInteger(sr[0].qty)&&sr[0].qty!==history[history.length-1].after)issue('CASHIER_STOCK_CURRENT_BALANCE_MISMATCH',key,'Saldo StokKasir saat ini berbeda dari saldo mutasi Kasir terakhir.');});
  checkReservations_(activeReservations,stockRowsByKey,'Gudang');checkReservations_(activeStoreReservations,cashierStockRowsByKey,'Kasir');

  const sales=readRows_(ss.getSheetByName('PenjualanToko')),saleDetails=readRows_(ss.getSheetByName('DetailPenjualanToko'));
  const saleDetailMap=Object.create(null),saleMutationMap=Object.create(null);
  saleDetails.forEach(function(r){const id=String(r[1]||'');if(!saleDetailMap[id])saleDetailMap[id]=[];saleDetailMap[id].push(r);});
  cashierMutations.forEach(function(r){if(String(r[3]||'').toUpperCase()!=='KELUAR')return;const ref=String(r[7]||'');if(!saleMutationMap[ref])saleMutationMap[ref]=[];saleMutationMap[ref].push(r);});
  const cashierCutoverTime=cashierMutations.reduce(function(min,r){const t=r[10] instanceof Date?r[10].getTime():new Date(r[10]||0).getTime();return Number.isFinite(t)&&t>0?Math.min(min,t):min;},Infinity);
  sales.forEach(function(s){
    if(String(s[11]||'').toUpperCase()!=='LUNAS')return;
    const finalizedAt=s[16] instanceof Date?s[16].getTime():new Date(s[16]||s[15]||0).getTime();
    // Riwayat POS sebelum mutasi Kasir pertama merupakan histori legacy dari era stok gabungan.
    if(!Number.isFinite(cashierCutoverTime)||!Number.isFinite(finalizedAt)||finalizedAt<cashierCutoverTime)return;
    const id=String(s[0]||''),expected=Object.create(null),actual=Object.create(null);
    (saleDetailMap[id]||[]).forEach(function(d){const key=String(d[2]||'')+'|'+String(d[3]||''),qty=Number(d[8]);expected[key]=(expected[key]||0)+(Number.isSafeInteger(qty)&&qty>0?qty:0);});
    (saleMutationMap[id]||[]).forEach(function(m){const key=String(m[1]||'')+'|'+String(m[2]||'');actual[key]=(actual[key]||0)+(Number(m[4])||0);});
    const all=Object.create(null);Object.keys(expected).concat(Object.keys(actual)).forEach(function(k){all[k]=true;});
    Object.keys(all).forEach(function(key){if((expected[key]||0)!==(actual[key]||0))issue('POS_SALE_MUTATION_INCOMPLETE',key,'Penjualan POS '+id+' berstatus LUNAS, tetapi total mutasi keluar '+(actual[key]||0)+' tidak sama dengan detail '+(expected[key]||0)+'.');});
  });

  const orders=readRows_(ss.getSheetByName('Pesanan')),orderDetails=readRows_(ss.getSheetByName('DetailPesanan')),orderDetailMap=Object.create(null),orderMutationMap=Object.create(null);
  orderDetails.forEach(function(r){const id=String(r[1]||'');if(!orderDetailMap[id])orderDetailMap[id]=[];orderDetailMap[id].push(r);});
  mutations.forEach(function(r){if(String(r[3]||'').toUpperCase()!=='KELUAR')return;const ref=String(r[7]||'');if(!orderMutationMap[ref])orderMutationMap[ref]=[];orderMutationMap[ref].push(r);});
  const paidStatuses=['DIBAYAR','DIPROSES','DISIAPKAN','SIAP_DIAMBIL','DIANTAR','DITERIMA'];
  orders.forEach(function(o){
    if(paidStatuses.indexOf(String(o[8]||'').toUpperCase())<0)return;
    const id=String(o[0]||''),expected=Object.create(null),actual=Object.create(null);
    (orderDetailMap[id]||[]).forEach(function(d){const key=String(d[2]||'')+'|'+String(d[3]||''),qty=Number(d[8]);expected[key]=(expected[key]||0)+(Number.isSafeInteger(qty)&&qty>0?qty:0);});
    (orderMutationMap[id]||[]).forEach(function(m){const key=String(m[1]||'')+'|'+String(m[2]||'');actual[key]=(actual[key]||0)+(Number(m[4])||0);});
    const all=Object.create(null);Object.keys(expected).concat(Object.keys(actual)).forEach(function(k){all[k]=true;});
    Object.keys(all).forEach(function(key){if((expected[key]||0)!==(actual[key]||0))issue('ORDER_STOCK_MUTATION_INCOMPLETE',key,'Pesanan '+id+' berstatus '+String(o[8])+' tetapi total mutasi keluar '+(actual[key]||0)+' tidak sama dengan detail '+(expected[key]||0)+'.');});
  });

  return {
    checkedAt:new Date().toISOString(),mode:'READ_ONLY',
    counts:{warehouseStockRows:stocks.length,warehouseMutationRows:mutations.length,cashierStockRows:cashierStocks.length,cashierMutationRows:cashierMutations.length,activeOrderReservations:activeReservations.length,activeStoreReservations:activeStoreReservations.length,salesChecked:sales.length,ordersChecked:orders.length},
    issueCount:issues.length,issues:issues,truncated:issues.length>=maxIssues,
    recoveryCandidateCount:recoveryCandidates.length,recoveryCandidates:recoveryCandidates.slice(0,maxIssues),
    recoveryPolicy:'NO_AUTOMATIC_STOCK_ADJUSTMENT'
  };
}


/** Memvalidasi mutasi MASUK manual terhadap AuditLog, termasuk referensi requestKey baru. */
function hasMatchingManualInboundAudit_(auditRows, mutation) {
  const pid=String(mutation[1]||''),variationId=String(mutation[2]||''),requestKey=String(mutation[7]||'');
  const mutationTime=new Date(mutation[10]||0).getTime();
  return (auditRows||[]).some(function(a){
    if(String(a[3]||'').toUpperCase()!=='ADJUST_STOCK'||String(a[4]||'').toUpperCase()!=='STOK')return false;
    let after={};try{after=JSON.parse(String(a[7]||'{}'));}catch(e){}
    const entityId=String(a[5]||''),auditTime=new Date(a[9]||0).getTime();
    return (entityId===requestKey||entityId===pid)&&String(after.productId||'')===pid&&
      String(after.variationId||'')===variationId&&String(after.type||'').toUpperCase()==='MASUK'&&
      Number(after.qty)===Number(mutation[4])&&Number(after.stockBefore)===Number(mutation[5])&&
      Number(after.stockAfter)===Number(mutation[6])&&auditTime===mutationTime;
  });
}

/**
 * Tahap 13 — Audit penerimaan barang dan jejak mutasi Gudang.
 * Read-only: tidak membuat sheet dan tidak mengubah data.
 */
function auditWarehouseReceivingIntegrity_() {
  const ss=getSS_(),issues=[],maxIssues=1000;
  function rows(name){const sh=ss.getSheetByName(name);return sh?readRows_(sh):null;}
  function issue(code,sheet,row,detail){
    if(issues.length<maxIssues)issues.push({code:code,sheet:sheet,row:row||'',detail:detail||''});
  }
  const receiptRows=rows('PenerimaanBarang'),detailRows=rows('DetailPenerimaanBarang'),mutationRows=rows('MutasiStok'),auditRows=rows('AuditLog')||[],variationRows=rows('VariasiProduk')||[];
  const variationIds=Object.create(null);variationRows.forEach(function(v){variationIds[String(v[0]||'')]=true;});
  if(!receiptRows)issue('RECEIPT_SHEET_MISSING','PenerimaanBarang','','Sheet penerimaan belum tersedia.');
  if(!detailRows)issue('RECEIPT_DETAIL_SHEET_MISSING','DetailPenerimaanBarang','','Sheet detail penerimaan belum tersedia.');
  if(!mutationRows)issue('STOCK_MUTATION_SHEET_MISSING','MutasiStok','','Sheet mutasi stok belum tersedia.');
  const receipts=receiptRows||[],details=detailRows||[],mutations=mutationRows||[];
  const receiptById=Object.create(null),receiptNumbers=Object.create(null),detailsByReceipt=Object.create(null),mutationsByReceipt=Object.create(null),detailIds=Object.create(null),mutationIds=Object.create(null);
  receipts.forEach(function(r,i){
    const id=String(r[0]||''),number=String(r[1]||'');
    if(!id)issue('RECEIPT_ID_EMPTY','PenerimaanBarang',i+2,'PenerimaanId kosong.');
    else if(receiptById[id])issue('RECEIPT_ID_DUPLICATE','PenerimaanBarang',i+2,'PenerimaanId duplikat: '+id+'.');
    else receiptById[id]={row:i+2,values:r};
    if(!number)issue('RECEIPT_NUMBER_EMPTY','PenerimaanBarang',i+2,'Nomor penerimaan kosong.');
    else if(receiptNumbers[number])issue('RECEIPT_NUMBER_DUPLICATE','PenerimaanBarang',i+2,'Nomor penerimaan duplikat.');
    else receiptNumbers[number]=i+2;
    if(!Number.isSafeInteger(Number(r[6]))||Number(r[6])<1||!Number.isSafeInteger(Number(r[7]))||Number(r[7])<1)issue('RECEIPT_TOTAL_INVALID','PenerimaanBarang',i+2,'Jumlah baris atau total kuantitas penerimaan tidak valid.');
  });
  details.forEach(function(d,i){
    const id=String(d[0]||''),receiptId=String(d[1]||''),pid=String(d[2]||''),vid=String(d[3]||''),qty=Number(d[4]),before=Number(d[5]),after=Number(d[6]),key=pid+'|'+vid;
    if(!id)issue('RECEIPT_DETAIL_ID_EMPTY','DetailPenerimaanBarang',i+2,'DetailPenerimaanId kosong.');
    else if(detailIds[id])issue('RECEIPT_DETAIL_ID_DUPLICATE','DetailPenerimaanBarang',i+2,'DetailPenerimaanId duplikat.');
    detailIds[id]=true;
    if(!receiptById[receiptId])issue('RECEIPT_DETAIL_ORPHAN','DetailPenerimaanBarang',i+2,'Detail merujuk PenerimaanId yang tidak ditemukan: '+receiptId+'.');
    if(!detailsByReceipt[receiptId])detailsByReceipt[receiptId]=[];
    detailsByReceipt[receiptId].push({row:i+2,key:key,pid:pid,vid:vid,qty:qty,before:before,after:after});
    if(!pid||!Number.isSafeInteger(qty)||qty<1||!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after!==before+qty)issue('RECEIPT_DETAIL_ARITHMETIC_INVALID','DetailPenerimaanBarang',i+2,'Produk, kuantitas, atau saldo sebelum/sesudah detail penerimaan tidak valid.');
  });
  mutations.forEach(function(m,i){
    const id=String(m[0]||''),type=String(m[3]||'').toUpperCase(),ref=String(m[7]||'');
    if(!id)issue('MUTATION_ID_EMPTY','MutasiStok',i+2,'MutasiId kosong.');
    else if(mutationIds[id])issue('MUTATION_ID_DUPLICATE','MutasiStok',i+2,'MutasiId duplikat.');
    mutationIds[id]=true;
    if(type!=='MASUK')return;
    if(ref&&receiptById[ref]){
      if(!mutationsByReceipt[ref])mutationsByReceipt[ref]=[];
      mutationsByReceipt[ref].push({row:i+2,values:m});
      return;
    }
    if(ref&&variationIds[ref]){
      if(Number(m[5])!==0||!Number.isSafeInteger(Number(m[4]))||Number(m[4])<1||Number(m[6])!==Number(m[4]))
        issue('OPENING_STOCK_MUTATION_INVALID','MutasiStok',i+2,'Mutasi stok awal variasi harus mencatat saldo 0 menjadi jumlah stok awal yang sama dengan qty.');
      return;
    }
    if(!hasMatchingManualInboundAudit_(auditRows,m))
      issue('MANUAL_INBOUND_AUDIT_MISSING','MutasiStok',i+2,'Mutasi MASUK manual tidak memiliki AuditLog ADJUST_STOCK yang cocok dengan referensi, produk, variasi, jumlah, saldo, dan timestamp.');
  });
  Object.keys(receiptById).forEach(function(id){
    const receipt=receiptById[id],r=receipt.values,receiptDetails=detailsByReceipt[id]||[],receiptMutations=mutationsByReceipt[id]||[];
    const expectedLines=Number(r[6]),expectedTotal=Number(r[7]),detailTotal=receiptDetails.reduce(function(sum,d){return sum+(Number.isSafeInteger(d.qty)&&d.qty>0?d.qty:0);},0);
    if(receiptDetails.length!==expectedLines)issue('RECEIPT_LINE_COUNT_MISMATCH','PenerimaanBarang',receipt.row,'Jumlah baris header '+expectedLines+' berbeda dari detail '+receiptDetails.length+'.');
    if(detailTotal!==expectedTotal)issue('RECEIPT_TOTAL_QTY_MISMATCH','PenerimaanBarang',receipt.row,'Total header '+expectedTotal+' berbeda dari total detail '+detailTotal+'.');
    const expected=Object.create(null),actual=Object.create(null);
    receiptDetails.forEach(function(d){
      if(!expected[d.key])expected[d.key]={qty:0,details:[]};
      expected[d.key].qty+=Number.isSafeInteger(d.qty)&&d.qty>0?d.qty:0;
      expected[d.key].details.push(d);
    });
    receiptMutations.forEach(function(x){
      const m=x.values,key=String(m[1]||'')+'|'+String(m[2]||'');
      if(!actual[key])actual[key]={qty:0,rows:[]};
      actual[key].qty+=Number(m[4])||0;actual[key].rows.push(x);
    });
    const keys=Object.create(null);Object.keys(expected).concat(Object.keys(actual)).forEach(function(k){keys[k]=true;});
    Object.keys(keys).forEach(function(key){
      const e=expected[key],a=actual[key];
      if(!e||!a||e.qty!==a.qty)issue('RECEIPT_MUTATION_QTY_MISMATCH','PenerimaanBarang',receipt.row,'Kuantitas mutasi MASUK untuk '+key+' tidak sama dengan detail penerimaan.');
      if(a&&a.rows.length!==1)issue('RECEIPT_MUTATION_DUPLICATE','MutasiStok',a.rows[0].row,'Satu item penerimaan memiliki lebih dari satu mutasi MASUK.');
      if(e&&a&&e.details.length===1&&a.rows.length===1){
        const d=e.details[0],m=a.rows[0].values;
        if(Number(m[4])!==d.qty||Number(m[5])!==d.before||Number(m[6])!==d.after)issue('RECEIPT_MUTATION_DETAIL_MISMATCH','MutasiStok',a.rows[0].row,'Nilai mutasi tidak sama dengan detail penerimaan untuk '+key+'.');
      }
    });
    const duplicateItemKeys=Object.create(null);
    receiptDetails.forEach(function(d){if(duplicateItemKeys[d.key])issue('RECEIPT_DUPLICATE_ITEM_LINE','DetailPenerimaanBarang',d.row,'Produk/variasi muncul lebih dari sekali pada satu penerimaan.');duplicateItemKeys[d.key]=true;});
    const auditExists=auditRows.some(function(a){return String(a[3]||'').toUpperCase()==='CREATE_STOCK_RECEIPT'&&String(a[4]||'').toUpperCase()==='PENERIMAAN_BARANG'&&String(a[5]||'')===id;});
    if(!auditExists)issue('RECEIPT_AUDITLOG_MISSING','PenerimaanBarang',receipt.row,'Catatan AuditLog CREATE_STOCK_RECEIPT tidak ditemukan.');
  });
  Object.keys(mutationsByReceipt).forEach(function(id){
    if(!receiptById[id])issue('RECEIPT_MUTATION_ORPHAN','MutasiStok',mutationsByReceipt[id][0].row,'Mutasi MASUK merujuk penerimaan yang tidak ditemukan: '+id+'.');
  });
  return {
    checkedAt:new Date().toISOString(),mode:'READ_ONLY',
    counts:{receipts:receipts.length,receiptDetails:details.length,stockMutations:mutations.length},
    issueCount:issues.length,issues:issues,truncated:issues.length>=maxIssues,
    policy:'NO_AUTOMATIC_REPAIR'
  };
}


/** Audit read-only transaksi yang mungkin terhenti di antara beberapa penulisan sheet. */
function auditFMartTransactionRecovery_(){
 const ss=getSS_(),issues=[],max=500;function add(code,id,detail,action){if(issues.length<max)issues.push({code:code,entityId:String(id||''),detail:detail,action:action,automaticRepair:false});}
 const orders=readRows_(ss.getSheetByName('Pesanan')),details=readRows_(ss.getSheetByName('DetailPesanan')),ships=readRows_(ss.getSheetByName('Pengiriman')),dm=Object.create(null),sm=Object.create(null);
 details.forEach(r=>dm[String(r[1]||'')]=(dm[String(r[1]||'')]||0)+1);ships.forEach(r=>sm[String(r[1]||'')]=(sm[String(r[1]||'')]||0)+1);
 orders.forEach(r=>{const id=String(r[0]||''),raw=String(r[14]||'');if(!raw)return;let p;try{p=JSON.parse(raw)}catch(e){add('CHECKOUT_PAYLOAD_INVALID',id,'Payload checkout tidak dapat dibaca.','Periksa manual; jangan mengubah stok.');return;}const expected=(p.items||[]).length;if((dm[id]||0)!==expected)add('CHECKOUT_DETAIL_INCOMPLETE',id,'Detail '+(dm[id]||0)+' dari '+expected+'.','Jalankan recoverFMartTransactions_() sebagai Admin/Superadmin.');if((sm[id]||0)!==1)add('CHECKOUT_SHIPMENT_INCOMPLETE',id,'Jumlah pengiriman '+(sm[id]||0)+'.','Jalankan recoverFMartTransactions_() sebagai Admin/Superadmin.');});
 const receipts=readRows_(ss.getSheetByName('PenerimaanBarang')),rd=readRows_(ss.getSheetByName('DetailPenerimaanBarang')),mut=readRows_(ss.getSheetByName('MutasiStok')),rdm=Object.create(null),rm=Object.create(null);
 rd.forEach(r=>rdm[String(r[1]||'')]=(rdm[String(r[1]||'')]||0)+1);mut.forEach(r=>{if(String(r[3]||'').toUpperCase()==='MASUK')rm[String(r[7]||'')]=(rm[String(r[7]||'')]||0)+1;});
 receipts.forEach(r=>{const id=String(r[0]||''),expected=Number(r[6])||0;if((rdm[id]||0)!==expected||(rm[id]||0)<expected)add('RECEIPT_INCOMPLETE',id,'Detail atau mutasi penerimaan belum lengkap.','Jalankan recoverFMartTransactions_() setelah pemeriksaan sumber stok.');});
 return {checkedAt:new Date().toISOString(),mode:'READ_ONLY',issueCount:issues.length,issues:issues,truncated:issues.length>=max,policy:'NO_AUTOMATIC_STOCK_OR_PAYMENT_REPAIR'};
}
/** Pemulihan checkout dan penerimaan yang memiliki payload/fingerprint valid; tidak menyentuh pembayaran. */
function recoverFMartTransactions_(token,limit){
 const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]),max=Math.max(1,Math.min(100,Number(limit)||25)),lock=LockService.getScriptLock();lock.waitLock(20000);
 try{
  const ss=getSS_(),orders=readRows_(ss.getSheetByName('Pesanan')),details=readRows_(ss.getSheetByName('DetailPesanan')),ships=readRows_(ss.getSheetByName('Pengiriman')),dm=Object.create(null),sm=Object.create(null);
  details.forEach(r=>dm[String(r[1]||'')]=(dm[String(r[1]||'')]||0)+1);ships.forEach(r=>sm[String(r[1]||'')]=(sm[String(r[1]||'')]||0)+1);
  const results=[];orders.map((r,i)=>({values:r,rowNumber:i+2})).filter(o=>String(o.values[14]||'')).forEach(o=>{
   if(results.length>=max)return;let p;try{p=JSON.parse(String(o.values[14]))}catch(e){results.push({id:String(o.values[0]),type:'CHECKOUT',ok:false,error:'Payload tidak valid.'});return;}
   if((dm[String(o.values[0])]||0)===(p.items||[]).length&&(sm[String(o.values[0])]||0)===1)return;
   try{const fingerprintPayload=p.recipientSnapshot?{userId:p.userId,recipient:p.recipientSnapshot,selectedCartIds:(p.selectedCartIds||[]).slice().sort(),note:String(o.values[9]||''),shippingMethod:p.shippingMethod,requestedDestination:String(p.requestedDestination||'')}:{userId:p.userId,santriId:p.santriId,selectedCartIds:(p.selectedCartIds||[]).slice().sort(),note:String(o.values[9]||''),shippingMethod:p.shippingMethod,requestedDestination:String(p.requestedDestination||'')};const expected=sha256Hex_(JSON.stringify(fingerprintPayload));if(expected!==String(o.values[13]||'')||String(p.userId)!==String(o.values[2]))throw new Error('Fingerprint/pemilik tidak cocok.');const done=completeCheckoutOrder_(ss,o,p,session.userId,session.role);results.push({id:String(o.values[0]),type:'CHECKOUT',ok:true,completed:done.itemCount});}catch(e){results.push({id:String(o.values[0]),type:'CHECKOUT',ok:false,error:String(e.message||e)});}
  });
  const receipts=readRows_(ss.getSheetByName('PenerimaanBarang')),rDetails=readRows_(ss.getSheetByName('DetailPenerimaanBarang')),mut=readRows_(ss.getSheetByName('MutasiStok')),rdm=Object.create(null),rm=Object.create(null);
  rDetails.forEach(r=>rdm[String(r[1]||'')]=(rdm[String(r[1]||'')]||0)+1);mut.forEach(r=>{if(String(r[3]||'').toUpperCase()==='MASUK')rm[String(r[7]||'')]=(rm[String(r[7]||'')]||0)+1;});
  receipts.map((r,i)=>({values:r,rowNumber:i+2})).filter(r=>String(r.values[12]||'')).forEach(r=>{
   if(results.length>=max)return;let p;try{p=JSON.parse(String(r.values[12]))}catch(e){results.push({id:String(r.values[0]),type:'RECEIPT',ok:false,error:'Payload tidak valid.'});return;}
   if((rdm[String(r.values[0])]||0)===(p.items||[]).length&&(rm[String(r.values[0])]||0)>=(p.items||[]).length)return;
   try{const fingerprint=sha256Hex_(JSON.stringify({supplier:p.supplier,reference:p.reference,note:p.note,receivedDate:String(p.receivedDateInput||''),items:(p.items||[]).map(x=>({productId:x.productId,variationId:x.variationId,qty:x.qty})).sort((a,b)=>(a.productId+'|'+a.variationId).localeCompare(b.productId+'|'+b.variationId))}));if(fingerprint!==String(r.values[11]||''))throw new Error('Fingerprint penerimaan tidak cocok. Pemulihan dibatalkan.');const done=completeStockReceipt_(ss,r,p,session.userId,session.role);results.push({id:String(r.values[0]),type:'RECEIPT',ok:true,completed:done.totalLines});}catch(e){results.push({id:String(r.values[0]),type:'RECEIPT',ok:false,error:String(e.message||e)});}
  });
  return {ok:true,checked:results.length,recovered:results.filter(x=>x.ok).length,results:results,policy:'CHECKOUT_AND_RECEIPT_ONLY_NO_PAYMENT_REPAIR'};
 }finally{lock.releaseLock();}
}


/**
 * Menulis hasil readiness audit dalam beberapa log kecil agar Execution Log
 * Apps Script tidak memotong JSON report besar. Report lengkap tetap
 * dikembalikan sebagai nilai fungsi; helper ini hanya melakukan logging.
 */
function logFMartReadinessAudit_(report) {
  const checks = report && report.checks ? report.checks : {};
  const chunkSize = 5;
  Logger.log('FMART_AUDIT_SUMMARY ' + JSON.stringify({
    checkedAt: report.checkedAt,
    ok: report.ok,
    totalIssues: report.totalIssues,
    summary: report.summary
  }));
  Object.keys(checks).forEach(function(name) {
    const result = checks[name] || {};
    const issues = Array.isArray(result.issues) ? result.issues : [];
    const diagnostics = {
      name: name,
      ok: result.ok !== false && issues.length === 0 && !(Number(result.issueCount) > 0),
      issueCount: issues.length || Number(result.issueCount) || 0,
      counts: result.counts || null,
      database: result.database || null,
      activeUsersByRole: result.activeUsersByRole || null,
      driveFolders: result.driveFolders || null,
      triggers: result.triggers || null,
      truncated: result.truncated === true,
      error: result.error || null
    };
    Logger.log('FMART_AUDIT_CHECK ' + JSON.stringify(diagnostics));
    if (!issues.length) {
      Logger.log('FMART_AUDIT_ISSUES ' + JSON.stringify({
        name: name, part: 1, totalParts: 1, issues: []
      }));
      return;
    }
    const totalParts = Math.ceil(issues.length / chunkSize);
    for (let i = 0; i < issues.length; i += chunkSize) {
      Logger.log('FMART_AUDIT_ISSUES ' + JSON.stringify({
        name: name,
        part: Math.floor(i / chunkSize) + 1,
        totalParts: totalParts,
        issues: issues.slice(i, i + chunkSize)
      }));
    }
  });
  Logger.log('FMART_AUDIT_COMPLETE ' + JSON.stringify({
    checkedAt: report.checkedAt,
    ok: report.ok,
    totalIssues: report.totalIssues
  }));
}

/** One-click, read-only readiness audit for Apps Script editor. */
/**
 * Rekonsiliasi read-only pengajuan pembayaran QRIS Wali dengan pesanan.
 * Tidak membaca atau mengubah saldo bank/merchant; verifikasi dana tetap manual.
 */
function auditFMartPaymentIntegrity_() {
  const ss = getSS_();
  const payments = readRows_(ss.getSheetByName('Pembayaran'));
  const orders = readRows_(ss.getSheetByName('Pesanan'));
  const issues = [];
  const maxIssues = 1000;
  const orderById = Object.create(null);
  const paymentIds = Object.create(null);
  const requestKeys = Object.create(null);
  const activeByOrder = Object.create(null);
  const counts = { payments: payments.length, orders: orders.length, pending: 0, verified: 0, rejected: 0 };
  orders.forEach(function(row, index) { const id = String(row[0] || '').trim(); if (id && !orderById[id]) orderById[id] = { row: index + 2, values: row }; });
  function issue(code, row, paymentId, detail) { if (issues.length < maxIssues) issues.push({ code: code, sheet: 'Pembayaran', row: row || '', paymentId: paymentId || '', detail: detail || '' }); }
  const paidOrderStatuses = ['MENUNGGU_STOK','DIBAYAR','DIPROSES','DISIAPKAN','SIAP_DIAMBIL','DIANTAR','DITERIMA'];
  payments.forEach(function(payment, index) {
    const rowNumber = index + 2, id = String(payment[0] || '').trim(), orderId = String(payment[1] || '').trim();
    const method = String(payment[2] || '').trim().toUpperCase(), amount = Number(payment[3]);
    const proofUrl = String(payment[4] || '').trim(), status = String(payment[5] || '').trim().toUpperCase();
    const verifiedBy = String(payment[6] || '').trim(), verifiedAt = payment[7], ownerId = String(payment[11] || '').trim();
    const requestKey = String(payment[13] || '').trim(), proofHash = String(payment[14] || '').trim(), order = orderById[orderId];
    if (!id) issue('PAYMENT_ID_EMPTY', rowNumber, '', 'PaymentId kosong.');
    else if (paymentIds[id]) issue('PAYMENT_ID_DUPLICATE', rowNumber, id, 'PaymentId duplikat; baris pertama ' + paymentIds[id] + '.');
    else paymentIds[id] = rowNumber;
    if (!order) issue('PAYMENT_ORDER_MISSING', rowNumber, id, 'Pesanan terkait tidak ditemukan: ' + orderId + '.');
    else {
      if (ownerId !== String(order.values[2] || '').trim()) issue('PAYMENT_OWNER_MISMATCH', rowNumber, id, 'UserId pengaju pembayaran tidak sama dengan pemilik pesanan.');
      const orderTotal = Number(order.values[7]);
      if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(orderTotal) || orderTotal < 1 || amount !== orderTotal) issue('PAYMENT_AMOUNT_MISMATCH', rowNumber, id, 'Nominal pembayaran tidak sama dengan total pesanan.');
    }
    if (requestKey) { if (requestKeys[requestKey]) issue('PAYMENT_REQUEST_KEY_DUPLICATE', rowNumber, id, 'RequestKey juga digunakan pada baris ' + requestKeys[requestKey] + '.'); else requestKeys[requestKey] = rowNumber; }
    if (['MENUNGGU_VERIFIKASI','TERVERIFIKASI','DITOLAK'].indexOf(status) < 0) { issue('PAYMENT_STATUS_INVALID', rowNumber, id, 'Status pembayaran tidak dikenal: ' + status + '.'); return; }
    if (status === 'MENUNGGU_VERIFIKASI') counts.pending++;
    if (status === 'TERVERIFIKASI') counts.verified++;
    if (status === 'DITOLAK') counts.rejected++;
    if (['MENUNGGU_VERIFIKASI','TERVERIFIKASI'].indexOf(status) >= 0) {
      activeByOrder[orderId] = (activeByOrder[orderId] || 0) + 1;
      if (method !== 'QRIS') issue('PAYMENT_METHOD_NOT_QRIS', rowNumber, id, 'Pembayaran aktif/terverifikasi harus menggunakan QRIS.');
      if (!proofUrl) issue('PAYMENT_PROOF_MISSING', rowNumber, id, 'Pembayaran aktif tidak memiliki referensi bukti.');
      if (order && status === 'MENUNGGU_VERIFIKASI' && String(order.values[8] || '').toUpperCase() !== 'MENUNGGU_PEMBAYARAN') issue('PAYMENT_PENDING_ORDER_STATUS_MISMATCH', rowNumber, id, 'Pembayaran menunggu verifikasi tetapi status pesanan bukan MENUNGGU_PEMBAYARAN.');
      if (status === 'MENUNGGU_VERIFIKASI' && (verifiedBy || verifiedAt)) issue('PAYMENT_PENDING_HAS_VERIFIER', rowNumber, id, 'Pembayaran masih pending tetapi kolom verifikator/waktu verifikasi sudah terisi.');
      if (status === 'TERVERIFIKASI') {
        if (!verifiedBy || !verifiedAt || !Number.isFinite(new Date(verifiedAt).getTime())) issue('PAYMENT_VERIFICATION_METADATA_MISSING', rowNumber, id, 'Pembayaran terverifikasi tidak memiliki verifikator dan waktu verifikasi yang valid.');
        if (order && paidOrderStatuses.indexOf(String(order.values[8] || '').toUpperCase()) < 0) issue('PAYMENT_VERIFIED_ORDER_STATUS_MISMATCH', rowNumber, id, 'Pembayaran terverifikasi tetapi status pesanan belum berada pada alur setelah pembayaran.');
      }
      if (String(payment[10] || '').toUpperCase() === 'APLIKASI' && (!requestKey || !/^[a-f0-9]{64}$/i.test(proofHash))) issue('PAYMENT_IDEMPOTENCY_METADATA_MISSING', rowNumber, id, 'Pembayaran aplikasi tidak memiliki RequestKey atau hash bukti SHA-256 yang valid.');
    }
  });
  Object.keys(activeByOrder).forEach(function(orderId) { if (activeByOrder[orderId] > 1) issue('PAYMENT_MULTIPLE_ACTIVE_FOR_ORDER', '', orderId, 'Lebih dari satu pembayaran pending/terverifikasi terkait pesanan yang sama.'); });
  return { checkedAt: new Date().toISOString(), mode: 'READ_ONLY', counts: counts, issueCount: issues.length, issues: issues, truncated: issues.length >= maxIssues, policy: 'NO_PAYMENT_STATUS_NO_BANK_BALANCE_NO_STOCK_MUTATION' };
}
function runFMartReadinessAudit_() {
  const checks = {};
  function run_(name, callback) {
    try { checks[name] = callback(); }
    catch (error) { checks[name] = { ok:false, mode:'READ_ONLY', error:String(error && error.message || error), issues:[{code:'AUDIT_EXECUTION_FAILED',detail:String(error && error.message || error)}] }; }
  }
  run_('database', auditFMartDatabaseIntegrity_);
  run_('runtime', auditFMartRuntime_);
  run_('paymentIntegrity', auditFMartPaymentIntegrity_);
  run_('operationalSync', auditFMartOperationalSync_);
  run_('stockAndPOS', auditFMartStockReconciliation_);
  run_('cashierPOS', auditCashierPOSIntegrity_);
  run_('warehouseReceiving', auditWarehouseReceivingIntegrity_);
  run_('transactionRecovery', auditFMartTransactionRecovery_);
  const summary = Object.keys(checks).map(function(name) {
    const result=checks[name]||{},issues=Array.isArray(result.issues)?result.issues.length:Number(result.issueCount)||0;
    return {name:name,ok:result.ok!==false&&issues===0,issueCount:issues};
  });
  const report={ok:summary.every(function(x){return x.ok;}),mode:'READ_ONLY',checkedAt:new Date().toISOString(),
    summary:summary,totalIssues:summary.reduce(function(n,x){return n+x.issueCount;},0),checks:checks,
    note:'Audit tidak mengubah data. Tinjau semua issue sebelum menjalankan transaksi atau mengaktifkan fitur keamanan tambahan.'};
  logFMartReadinessAudit_(report);
  return report;
}


/** Audit read-only HPP, biaya penerimaan, dan snapshot penjualan. Tidak melakukan migrasi/perbaikan. */
function auditFMartCostingIntegrity_(){
 const ss=getSS_(),issues=[],maxIssues=1000,counts={products:0,variations:0,warehouseStockRows:0,cashierStockRows:0,receiptLines:0,costedReceiptLines:0,legacyUncostedReceiptLines:0,orderLines:0,costedOrderLines:0,legacyUncostedOrderLines:0,posLines:0,costedPosLines:0,legacyUncostedPosLines:0,costedInboundMutations:0,legacyUncostedInboundMutations:0};
 function issue(code,sheet,row,detail){if(issues.length<maxIssues)issues.push({code:code,sheet:sheet,row:row||'',detail:detail||''});}
 function sheet(name){return ss.getSheetByName(name);}
 function rows(name){const sh=sheet(name);return sh?readRows_(sh):[];}
 function col(name,header){const sh=sheet(name);if(!sh)return -1;const headers=sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getDisplayValues()[0].map(function(v){return String(v||'').trim();}),found=[];headers.forEach(function(v,i){if(v===header)found.push(i);});if(found.length!==1){issue(found.length?'COST_HEADER_DUPLICATE':'COST_HEADER_MISSING',name,1,'Header '+header+' harus tersedia tepat satu kali.');return -1;}return found[0];}
 const expected=[['Produk','HargaPokokRataRata',11],['VariasiProduk','HargaPokokRataRata',9],['MutasiStok','BiayaPerUnit',11],['MutasiStok','HPPSebelum',12],['MutasiStok','HPPSesudah',13],['DetailPenerimaanBarang','BiayaPerUnit',8],['DetailPenerimaanBarang','TotalBiaya',9],['DetailPesanan','HPPUnit',10],['DetailPesanan','HPPSubtotal',11],['DetailPesanan','HPPStatus',12],['DetailPenjualanToko','HPPUnit',10],['DetailPenjualanToko','HPPSubtotal',11],['DetailPenjualanToko','HPPStatus',12]];
 expected.forEach(function(x){const idx=col(x[0],x[1]);if(idx>=0&&idx!==x[2])issue('COST_HEADER_POSITION_INVALID',x[0],1,'Header '+x[1]+' berada di kolom '+(idx+1)+', seharusnya '+(x[2]+1)+'.');});
 const pHpp=col('Produk','HargaPokokRataRata'),vHpp=col('VariasiProduk','HargaPokokRataRata'),inCost=col('MutasiStok','BiayaPerUnit'),inBefore=col('MutasiStok','HPPSebelum'),inAfter=col('MutasiStok','HPPSesudah'),receiptUnit=col('DetailPenerimaanBarang','BiayaPerUnit'),receiptTotal=col('DetailPenerimaanBarang','TotalBiaya'),orderUnit=col('DetailPesanan','HPPUnit'),orderTotal=col('DetailPesanan','HPPSubtotal'),orderStatus=col('DetailPesanan','HPPStatus'),posUnit=col('DetailPenjualanToko','HPPUnit'),posTotal=col('DetailPenjualanToko','HPPSubtotal'),posStatus=col('DetailPenjualanToko','HPPStatus');
 const products=rows('Produk'),variations=rows('VariasiProduk'),warehouse=rows('Stok'),cashier=rows('StokKasir'),mutations=rows('MutasiStok'),receipts=rows('DetailPenerimaanBarang'),orders=rows('DetailPesanan'),pos=rows('DetailPenjualanToko');
 counts.products=products.length;counts.variations=variations.length;counts.warehouseStockRows=warehouse.length;counts.cashierStockRows=cashier.length;counts.receiptLines=receipts.length;counts.orderLines=orders.length;counts.posLines=pos.length;
 const master=Object.create(null),stockTotals=Object.create(null),lastCostedInbound=Object.create(null);
 products.forEach(function(r){const id=String(r[0]||''),value=pHpp>=0?r[pHpp]:'';if(id)master[id+'|']={hpp:value===''?0:Number(value),sheet:'Produk'};});
 variations.forEach(function(r){const id=String(r[0]||''),pid=String(r[1]||''),value=vHpp>=0?r[vHpp]:'';if(id)master[pid+'|'+id]={hpp:value===''?0:Number(value),sheet:'VariasiProduk'};});
 function addStock(list,name){const seen=Object.create(null);list.forEach(function(r,i){const key=String(r[1]||'')+'|'+String(r[2]||''),qty=Number(r[3]);if(seen[key])issue('COST_STOCK_ROW_DUPLICATE',name,i+2,'Ada lebih dari satu baris saldo untuk item yang sama.');seen[key]=true;if(!Number.isSafeInteger(qty)||qty<0){issue('COST_STOCK_QTY_INVALID',name,i+2,'Saldo stok harus bilangan bulat nol atau lebih.');return;}stockTotals[key]=(stockTotals[key]||0)+qty;});}
 addStock(warehouse,'Stok');addStock(cashier,'StokKasir');
 Object.keys(master).forEach(function(key){const m=master[key],hpp=m.hpp===''?0:Number(m.hpp),qty=Number(stockTotals[key]||0);if(!Number.isSafeInteger(hpp)||hpp<0)issue('MASTER_HPP_INVALID',m.sheet,key,'HPP master harus bilangan bulat nol atau lebih.');else if(qty>0&&hpp<=0)issue('MASTER_HPP_MISSING_WITH_STOCK',m.sheet,key,'Stok gabungan Gudang + Kasir tersedia tetapi HPP master belum bernilai.');});
 receipts.forEach(function(r,i){const qty=Number(r[4]),unit=receiptUnit>=0?Number(r[receiptUnit]):0,total=receiptTotal>=0?Number(r[receiptTotal]):0,hasUnit=receiptUnit>=0&&String(r[receiptUnit]||'').trim()!=='',hasTotal=receiptTotal>=0&&String(r[receiptTotal]||'').trim()!=='';if(!hasUnit&&!hasTotal){counts.legacyUncostedReceiptLines++;return;}if(!hasUnit||!hasTotal||!Number.isSafeInteger(qty)||qty<1||!Number.isSafeInteger(unit)||unit<1||!Number.isSafeInteger(total)||total!==qty*unit)issue('RECEIPT_COST_INVALID','DetailPenerimaanBarang',i+2,'Biaya per unit dan total biaya tidak konsisten dengan kuantitas.');else counts.costedReceiptLines++;});
 mutations.forEach(function(r,i){if(String(r[3]||'').toUpperCase()!=='MASUK')return;const unit=inCost>=0?String(r[inCost]||'').trim():'',before=inBefore>=0?String(r[inBefore]||'').trim():'',after=inAfter>=0?String(r[inAfter]||'').trim():'';if(!unit&&!before&&!after){counts.legacyUncostedInboundMutations++;return;}const u=Number(unit),b=Number(before),a=Number(after);if(!unit||!before||!after||!Number.isSafeInteger(u)||u<1||!Number.isSafeInteger(b)||b<0||!Number.isSafeInteger(a)||a<1)issue('INBOUND_HPP_JOURNAL_INVALID','MutasiStok',i+2,'Jurnal stok masuk memiliki biaya/HPP sebelum/sesudah yang tidak lengkap atau tidak valid.');else{counts.costedInboundMutations++;const key=String(r[1]||'')+'|'+String(r[2]||'');lastCostedInbound[key]={hpp:a,row:i+2};}});
 receipts.forEach(function(r,i){const unit=receiptUnit>=0?Number(r[receiptUnit]):0,total=receiptTotal>=0?Number(r[receiptTotal]):0;if(!Number.isSafeInteger(unit)||unit<1||!Number.isSafeInteger(total)||total<1)return;const receiptId=String(r[1]||''),itemKey=String(r[2]||'')+'|'+String(r[3]||''),matches=mutations.filter(function(m){return String(m[7]||'')===receiptId&&String(m[1]||'')+'|'+String(m[2]||'')===itemKey&&String(m[3]||'').toUpperCase()==='MASUK';});if(matches.length===1&&inCost>=0&&Number(matches[0][inCost])!==unit)issue('RECEIPT_COST_MUTATION_VALUE_MISMATCH','MutasiStok',i+2,'Biaya per unit pada mutasi berbeda dari detail penerimaan.');});
 function auditSaleLines(list,name,unitIndex,totalIndex,statusIndex,kind){list.forEach(function(r,i){const qty=Number(r[8]),status=statusIndex>=0?String(r[statusIndex]||'').toUpperCase():'',unit=unitIndex>=0?Number(r[unitIndex]):0,total=totalIndex>=0?Number(r[totalIndex]):0,hasUnit=unitIndex>=0&&String(r[unitIndex]||'').trim()!=='',hasTotal=totalIndex>=0&&String(r[totalIndex]||'').trim()!=='';const costed=kind==='ORDER'?function(){counts.costedOrderLines++;}:function(){counts.costedPosLines++;},legacy=kind==='ORDER'?function(){counts.legacyUncostedOrderLines++;}:function(){counts.legacyUncostedPosLines++;};if(status==='TERCATAT'&&hasUnit&&hasTotal&&Number.isSafeInteger(qty)&&qty>0&&Number.isSafeInteger(unit)&&unit>0&&Number.isSafeInteger(total)&&total===qty*unit)costed();else if(!status||status==='BELUM_DICATAT')legacy();else issue('SALE_HPP_SNAPSHOT_INVALID',name,i+2,'Snapshot HPP berstatus TERCATAT tetapi nilai unit/subtotal tidak konsisten, atau status tidak dikenal.');});}
 auditSaleLines(orders,'DetailPesanan',orderUnit,orderTotal,orderStatus,'ORDER');auditSaleLines(pos,'DetailPenjualanToko',posUnit,posTotal,posStatus,'POS');
 Object.keys(lastCostedInbound).forEach(function(key){const m=master[key],stock=Number(stockTotals[key]||0);if(m&&stock>0&&Number(m.hpp)!==lastCostedInbound[key].hpp)issue('MASTER_HPP_DIFFERS_FROM_LAST_INBOUND',m.sheet,key,'HPP master berbeda dari HPP sesudah pada mutasi MASUK berbiaya terakhir (baris '+lastCostedInbound[key].row+').');});
 return {checkedAt:new Date().toISOString(),mode:'READ_ONLY',issueCount:issues.length,issues:issues,truncated:issues.length>=maxIssues,counts:counts,policy:'NO_SCHEMA_MIGRATION_NO_DATA_REPAIR'};
}
