/**
 * FMart - Code.gs
 * Backend, autentikasi, otorisasi, dan API aplikasi.
 */

const FMART = Object.freeze({
  APP_NAME: 'FMart',
  SESSION_TTL_SECONDS: 21600,
  LOGIN_RATE_LIMIT_SECONDS: 300,
  LOGIN_MAX_FAILURES: 8,
  SPREADSHEET_PROPERTY: 'FMART_SPREADSHEET_ID',
  ROLES: Object.freeze({ WALI_SANTRI:'WALI_SANTRI', ADMIN:'ADMIN', KASIR:'KASIR', GUDANG:'GUDANG', SUPERADMIN:'SUPERADMIN' })
});

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(FMART.APP_NAME)
    .addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getSS_() {
  const id = PropertiesService.getScriptProperties().getProperty(FMART.SPREADSHEET_PROPERTY);
  if (!id) throw new Error('Database FMart belum dikonfigurasi. Jalankan setupFMartDatabase() terlebih dahulu.');
  return SpreadsheetApp.openById(id);
}

function login(username, password) {
  const rawLogin = String(username || '').trim();
  username = normalizeUsername_(rawLogin);
  if (!username || typeof password !== 'string' || !password) return {ok:false, message:'Nomor HP atau password tidak valid.'};
  const phoneKeyForRate = normalizePhone_(rawLogin);
  const rate = loginRateKey_(phoneKeyForRate || username);
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get(rate) || 0);
  if (failures >= FMART.LOGIN_MAX_FAILURES) return {ok:false, message:'Terlalu banyak percobaan login. Silakan coba lagi beberapa menit kemudian.'};

  const ss = getSS_();
  const sheet = ss.getSheetByName('Users');
  if (!sheet || sheet.getLastRow() < 2) return {ok:false, message:'Belum ada akun FMart.'};
  const rows = sheet.getRange(2,1,sheet.getLastRow()-1,10).getValues();

  // Wali Santri login menggunakan No. HP yang terdaftar pada WaliSantri.
  // Akun staff tetap login menggunakan Username biasa.
  let targetIndex = -1;
  for (let i=0;i<rows.length;i++) {
    if (normalizeUsername_(rows[i][1]) === username) { targetIndex=i; break; }
  }

  if (targetIndex === -1) {
    const phoneKey = normalizePhone_(rawLogin);
    if (phoneKey) {
      const waliRows = readRows_(ss.getSheetByName('WaliSantri'));
      const matches = waliRows.filter(function(r){
        return normalizePhone_(r[3]) === phoneKey && String(r[6] || '').toUpperCase() === 'AKTIF';
      });
      if (matches.length > 1) return {ok:false, message:'Nomor HP terdaftar pada lebih dari satu Wali Santri. Hubungi Admin.'};
      if (matches.length === 1) {
        const userId = String(matches[0][1] || '');
        for (let i=0;i<rows.length;i++) {
          if (String(rows[i][0] || '') === userId && String(rows[i][5] || '').toUpperCase() === 'WALI_SANTRI') { targetIndex=i; break; }
        }
      }
    }
  }

  if (targetIndex === -1) {
    cache.put(rate, String(failures + 1), FMART.LOGIN_RATE_LIMIT_SECONDS);
    return {ok:false, message:'Nomor HP/username atau password salah.'};
  }

  const r = rows[targetIndex];
  if (String(r[6]).toUpperCase() !== 'AKTIF') return {ok:false, message:'Akun tidak aktif.'};
  if (!verifyPassword_(password, String(r[3]), String(r[2]))) {
    cache.put(rate, String(failures + 1), FMART.LOGIN_RATE_LIMIT_SECONDS);
    return {ok:false, message:'Nomor HP/username atau password salah.'};
  }

  const token = Utilities.getUuid() + '.' + Utilities.getUuid();
  const role = String(r[5]).toUpperCase();
  let sessionUsername = String(r[1] || '');
  if (role === FMART.ROLES.WALI_SANTRI) {
    const wali = findWaliByUserId_(ss, String(r[0]));
    if (!wali || !normalizePhone_(wali.noHp)) return {ok:false, message:'No. HP Wali Santri belum terdaftar. Hubungi Admin.'};
    sessionUsername = wali.noHp;
  }
  const session = {userId:String(r[0]), username:sessionUsername, nama:String(r[4]), role:role, issuedAt:Date.now()};
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(session), FMART.SESSION_TTL_SECONDS);
  sheet.getRange(targetIndex+2,10).setValue(new Date());
  cache.remove(rate);
  writeAudit_(session.userId, session.role, 'LOGIN_SUCCESS', 'USER', session.userId, '', JSON.stringify({username:session.username}), 'Login berhasil');
  return {ok:true, token:token, user:{userId:session.userId,username:session.username,nama:session.nama,role:session.role}};
}

function normalizePhone_(value) {
  let s = String(value == null ? '' : value).trim().replace(/[^0-9+]/g, '');
  if (!s) return '';
  if (s.indexOf('+62') === 0) s = '0' + s.slice(3);
  else if (s.indexOf('62') === 0) s = '0' + s.slice(2);
  else if (s.charAt(0) === '8') s = '0' + s;
  if (!/^08[0-9]{8,13}$/.test(s)) return '';
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
    if (password.length < 6) throw new Error('Password minimal 6 karakter.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Format email tidak valid.');
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
  if (newPassword.length < 6) throw new Error('Password baru minimal 6 karakter.');
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
      throw new Error('Perubahan password tidak dapat diverifikasi. Tidak ada perubahan sesi yang dilakukan.');
    }
    writeAudit_(session.userId, session.role, 'CHANGE_PASSWORD', 'USER', session.userId, '', JSON.stringify({username:session.username}), 'Password berhasil diganti oleh pemilik akun');
    return {ok:true, message:'Password berhasil diganti.'};
  } finally {
    lock.releaseLock();
  }
}

