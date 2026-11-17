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
  PASSWORD_HASH_MODE: 'LEGACY', // Aktifkan PBKDF2 hanya setelah benchmark runtime lulus.
  PASSWORD_HASH_ITERATIONS: 600000,
  SPREADSHEET_PROPERTY: 'FMART_SPREADSHEET_ID',
  ROLES: Object.freeze({ WALI_SANTRI:'WALI_SANTRI', ADMIN:'ADMIN', KASIR:'KASIR', GUDANG:'GUDANG', PETUGAS_PENGANTAR:'PETUGAS_PENGANTAR', SUPERADMIN:'SUPERADMIN' })
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
    return ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'].indexOf(role) >= 0;
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
  if (!id) throw new Error('Database FMart belum dikonfigurasi. Jalankan setupFMartDatabase() terlebih dahulu.');
  return SpreadsheetApp.openById(id);
}

function login(username, password, portalMode) {
  portalMode = String(portalMode || 'BUYER') === 'ADMINFMART16720' ? 'ADMINFMART16720' : 'BUYER';
  const rawLogin = String(username || '').trim();
  username = normalizeUsername_(rawLogin);
  if (!username || typeof password !== 'string' || !password) return {ok:false, message:portalMode === 'ADMINFMART16720' ? 'Email atau password tidak valid.' : 'Nomor HP atau password tidak valid.'};
  const phoneKeyForRate = normalizePhone_(rawLogin);
  const rate = loginRateKey_(phoneKeyForRate || username);
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
    const loginValue = portalMode === 'ADMINFMART16720'
      ? normalizeEmail_(rows[i][10])
      : normalizeUsername_(rows[i][1]);
    if (loginValue === username && (portalMode !== 'ADMINFMART16720' || ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'].indexOf(rowRole) >= 0)) {
      if (targetIndex !== -1) {
        recordLoginFailure_(rate);
        return {ok:false,message:'Email atau password tidak valid.'};
      }
      targetIndex=i;
    }
  }

  if (targetIndex === -1 && portalMode !== 'ADMINFMART16720') {
    const phoneKey = normalizePhone_(rawLogin);
    if (phoneKey) {
      const waliRows = readRows_(ss.getSheetByName('WaliSantri'));
      const matches = waliRows.filter(function(r){
        return normalizePhone_(r[3]) === phoneKey && String(r[6] || '').toUpperCase() === 'AKTIF';
      });
      if (matches.length > 1) {
        recordLoginFailure_(rate);
        return {ok:false, message:'Nomor HP/username atau password salah.'};
      }
      if (matches.length === 1) {
        const userId = String(matches[0][1] || '');
        for (let i=0;i<rows.length;i++) {
          if (String(rows[i][0] || '') === userId && String(rows[i][5] || '').toUpperCase() === 'WALI_SANTRI') { targetIndex=i; break; }
        }
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

  // OTP email Admin dinonaktifkan sementara. Email tetap menjadi username staf;
  // password, status akun, pembatasan percobaan, dan role guard tetap berlaku.

  // Migrasi hash lama hanya setelah password lama terbukti benar.
  if (FMART.PASSWORD_HASH_MODE === 'PBKDF2' && isLegacyPasswordHash_(String(r[2] || ''))) {
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
  const cache = CacheService.getScriptCache();
  const userId = String(userRow[0] || '');
  const cooldownKey = adminOtpCooldownKey_(userId);
  if (cache.get(cooldownKey)) return {ok:false,message:'Kode OTP baru saja dikirim. Periksa email atau tunggu sebelum meminta kode baru.'};
  const code = String(100000 + (parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16) % 900000));
  const challengeId = Utilities.getUuid() + Utilities.getUuid();
  const challenge = {
    userId:userId, role:String(userRow[5] || '').toUpperCase(), email:email,
    authUpdatedAt:userRow[8] instanceof Date ? userRow[8].getTime() : (new Date(userRow[8] || 0).getTime() || 0),
    otpHash:adminOtpHash_(challengeId,code), attempts:0, createdAt:Date.now()
  };
  cache.put(adminOtpChallengeKey_(challengeId),JSON.stringify(challenge),300);
  cache.put(cooldownKey,'1',60);
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
       normalizeEmail_(user.values[10])!==challenge.email ||
       !(String(user.values[11]||'').toUpperCase()==='TRUE'||user.values[11]===true)){
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
    if(['ADMIN','SUPERADMIN','KASIR','GUDANG'].indexOf(role)<0) throw new Error('Email hanya dapat diatur untuk akun staf.');
    const rows=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues():[];
    if(rows.some(function(r){return String(r[0]||'')!==String(userId)&&normalizeEmail_(r[10])===email;})) throw new Error('Email sudah digunakan akun lain.');
    sheet.getRange(target.rowNumber,11,1,2).setValues([[email,false]]);
    sheet.getRange(target.rowNumber,9).setValue(new Date());
    const code=String(100000+(parseInt(Utilities.getUuid().replace(/-/g,'').slice(0,8),16)%900000)),challengeId=Utilities.getUuid()+Utilities.getUuid();
    CacheService.getScriptCache().put(staffEmailVerifyKey_(challengeId),JSON.stringify({userId:String(userId),email:email,hash:adminOtpHash_(challengeId,code),createdAt:Date.now(),attempts:0}),600);
    MailApp.sendEmail({to:email,subject:'Verifikasi Email Akun FMart',body:'Kode verifikasi email FMart Anda: '+code+'\n\nKode berlaku selama 10 menit.' ,name:'FMart'});
    writeAudit_(session.userId,session.role,'SET_STAFF_EMAIL','USER',String(userId),'',JSON.stringify({email:maskEmail_(email)}),'Email staf diatur; menunggu verifikasi');
    SpreadsheetApp.flush();
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

/** Pendaftaran mandiri Wali Santri. Akun langsung AKTIF, tanpa relasi anak sampai ditambahkan. */
function registerWaliSantri(nama, noHp, password, email, alamat) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    nama = String(nama || '').trim(); noHp = normalizePhone_(noHp); password = String(password || '');
    email = String(email || '').trim(); alamat = String(alamat || '').trim();
    if (!nama) throw new Error('Nama wajib diisi.');
    if (!noHp) throw new Error('Nomor HP tidak valid. Gunakan format 08xxxxxxxxxx.');
    if (password.length < FMART.PASSWORD_MIN_LENGTH) throw new Error('Password minimal ' + FMART.PASSWORD_MIN_LENGTH + ' karakter.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) throw new Error('Format email tidak valid.');
    const ss=getSS_(), users=ss.getSheetByName('Users'), waliSheet=ss.getSheetByName('WaliSantri');
    if(!users||!waliSheet) throw new Error('Database FMart belum siap.');
    const userRows=readRows_(users), waliRows=readRows_(waliSheet);
    if(waliRows.some(r=>phoneEquals_(r[3],noHp))) throw new Error('Nomor HP sudah terdaftar. Silakan gunakan nomor lain atau login.');
    if(userRows.some(r=>String(r[1]||'').trim()===noHp)) throw new Error('Nomor HP sudah digunakan sebagai akun.');
    const userId=makeFMartId_('USR'), waliId=makeFMartId_('WAL'), salt=Utilities.getUuid().replace(/-/g,''), hash=hashPassword_(password,salt), now=new Date();
    users.getRange(users.getLastRow()+1,1,1,10).setValues([[userId,noHp,hash,salt,nama,'WALI_SANTRI','AKTIF',now,now,'']]);
    waliSheet.getRange(waliSheet.getLastRow()+1,1,1,9).setValues([[waliId,userId,nama,noHp,email,alamat,'AKTIF',now,now]]);
    users.getRange(users.getLastRow(),2).setNumberFormat('@'); waliSheet.getRange(waliSheet.getLastRow(),4).setNumberFormat('@');
    SpreadsheetApp.flush(); writeAudit_('', 'SYSTEM', 'REGISTER_WALI_SANTRI', 'USER', userId, '', JSON.stringify({username:noHp,role:'WALI_SANTRI'}), 'Pendaftaran mandiri Wali Santri');
    return {ok:true,userId:userId,waliId:waliId,message:'Pendaftaran berhasil. Silakan login menggunakan nomor HP dan password Anda.'};
  } finally { lock.releaseLock(); }
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
function getWaliProfileManagement(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const wali = findWaliByUserId_(ss, session.userId);
  if (!wali) throw new Error('Data Wali Santri tidak ditemukan.');
  const santriSheet = ss.getSheetByName('Santri');
  const santriMap = getSantriColumnMap_(santriSheet);
  const santriById = {};
  readSantriRows_(santriSheet).forEach(function(row) {
    const child = santriRecord_(row, santriMap);
    santriById[String(child.id)] = child;
  });
  const relationships = readRows_(ss.getSheetByName('WaliSantriSantri'))
    .filter(function(row) {
      return String(row[1] || '') === String(wali.waliId) &&
        ['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(row[3] || '').toUpperCase()) !== -1;
    })
    .map(function(row) {
      const child = santriById[String(row[2] || '')];
      if (!child) return null;
      const status = String(row[3] || '').toUpperCase();
      return {
        relationId:String(row[0] || ''),
        santriId:String(row[2] || ''),
        name:String(child.name || ''),
        className:String(child.className || ''),
        nis:status === 'AKTIF' ? String(child.nis || '') : maskNis_(child.nis),
        hubungan:String(row[5] || ''),
        status:status,
        requestedAt:dateIso_(row[4]),
        active:status === 'AKTIF' && String(child.status || '').toUpperCase() === 'AKTIF'
      };
    })
    .filter(function(item) { return !!item; });
  const users = getSS_().getSheetByName('Users');
  const userRow = findRowById_(users, session.userId, 1);
  return {
    ok:true,
    profile:{
      nama:wali.nama,
      noHp:wali.noHp,
      email:wali.email,
      alamat:wali.alamat,
      status:String(wali.status || 'AKTIF'),
      username:userRow ? String(userRow.values[1] || '') : String(wali.noHp || '')
    },
    relationships:relationships
  };
}

/** Wali hanya dapat mengubah data kontak non-login miliknya sendiri. */
function updateMyWaliProfile(token, nama, email, alamat) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  nama = String(nama || '').trim().slice(0,120);
  email = String(email || '').trim().slice(0,160);
  alamat = String(alamat || '').trim().slice(0,500);
  if (!nama) throw new Error('Nama wajib diisi.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) throw new Error('Format email tidak valid.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSS_();
    const waliSheet = ss.getSheetByName('WaliSantri');
    const usersSheet = ss.getSheetByName('Users');
    const waliRows = readRows_(waliSheet);
    const waliIndex = waliRows.findIndex(function(row) {
      return String(row[1] || '') === String(session.userId) && String(row[6] || '').toUpperCase() === 'AKTIF';
    });
    if (waliIndex < 0) throw new Error('Data Wali Santri tidak ditemukan atau tidak aktif.');
    const waliRowNumber = waliIndex + 2;
    const before = {nama:String(waliRows[waliIndex][2] || ''),email:String(waliRows[waliIndex][4] || ''),alamat:String(waliRows[waliIndex][5] || '')};
    const now = new Date();
    waliSheet.getRange(waliRowNumber,3).setValue(nama);
    waliSheet.getRange(waliRowNumber,5,1,2).setValues([[email,alamat]]);
    waliSheet.getRange(waliRowNumber,9).setValue(now);
    const userRow = findRowById_(usersSheet, session.userId, 1);
    if (!userRow) throw new Error('Data akun pengguna tidak ditemukan.');
    usersSheet.getRange(userRow.rowNumber,5).setValue(nama);
    writeAudit_(session.userId,session.role,'UPDATE_MY_WALI_PROFILE','WALI_SANTRI',String(waliRows[waliIndex][0] || ''),JSON.stringify(before),JSON.stringify({nama:nama,email:email,alamat:alamat}),'Wali memperbarui profil pribadi');
    SpreadsheetApp.flush();
    return {ok:true,message:'Profil berhasil diperbarui.',profile:{nama:nama,noHp:String(waliRows[waliIndex][3] || ''),email:email,alamat:alamat,status:'AKTIF',username:String(userRow.values[1] || '')}};
  } finally {
    lock.releaseLock();
  }
}

/** Wali hanya dapat membatalkan pengajuan relasi miliknya yang masih menunggu. */
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
  const session = requireSession_(token);
  const ss = getSS_();
  const result = {user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role},categories:[],products:[],children:[]};

  result.categories = readRows_(ss.getSheetByName('Kategori')).filter(function(r){return String(r[4]).toUpperCase()==='AKTIF';}).map(function(r){return {id:r[0],name:r[1],description:r[2],order:r[3]||0};});
  result.products = readRows_(ss.getSheetByName('Produk')).filter(function(r){return String(r[8]).toUpperCase()==='AKTIF';}).map(function(r){return {id:r[0],categoryId:r[1],sku:r[2],name:r[3],description:r[4],price:Number(r[5])||0,minStock:Number(r[6])||0,photoUrl:r[7]||''};});
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
  requireSession_(token);
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

  const variations = readRows_(ss.getSheetByName('VariasiProduk')).filter(function(v) {
    return String(v[1]) === productId && String(v[6] || '').toUpperCase() === 'AKTIF';
  }).map(function(v) {
    return {id:String(v[0]), name:String(v[2] || ''), value:String(v[3] || ''), priceAddition:Number(v[4]) || 0, stock:Number(v[5]) || 0};
  });

  const stocks = readRows_(ss.getSheetByName('Stok')).filter(function(st) {
    return String(st[1]) === productId && (!st[2] || variations.some(function(v){return String(v.id)===String(st[2]);}));
  });
  const baseStockRows = stocks.filter(function(st){ return !st[2]; });
  const variationStock = {};
  stocks.forEach(function(st){ if(st[2]) variationStock[String(st[2])] = Number(st[3]) || 0; });
  variations.forEach(function(v){ if(Object.prototype.hasOwnProperty.call(variationStock,v.id)) v.stock=variationStock[v.id]; });
  const stock = variations.length ? variations.reduce(function(total,v){return total + Math.max(0,v.stock);},0) : (baseStockRows.length ? Number(baseStockRows[0][3]) || 0 : 0);

  return {ok:true, product:{
    id:String(r[0]), categoryId:String(r[1] || ''), categoryName:String(cat.values[1] || ''), sku:String(r[2] || ''),
    name:String(r[3] || ''), description:String(r[4] || ''), price:Number(r[5]) || 0, minStock:Number(r[6]) || 0,
    photoUrl:String(r[7] || ''), stock:Math.max(0,stock), variations:variations
  }};
}

function getCatalog(token) {
  const session = requireSession_(token);
  if (session.role === FMART.ROLES.PETUGAS_PENGANTAR) throw new Error('Petugas Pengantar hanya memiliki akses ke modul pengantaran.');
  const ss = getSS_();
  const categorySheet = ss.getSheetByName('Kategori');
  const productSheet = ss.getSheetByName('Produk');
  const stockSheet = ss.getSheetByName('Stok');
  const variationSheet = ss.getSheetByName('VariasiProduk');
  if (!categorySheet || !productSheet || !stockSheet || !variationSheet) {
    throw new Error('Database katalog FMart belum lengkap. Jalankan setupFMartDatabase().');
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
      priceAddition:Number(r[4]) || 0,
      stock:Object.prototype.hasOwnProperty.call(stockByKey,key) ? stockByKey[key] : Math.max(0,Number(r[5]) || 0)
    });
  });

  products.forEach(function(p){
    const vars = variationsByProduct[p.id] || [];
    if (vars.length) {
      p.stock = vars.reduce(function(sum,v){ return sum + Math.max(0,v.stock); }, 0);
    } else {
      p.stock = Object.prototype.hasOwnProperty.call(stockByKey,p.id+'|') ? stockByKey[p.id+'|'] : 0;
    }
  });

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