function getSession(token) {
  const s = requireSession_(token);
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
  return readRows_(ss.getSheetByName('Santri')).filter(function(r){return santriIds.indexOf(String(r[0]))!==-1 && String(r[4]).toUpperCase()==='AKTIF';}).map(function(r){return {id:r[0],nis:r[1],name:r[2],className:r[3]};});
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

/** Fase 3: keranjang per Wali Santri + anak. Semua harga/stok dihitung ulang di server. */
function getCart(token, santriId) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  const ss = getSS_();
  const child = assertWaliChild_(ss, session.userId, santriId);
  const rows = readRows_(ss.getSheetByName('Keranjang'));
  const items = [];
  let subtotal = 0;
  rows.forEach(function(r) {
    if (String(r[1]) !== String(session.userId) || String(r[2]) !== String(child.id)) return;
    const qty = Math.max(0, Math.floor(Number(r[5]) || 0));
    if (!qty) return;
    const snap = getProductSnapshot_(ss, r[3], r[4]);
    const requested = qty;
    const available = snap ? Math.max(0, snap.stock) : 0;
    const lineSubtotal = snap ? snap.unitPrice * requested : 0;
    subtotal += lineSubtotal;
    items.push({
      cartId:String(r[0]), productId:String(r[3]), variationId:String(r[4] || ''),
      name:snap ? snap.name : 'Produk tidak tersedia',
      variationName:snap ? snap.variationName : '', sku:snap ? snap.sku : '',
      photoUrl:snap ? snap.photoUrl : '', unitPrice:snap ? snap.unitPrice : 0,
      qty:requested, stock:available, subtotal:lineSubtotal,
      available:snap ? snap.active : false,
      exceedsStock:requested > available
    });
  });
  return {ok:true,child:child,items:items,subtotal:subtotal,total:subtotal,canCheckout:items.length>0 && items.every(function(i){return i.available && !i.exceedsStock;})};
}

function addToCart(token, productId, variationId, qty, santriId) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  productId = String(productId || '').trim();
  variationId = String(variationId || '').trim();
  santriId = String(santriId || '').trim();
  qty = Math.floor(Number(qty));
  if (!productId || !santriId || !Number.isFinite(qty) || qty < 1) throw new Error('Data keranjang tidak valid.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSS_();
    assertWaliChild_(ss, session.userId, santriId);
    const snap = getProductSnapshot_(ss, productId, variationId);
    if (!snap || !snap.active) throw new Error('Produk tidak tersedia.');
    const sheet = ss.getSheetByName('Keranjang');
    const rows = readRows_(sheet);
    let foundRow = null;
    let currentQty = 0;
    for (let i=0;i<rows.length;i++) {
      const r = rows[i];
      if (String(r[1]) === session.userId && String(r[2]) === santriId && String(r[3]) === productId && String(r[4] || '') === variationId) {
        foundRow = i + 2;
        currentQty = Math.floor(Number(r[5]) || 0);
        break;
      }
    }
    const nextQty = currentQty + qty;
    if (nextQty > snap.stock) throw new Error('Jumlah melebihi stok tersedia (' + snap.stock + ').');
    const now = new Date();
    if (foundRow) sheet.getRange(foundRow, 6, 1, 2).setValues([[nextQty, now]]);
    else sheet.appendRow([makeFMartId_('CRT'),session.userId,santriId,productId,variationId,nextQty,now,now]);
    return getCart(token, santriId);
  } finally { lock.releaseLock(); }
}

function updateCartItem(token, cartId, qty, santriId) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  cartId = String(cartId || '').trim(); santriId = String(santriId || '').trim(); qty = Math.floor(Number(qty));
  if (!cartId || !santriId || !Number.isFinite(qty) || qty < 0) throw new Error('Data keranjang tidak valid.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const ss = getSS_(); assertWaliChild_(ss, session.userId, santriId);
    const sheet = ss.getSheetByName('Keranjang'); const row = findRowById_(sheet, cartId, 1);
    if (!row || String(row.values[1]) !== session.userId || String(row.values[2]) !== santriId) throw new Error('Item keranjang tidak ditemukan.');
    if (qty === 0) sheet.deleteRow(row.rowNumber);
    else {
      const snap = getProductSnapshot_(ss, row.values[3], row.values[4]);
      if (!snap || !snap.active) throw new Error('Produk sudah tidak tersedia.');
      if (qty > snap.stock) throw new Error('Jumlah melebihi stok tersedia (' + snap.stock + ').');
      sheet.getRange(row.rowNumber, 6, 1, 2).setValues([[qty,new Date()]]);
    }
    return getCart(token, santriId);
  } finally { lock.releaseLock(); }
}

function removeCartItem(token, cartId, santriId) { return updateCartItem(token, cartId, 0, santriId); }