/** Tahap Wali: keranjang umum per akun. Santri dipilih saat checkout. */
function getCart(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const rows = readRows_(ss.getSheetByName('Keranjang'));
  const items = [];
  let subtotal = 0;
  rows.forEach(function(r) {
    if (String(r[1]) !== String(session.userId)) return;
    const qty = Math.max(0, Math.floor(Number(r[5]) || 0));
    if (!qty) return;
    const snap = getProductSnapshot_(ss, r[3], r[4]);
    const available = snap ? Math.max(0, snap.stock) : 0;
    const lineSubtotal = snap ? snap.unitPrice * qty : 0;
    subtotal += lineSubtotal;
    items.push({
      cartId:String(r[0]), productId:String(r[3]), variationId:String(r[4] || ''),
      name:snap ? snap.name : 'Produk tidak tersedia',
      variationName:snap ? snap.variationName : '', sku:snap ? snap.sku : '',
      photoUrl:snap ? snap.photoUrl : '', unitPrice:snap ? snap.unitPrice : 0,
      qty:qty, stock:available, subtotal:lineSubtotal,
      available:snap ? snap.active : false,
      exceedsStock:qty > available
    });
  });
  return {ok:true,items:items,subtotal:subtotal,total:subtotal,
    canCheckout:items.length>0 && items.every(function(i){return i.available && !i.exceedsStock;})};
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
    if (nextQty > snap.stock) throw new Error('Jumlah melebihi stok tersedia (' + snap.stock + ').');
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
      if (qty > snap.stock) throw new Error('Jumlah melebihi stok tersedia (' + snap.stock + ').');
      sheet.getRange(row.rowNumber, 3).clearContent();
      sheet.getRange(row.rowNumber, 6, 1, 2).setValues([[qty,new Date()]]);
    }
    return getCart(token);
  } finally { lock.releaseLock(); }
}

function removeCartItem(token, cartId) { return updateCartItem(token, cartId, 0); }

/** Satu checkout menghasilkan satu pesanan untuk satu santri dan hanya item terpilih. */
function checkoutCart(token, santriId, selectedCartIds, catatan, metodePengiriman, tujuan) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  santriId = String(santriId || '').trim();
  selectedCartIds = Array.isArray(selectedCartIds) ? selectedCartIds.map(function(id){return String(id || '').trim();}).filter(Boolean) : [];
  catatan = String(catatan || '').trim().slice(0,500);
  metodePengiriman = String(metodePengiriman || 'AMBIL_FMART').trim().toUpperCase();
  tujuan = String(tujuan || '').trim().slice(0,500);
  if (!santriId) throw new Error('Santri tujuan belum dipilih.');
  if (!selectedCartIds.length) throw new Error('Pilih minimal satu barang untuk checkout.');
  if (['AMBIL_FMART','ANTAR_PESANTREN'].indexOf(metodePengiriman) === -1) throw new Error('Metode pengiriman tidak valid.');
  if (metodePengiriman === 'ANTAR_PESANTREN' && !tujuan) throw new Error('Titik atau pihak penerima wajib diisi untuk pengantaran.');
  const selectedMap = {};
  selectedCartIds.forEach(function(id){selectedMap[id]=true;});
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const ss = getSS_();
    const child = assertWaliChild_(ss, session.userId, santriId);
    const cartSheet = ss.getSheetByName('Keranjang');
    const cartRows = readRows_(cartSheet);
    const selectedRows = [];
    cartRows.forEach(function(r,index){
      if (String(r[1]) === session.userId && selectedMap[String(r[0])]) {
        selectedRows.push({rowNumber:index+2,row:r});
      }
    });
    if (selectedRows.length !== Object.keys(selectedMap).length) throw new Error('Sebagian barang keranjang tidak ditemukan. Muat ulang keranjang.');
    const items = selectedRows.map(function(entry){
      const r=entry.row, qty=Math.max(0,Math.floor(Number(r[5])||0));
      const snap=getProductSnapshot_(ss,r[3],r[4]);
      return {cartId:String(r[0]),rowNumber:entry.rowNumber,productId:String(r[3]),variationId:String(r[4]||''),
        qty:qty,active:!!(snap&&snap.active),stock:snap?Math.max(0,snap.stock):0,
        unitPrice:snap?snap.unitPrice:0,sku:snap?snap.sku:'',name:snap?snap.name:'Produk tidak tersedia',
        variationName:snap?snap.variationName:''};
    });
    if (!items.length) throw new Error('Barang yang dipilih tidak ditemukan di keranjang.');
    const invalid=items.find(function(i){return !i.active||i.qty<1;});
    if (invalid) throw new Error('Produk "'+invalid.name+'" tidak tersedia. Silakan periksa keranjang.');
    const stockTotals={};
    items.forEach(function(i){
      const key=i.productId+'|'+i.variationId;
      stockTotals[key]=(stockTotals[key]||0)+i.qty;
      i.stockKey=key;
    });
    const stockIssue=items.find(function(i){return stockTotals[i.stockKey]>i.stock;});
    if (stockIssue) throw new Error('Total jumlah "'+stockIssue.name+'" melebihi stok tersedia ('+stockIssue.stock+').');
    const subtotal=items.reduce(function(sum,i){return sum+i.unitPrice*i.qty;},0);
    const ongkir=0,diskon=0,total=subtotal+ongkir-diskon,now=new Date();
    const orderId=makeFMartId_('ORD');
    const nomorPesanan='FM-'+Utilities.formatDate(now,FMART_DB.TIMEZONE,'yyyyMMdd-HHmmss')+'-'+Math.floor(1000+Math.random()*9000);
    ss.getSheetByName('Pesanan').appendRow([orderId,nomorPesanan,session.userId,santriId,subtotal,ongkir,diskon,total,'MENUNGGU_PEMBAYARAN',catatan,now,now]);
    const detailSheet=ss.getSheetByName('DetailPesanan');
    items.forEach(function(i){
      detailSheet.appendRow([makeFMartId_('DTL'),orderId,i.productId,i.variationId,i.sku,i.name,i.variationName,i.unitPrice,i.qty,i.unitPrice*i.qty]);
    });
    const tujuanPengiriman = metodePengiriman === 'ANTAR_PESANTREN' ? tujuan : ('Pengambilan langsung di FMart' + (tujuan ? ' — ' + tujuan : ''));
    ss.getSheetByName('Pengiriman').appendRow([makeFMartId_('SHP'),orderId,metodePengiriman,tujuanPengiriman,'MENUNGGU','','',session.userId,now]);
    selectedRows.sort(function(a,b){return b.rowNumber-a.rowNumber;}).forEach(function(entry){cartSheet.deleteRow(entry.rowNumber);});
    writeAudit_(session.userId,session.role,'CREATE_ORDER','PESANAN',orderId,'',JSON.stringify({number:nomorPesanan,santriId:santriId,total:total,itemCount:items.length,shippingMethod:metodePengiriman}),'Checkout membuat pesanan dari item terpilih');
    SpreadsheetApp.flush();
    return {ok:true,orderId:orderId,nomorPesanan:nomorPesanan,total:total,status:'MENUNGGU_PEMBAYARAN',child:child,itemCount:items.length};
  } finally { lock.releaseLock(); }
}