/** Checkout membuat pesanan MENUNGGU_PEMBAYARAN. Pembayaran ditangani Fase 4. */
function checkoutCart(token, santriId, catatan, metodePengiriman, tujuan) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  santriId = String(santriId || '').trim();
  catatan = String(catatan || '').trim().slice(0,500);
  metodePengiriman = String(metodePengiriman || 'AMBIL_FMART').trim().toUpperCase();
  tujuan = String(tujuan || '').trim().slice(0,500);
  if (!santriId) throw new Error('Anak tujuan belum dipilih.');
  if (['AMBIL_FMART','ANTAR_PESANTREN'].indexOf(metodePengiriman) === -1) throw new Error('Metode pengiriman tidak valid.');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const ss = getSS_(); const child = assertWaliChild_(ss, session.userId, santriId);
    const cart = buildCartSnapshot_(ss, session.userId, santriId);
    if (!cart.items.length) throw new Error('Keranjang masih kosong.');
    const invalid = cart.items.find(function(i){return !i.active || i.qty > i.stock;});
    if (invalid) throw new Error('Stok untuk "' + invalid.name + '" tidak mencukupi. Silakan periksa keranjang.');
    const subtotal = cart.items.reduce(function(sum,i){return sum + i.unitPrice * i.qty;},0);
    const ongkir = 0, diskon = 0, total = subtotal + ongkir - diskon;
    const now = new Date();
    const orderId = makeFMartId_('ORD');
    const nomorPesanan = 'FM-' + Utilities.formatDate(now, FMART_DB.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' + Math.floor(1000 + Math.random()*9000);
    const orderSheet = ss.getSheetByName('Pesanan');
    orderSheet.appendRow([orderId,nomorPesanan,session.userId,santriId,subtotal,ongkir,diskon,total,'MENUNGGU_PEMBAYARAN',catatan,now,now]);
    const detailSheet = ss.getSheetByName('DetailPesanan');
    cart.items.forEach(function(i){
      detailSheet.appendRow([makeFMartId_('DTL'),orderId,i.productId,i.variationId,i.sku,i.name,i.variationName,i.unitPrice,i.qty,i.unitPrice*i.qty]);
    });
    ss.getSheetByName('Pengiriman').appendRow([makeFMartId_('SHP'),orderId,metodePengiriman,tujuan || child.name,'MENUNGGU','','',session.userId,now]);
    const cartSheet = ss.getSheetByName('Keranjang');
    const cartRows = readRows_(cartSheet);
    for (let i=cartRows.length-1;i>=0;i--) {
      const r=cartRows[i];
      if (String(r[1])===session.userId && String(r[2])===santriId) cartSheet.deleteRow(i+2);
    }
    writeAudit_(session.userId,session.role,'CREATE_ORDER','PESANAN',orderId,'',JSON.stringify({number:nomorPesanan,santriId:santriId,total:total,itemCount:cart.items.length,shippingMethod:metodePengiriman}),'Checkout membuat pesanan');
    SpreadsheetApp.flush();
    return {ok:true,orderId:orderId,nomorPesanan:nomorPesanan,total:total,status:'MENUNGGU_PEMBAYARAN',child:child};
  } finally { lock.releaseLock(); }
}



/** Fase 4: pesanan dan pembayaran Wali Santri. */
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
  const santri = findRowById_(ss.getSheetByName('Santri'), String(r[3]), 1);
  const details = readRows_(ss.getSheetByName('DetailPesanan')).filter(function(d){ return String(d[1]) === orderId; }).map(function(d){
    return {id:String(d[0]),productId:String(d[2]),variationId:String(d[3]||''),sku:String(d[4]||''),name:String(d[5]||''),variationName:String(d[6]||''),price:Number(d[7])||0,qty:Number(d[8])||0,subtotal:Number(d[9])||0};
  });
  return {ok:true,order:{orderId:String(r[0]),number:String(r[1]),santriId:String(r[3]),childName:santri?String(santri.values[2]||''):'Anak',className:santri?String(santri.values[3]||''):'',subtotal:Number(r[4])||0,shipping:Number(r[5])||0,discount:Number(r[6])||0,total:Number(r[7])||0,status:String(r[8]||''),note:String(r[9]||''),createdAt:dateIso_(r[10]),updatedAt:dateIso_(r[11]),details:details}};
}

function submitPayment(token, orderId, method, nominal, fileName, mimeType, base64Data) {
  const session = requireRole_(token, [FMART.ROLES.WALI_SANTRI]);
  orderId = String(orderId || '').trim();
  method = String(method || '').trim().toUpperCase();
  nominal = Math.round(Number(nominal));
  if (!orderId || method !== 'TRANSFER' || !Number.isFinite(nominal) || nominal < 1) throw new Error('Pembayaran FMart hanya menggunakan Transfer dan nominal harus valid.');
  if (!base64Data) throw new Error('Bukti transfer wajib diupload sebelum pembayaran dikirim.');
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

    const cleanName = sanitizeFileName_(fileName || 'bukti-transfer');
    const mime = String(mimeType || '').toLowerCase();
    if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)) throw new Error('Format bukti transfer harus JPG, PNG, WEBP, atau PDF.');
    const raw = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    const bytes = Utilities.base64Decode(raw);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Ukuran bukti transfer maksimal 5 MB.');
    const folder = getPaymentProofFolder_();
    const file = folder.createFile(Utilities.newBlob(bytes, mime, orderId + '-' + cleanName));
    const buktiUrl = file.getUrl();
    const now = new Date();
    const paymentId = makeFMartId_('PAY');
    paymentSheet.appendRow([paymentId,orderId,'TRANSFER',nominal,buktiUrl,'MENUNGGU_VERIFIKASI','','',now,now,'APLIKASI',session.userId,'']);
    writeAudit_(session.userId,session.role,'SUBMIT_PAYMENT','PEMBAYARAN',paymentId,'',JSON.stringify({orderId:orderId,method:'TRANSFER',nominal:nominal,hasProof:true,buktiSumber:'APLIKASI'}),'Pengajuan pembayaran transfer dengan bukti');
    SpreadsheetApp.flush();
    return getOrderDetail(token, orderId);
  } finally { lock.releaseLock(); }
}

function getPaymentSettings(token) {
  requireSession_(token);
  return {ok:true,bankName:getSettingValue_('PAYMENT_BANK_NAME'),accountNumber:getSettingValue_('PAYMENT_ACCOUNT_NUMBER'),accountName:getSettingValue_('PAYMENT_ACCOUNT_NAME'),adminWhatsapp:getSettingValue_('PAYMENT_ADMIN_WHATSAPP')};
}

function savePaymentSettings(token, bankName, accountNumber, accountName, adminWhatsapp) {
  const session = requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  bankName=String(bankName||'').trim().slice(0,80);
  accountNumber=String(accountNumber||'').replace(/[^0-9]/g,'').slice(0,30);
  accountName=String(accountName||'').trim().slice(0,120);
  adminWhatsapp=normalizePhone_(adminWhatsapp);
  if(!bankName||!accountNumber||!accountName) throw new Error('Nama bank, nomor rekening, dan nama pemilik rekening wajib diisi.');
  if(adminWhatsapp && adminWhatsapp.length<10) throw new Error('Nomor WhatsApp Admin/Kasir tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const sheet=getSS_().getSheetByName('Pengaturan');
    const updates=[['PAYMENT_BANK_NAME',bankName],['PAYMENT_ACCOUNT_NUMBER',accountNumber],['PAYMENT_ACCOUNT_NAME',accountName],['PAYMENT_ADMIN_WHATSAPP',adminWhatsapp]];
    updates.forEach(function(item){
      const rows=readRows_(sheet),idx=rows.findIndex(function(r){return String(r[0])===item[0];});
      if(idx<0) sheet.appendRow([item[0],item[1],item[0]==='PAYMENT_BANK_NAME'?'Nama bank rekening pembayaran FMart':item[0]==='PAYMENT_ACCOUNT_NUMBER'?'Nomor rekening pembayaran FMart':item[0]==='PAYMENT_ACCOUNT_NAME'?'Nama pemilik rekening pembayaran FMart':'Nomor WhatsApp Admin/Kasir untuk konfirmasi pembayaran',new Date()]);
      else sheet.getRange(idx+2,2,1,2).setValues([[item[1],sheet.getRange(idx+2,3).getValue()]]),sheet.getRange(idx+2,4).setValue(new Date());
    });
    writeAudit_(session.userId,session.role,'UPDATE_PAYMENT_SETTINGS','PENGATURAN','PAYMENT','',JSON.stringify({bankName:bankName,accountNumberLast4:accountNumber.slice(-4),accountName:accountName,hasWhatsapp:!!adminWhatsapp}),'Mengubah rekening dan kontak pembayaran FMart');
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
  const santri = readRows_(ss.getSheetByName('Santri'));
  const products = readRows_(ss.getSheetByName('Produk'));
  const stockRows = readRows_(ss.getSheetByName('Stok'));
  const cats = readRows_(ss.getSheetByName('Kategori'));
  const variationRows = readRows_(ss.getSheetByName('VariasiProduk'));
  const userMap = {}; users.forEach(r => userMap[String(r[0])] = {name:String(r[4]||''),username:String(r[1]||'')});
  const childMap = {}; santri.forEach(r => childMap[String(r[0])] = {name:String(r[2]||''),className:String(r[3]||'')});
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



/** Fase 6: laporan operasional terhitung dari data transaksi aktual. */
function getFMartReports(token, startDate, endDate) {
  const session = requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const start=parseReportDate_(startDate,false), end=parseReportDate_(endDate,true);
  if(end<start) throw new Error('Periode laporan tidak valid.');
  const orders=readRows_(ss.getSheetByName('Pesanan')).filter(r=>inReportRange_(r[10],start,end));
  const details=readRows_(ss.getSheetByName('DetailPesanan'));
  const payments=readRows_(ss.getSheetByName('Pembayaran')).filter(r=>inReportRange_(r[8],start,end));
  const santri=readRows_(ss.getSheetByName('Santri')); const users=readRows_(ss.getSheetByName('Users')); const products=readRows_(ss.getSheetByName('Produk')); const cats=readRows_(ss.getSheetByName('Kategori')); const mutasi=readRows_(ss.getSheetByName('MutasiStok')).filter(r=>inReportRange_(r[10],start,end));
  const childMap={};santri.forEach(r=>childMap[String(r[0])]=String(r[2]||''));
  const userMap={};users.forEach(r=>userMap[String(r[0])]=String(r[4]||''));
  const productMap={};products.forEach(r=>productMap[String(r[0])]=String(r[3]||''));
  const catMap={};cats.forEach(r=>catMap[String(r[0])]=String(r[1]||''));
  const paidOrderIds={};payments.forEach(r=>{if(String(r[5]||'').toUpperCase()==='TERVERIFIKASI')paidOrderIds[String(r[1])]=true;});
  const statusCounts={}; orders.forEach(r=>{const st=String(r[8]||'').toUpperCase();statusCounts[st]=(statusCounts[st]||0)+1;});
  const gross=orders.filter(r=>String(r[8]||'').toUpperCase()!=='DIBATALKAN').reduce((n,r)=>n+(Number(r[7])||0),0);
  const paid=orders.filter(r=>paidOrderIds[String(r[0])]).reduce((n,r)=>n+(Number(r[7])||0),0);
  const categorySales={}; const productSales={};
  details.forEach(d=>{const order=orders.find(o=>String(o[0])===String(d[1])); if(!order || String(order[8]||'').toUpperCase()==='DIBATALKAN') return; const qty=Math.max(0,Number(d[8])||0), sub=Math.max(0,Number(d[9])||0), pid=String(d[2]||''), p=products.find(x=>String(x[0])===pid); const cat=p?String(p[1]||''):''; const cn=catMap[cat]||'Tanpa Kategori'; categorySales[cn]=(categorySales[cn]||0)+sub; const pn=productMap[pid]||String(d[5]||'Produk'); if(!productSales[pn])productSales[pn]={name:pn,qty:0,amount:0}; productSales[pn].qty+=qty;productSales[pn].amount+=sub;});
  const paymentMethods={}; payments.filter(r=>String(r[5]||'').toUpperCase()==='TERVERIFIKASI').forEach(r=>{const m=String(r[2]||'Lainnya');paymentMethods[m]=(paymentMethods[m]||0)+(Number(r[3])||0);});
  const stockIn=mutasi.filter(r=>String(r[3]||'').toUpperCase()==='MASUK').reduce((n,r)=>n+(Number(r[4])||0),0);
  const stockOut=mutasi.filter(r=>String(r[3]||'').toUpperCase()==='KELUAR').reduce((n,r)=>n+(Number(r[4])||0),0);
  const daily={}; orders.forEach(r=>{if(String(r[8]||'').toUpperCase()==='DIBATALKAN')return;const key=formatReportDay_(r[10]);if(!daily[key])daily[key]={date:key,orders:0,amount:0};daily[key].orders++;daily[key].amount+=Number(r[7])||0;});
  const topProducts=Object.keys(productSales).map(k=>productSales[k]).sort((a,b)=>b.amount-a.amount).slice(0,10);
  return {ok:true,period:{start:start.toISOString(),end:end.toISOString()},summary:{orders:orders.length,activeOrders:orders.filter(r=>!['DITERIMA','DIBATALKAN'].includes(String(r[8]||'').toUpperCase())).length,gross:gross,paid:paid,unpaid:Math.max(0,gross-paid),averageOrder:orders.length?Math.round(gross/orders.length):0,stockIn:stockIn,stockOut:stockOut},statusCounts:statusCounts,categorySales:Object.keys(categorySales).map(k=>({name:k,amount:categorySales[k]})).sort((a,b)=>b.amount-a.amount),paymentMethods:Object.keys(paymentMethods).map(k=>({name:k,amount:paymentMethods[k]})).sort((a,b)=>b.amount-a.amount),daily:Object.keys(daily).sort().map(k=>daily[k]),topProducts:topProducts,generatedAt:new Date().toISOString(),generatedBy:{userId:session.userId,nama:session.nama}};
}

function parseReportDate_(value,endOfDay){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Tanggal laporan tidak valid.');
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

function getStockCatalog(token) {
  requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_(); const products=readRows_(ss.getSheetByName('Produk')).filter(r=>String(r[8]||'').toUpperCase()==='AKTIF'); const vars=readRows_(ss.getSheetByName('VariasiProduk')).filter(r=>String(r[6]||'').toUpperCase()==='AKTIF'); const stocks=readRows_(ss.getSheetByName('Stok')); 
  return {ok:true,products:products.map(p=>{const pid=String(p[0]);const vs=vars.filter(v=>String(v[1])===pid).map(v=>{const sr=stocks.find(r=>String(r[1])===pid&&String(r[2]||'')===String(v[0]));return {id:String(v[0]),name:String(v[2]||''),value:String(v[3]||''),stock:sr?Number(sr[3])||0:Number(v[5])||0};});const sr=stocks.find(r=>String(r[1])===pid&&!r[2]);return {id:pid,name:String(p[3]||''),sku:String(p[2]||''),stock:sr?Number(sr[3])||0:0,variations:vs};})};
}

function adjustStock(token, productId, variationId, type, qty, note) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  productId=String(productId||'').trim(); variationId=String(variationId||'').trim(); type=String(type||'').toUpperCase(); qty=Math.floor(Number(qty)); note=String(note||'').trim().slice(0,300);
  if(!productId||!Number.isFinite(qty)||qty<1||['MASUK','KELUAR'].indexOf(type)<0)throw new Error('Data mutasi stok tidak valid.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const ss=getSS_();const product=findRowById_(ss.getSheetByName('Produk'),productId,1);if(!product)throw new Error('Produk tidak ditemukan.');
    if(variationId){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),variationId,1);if(!vr||String(vr.values[1])!==productId)throw new Error('Variasi tidak valid.');}
    const sheet=ss.getSheetByName('Stok');let row=readRows_(sheet).findIndex(r=>String(r[1])===productId&&String(r[2]||'')===variationId);const before=row>=0?Math.max(0,Number(readRows_(sheet)[row][3])||0):0;const after=type==='MASUK'?before+qty:before-qty;if(after<0)throw new Error('Stok tidak mencukupi.');const now=new Date();
    if(row>=0)sheet.getRange(row+2,4,1,2).setValues([[after,now]]);else sheet.appendRow([makeFMartId_('STK'),productId,variationId,after,Number(product.values[6])||0,now]);
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
    const stockPlan=[];
    for(const d of details){const snap=getProductSnapshot_(ss,d[2],d[3]);const qty=Math.floor(Number(d[8])||0);if(qty<1||!snap||!snap.active||qty>Number(snap.stock))throw new Error('Stok tidak mencukupi untuk '+String(d[5]||'produk')+'. Pembayaran belum diterima.');const pid=String(d[2]),vid=String(d[3]||'');const idx=stockRows.findIndex(r=>String(r[1])===pid&&String(r[2]||'')===vid);if(idx<0)throw new Error('Data stok tidak ditemukan untuk '+String(d[5]||'produk')+'.');const before=Math.max(0,Number(stockRows[idx][3])||0);if(qty>before)throw new Error('Stok berubah dan tidak mencukupi untuk '+String(d[5]||'produk')+'.');stockPlan.push({d:d,idx:idx,before:before,after:before-qty,pid:pid,vid:vid,qty:qty});}
    for(const x of stockPlan){stockSheet.getRange(x.idx+2,4,1,2).setValues([[x.after,now]]);if(x.vid){const vr=findRowById_(ss.getSheetByName('VariasiProduk'),x.vid,1);if(vr)ss.getSheetByName('VariasiProduk').getRange(vr.rowNumber,6,1,3).setValues([[x.after,String(vr.values[6]||'AKTIF'),now]]);}ss.getSheetByName('MutasiStok').appendRow([makeFMartId_('MUT'),x.pid,x.vid,'KELUAR',x.qty,x.before,x.after,String(order.values[0]),'Penjualan '+String(order.values[1]),session.userId,now]);}
    paySheet.getRange(pay.rowNumber,6,1,3).setValues([['TERVERIFIKASI',session.userId,now]]);paySheet.getRange(pay.rowNumber,10).setValue(now);orderSheet.getRange(order.rowNumber,9,1,3).setValues([['DIBAYAR',order.values[9],now]]);ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(order.values[2]),String(order.values[0]),'Pembayaran terverifikasi','Pembayaran pesanan '+String(order.values[1])+' telah diverifikasi.','PEMBAYARAN',false,now]);writeAudit_(session.userId,session.role,'VERIFY_PAYMENT','PEMBAYARAN',paymentId,JSON.stringify({status:'MENUNGGU_VERIFIKASI',orderId:String(order.values[0])}),JSON.stringify({status:'TERVERIFIKASI',orderStatus:'DIBAYAR'}),'Pembayaran diverifikasi dan stok dikurangi');SpreadsheetApp.flush();return getOperationsDashboard(token);
  }finally{lock.releaseLock();}
}