/** Notifikasi pribadi Wali; hanya notifikasi milik sesi aktif yang dikembalikan. */
function getMyNotifications(token) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  const rows=readRows_(getSS_().getSheetByName('Notifikasi')).filter(function(r){return String(r[1]||'')===String(session.userId);}).sort(function(a,b){return new Date(b[7]||0).getTime()-new Date(a[7]||0).getTime();});
  const notifications=rows.slice(0,100).map(function(r){return{id:String(r[0]||''),orderId:String(r[2]||''),title:String(r[3]||''),message:String(r[4]||''),type:String(r[5]||''),isRead:r[6]===true||String(r[6]).toUpperCase()==='TRUE',createdAt:dateIso_(r[7])};});
  return {ok:true,notifications:notifications,unreadCount:notifications.filter(function(n){return !n.isRead;}).length};
}
function markMyNotificationRead(token, notificationId) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);notificationId=String(notificationId||'').trim();if(!notificationId)throw new Error('Notifikasi tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const sheet=getSS_().getSheetByName('Notifikasi');const row=findRowById_(sheet,notificationId,1);if(!row||String(row.values[1]||'')!==String(session.userId))throw new Error('Notifikasi tidak ditemukan.');if(row.values[6]!==true&&String(row.values[6]).toUpperCase()!=='TRUE')sheet.getRange(row.rowNumber,7).setValue(true);SpreadsheetApp.flush();return {ok:true};}finally{lock.releaseLock();}
}
function markAllMyNotificationsRead(token) {
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const sheet=getSS_().getSheetByName('Notifikasi');const rows=readRows_(sheet);let changed=0;rows.forEach(function(r,i){if(String(r[1]||'')===String(session.userId)&&r[6]!==true&&String(r[6]).toUpperCase()!=='TRUE'){sheet.getRange(i+2,7).setValue(true);changed++;}});SpreadsheetApp.flush();return {ok:true,updated:changed};}finally{lock.releaseLock();}
}
/** Fase 4: pesanan dan pembayaran Wali Santri. */
/** Dashboard ringkas Wali: hanya membaca pesanan dan relasi milik sesi aktif. */
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
    const child = childMap[String(row[3])] || {name:'Santri',className:''};
    return {
      orderId:orderId,
      number:String(row[1] || ''),
      childName:String(child.name || ''),
      className:String(child.className || ''),
      total:Number(row[7]) || 0,
      status:status,
      paymentStatus:payment ? payment.status : '',
      createdAt:dateIso_(row[10])
    };
  });

  // Hitung ringkasan seluruh pesanan, bukan hanya lima pesanan terbaru.
  summary.activeOrders = 0;
  summary.unpaidOrders = 0;
  summary.awaitingPaymentVerification = 0;
  summary.rejectedPayments = 0;
  summary.completedOrders = 0;
  summary.cancelledOrders = 0;
  orderRows.forEach(function(row){
    const status = String(row[8] || '');
    const payment = paymentMap[String(row[0])] || null;
    if (status === 'MENUNGGU_PEMBAYARAN' && (!payment || payment.status === 'DITOLAK')) summary.unpaidOrders++;
    if (['DIBAYAR','DIPROSES','DISIAPKAN','DIANTAR'].indexOf(status) !== -1) summary.activeOrders++;
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

function getMyOrders(token) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const orderRows = readRows_(ss.getSheetByName('Pesanan'))
    .filter(function(r){ return String(r[2]) === String(session.userId); })
    .sort(function(a,b){ return new Date(b[10] || 0).getTime() - new Date(a[10] || 0).getTime(); });
  const santriMap = {};
  getChildrenForWali_(ss, session.userId).forEach(function(c){ santriMap[String(c.id)] = c; });
  const paymentRows = readRows_(ss.getSheetByName('Pembayaran'));
  const shipmentRows = readRows_(ss.getSheetByName('Pengiriman'));
  const result = orderRows.map(function(r){
    const payment = latestPaymentForOrder_(paymentRows, String(r[0]));
    const shipment = latestShipmentForOrder_(shipmentRows, String(r[0]));
    const child = santriMap[String(r[3])] || {id:String(r[3]),name:'Anak',className:''};
    return {
      orderId:String(r[0]), number:String(r[1]), santriId:String(r[3]), childName:String(child.name || ''), className:String(child.className || ''),
      subtotal:Number(r[4])||0, shipping:Number(r[5])||0, discount:Number(r[6])||0, total:Number(r[7])||0,
      status:String(r[8]||''), note:String(r[9]||''), createdAt:dateIso_(r[10]), updatedAt:dateIso_(r[11]),
      payment:payment ? {id:payment.id,method:payment.method,nominal:payment.nominal,status:payment.status,buktiUrl:payment.buktiUrl,buktiSumber:payment.buktiSumber,submittedBy:payment.submittedBy,catatan:payment.catatan,createdAt:dateIso_(payment.createdAt)} : null,
      shipment:shipment ? {id:shipment.id,method:shipment.method,destination:shipment.destination,status:shipment.status,updatedAt:dateIso_(shipment.updatedAt)} : null
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
  const child = assertWaliChild_(ss, session.userId, String(r[3]));
  const details = readRows_(ss.getSheetByName('DetailPesanan')).filter(function(d){ return String(d[1]) === orderId; }).map(function(d){
    return {id:String(d[0]),productId:String(d[2]),variationId:String(d[3]||''),sku:String(d[4]||''),name:String(d[5]||''),variationName:String(d[6]||''),price:Number(d[7])||0,qty:Number(d[8])||0,subtotal:Number(d[9])||0};
  });
  const paymentRows = readRows_(ss.getSheetByName('Pembayaran'));
  const shipmentRows = readRows_(ss.getSheetByName('Pengiriman'));
  const payment = latestPaymentForOrder_(paymentRows, orderId);
  const shipment = latestShipmentForOrder_(shipmentRows, orderId);
  return {ok:true,order:{orderId:String(r[0]),number:String(r[1]),santriId:String(r[3]),childName:String(child.name||''),className:String(child.className||''),subtotal:Number(r[4])||0,shipping:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,status:String(r[8]||''),note:String(r[9]||''),createdAt:dateIso_(r[10]),updatedAt:dateIso_(r[11]),details:details,payment:payment?{id:payment.id,method:payment.method,nominal:payment.nominal,status:payment.status,buktiUrl:payment.buktiUrl,buktiSumber:payment.buktiSumber,submittedBy:payment.submittedBy,catatan:payment.catatan,createdAt:dateIso_(payment.createdAt),verifiedAt:dateIso_(payment.verifiedAt)}:null,shipment:shipment?{id:shipment.id,method:shipment.method,destination:shipment.destination,status:shipment.status,dikirimAt:dateIso_(shipment.dikirimAt),diterimaAt:dateIso_(shipment.diterimaAt),updatedAt:dateIso_(shipment.updatedAt)}:null}};
}


/** Detail pesanan untuk operasional internal. Tidak mengekspos bukti pembayaran ke role selain Kasir/Superadmin. */
function getOperationsOrderDetail(token, orderId) {
  const session = requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.KASIR, FMART.ROLES.GUDANG, FMART.ROLES.SUPERADMIN]);
  orderId = String(orderId || '').trim();
  if (!orderId) throw new Error('Pesanan tidak valid.');
  const ss = getSS_();
  const orderRow = findRowById_(ss.getSheetByName('Pesanan'), orderId, 1);
  if (!orderRow) throw new Error('Pesanan tidak ditemukan.');
  const r = orderRow.values;
  const details = readRows_(ss.getSheetByName('DetailPesanan')).filter(function(d){ return String(d[1]) === orderId; }).map(function(d){
    return {id:String(d[0]),productId:String(d[2]),variationId:String(d[3]||''),sku:String(d[4]||''),name:String(d[5]||''),variationName:String(d[6]||''),price:Number(d[7])||0,qty:Number(d[8])||0,subtotal:Number(d[9])||0};
  });
  const santriMap = getSantriColumnMap_(ss.getSheetByName('Santri'));
  const santri = findSantriRowById_(ss.getSheetByName('Santri'), String(r[3]));
  const santriData = santri ? santriRecord_(santri.values, santriMap) : null;
  const payments = readRows_(ss.getSheetByName('Pembayaran')).filter(function(p){return String(p[1])===orderId;}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();});
  const payment = payments.length ? {status:String(payments[0][5]||''),method:String(payments[0][2]||''),nominal:Number(payments[0][3])||0,verifiedAt:dateIso_(payments[0][7])} : null;
  const shipments = readRows_(ss.getSheetByName('Pengiriman')).filter(function(sh){return String(sh[1])===orderId;}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();});
  const shipment = shipments.length ? {status:String(shipments[0][4]||''),method:String(shipments[0][2]||''),destination:String(shipments[0][3]||'')} : null;
  return {ok:true,order:{orderId:String(r[0]),number:String(r[1]),santriId:String(r[3]),childName:santriData?santriData.name:'Anak',className:santriData?santriData.className:'',subtotal:Number(r[4])||0,shipping:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,status:String(r[8]||''),note:String(r[9]||''),createdAt:dateIso_(r[10]),updatedAt:dateIso_(r[11]),payment:payment,shipment:shipment,details:details}};
}

function submitPayment(token, orderId, method, nominal, fileName, mimeType, base64Data) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  orderId = String(orderId || '').trim();
  method = String(method || '').trim().toUpperCase();
  nominal = Math.round(Number(nominal));
  if (!orderId || method !== 'QRIS' || !Number.isFinite(nominal) || nominal < 1) throw new Error('FMart hanya menerima pembayaran QRIS.');
  if (!base64Data) throw new Error('Bukti pembayaran QRIS wajib diunggah.');
  if (!/^https:\/\//i.test(getSettingValue_('PAYMENT_QRIS_IMAGE_URL'))) throw new Error('QRIS FMart belum dikonfigurasi.');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const ss = getSS_();
    const orderRow = findRowById_(ss.getSheetByName('Pesanan'), orderId, 1);
    if (!orderRow || String(orderRow.values[2]) !== String(session.userId)) throw new Error('Pesanan tidak ditemukan.');
    const order = orderRow.values;
    if (String(order[8] || '').toUpperCase() !== 'MENUNGGU_PEMBAYARAN') throw new Error('Pesanan tidak sedang menunggu pembayaran.');
    const total = Math.round(Number(order[7]) || 0);
    if (nominal !== total) throw new Error('Nominal pembayaran harus tepat Rp ' + total.toLocaleString('id-ID') + '.');
    const paymentSheet = ss.getSheetByName('Pembayaran');
    const existing = readRows_(paymentSheet).filter(function(r){ return String(r[1]) === orderId; }).sort(function(a,b){ return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime(); })[0];
    if (existing && ['MENUNGGU_VERIFIKASI','TERVERIFIKASI'].indexOf(String(existing[5]||'').toUpperCase()) !== -1) throw new Error('Pembayaran untuk pesanan ini sudah diajukan.');
    const cleanName = sanitizeFileName_(fileName || 'bukti-qris');
    const mime = String(mimeType || '').toLowerCase();
    if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)) throw new Error('Format bukti pembayaran harus JPG, PNG, WEBP, atau PDF.');
    const raw = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    const bytes = Utilities.base64Decode(raw);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Ukuran bukti pembayaran maksimal 5 MB.');
    const folder = getPaymentProofFolder_();
    const file = folder.createFile(Utilities.newBlob(bytes, mime, orderId + '-' + cleanName));
    const buktiUrl = file.getUrl();
    const now = new Date();
    const paymentId = makeFMartId_('PAY');
    paymentSheet.appendRow([paymentId,orderId,'QRIS',nominal,buktiUrl,'MENUNGGU_VERIFIKASI','','',now,now,'APLIKASI',session.userId,'']);
    writeAudit_(session.userId,session.role,'SUBMIT_PAYMENT','PEMBAYARAN',paymentId,'',JSON.stringify({orderId:orderId,method:'QRIS',nominal:nominal,hasProof:true,buktiSumber:'APLIKASI'}),'Pengajuan pembayaran QRIS dengan bukti');
    SpreadsheetApp.flush();
    return getOrderDetail(token, orderId);
  } finally { lock.releaseLock(); }
}
function getPaymentSettings(token) {
  requireSession_(token);
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
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  orderId = String(orderId || '').trim();
  if (!orderId) throw new Error('Pesanan tidak valid.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const ss = getSS_();
    const orderSheet = ss.getSheetByName('Pesanan');
    const orderRow = findRowById_(orderSheet, orderId, 1);
    if (!orderRow || String(orderRow.values[2]) !== String(session.userId)) throw new Error('Pesanan tidak ditemukan.');
    if (String(orderRow.values[8] || '').toUpperCase() !== 'DIANTAR') throw new Error('Pesanan belum berada pada status dapat diterima.');
    const now = new Date();
    orderSheet.getRange(orderRow.rowNumber, 9, 1, 3).setValues([['DITERIMA',orderRow.values[9],now]]);
    const shipSheet = ss.getSheetByName('Pengiriman');
    const shipRow = latestShipmentRow_(shipSheet, orderId);
    if (shipRow) shipSheet.getRange(shipRow, 6, 1, 4).setValues([[shipSheet.getRange(shipRow,6).getValue(),now,session.userId,now]]);
    ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),session.userId,orderId,'Pesanan diterima','Pesanan '+String(orderRow.values[1])+' telah diterima.','PESANAN',false,now]);
    writeAudit_(session.userId,session.role,'RECEIVE_ORDER','PESANAN',orderId,JSON.stringify({status:'DIANTAR'}),JSON.stringify({status:'DITERIMA'}),'Pesanan diterima Wali Santri');
    SpreadsheetApp.flush();
    return getOrderDetail(token, orderId);
  } finally { lock.releaseLock(); }
}


/** Fase 5: operasi internal FMart. Semua otorisasi dilakukan di server. */
function getOperationsDashboard(token) {
  const session = requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.KASIR, FMART.ROLES.GUDANG, FMART.ROLES.SUPERADMIN]);
  const ss = getSS_();
  const orders = readRows_(ss.getSheetByName('Pesanan'));
  const payments = readRows_(ss.getSheetByName('Pembayaran'));
  const shipments = readRows_(ss.getSheetByName('Pengiriman'));
  const users = readRows_(ss.getSheetByName('Users'));
  const santri = readSantriRows_(ss.getSheetByName('Santri'));
  const products = readRows_(ss.getSheetByName('Produk'));
  const stockRows = readRows_(ss.getSheetByName('Stok'));
  const cats = readRows_(ss.getSheetByName('Kategori'));
  const variationRows = readRows_(ss.getSheetByName('VariasiProduk'));
  const userMap = {}; users.forEach(r => userMap[String(r[0])] = {name:String(r[4]||''),username:String(r[1]||'')});
  const santriMap = getSantriColumnMap_(ss.getSheetByName('Santri'));
  const childMap = {}; santri.forEach(r => { const child = santriRecord_(r,santriMap); if(child.id) childMap[child.id] = {name:child.name,className:child.className}; });
  const paymentMap = {}; payments.forEach(r => { const id=String(r[1]); const old=paymentMap[id]; if(!old || new Date(r[8]||0).getTime()>new Date(old[8]||0).getTime()) paymentMap[id]=r; });
  const shipMap = {}; shipments.forEach(r => { const id=String(r[1]); const old=shipMap[id]; if(!old || new Date(r[8]||0).getTime()>new Date(old[8]||0).getTime()) shipMap[id]=r; });
  const stockMap = {};
  stockRows.forEach(r => { const key=String(r[1])+'|'+String(r[2]||''); stockMap[key]=Number(r[3])||0; });
  variationRows.forEach(r => { const key=String(r[1])+'|'+String(r[0]); if(stockMap[key]===undefined) stockMap[key]=Number(r[5])||0; });
  const productMap = {}; products.forEach(r => productMap[String(r[0])] = {id:String(r[0]),categoryId:String(r[1]||''),sku:String(r[2]||''),name:String(r[3]||''),price:Number(r[5])||0,status:String(r[8]||''),photoUrl:String(r[7]||'')});
  const categoryMap = {}; cats.forEach(r => categoryMap[String(r[0])] = String(r[1]||''));
  const resultOrders = orders.slice().sort((a,b)=>new Date(b[10]||0).getTime()-new Date(a[10]||0).getTime()).slice(0,60).map(r => {
    const pay=paymentMap[String(r[0])], ship=shipMap[String(r[0])], child=childMap[String(r[3])], wali=userMap[String(r[2])];
    return {orderId:String(r[0]),number:String(r[1]),waliName:wali?wali.name:'-',childName:child?child.name:'-',className:child?child.className:'-',total:Number(r[7])||0,status:String(r[8]||''),createdAt:dateIso_(r[10]),payment:pay?{id:String(pay[0]),method:String(pay[2]||''),nominal:Number(pay[3])||0,status:String(pay[5]||''),buktiUrl:([FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.SUPERADMIN].indexOf(session.role)>=0?String(pay[4]||''):'')} : null,shipment:ship?{status:String(ship[4]||''),method:String(ship[2]||''),destination:String(ship[3]||'')} : null};
  });
  let lowStock=0;
  const productStock = products.map(r => {
    const pid=String(r[0]); const vars=variationRows.filter(v=>String(v[1])===pid && String(v[6]||'').toUpperCase()==='AKTIF');
    let qty=0; if(vars.length) vars.forEach(v=>qty += Math.max(0,Number(stockMap[pid+'|'+String(v[0])])||0)); else qty=Math.max(0,Number(stockMap[pid+'|'])||0);
    const min=Number(r[6])||0; if(qty<=min) lowStock++;
    return {id:pid,name:String(r[3]||''),sku:String(r[2]||''),categoryName:categoryMap[String(r[1])]||'-',stock:qty,minStock:min,status:String(r[8]||'')};
  });
  const pendingVerification=payments.filter(r=>String(r[5]||'').toUpperCase()==='MENUNGGU_VERIFIKASI').length;
  const countStatus=st=>orders.filter(r=>String(r[8]||'').toUpperCase()===st).length;
  return {ok:true,user:{userId:session.userId,nama:session.nama,role:session.role},stats:{pendingVerification:pendingVerification,menungguPembayaran:countStatus('MENUNGGU_PEMBAYARAN'),dibayar:countStatus('DIBAYAR'),diproses:countStatus('DIPROSES'),disiapkan:countStatus('DISIAPKAN'),diantar:countStatus('DIANTAR'),diterima:countStatus('DITERIMA'),activeProducts:products.filter(r=>String(r[8]||'').toUpperCase()==='AKTIF').length,lowStock:lowStock,categories:cats.filter(r=>String(r[4]||'').toUpperCase()==='AKTIF').length},categories:cats.map(r=>({id:String(r[0]),name:String(r[1]||''),description:String(r[2]||''),order:Number(r[3])||0,status:String(r[4]||'')})),orders:resultOrders,products:productStock};
}




/** Tahap 6: riwayat pemenuhan, mutasi stok, dan penerimaan khusus Gudang. */
function getWarehouseHistoryReport(token, startDate, endDate) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const parseDay=function(value,endOfDay){
    const text=String(value||'').trim();
    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(text))throw new Error('Format periode laporan tidak valid.');
    const p=text.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2],endOfDay?23:0,endOfDay?59:0,endOfDay?59:0,endOfDay?999:0);
    if(d.getFullYear()!==p[0]||d.getMonth()!==p[1]-1||d.getDate()!==p[2])throw new Error('Tanggal laporan tidak valid.');
    return d;
  };
  const start=parseDay(startDate,false),end=parseDay(endDate,true);
  if(end<start)throw new Error('Tanggal akhir tidak boleh lebih awal dari tanggal mulai.');
  const inRange=function(value){const d=value instanceof Date?value:new Date(value||0);const t=d.getTime();return Number.isFinite(t)&&t>=start.getTime()&&t<=end.getTime();};
  const ss=getSS_();
  const users=readRows_(ss.getSheetByName('Users')),userMap={};
  users.forEach(function(r){userMap[String(r[0])]=String(r[4]||r[1]||'-');});
  const orders=readRows_(ss.getSheetByName('Pesanan')),orderMap={};
  orders.forEach(function(r){orderMap[String(r[0])]={number:String(r[1]||r[0]),childId:String(r[3]||''),status:String(r[8]||'')};});
  const santriSheet=ss.getSheetByName('Santri'),santriMap=getSantriColumnMap_(santriSheet),santriNames={};
  readSantriRows_(santriSheet).forEach(function(r){const c=santriRecord_(r,santriMap);if(c.id)santriNames[c.id]=c.name;});
  const auditRows=readRows_(ss.getSheetByName('AuditLog'));
  const orderHistory=auditRows.filter(function(r){return String(r[3]||'').toUpperCase()==='UPDATE_ORDER_STATUS'&&String(r[4]||'').toUpperCase()==='PESANAN'&&inRange(r[9]);}).map(function(r){
    let before={},after={};try{before=JSON.parse(String(r[6]||'{}'));}catch(e){}try{after=JSON.parse(String(r[7]||'{}'));}catch(e){}
    const order=orderMap[String(r[5]||'')]||{};
    return {id:String(r[0]||''),orderId:String(r[5]||''),orderNumber:order.number||String(r[5]||''),childName:santriNames[order.childId]||'-',fromStatus:String(before.status||'-'),toStatus:String(after.status||'-'),note:String(after.note||r[8]||''),actor:userMap[String(r[1])]||'-',role:String(r[2]||'-'),createdAt:dateIso_(r[9]),sortAt:new Date(r[9]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;});
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
  const inbound=stockHistory.filter(function(x){return x.type.toUpperCase()==='MASUK';}).reduce(function(n,x){return n+x.qty;},0);
  const outbound=stockHistory.filter(function(x){return x.type.toUpperCase()==='KELUAR';}).reduce(function(n,x){return n+x.qty;},0);
  const counts={};orderHistory.forEach(function(x){counts[x.toStatus]=(counts[x.toStatus]||0)+1;});
  const clean=function(rows){return rows.slice(0,500).map(function(x){delete x.sortAt;return x;});};
  return {ok:true,period:{start:startDate,end:endDate},summary:{orderChanges:orderHistory.length,receipts:receivingHistory.length,stockMutations:stockHistory.length,inboundQty:inbound,outboundQty:outbound,orderStageChanges:counts},orderHistory:clean(orderHistory),stockHistory:clean(stockHistory),receivingHistory:clean(receivingHistory),limits:{orderHistory:500,stockHistory:500,receivingHistory:500}};
}

/** Fase 6: laporan operasional terhitung dari data transaksi aktual. */
function getFMartReports(token, startDate, endDate) {
  const session = requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const start=parseReportDate_(startDate,false), end=parseReportDate_(endDate,true);
  if(end<start) throw new Error('Periode laporan tidak valid.');
  const orders=readRows_(ss.getSheetByName('Pesanan')).filter(r=>inReportRange_(r[10],start,end));
  const details=readRows_(ss.getSheetByName('DetailPesanan'));
  const allPayments=readRows_(ss.getSheetByName('Pembayaran'));
  const payments=allPayments.filter(r=>inReportRange_(r[8],start,end));
  const santri=readSantriRows_(ss.getSheetByName('Santri')); const users=readRows_(ss.getSheetByName('Users')); const products=readRows_(ss.getSheetByName('Produk')); const cats=readRows_(ss.getSheetByName('Kategori')); const mutasi=readRows_(ss.getSheetByName('MutasiStok')).filter(r=>inReportRange_(r[10],start,end));
  const santriMap=getSantriColumnMap_(ss.getSheetByName('Santri'));
  const childMap={};santri.forEach(r=>{const child=santriRecord_(r,santriMap);if(child.id)childMap[child.id]=child.name;});
  const userMap={};users.forEach(r=>userMap[String(r[0])]=String(r[4]||''));
  const productMap={};products.forEach(r=>productMap[String(r[0])]=String(r[3]||''));
  const catMap={};cats.forEach(r=>catMap[String(r[0])]=String(r[1]||''));
  const paidOrderIds={};allPayments.forEach(r=>{if(String(r[5]||'').toUpperCase()==='TERVERIFIKASI')paidOrderIds[String(r[1])]=true;});
  const statusCounts={}; orders.forEach(r=>{const st=String(r[8]||'').toUpperCase();statusCounts[st]=(statusCounts[st]||0)+1;});
  const salesOrders=orders.filter(r=>String(r[8]||'').toUpperCase()!=='DIBATALKAN');
  const gross=salesOrders.reduce((n,r)=>n+(Number(r[7])||0),0);
  const paid=salesOrders.filter(r=>paidOrderIds[String(r[0])]).reduce((n,r)=>n+(Number(r[7])||0),0);
  const categorySales={}; const productSales={};
  details.forEach(d=>{const order=orders.find(o=>String(o[0])===String(d[1])); if(!order || String(order[8]||'').toUpperCase()==='DIBATALKAN') return; const qty=Math.max(0,Number(d[8])||0), sub=Math.max(0,Number(d[9])||0), pid=String(d[2]||''), p=products.find(x=>String(x[0])===pid); const cat=p?String(p[1]||''):''; const cn=catMap[cat]||'Tanpa Kategori'; categorySales[cn]=(categorySales[cn]||0)+sub; const pn=productMap[pid]||String(d[5]||'Produk'); if(!productSales[pn])productSales[pn]={name:pn,qty:0,amount:0}; productSales[pn].qty+=qty;productSales[pn].amount+=sub;});
  const paymentMethods={}; payments.filter(r=>String(r[5]||'').toUpperCase()==='TERVERIFIKASI').forEach(r=>{const m=String(r[2]||'Lainnya');paymentMethods[m]=(paymentMethods[m]||0)+(Number(r[3])||0);});
  const stockIn=mutasi.filter(r=>String(r[3]||'').toUpperCase()==='MASUK').reduce((n,r)=>n+(Number(r[4])||0),0);
  const stockOut=mutasi.filter(r=>String(r[3]||'').toUpperCase()==='KELUAR').reduce((n,r)=>n+(Number(r[4])||0),0);
  const daily={}; orders.forEach(r=>{if(String(r[8]||'').toUpperCase()==='DIBATALKAN')return;const key=formatReportDay_(r[10]);if(!daily[key])daily[key]={date:key,orders:0,amount:0};daily[key].orders++;daily[key].amount+=Number(r[7])||0;});
  const topProducts=Object.keys(productSales).map(k=>productSales[k]).sort((a,b)=>b.amount-a.amount).slice(0,10);
  return {ok:true,period:{start:start.toISOString(),end:end.toISOString()},summary:{orders:orders.length,activeOrders:orders.filter(r=>!['DITERIMA','DIBATALKAN'].includes(String(r[8]||'').toUpperCase())).length,gross:gross,paid:paid,unpaid:Math.max(0,gross-paid),averageOrder:salesOrders.length?Math.round(gross/salesOrders.length):0,stockIn:stockIn,stockOut:stockOut},statusCounts:statusCounts,categorySales:Object.keys(categorySales).map(k=>({name:k,amount:categorySales[k]})).sort((a,b)=>b.amount-a.amount),paymentMethods:Object.keys(paymentMethods).map(k=>({name:k,amount:paymentMethods[k]})).sort((a,b)=>b.amount-a.amount),daily:Object.keys(daily).sort().map(k=>daily[k]),topProducts:topProducts,generatedAt:new Date().toISOString(),generatedBy:{userId:session.userId,nama:session.nama}};
}

/** Laporan audit untuk Admin/Superadmin. Hanya metadata aman yang dikirim ke UI; BeforeData/AfterData tidak diekspos. */
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
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(text)) throw new Error('Tanggal laporan tidak valid.');
  const parts=text.split('-').map(Number); const d=new Date(parts[0],parts[1]-1,parts[2],endOfDay?23:0,endOfDay?59:0,endOfDay?59:0,endOfDay?999:0);
  if(isNaN(d.getTime())) throw new Error('Tanggal laporan tidak valid.'); return d;
}
function inReportRange_(value,start,end){if(!value)return false;const t=new Date(value).getTime();return isFinite(t)&&t>=start.getTime()&&t<=end.getTime();}
function formatReportDay_(value){const d=new Date(value);return Utilities.formatDate(d,Session.getScriptTimeZone()||'Asia/Jakarta','yyyy-MM-dd');}