function updateOrderOperation(token, orderId, nextStatus, shipmentStatus, note) {
  const session=requireRole_(token,[FMART.ROLES.GUDANG,FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);orderId=String(orderId||'').trim();nextStatus=String(nextStatus||'').toUpperCase();shipmentStatus=String(shipmentStatus||'').toUpperCase();note=String(note||'').trim().slice(0,300);
  const allowed=['DIBAYAR','DIPROSES','DISIAPKAN','DIANTAR','DIBATALKAN'];if(allowed.indexOf(nextStatus)<0)throw new Error('Status pesanan tidak valid.');
  if(nextStatus==='DIBATALKAN' && session.role==='GUDANG') throw new Error('Gudang tidak berwenang membatalkan pesanan.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{const ss=getSS_();const os=ss.getSheetByName('Pesanan');const row=findRowById_(os,orderId,1);if(!row)throw new Error('Pesanan tidak ditemukan.');const current=String(row.values[8]||'').toUpperCase();const orderFlow={DIBAYAR:['DIPROSES'],DIPROSES:['DISIAPKAN'],DISIAPKAN:['DIANTAR'],DIANTAR:['DITERIMA'],DITERIMA:[],MENUNGGU_PEMBAYARAN:['DIBATALKAN'],DIBATALKAN:[]};if(!orderFlow[current]||orderFlow[current].indexOf(nextStatus)<0)throw new Error('Perubahan status '+current+' ke '+nextStatus+' tidak diperbolehkan.');const now=new Date();os.getRange(row.rowNumber,9,1,3).setValues([[nextStatus,note||row.values[9],now]]);const shipSheet=ss.getSheetByName('Pengiriman');const ship=latestShipmentRow_(shipSheet,orderId);if(ship){const currentShip=shipSheet.getRange(ship,1,1,9).getValues()[0];let st=String(currentShip[4]||'MENUNGGU');let sent=currentShip[5],received=currentShip[6];if(nextStatus==='DIANTAR'){st='DIANTAR';sent=now;}shipSheet.getRange(ship,5,1,5).setValues([[st,sent,received,session.userId,now]]);}else shipSheet.appendRow([makeFMartId_('SHP'),orderId,'', '',nextStatus==='DIANTAR'?'DIANTAR':'MENUNGGU','','',session.userId,now]);ss.getSheetByName('Notifikasi').appendRow([makeFMartId_('NTF'),String(row.values[2]),orderId,'Status pesanan diperbarui','Pesanan '+String(row.values[1])+' sekarang '+nextStatus+'.','PESANAN',false,now]);writeAudit_(session.userId,session.role,'UPDATE_ORDER_STATUS','PESANAN',orderId,JSON.stringify({status:current,note:String(row.values[9]||'')}),JSON.stringify({status:nextStatus,note:note}),'Perubahan status operasional');SpreadsheetApp.flush();return getOperationsDashboard(token);}finally{lock.releaseLock();}
}

function createStaffUser(token, username, password, nama, role) {
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const result=createFMartUser(username,password,nama,role);
    writeAudit_(session.userId,session.role,'CREATE_USER','USER',result.userId,'',JSON.stringify({username:result.username,role:result.role}),'Membuat pengguna');
    SpreadsheetApp.flush();
    return getOperationsDashboard(token);
  } finally { lock.releaseLock(); }
}

function upsertStockRow_(ss,productId,variationId,qty,userId){const sheet=ss.getSheetByName('Stok');const rows=readRows_(sheet);const idx=rows.findIndex(r=>String(r[1])===String(productId)&&String(r[2]||'')===String(variationId||''));const now=new Date();if(idx>=0)sheet.getRange(idx+2,4,1,2).setValues([[Math.max(0,Number(qty)||0),now]]);else sheet.appendRow([makeFMartId_('STK'),productId,variationId,Math.max(0,Number(qty)||0),0,now]);}

/** Fase 8.8/8.12.1: Manajemen pengguna dan verifikasi relasi Wali Santri. */
function getUserManagement(token) {
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.KASIR,FMART.ROLES.SUPERADMIN]);
  const ss=getSS_();
  const usersSheet=ss.getSheetByName('Users');
  const waliSheet=ss.getSheetByName('WaliSantri');
  const relSheet=ss.getSheetByName('WaliSantriSantri');
  if(!usersSheet) throw new Error('Data pengguna belum siap. Sheet Users tidak ditemukan.');
  if(!waliSheet) throw new Error('Data Wali Santri belum siap. Sheet WaliSantri tidak ditemukan.');
  const userRows=readRows_(usersSheet), waliRows=readRows_(waliSheet), relRows=relSheet?readRows_(relSheet):[], santriRows=readRows_(ss.getSheetByName('Santri'));
  const userMap={};
  userRows.forEach(function(r){const uid=String(r[0]||'');if(uid) userMap[uid]={userId:uid,username:String(r[1]||''),nama:String(r[4]||''),role:String(r[5]||''),status:String(r[6]||''),createdAt:dateIso_(r[7]),lastLoginAt:dateIso_(r[9])};});
  const santriMap={};
  santriRows.forEach(function(r){const id=String(r[0]||'');if(id) santriMap[id]={id:id,nis:String(r[1]||''),name:String(r[2]||''),className:String(r[3]||''),status:String(r[4]||'')};});
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
  const rows=readRows_(ss.getSheetByName('Santri')), classes={};
  rows.forEach(function(r){const id=String(r[0]||''),cls=String(r[3]||'').trim();if(!id||!cls||String(r[4]||'').toUpperCase()!=='AKTIF'||blocked[id])return;classes[cls]=true;});
  return {ok:true,classes:Object.keys(classes).sort(function(a,b){return a.localeCompare(b,'id',{numeric:true,sensitivity:'base'});})};
}