/** Fase 6: status koneksi integrasi Tabungan. Tidak menulis ke sistem eksternal. */
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
  requireRole_(token, [FMART.ROLES.ADMIN, FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const categories=readRows_(ss.getSheetByName('Kategori')).map(r=>({id:String(r[0]),name:String(r[1]||''),description:String(r[2]||''),order:Number(r[3])||0,status:String(r[4]||'')}));
  const products=readRows_(ss.getSheetByName('Produk')).map(r=>({id:String(r[0]),categoryId:String(r[1]||''),sku:String(r[2]||''),name:String(r[3]||''),description:String(r[4]||''),price:Number(r[5])||0,minStock:Number(r[6])||0,photoUrl:String(r[7]||''),status:String(r[8]||'')}));
  const variations=readRows_(ss.getSheetByName('VariasiProduk')).map(r=>({id:String(r[0]),productId:String(r[1]),name:String(r[2]||''),value:String(r[3]||''),priceAddition:Number(r[4])||0,stock:Number(r[5])||0,status:String(r[6]||'')}));
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

function saveProduct(token, data) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
  if(!data || typeof data!=='object') throw new Error('Data produk tidak valid.');
  const id=String(data.id||'').trim(), categoryId=String(data.categoryId||'').trim(), sku=String(data.sku||'').trim().slice(0,60), name=String(data.name||'').trim().slice(0,150), description=String(data.description||'').trim().slice(0,1000), price=Math.round(Number(data.price)), minStock=Math.max(0,Math.floor(Number(data.minStock)||0)), photoUrl=String(data.photoUrl||'').trim().slice(0,500), status=String(data.status||'AKTIF').toUpperCase();
  if(!categoryId||!name||!sku||!Number.isFinite(price)||price<0)throw new Error('Data produk belum lengkap.');
  if(!/^https?:\/\//i.test(photoUrl) && photoUrl) throw new Error('Foto produk harus berupa URL http/https.');
  const cat=findRowById_(getSS_().getSheetByName('Kategori'),categoryId,1); if(!cat || String(cat.values[4]).toUpperCase()!=='AKTIF') throw new Error('Kategori tidak tersedia.');
  if(['AKTIF','NONAKTIF'].indexOf(status)<0)throw new Error('Status produk tidak valid.');
  const sheet=getSS_().getSheetByName('Produk'); const now=new Date();
  const rows=readRows_(sheet); if(rows.some(r=>String(r[2]).toLowerCase()===sku.toLowerCase() && String(r[0])!==id))throw new Error('SKU sudah digunakan.');
  if(id){const row=findRowById_(sheet,id,1);if(!row)throw new Error('Produk tidak ditemukan.');const before=JSON.stringify(row.values);sheet.getRange(row.rowNumber,2,1,9).setValues([[categoryId,sku,name,description,price,minStock,photoUrl,status,now]]);writeAudit_(session.userId,session.role,'UPDATE_PRODUCT','PRODUK',id,before,JSON.stringify({categoryId,sku,name,description,price,minStock,photoUrl,status}),'Perubahan produk');}
  else {const newId=makeFMartId_('PRD');sheet.appendRow([newId,categoryId,sku,name,description,price,minStock,photoUrl,status,now,now]);writeAudit_(session.userId,session.role,'CREATE_PRODUCT','PRODUK',newId,'',JSON.stringify({categoryId,sku,name,description,price,minStock,photoUrl,status}),'Produk baru');}
  SpreadsheetApp.flush(); return getAdminCatalog(token);
  } finally { lock.releaseLock(); }
}

function saveVariation(token, data) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
  if(!data||typeof data!=='object')throw new Error('Data variasi tidak valid.');
  const id=String(data.id||'').trim(), productId=String(data.productId||'').trim(), name=String(data.name||'').trim().slice(0,80), value=String(data.value||'').trim().slice(0,100), addition=Math.round(Number(data.priceAddition)||0), requestedStock=Math.max(0,Math.floor(Number(data.stock)||0)), status=String(data.status||'AKTIF').toUpperCase();
  if(!productId||!name||!value||addition<0)throw new Error('Data variasi belum lengkap.'); if(['AKTIF','NONAKTIF'].indexOf(status)<0)throw new Error('Status variasi tidak valid.');
  const ss=getSS_(); const product=findRowById_(ss.getSheetByName('Produk'),productId,1); if(!product)throw new Error('Produk tidak ditemukan.');
  const sheet=ss.getSheetByName('VariasiProduk'); const now=new Date(); let variationId=id; let stock=requestedStock;
  let beforeData=''; if(id){const row=findRowById_(sheet,id,1);if(!row)throw new Error('Variasi tidak ditemukan.');beforeData=JSON.stringify(row.values);variationId=id;stock=Math.max(0,Number(row.values[5])||0);sheet.getRange(row.rowNumber,2,1,7).setValues([[productId,name,value,addition,stock,status,now]]);}
  else {variationId=makeFMartId_('VAR');sheet.appendRow([variationId,productId,name,value,addition,stock,status,now,now]);}
  upsertStockRow_(ss,productId,variationId,stock,session.userId);
  writeAudit_(session.userId,session.role,id?'UPDATE_VARIATION':'CREATE_VARIATION','VARIASI_PRODUK',variationId,beforeData,JSON.stringify({productId,name,value,addition,stock,status}),'Perubahan variasi; stok hanya ditetapkan saat membuat variasi');
  SpreadsheetApp.flush();
  return getAdminCatalog(token);
  } finally { lock.releaseLock(); }
}

function ensureReceivingSheets_(ss) {
  const definitions=[
    {name:'PenerimaanBarang',headers:['PenerimaanId','NomorPenerimaan','Pemasok','ReferensiDokumen','TanggalTerima','Catatan','JumlahBaris','TotalQty','CreatedBy','CreatedAt']},
    {name:'DetailPenerimaanBarang',headers:['DetailPenerimaanId','PenerimaanId','ProdukId','VariasiId','Qty','StokSebelum','StokSesudah','Catatan']}
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
  const ss=getSS_();ensureReceivingSheets_(ss);
  const products=getStockCatalog(token).products;
  const productRows=readRows_(ss.getSheetByName('Produk')),variationRows=readRows_(ss.getSheetByName('VariasiProduk'));
  const userRows=readRows_(ss.getSheetByName('Users')),users={};
  userRows.forEach(function(r){users[String(r[0])]=String(r[4]||r[1]||'-');});
  const pmap={};productRows.forEach(function(r){pmap[String(r[0])]=r;});
  const receipts=readRows_(ss.getSheetByName('PenerimaanBarang')).slice(-50).reverse().map(function(r){
    const receiptId=String(r[0]||'');
    const details=readRows_(ss.getSheetByName('DetailPenerimaanBarang')).filter(function(d){return String(d[1])===receiptId;});
    return {id:receiptId,number:String(r[1]||''),supplier:String(r[2]||''),reference:String(r[3]||''),receivedAt:r[4] instanceof Date?r[4].toISOString():String(r[4]||''),note:String(r[5]||''),lineCount:Number(r[6])||details.length,totalQty:Number(r[7])||0,actor:users[String(r[8])]||'-',createdAt:r[9] instanceof Date?r[9].toISOString():String(r[9]||''),items:details.map(function(d){const p=pmap[String(d[2])],v=variationRows.find(function(x){return String(x[0])===String(d[3]);});return {productName:p?String(p[3]||''):'Produk tidak ditemukan',variationName:v?[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': '):'',qty:Number(d[4])||0,before:Number(d[5])||0,after:Number(d[6])||0,note:String(d[7]||'')};})};
  });
  return {ok:true,products:products,receipts:receipts};
}

function createStockReceipt(token, payload) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  payload=payload&&typeof payload==='object'?payload:{};
  const supplier=String(payload.supplier||'').trim().slice(0,120);
  const reference=String(payload.reference||'').trim().slice(0,100);
  const note=String(payload.note||'').trim().slice(0,500);
  const receivedDate=String(payload.receivedDate||'').trim();
  const rawItems=Array.isArray(payload.items)?payload.items:[];
  if(!supplier)throw new Error('Nama pemasok atau asal barang wajib diisi.');
  if(rawItems.length<1||rawItems.length>100)throw new Error('Tambahkan minimal satu item penerimaan dan maksimal 100 baris.');
  let receivedAt=new Date();
  if(receivedDate){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate))throw new Error('Tanggal penerimaan tidak valid.');
    const parts=receivedDate.split('-').map(Number);receivedAt=new Date(parts[0],parts[1]-1,parts[2],12,0,0);
    if(isNaN(receivedAt.getTime())||receivedAt.getFullYear()!==parts[0]||receivedAt.getMonth()!==parts[1]-1||receivedAt.getDate()!==parts[2])throw new Error('Tanggal penerimaan tidak valid.');
  }
  const grouped={};
  rawItems.forEach(function(item){
    const productId=String(item&&item.productId||'').trim(),variationId=String(item&&item.variationId||'').trim(),qty=Number(item&&item.qty);
    if(!productId||!Number.isInteger(qty)||qty<1)throw new Error('Setiap item harus memiliki produk dan jumlah bilangan bulat minimal 1.');
    const key=productId+'|'+variationId;
    if(!grouped[key])grouped[key]={productId:productId,variationId:variationId,qty:0};
    grouped[key].qty+=qty;
    if(!Number.isSafeInteger(grouped[key].qty))throw new Error('Jumlah penerimaan terlalu besar.');
  });
  const items=Object.keys(grouped).map(function(k){return grouped[k];});
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_();ensureReceivingSheets_(ss);
    const productSheet=ss.getSheetByName('Produk'),variationSheet=ss.getSheetByName('VariasiProduk'),stockSheet=ss.getSheetByName('Stok');
    const productRows=readRows_(productSheet),variationRows=readRows_(variationSheet),stockRows=readRows_(stockSheet);
    const prepared=items.map(function(item){
      const product=productRows.find(function(r){return String(r[0])===item.productId;});
      if(!product||String(product[8]||'').toUpperCase()!=='AKTIF')throw new Error('Produk tidak ditemukan atau tidak aktif.');
      const activeVariations=variationRows.filter(function(v){return String(v[1])===item.productId&&String(v[6]||'').toUpperCase()==='AKTIF';});
      if(activeVariations.length&&!item.variationId)throw new Error('Pilih variasi untuk produk '+String(product[3]||'')+'.');
      let variation=null;
      if(item.variationId){variation=variationRows.find(function(v){return String(v[0])===item.variationId&&String(v[1])===item.productId;});if(!variation||String(variation[6]||'').toUpperCase()!=='AKTIF')throw new Error('Variasi tidak valid atau tidak aktif untuk produk '+String(product[3]||'')+'.');}
      const stockIndex=stockRows.findIndex(function(r){return String(r[1])===item.productId&&String(r[2]||'')===item.variationId;});
      const before=stockIndex>=0?Math.max(0,Number(stockRows[stockIndex][3])||0):(variation?Math.max(0,Number(variation[5])||0):0);
      const after=before+item.qty;
      if(!Number.isSafeInteger(after))throw new Error('Hasil stok terlalu besar.');
      return {productId:item.productId,variationId:item.variationId,qty:item.qty,product:product,variation:variation,stockIndex:stockIndex,before:before,after:after};
    });
    const now=new Date(),receiptId=makeFMartId_('RCV'),receiptNumber='PN-'+Utilities.formatDate(now,Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase();
    const totalQty=prepared.reduce(function(sum,x){return sum+x.qty;},0);if(!Number.isSafeInteger(totalQty))throw new Error('Total jumlah penerimaan terlalu besar.');
    const receiptSheet=ss.getSheetByName('PenerimaanBarang'),detailSheet=ss.getSheetByName('DetailPenerimaanBarang'),mutationSheet=ss.getSheetByName('MutasiStok');
    receiptSheet.appendRow([receiptId,receiptNumber,supplier,reference,receivedAt,note,prepared.length,totalQty,session.userId,now]);
    detailSheet.getRange(detailSheet.getLastRow()+1,1,prepared.length,8).setValues(prepared.map(function(x){return [makeFMartId_('DRC'),receiptId,x.productId,x.variationId,x.qty,x.before,x.after,''];}));
    prepared.forEach(function(x){
      if(x.stockIndex>=0){stockSheet.getRange(x.stockIndex+2,4).setValue(x.after);stockSheet.getRange(x.stockIndex+2,6).setValue(now);}
      else stockSheet.appendRow([makeFMartId_('STK'),x.productId,x.variationId,x.after,Math.max(0,Number(x.product[6])||0),now]);
      if(x.variation){const row=variationRows.find(function(v){return String(v[0])===x.variationId;});const rowNumber=variationRows.indexOf(row)+2;variationSheet.getRange(rowNumber,6,1,3).setValues([[x.after,'AKTIF',now]]);}
      mutationSheet.appendRow([makeFMartId_('MUT'),x.productId,x.variationId,'MASUK',x.qty,x.before,x.after,receiptId,'Penerimaan '+receiptNumber+(note?' · '+note:''),session.userId,now]);
    });
    writeAudit_(session.userId,session.role,'CREATE_STOCK_RECEIPT','PENERIMAAN_BARANG',receiptId,'',JSON.stringify({receiptNumber:receiptNumber,supplier:supplier,reference:reference,items:prepared.map(function(x){return {productId:x.productId,variationId:x.variationId,qty:x.qty,before:x.before,after:x.after};})}),'Mencatat penerimaan barang');
    SpreadsheetApp.flush();
    return {ok:true,id:receiptId,number:receiptNumber,totalLines:prepared.length,totalQty:totalQty};
  }finally{lock.releaseLock();}
}

function getStockCatalog(token) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_(); const products=readRows_(ss.getSheetByName('Produk')).filter(r=>String(r[8]||'').toUpperCase()==='AKTIF'); const vars=readRows_(ss.getSheetByName('VariasiProduk')).filter(r=>String(r[6]||'').toUpperCase()==='AKTIF'); const stocks=readRows_(ss.getSheetByName('Stok')); 
  return {ok:true,products:products.map(p=>{const pid=String(p[0]);const vs=vars.filter(v=>String(v[1])===pid).map(v=>{const sr=stocks.find(r=>String(r[1])===pid&&String(r[2]||'')===String(v[0]));return {id:String(v[0]),name:String(v[2]||''),value:String(v[3]||''),stock:sr?Number(sr[3])||0:Number(v[5])||0};});const sr=stocks.find(r=>String(r[1])===pid&&!r[2]);return {id:pid,name:String(p[3]||''),sku:String(p[2]||''),stock:sr?Number(sr[3])||0:0,variations:vs};})};
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
  const stockMap={};stockRows.forEach(function(r){stockMap[String(r[1])+'|'+String(r[2]||'')]=r;});
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
        const qty=sr?Math.max(0,Number(sr[3])||0):Math.max(0,Number(v[5])||0);
        const min=sr&&!(sr[4] instanceof Date)&&String(sr[4]||'').trim()!==''&&Number.isFinite(Number(sr[4]))?Math.max(0,Number(sr[4])||0):baseMin;
        items.push({key:pid+'|'+vid,productId:pid,variationId:vid,name:String(p[3]||''),sku:String(p[2]||''),categoryName:categoryMap[String(p[1])]||'-',variationName:[String(v[2]||''),String(v[3]||'')].filter(Boolean).join(': '),stock:qty,minStock:min,productStatus:String(p[8]||''),variationStatus:String(v[6]||'')});
      });
    }else{
      const sr=stockMap[pid+'|'];const qty=sr?Math.max(0,Number(sr[3])||0):0;const min=sr&&!(sr[4] instanceof Date)&&String(sr[4]||'').trim()!==''&&Number.isFinite(Number(sr[4]))?Math.max(0,Number(sr[4])||0):baseMin;
      items.push({key:pid+'|',productId:pid,variationId:'',name:String(p[3]||''),sku:String(p[2]||''),categoryName:categoryMap[String(p[1])]||'-',variationName:'',stock:qty,minStock:min,productStatus:String(p[8]||''),variationStatus:''});
    }
  });
  const history=mutationRows.map(function(m){
    const pid=String(m[1]||'');const vid=String(m[2]||'');const product=productRows.find(function(p){return String(p[0])===pid;});const variation=vid?variationRows.find(function(v){return String(v[0])===vid;}):null;
    return {id:String(m[0]||''),productName:product?String(product[3]||''):'Produk tidak ditemukan',sku:product?String(product[2]||''):'-',variationName:variation?[String(variation[2]||''),String(variation[3]||'')].filter(Boolean).join(': '):'',type:String(m[3]||''),qty:Number(m[4])||0,before:Number(m[5])||0,after:Number(m[6])||0,referenceId:String(m[7]||''),note:String(m[8]||''),actor:userMap[String(m[9])]||'-',createdAt:dateIso_(m[10]),sortAt:m[10] instanceof Date?m[10].getTime():new Date(m[10]||0).getTime()};
  }).sort(function(a,b){return b.sortAt-a.sortAt;}).slice(0,100).map(function(x){delete x.sortAt;return x;});
  let totalUnits=0,lowStock=0,outOfStock=0;
  items.forEach(function(x){totalUnits+=x.stock;if(x.stock<=0)outOfStock++;else if(x.stock<=x.minStock)lowStock++;});
  return {ok:true,summary:{totalItems:items.length,totalUnits:totalUnits,lowStock:lowStock,outOfStock:outOfStock},items:items,history:history};
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
    else stockSheet.appendRow([makeFMartId_('STK'),productId,variationId,variation?Math.max(0,Number(variation.values[5])||0):0,minStock,now]);
    if(!variationId)ss.getSheetByName('Produk').getRange(product.rowNumber,7).setValue(minStock);
    writeAudit_(session.userId,session.role,'SET_STOCK_MINIMUM','STOK',productId,JSON.stringify({variationId:variationId,minStock:before}),JSON.stringify({variationId:variationId,minStock:minStock}),'Perubahan batas stok minimum');
    SpreadsheetApp.flush();return getStockManagement(token);
  }finally{lock.releaseLock();}
}