/** Fase 8.12.3: pencarian Wali real-time, opsional filter kelas. */
function searchSantriForWaliSelf(token,query,className){
  const session=requireRole_(token,[FMART.ROLES.WALI_SANTRI]);
  query=String(query||'').trim().toLowerCase();
  className=String(className||'').trim().toLowerCase();
  if(query.length===1) throw new Error('Ketik minimal 2 huruf untuk mulai mencari.');
  const ss=getSS_(), wali=findWaliByUserId_(ss,session.userId);
  if(!wali) throw new Error('Data Wali Santri tidak ditemukan.');
  const relRows=readRows_(ss.getSheetByName('WaliSantriSantri'));
  const blocked={};
  relRows.forEach(function(r){if(String(r[1]||'')===String(wali.waliId) && ['AKTIF','MENUNGGU_VERIFIKASI'].indexOf(String(r[3]||'').toUpperCase())>=0) blocked[String(r[2]||'')]=true;});
  const rows=readRows_(ss.getSheetByName('Santri')), result=[];
  rows.forEach(function(r){
    const id=String(r[0]||''),nis=String(r[1]||''),name=String(r[2]||''),cls=String(r[3]||'');
    if(!id||String(r[4]||'').toUpperCase()!=='AKTIF'||blocked[id])return;
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
    const santri=findRowById_(santriSheet,santriId,1); if(!santri||String(santri.values[4]||'').toUpperCase()!=='AKTIF') throw new Error('Data Santri tidak ditemukan atau tidak aktif.');
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
  const rows=readRows_(ss.getSheetByName('Santri')),result=[];rows.forEach(function(r){const id=String(r[0]||''),nis=String(r[1]||''),name=String(r[2]||''),cls=String(r[3]||'');if(!id||String(r[4]||'').toUpperCase()!=='AKTIF'||linked[id])return;const hay=(nis+' '+name+' '+cls).toLowerCase();if(query&&hay.indexOf(query)===-1)return;result.push({id:id,nis:nis,name:name,className:cls});});
  return {ok:true,santri:result.slice(0,50),searched:query};
}

/** Fase 8.12.1: Admin/Superadmin langsung menghubungkan Santri. Multi-Wali tetap diperbolehkan. */
function linkWaliSantri(token,waliId,santriId,hubungan){
  const session=requireRole_(token,[FMART.ROLES.ADMIN,FMART.ROLES.SUPERADMIN]);
  waliId=String(waliId||'').trim();santriId=String(santriId||'').trim();hubungan=String(hubungan||'WALI').trim().toUpperCase();
  if(!waliId||!santriId)throw new Error('Wali Santri dan Santri wajib dipilih.');if(['AYAH','IBU','WALI','LAINNYA'].indexOf(hubungan)===-1)hubungan='WALI';
  const lock=LockService.getScriptLock();lock.waitLock(10000);try{
    const ss=getSS_(),ws=ss.getSheetByName('WaliSantri'),ssheet=ss.getSheetByName('Santri'),rs=ss.getSheetByName('WaliSantriSantri');if(!ws||!ssheet||!rs)throw new Error('Database relasi Wali Santri belum siap. Jalankan setupFMartDatabase().');
    const wali=findRowById_(ws,waliId,1),santri=findRowById_(ssheet,santriId,1);if(!wali)throw new Error('Data Wali Santri tidak ditemukan.');if(!santri||String(santri.values[4]||'').toUpperCase()!=='AKTIF')throw new Error('Santri tidak ditemukan atau tidak aktif.');
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
    const wali=findRowById_(ss.getSheetByName('WaliSantri'),String(row.values[1]),1),santri=findRowById_(ss.getSheetByName('Santri'),String(row.values[2]),1);if(!wali||String(wali.values[6]||'').toUpperCase()!=='AKTIF')throw new Error('Akun Wali Santri tidak aktif.');if(!santri||String(santri.values[4]||'').toUpperCase()!=='AKTIF')throw new Error('Santri tidak aktif.');
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
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Format email tidak valid.');
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
  const sheet=getSS_().getSheetByName('Users'); const row=findRowById_(sheet,String(userId||''),1);
  if(!row) throw new Error('Pengguna tidak ditemukan.');
  const role=String(row.values[5]||'').toUpperCase();
  if(role==='SUPERADMIN') throw new Error('Status Superadmin tidak dapat diubah dari menu ini.');
  const current=String(row.values[6]||'AKTIF').toUpperCase(); const next=current==='AKTIF'?'NONAKTIF':'AKTIF';
  sheet.getRange(row.rowNumber,7).setValue(next); sheet.getRange(row.rowNumber,9).setValue(new Date());
  writeAudit_(session.userId,session.role,'TOGGLE_USER','USER',String(userId),JSON.stringify({status:current}),JSON.stringify({status:next}),'Mengubah status pengguna'); SpreadsheetApp.flush();
  return {ok:true,status:next};
}

function resetFMartUserPassword(token,userId){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const sheet=getSS_().getSheetByName('Users'); const row=findRowById_(sheet,String(userId||''),1);
  if(!row) throw new Error('Pengguna tidak ditemukan.');
  const role=String(row.values[5]||'').toUpperCase(); if(role==='SUPERADMIN') throw new Error('Password Superadmin tidak dapat direset dari menu ini.');
  const tempPassword='FM'+Math.random().toString(36).slice(2,7).toUpperCase()+Math.floor(10+Math.random()*90);
  const salt=Utilities.getUuid().replace(/-/g,''); const hash=hashPassword_(tempPassword,salt); const now=new Date();
  sheet.getRange(row.rowNumber,3,1,2).setValues([[hash,salt]]); sheet.getRange(row.rowNumber,9).setValue(now);
  writeAudit_(session.userId,session.role,'RESET_USER_PASSWORD','USER',String(userId),'',JSON.stringify({username:String(row.values[1]||''),role:role}),'Reset password pengguna'); SpreadsheetApp.flush();
  return {ok:true,tempPassword:tempPassword,username:String(row.values[1]||'')};
}

function updateFMartUser(token,userId,nama,role){
  const session=requireRole_(token,[FMART.ROLES.SUPERADMIN]);
  const sheet=getSS_().getSheetByName('Users'); const row=findRowById_(sheet,String(userId||''),1); if(!row) throw new Error('Pengguna tidak ditemukan.');
  const targetRole=String(row.values[5]||'').toUpperCase(); if(targetRole==='SUPERADMIN') throw new Error('Data Superadmin tidak dapat diubah dari menu ini.');
  nama=String(nama||'').trim().slice(0,120); role=String(role||'').toUpperCase();
  if(!nama) throw new Error('Nama wajib diisi.'); if(['ADMIN','KASIR','GUDANG','WALI_SANTRI'].indexOf(role)<0) throw new Error('Role tidak valid.');
  const before={nama:String(row.values[4]||''),role:targetRole}; sheet.getRange(row.rowNumber,5).setValue(nama); sheet.getRange(row.rowNumber,6).setValue(role); sheet.getRange(row.rowNumber,9).setValue(new Date());
  writeAudit_(session.userId,session.role,'UPDATE_USER','USER',String(userId),JSON.stringify(before),JSON.stringify({nama:nama,role:role}),'Mengubah data pengguna'); SpreadsheetApp.flush();
  return {ok:true};
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

function makeFMartId_(prefix){ return prefix + '-' + Utilities.getUuid().replace(/-/g,'').slice(0,18).toUpperCase(); }

function requireSession_(token) {
  if (!token || typeof token !== 'string') throw new Error('Sesi tidak valid. Silakan login kembali.');
  const raw = CacheService.getScriptCache().get(sessionKey_(token));
  if (!raw) throw new Error('Sesi telah berakhir. Silakan login kembali.');
  const s = JSON.parse(raw);
  if (!s.userId || !s.role) throw new Error('Sesi tidak valid.');
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
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + String(password), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes);
}

function verifyPassword_(password, salt, expectedHash) {
  return constantTimeEqual_(hashPassword_(password,salt), expectedHash);
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