function adjustStock(token, productId, variationId, type, qty, note) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  productId=String(productId||'').trim(); variationId=String(variationId||'').trim(); type=String(type||'').toUpperCase(); qty=Number(qty); note=String(note||'').trim().slice(0,300);
  if(!productId||!Number.isSafeInteger(qty)||qty<1||['MASUK','KELUAR'].indexOf(type)<0)throw new Error('Jumlah mutasi harus berupa bilangan bulat positif dan data mutasi harus valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const ss=getSS_();const product=findRowById_(ss.getSheetByName('Produk'),productId,1);if(!product)throw new Error('Produk tidak ditemukan.');
    const activeVariations=readRows_(ss.getSheetByName('VariasiProduk')).filter(v=>String(v[1])===productId&&String(v[6]||'').toUpperCase()==='AKTIF');if(activeVariations.length&&!variationId)throw new Error('Pilih variasi produk yang akan dimutasi.');
    if(variationId){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(!vr||String(vr.values[1])!==productId||String(vr.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Variasi tidak valid atau tidak aktif.');}
    if(String(product.values[8]||'').toUpperCase()!=='AKTIF')throw new Error('Produk nonaktif tidak dapat dimutasi.');const sheet=ss.getSheetByName('Stok'),currentStockRows=readRows_(sheet);let row=currentStockRows.findIndex(r=>String(r[1])===productId&&String(r[2]||'')===variationId);const variationRow=variationId?findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1):null;const before=row>=0?Math.max(0,Number(currentStockRows[row][3])||0):(variationRow?Math.max(0,Number(variationRow.values[5])||0):0);const after=type==='MASUK'?before+qty:before-qty;if(!Number.isSafeInteger(after))throw new Error('Hasil stok tidak valid atau terlalu besar.');if(after<0)throw new Error('Stok tidak mencukupi.');const now=new Date();
    if(row>=0){sheet.getRange(row+2,4).setValue(after);sheet.getRange(row+2,6).setValue(now);}else sheet.appendRow([makeFMartId_('STK'),productId,variationId,after,Number(product.values[6])||0,now]);
    if(variationId){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(vr)ss.getRange(vr.rowNumber,6,1,3).setValues([[after,String(vr.values[6]||'AKTIF'),now]]);}
    ss.getSheetByName('MutasiStok').appendRow([makeFMartId_('MUT'),productId,variationId,type,qty,before,after,'',note,session.userId,now]);writeAudit_(session.userId,session.role,'ADJUST_STOCK','STOK',productId,JSON.stringify({variationId:variationId,stock:before}),JSON.stringify({variationId:variationId,stock:after,type:type,qty:qty}),'Mutasi stok manual');SpreadsheetApp.flush();return getOperationsDashboard(token);
  }finally{lock.releaseLock();}
}

function verifyPayment(token, paymentId, decision, note) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.SUPERADMIN]); paymentId=String(paymentId||'').trim();decision=String(decision||'').toUpperCase();note=String(note||'').trim().slice(0,300);
  if(!paymentId||['TERIMA','TOLAK'].indexOf(decision)<0)throw new Error('Keputusan pembayaran tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try{const ss=getSS_();const paySheet=ss.getSheetByName('Pembayaran');const pay=findRowById_(paySheet,paymentId,1);if(!pay)throw new Error('Pengajuan pembayaran tidak ditemukan.');if(String(pay.values[5]).toUpperCase()!=='MENUNGGU_VERIFIKASI')throw new Error('Pembayaran sudah diproses.');const orderSheet=ss.getSheetByName('Pesanan');const order=findRowById_(orderSheet,String(pay.values[1]),1);if(!order)throw new Error('Pesanan terkait tidak ditemukan.');if(String(order.values[8]).toUpperCase()!=='MENUNGGU_PEMBAYARAN')throw new Error('Status pesanan tidak sesuai.');const now=new Date();
    if(decision==='TOLAK'){paySheet.getRange(pay.rowNumber,6,1,3).setValues([['DITOLAK','','']]);paySheet.getRange(pay.rowNumber,10).setValue(now);if(note){const n=ss.getSheetByName('Notifikasi');n.appendRow([makeFMartId_('NTF'),String(order.values[2]),String(order.values[0]),'Pembayaran ditolak',note,'PEMBAYARAN',false,now]);}writeAudit_(session.userId,session.role,'REJECT_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI'}),JSON.stringify({status:'DITOLAK',note:note}),'Pembayaran ditolak');SpreadsheetApp.flush();return getOperationsDashboard(token);}
    const details=readRows_(ss.getSheetByName('DetailPesanan')).filter(r=>String(r[1])===String(order.values[0]));
    if(!details.length) throw new Error('Detail pesanan tidak ditemukan.');
    const stockSheet=ss.getSheetByName('Stok');
    const stockRows=readRows_(stockSheet);
    const groupedDetails={};
    details.forEach(function(d){
      const pid=String(d[2]||''),vid=String(d[3]||''),qty=Number(d[8]);
      if(!pid||!Number.isSafeInteger(qty)||qty<1)throw new Error('Jumlah barang pada pesanan tidak valid.');
      const key=pid+'|'+vid;
      if(!groupedDetails[key])groupedDetails[key]={d:d,pid:pid,vid:vid,qty:0};
      groupedDetails[key].qty+=qty;
      if(!Number.isSafeInteger(groupedDetails[key].qty))throw new Error('Jumlah barang pada pesanan terlalu besar.');
    });
    const stockPlan=[];
    Object.keys(groupedDetails).forEach(function(key){
      const item=groupedDetails[key],snap=getProductSnapshot_(ss,item.pid,item.vid),qty=item.qty;
      if(!snap||!snap.active||qty>Number(snap.stock))throw new Error('Stok tidak mencukupi untuk '+String(item.d[5]||'produk')+'. Pembayaran belum diterima.');
      const idx=stockRows.findIndex(function(r){return String(r[1])===item.pid&&String(r[2]||'')===item.vid;});
      if(idx<0)throw new Error('Data stok tidak ditemukan untuk '+String(item.d[5]||'produk')+'.');
      const before=Math.max(0,Number(stockRows[idx][3])||0);
      if(qty>before)throw new Error('Stok berubah dan tidak mencukupi untuk '+String(item.d[5]||'produk')+'.');
      stockPlan.push({d:item.d,idx:idx,before:before,after:before-qty,pid:item.pid,vid:item.vid,qty:qty});
    });
    for(const x of stockPlan){stockSheet.getRange(x.idx+2,4).setValue(x.after);stockSheet.getRange(x.idx+2,6).setValue(now);if(x.vid){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),x.vid,1);if(vr)ss.getSheetByName('VariasiProduk').getRange(vr.rowNumber,6,1,3).setValues([[x.after,String(vr.values[6]||'AKTIF'),now]]);}ss.getSheetByName('MutasiStok').appendRow([makeFMartId_('MUT'),x.pid,x.vid,'KELUAR',x.qty,x.before,x.after,String(order.values[0]),'Penjualan '+String(order.values[1]),session.userId,now]);}
    paySheet.getRange(pay.rowNumber,6,1,3).setValues([['TERVERIFIKASI',session.userId,now]]);paySheet.getRange(pay.rowNumber,10).setValue(now);orderSheet.getRange(order.rowNumber,9,1,3).setValues([['DIBAYAR',order.values[9],now]]);ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),String(order.values[0]),'Pembayaran terverifikasi','Pembayaran pesanan '+String(order.values[1])+' telah diverifikasi.','PEMBAYARAN',false,now]);writeAudit_(session.userId,session.role,'VERIFY_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI',orderId:String(order.values[0])}),JSON.stringify({status:'TERVERIFIKASI',orderStatus:'DIBAYAR'}),'Pembayaran diverifikasi dan stok dikurangi');SpreadsheetApp.flush();return getOperationsDashboard(token);
  }finally{lock.releaseLock();}
}

function updateOrderOperation(token, orderId, nextStatus, shipmentStatus, note) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);orderId=String(orderId||'').trim();nextStatus=String(nextStatus||'').toUpperCase();shipmentStatus=String(shipmentStatus||'').toUpperCase();note=String(note||'').trim().slice(0,300);
  const allowed=['DIBAYAR','DIPROSES','DISIAPKAN','DIANTAR','DIBATALKAN'];if(allowed.indexOf(nextStatus)<0)throw new Error('Status pesanan tidak valid.');
  if(nextStatus==='DIBATALKAN' && session.role==='GUDANG') throw new Error('Gudang tidak berwenang membatalkan pesanan.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{const ss=getSS_();const os=ss.getSheetByName('Pesanan');const row=findRowById_(os,orderId,1);if(!row)throw new Error('Pesanan tidak ditemukan.');const current=String(row.values[8]||'').toUpperCase();const orderFlow={DIBAYAR:['DIPROSES'],DIPROSES:['DISIAPKAN'],DISIAPKAN:['DIANTAR'],DIANTAR:['DITERIMA'],DITERIMA:[],MENUNGGU_PEMBAYARAN:['DIBATALKAN'],DIBATALKAN:[]};if(!orderFlow[current]||orderFlow[current].indexOf(nextStatus)<0)throw new Error('Perubahan status '+current+' ke '+nextStatus+' tidak diperbolehkan.');if(session.role==='GUDANG'){const paidRows=readRows_(ss.getSheetByName('Pembayaran')).filter(function(p){return String(p[1])===orderId;}).sort(function(a,b){return new Date(b[8]||0).getTime()-new Date(a[8]||0).getTime();});if(!paidRows.length||String(paidRows[0][5]||'').toUpperCase()!=='TERVERIFIKASI')throw new Error('Pesanan belum memiliki pembayaran terverifikasi. Gudang belum dapat memproses pesanan ini.');if(['DIPROSES','DISIAPKAN','DIANTAR'].indexOf(nextStatus)<0)throw new Error('Gudang hanya dapat menjalankan tahapan pemenuhan pesanan.');}const now=new Date();os.getRange(row.rowNumber,9,1,3).setValues([[nextStatus,note||row.values[9],now]]);const shipSheet=ss.getSheetByName('Pengiriman');const ship=latestShipmentRow_(shipSheet,orderId);if(ship){const currentShip=shipSheet.getRange(ship,1,1,9).getValues()[0];let st=String(currentShip[4]||'MENUNGGU');let sent=currentShip[5],received=currentShip[6];if(nextStatus==='DIANTAR'){st='DIANTAR';sent=now;}shipSheet.getRange(ship,5,1,5).setValues([[st,sent,received,session.userId,now]]);}else shipSheet.appendRow([makeFMartId_('SHP'),orderId,'', '',nextStatus==='DIANTAR'?'DIANTAR':'MENUNGGU','','',session.userId,now]);ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(row.values[2]),orderId,'Status pesanan diperbarui','Pesanan '+String(row.values[1])+' sekarang '+nextStatus+'.','PESANAN',false,now]);writeAudit_(session.userId,session.role,'UPDATE_ORDER_STATUS','PESANAN',orderId,JSON.stringify({status:current,note:String(row.values[9]||'')}),JSON.stringify({status:nextStatus,note:note}),'Perubahan status operasional');SpreadsheetApp.flush();return getOperationsDashboard(token);}finally{lock.releaseLock();}
}

function createStaffUser(token, username, password, nama, role, email) {
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    email=normalizeEmail_(email);
    if(!isValidStaffEmail_(email)) throw new Error('Email staf wajib diisi dengan format yang valid.');
    username=email;
    role=String(role||'').trim().toUpperCase();
    if(['ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'].indexOf(role)<0) throw new Error('Peran petugas tidak valid.');
    const result=createFMartUser(username,password,nama,role,email);
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
    return {userId:String(r[0]||''),username:String(r[1]||''),email:String(r[10]||r[1]||''),nama:String(r[4]||''),role:String(r[5]||''),status:String(r[6]||''),createdAt:dateIso_(r[7]),lastLoginAt:dateIso_(r[9])};
  }).filter(function(u){return u.userId && ['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'].indexOf(u.role)>=0;});
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
  userRows.forEach(function(r){const uid=String(r[0]||'');if(uid) userMap[uid]={userId:uid,username:String(r[1]||''),nama:String(r[4]||''),role:String(r[5]||''),status:String(r[6]||''),createdAt:dateIso_(r[7]),lastLoginAt:dateIso_(r[9])};});
  const santriMap={};
  santriRows.forEach(function(r){const child=santriRecord_(r,santriColumnMap);if(child.id)santriMap[child.id]=child;});
  const waliSantri=waliRows.map(function(r){
    const waliId=String(r[0]||''), userId=String(r[1]||''), u=userMap[userId]||{};
    const own=relRows.filter(function(x){return String(x[1]||'')===waliId;});
    const children=own.filter(function(x){return String(x[3]||'').toUpperCase()==='AKTIF';}).map(function(x){const c=santriMap[String(x[2]||'')];return c?{id:c.id,nis:c.nis,name:c.name,className:c.className,hubungan:String(x[5]||'')} : null;}).filter(Boolean);
    const pendingRequests=own.filter(function(x){return String(x[3]||'').toUpperCase()==='MENUNGGU_VERIFIKASI';}).map(function(x){const c=santriMap[String(x[2]||'')];return c?{relasiId:String(x[0]||''),id:c.id,nis:c.nis,name:c.name,className:c.className,hubungan:String(x[5]||'')} : null;}).filter(Boolean);
    return {waliId:waliId,userId:userId,username:String(u.username||''),nama:String(r[2]||u.nama||''),noHp:String(r[3]||''),email:String(r[4]||''),alamat:String(r[5]||''),status:String(r[6]||u.status||''),createdAt:dateIso_(r[7]),updatedAt:dateIso_(r[8]),lastLoginAt:dateIso_(u.lastLoginAt),children:children,pendingRequests:pendingRequests};
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
  relRows.forEach(function(r){if(String(r[1]||'')===String(wali.waliId) && ['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0) blocked[String(r[2]||'')]=true;});
  const santriSheet=ss.getSheetByName('Santri'), santriMap=getSantriColumnMap_(santriSheet), rows=readSantriRows_(santriSheet), classes={};
  rows.forEach(function(r){const child=santriRecord_(r,santriMap),id=child.id,cls=child.className.trim();if(!id||!cls||child.status.toUpperCase()!=='AKTIF'||blocked[id])return;classes[cls]=true;});
  return {ok:true,classes:Object.keys(classes).sort(function(a,b){return a.localeCompare(b,'id',{numeric:true,sensitivity:'base'});})};
}

/** Fase 8.12.3: pencarian Wali real-time, opsional filter kelas. */
function searchSantriForWaliSelf(token,query,className){
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  query=String(query||'').trim().toLowerCase();
  className=String(className||'').trim().toLowerCase();
  if(query.length<3) throw new Error('Ketik minimal 3 huruf nama Santri untuk mulai mencari.');
  const searchCache=CacheService.getScriptCache();
  const searchRateKey='FMART_WALI_SANTRI_SEARCH_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(session.userId))).slice(0,40);
  const searchCount=Number(searchCache.get(searchRateKey)||0);
  if(searchCount>=30) throw new Error('Pencarian terlalu sering. Silakan tunggu sekitar satu menit sebelum mencoba lagi.');
  searchCache.put(searchRateKey,String(searchCount+1),60);
  const ss=getSS_(), wali=findWaliByUserId_(ss,session.userId);
  if(!wali) throw new Error('Data Wali Santri tidak ditemukan.');
  const relRows=readRows_(ss.getSheetByName('WaliSantriSantri'));
  const blocked={};
  relRows.forEach(function(r){if(String(r[1]||'')===String(wali.waliId) && ['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0) blocked[String(r[2]||'')]=true;});
  const santriSheet=ss.getSheetByName('Santri'), santriMap=getSantriColumnMap_(santriSheet), rows=readSantriRows_(santriSheet), result=[];
  rows.forEach(function(r){
    const child=santriRecord_(r,santriMap),id=child.id,nis=child.nis,name=child.name,cls=child.className;
    if(!id||child.status.toUpperCase()!=='AKTIF'||blocked[id])return;
    if(className && cls.toLowerCase()!==className)return;
    if(query && (name+' '+cls).toLowerCase().indexOf(query)===-1)return;
    result.push({id:id,name:name,className:cls,nisMasked:maskNis_(nis)});
  });
  return {ok:true,santri:result.slice(0,30),searched:query,className:className};
}

/** Fase 8.12.1: Wali mengajukan hubungan dengan Santri; status awal MENUNGGU_VERIFIKASI. */
function requestWaliSantriLink(token,santriId,hubungan){
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  santriId=String(santriId||'').trim(); hubungan=String(hubungan||'').trim().toUpperCase();
  if(!santriId) throw new Error('Santri tidak valid.');
  if(['AYAH','IBU','WALI','LAINNYA'].indexOf(hubungan)===-1) throw new Error('Hubungan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(), rs=ss.getSheetByName('WaliSantriSantri'), santriSheet=ss.getSheetByName('Santri');
    if(!rs||!santriSheet) throw new Error('Database relasi belum siap. Jalankan setupFMartDatabase().');
    const wali=findWaliByUserId_(ss,session.userId); if(!wali) throw new Error('Data Wali Santri tidak ditemukan.');
    const santri=findSantriRowById_(santriSheet,santriId), santriMap=getSantriColumnMap_(santriSheet); if(!santri||santriRecord_(santri.values,santriMap).status.toUpperCase()!=='AKTIF') throw new Error('Data Santri tidak ditemukan atau tidak aktif.');
    const relRows=readRows_(rs), existing=relRows.find(function(r){return String(r[1]||'')===wali.waliId&&String(r[2]||'')===santriId;});
    const activeOrPendingCount=relRows.filter(function(r){return String(r[2]||'')===santriId&&['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0;}).length;
    if(!existing && activeOrPendingCount>=2) throw new Error('Santri ini sudah memiliki maksimal 2 Wali Santri aktif/pending.');
    if(existing){const st=String(existing[3]||'').toUpperCase();if(st==='AKTIF')throw new Error('Santri sudah terhubung dengan akun Anda.');if(st==='MENUNGGU_VERIFIKASI')throw new Error('Pengajuan untuk Santri ini masih menunggu verifikasi.');}
    const now=new Date();
    if(existing){const rowNum=relRows.indexOf(existing)+2;rs.getRange(rowNum,4,1,3).setValues([['MENUNGGU_VERIFIKASI',now,hubungan]]);}else{rs.appendRow([makeFMartId_('REL'),wali.waliId,santriId,'MENUNGGU_VERIFIKASI',now,hubungan]);}
    writeAudit_(session.userId,session.role,'REQUEST_WALI_SANTRI_LINK','WALI_SANTRI_SANTRI',wali.waliId,'',JSON.stringify({waliId:wali.waliId,santriId:santriId,status:'MENUNGGU_VERIFIKASI',hubungan:hubungan}),'Wali mengajukan hubungan dengan Santri');
    SpreadsheetApp.flush();return {ok:true,message:'Pengajuan hubungan berhasil dikirim dan menunggu verifikasi Admin.'};
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
    const ss=getSS_(),ws=ss.getSheetByName('WaliSantri'),ssheet=ss.getSheetByName('Santri'),rs=ss.getSheetByName('WaliSantriSantri');if(!ws||!ssheet||!rs)throw new Error('Database relasi Wali Santri belum siap. Jalankan setupFMartDatabase().');
    const wali=findRowById_(ws,waliId,1),santri=findSantriRowById_(ssheet,santriId),santriMap=getSantriColumnMap_(ssheet);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');if(!santri||santriRecord_(santri.values,santriMap).status.toUpperCase()!=='AKTIF')throw new Error('Santri tidak ditemukan atau tidak aktif.');
    const relRows=readRows_(rs),duplicate=relRows.find(function(r){return String(r[1]||'')===waliId&&String(r[2]||'')===santriId&&String(r[3]||'').toUpperCase()==='AKTIF';});
    const activeOrPendingCount=relRows.filter(function(r){return String(r[2]||'')===santriId&&['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0;}).length;
    if(!duplicate && activeOrPendingCount>=2) throw new Error('Santri ini sudah memiliki maksimal 2 Wali Santri aktif/pending.');if(duplicate)throw new Error('Santri sudah terhubung dengan Wali Santri ini.');
    const existing=relRows.find(function(r){return String(r[1]||'')===waliId&&String(r[2]||'')===santriId;}),now=new Date();
    if(existing){const rowNum=relRows.indexOf(existing)+2;rs.getRange(rowNum,4,1,3).setValues([['AKTIF',now,hubungan]]);}else rs.appendRow([makeFMartId_('REL'),waliId,santriId,'AKTIF',now,hubungan]);
    writeAudit_(session.userId,session.role,'LINK_WALI_SANTRI','WALI_SANTRI_SANTRI',waliId,'',JSON.stringify({waliId:waliId,santriId:santriId,status:'AKTIF',hubungan:hubungan}),'Menghubungkan Wali Santri dengan Santri');SpreadsheetApp.flush();return {ok:true};
  }finally{lock.releaseLock();}
}

function approveWaliSantriRequest(token,relasiId){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);relasiId=String(relasiId||'').trim();if(!relasiId)throw new Error('Pengajuan tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{const ss=getSS_(),rs=ss.getSheetByName('WaliSantriSantri'),row=findRowById_(rs,relasiId,1);if(!row)throw new Error('Pengajuan tidak ditemukan.');if(String(row.values[3]||'').toUpperCase()!=='MENUNGGU_VERIFIKASI')throw new Error('Pengajuan ini sudah diproses.');
    const santriSheet=ss.getSheetByName('Santri'),santri=findSantriRowById_(santriSheet,String(row.values[2])),santriMap=getSantriColumnMap_(santriSheet);
    const wali=findRowById_(ss.getSheetByName('WaliSantri'),String(row.values[1]),1);if(!wali||String(wali.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Akun Wali Santri tidak aktif.');if(!santri||santriRecord_(santri.values,santriMap).status.toUpperCase()!=='AKTIF')throw new Error('Santri tidak aktif.');
    const activeCount=readRows_(rs).filter(function(r){return String(r[2]||'')===String(row.values[2]||'')&&String(r[3]||'').toUpperCase()==='AKTIF';}).length;
    if(activeCount>=2) throw new Error('Santri ini sudah memiliki 2 Wali Santri aktif.');
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
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  waliId=String(waliId||'').trim(); nama=String(nama||'').trim().slice(0,120); noHp=normalizePhone_(noHp); email=String(email||'').trim().slice(0,160); alamat=String(alamat||'').trim().slice(0,300);
  if(!waliId) throw new Error('Wali Santri tidak valid.');
  if(!nama) throw new Error('Nama wajib diisi.');
  if(!noHp) throw new Error('No. HP tidak valid. Gunakan format 08xxxxxxxxxx.');
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) throw new Error('Format email tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const ss=getSS_(), ws=ss.getSheetByName('WaliSantri'), us=ss.getSheetByName('Users');
    const row=findRowById_(ws,waliId,1); if(!row) throw new Error('Data Wali Santri tidak ditemukan.');
    const userId=String(row.values[1]||'');
    const waliRows=readRows_(ws);
    if(waliRows.some(function(r){return String(r[0]||'')!==waliId && phoneEquals_(r[3],noHp);})){throw new Error('No. HP sudah digunakan oleh Wali Santri lain.');}
    const userRow=findRowById_(us,userId,1); if(!userRow) throw new Error('Akun pengguna Wali Santri tidak ditemukan.');
    const now=new Date();
    ws.getRange(row.rowNumber,3,1,7).setValues([[nama,noHp,email,alamat,String(row.values[6]||'AKTIF'),row.values[7]||now,now]]);
    ws.getRange(row.rowNumber,4).setNumberFormat('@');
    us.getRange(userRow.rowNumber,5).setValue(nama); us.getRange(userRow.rowNumber,9).setValue(now);
    writeAudit_(session.userId,session.role,'UPDATE_WALI_SANTRI','WALI_SANTRI',waliId,JSON.stringify({nama:String(row.values[2]||''),noHp:String(row.values[3]||''),email:String(row.values[4]||''),alamat:String(row.values[5]||'')}),JSON.stringify({nama:nama,noHp:noHp,email:email,alamat:alamat}),'Memperbarui data Wali Santri');
    SpreadsheetApp.flush(); return {ok:true};
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
    if(!nama)throw new Error('Nama wajib diisi.');if(['ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','WALI_SANTRI'].indexOf(role)<0)throw new Error('Role tidak valid.');
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

function assertWaliChild_(ss, userId, santriId) {
  santriId = String(santriId || '').trim();
  if (!santriId) throw new Error('Anak belum dipilih.');
  const children = getChildrenForWali_(ss, userId);
  const child = children.find(function(c){return String(c.id)===santriId;});
  if (!child) throw new Error('Anak tidak terhubung ke akun Wali Santri.');
  return child;
}

function getProductSnapshot_(ss, productId, variationId) {
  productId=String(productId||'').trim(); variationId=String(variationId||'').trim();
  if(!productId)return null;
  const productRow=findRowById_(ss.getSheetByName('Produk'),productId,1); if(!productRow)return null;
  const p=productRow.values;
  if(String(p[8]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};
  const cat=findRowById_(ss.getSheetByName('Kategori'),String(p[1]||''),1);
  if(!cat||String(cat.values[4]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};
  let addition=0, variationName='', variationSku='';
  if(variationId){
    const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);
    if(!vr||String(vr.values[1])!==productId||String(vr.values[6]||'').toUpperCase()!=='AKTIF')return {active:false,stock:0};
    addition=Number(vr.values[4])||0; variationName=String(vr.values[2]||'') + (vr.values[3] ? ': '+String(vr.values[3]) : '');
  }
  const stockRows=readRows_(ss.getSheetByName('Stok'));
  const sr=stockRows.find(function(r){return String(r[1])===productId && String(r[2]||'')===variationId;});
  let stock=sr ? Math.max(0,Number(sr[3])||0) : 0;
  if(!sr && variationId){
    const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1); stock=vr?Math.max(0,Number(vr.values[5])||0):0;
  }
  return {active:true,id:productId,name:String(p[3]||''),sku:String(p[2]||''),photoUrl:String(p[7]||''),unitPrice:Math.max(0,(Number(p[5])||0)+addition),stock:stock,variationId:variationId,variationName:variationName};
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
  if (missing.length) throw new Error('Struktur master Santri belum lengkap. Header belum tersedia: ' + missing.join(', ') + '. Jalankan setupFMartDatabase() dan migrasi master Santri terlebih dahulu.');
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

function hashPassword_(password, salt) {
  if (FMART.PASSWORD_HASH_MODE === 'PBKDF2') {
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

function writeAudit_(userId, role, action, entityType, entityId, beforeData, afterData, note) {
  try {
    const sheet=getSS_().getSheetByName('AuditLog');
    if(!sheet) return;
    const safe=function(v){return String(v||'').slice(0,5000);};
    sheet.appendRow([makeFMartId_('AUD'),String(userId||''),String(role||''),String(action||''),String(entityType||''),String(entityId||''),safe(beforeData),safe(afterData),safe(note),new Date()]);
  } catch(e) { console.warn('Audit log gagal dicatat:', e); }
}

function readRows_(sheet) {
  if (!sheet || sheet.getLastRow()<2) return [];
  return sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
}
