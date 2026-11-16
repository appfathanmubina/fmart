/**
 * FMart - SetupDatabase.gs
 *
 * Tugas file ini HANYA untuk menyiapkan struktur database dan konfigurasi awal.
 * Jalankan setupFMartDatabase() sekali setelah project terhubung ke Spreadsheet.
 *
 * Keamanan:
 * - Tidak menyimpan password default di source code.
 * - Tidak menghapus sheet/data yang sudah ada.
 * - Header diperiksa dan dilengkapi secara idempotent.
 */

const FMART_DB = Object.freeze({
  PROPERTY_SPREADSHEET_ID: 'FMART_SPREADSHEET_ID',
  PROPERTY_PAYMENT_PROOF_FOLDER_ID: 'FMART_PAYMENT_PROOF_FOLDER_ID',
  APP_NAME: 'FMart',
  TIMEZONE: 'Asia/Jakarta',
  SHEETS: {
    USERS: ['UserId','Username','PasswordHash','PasswordSalt','Nama','Role','Status','CreatedAt','UpdatedAt','LastLoginAt','Email','EmailVerified'],
    WALI_SANTRI: ['WaliId','UserId','NamaWali','NoHP','Email','Alamat','Status','CreatedAt','UpdatedAt'],
    SANTRI: ['SantriId','NIS','NamaSantri','Kelas','Status','CreatedAt','UpdatedAt'],
    WALI_SANTRI_SANTRI: ['RelasiId','WaliId','SantriId','Status','CreatedAt','Hubungan'],
    KATEGORI: ['KategoriId','NamaKategori','Deskripsi','Urutan','Status','CreatedAt','UpdatedAt'],
    PRODUK: ['ProdukId','KategoriId','SKU','NamaProduk','Deskripsi','Harga','StokMinimum','FotoUrl','Status','CreatedAt','UpdatedAt'],
    VARIASI_PRODUK: ['VariasiId','ProdukId','NamaVariasi','NilaiVariasi','HargaTambahan','Stok','Status','CreatedAt','UpdatedAt'],
    STOK: ['StokId','ProdukId','VariasiId','StokSaatIni','StokMinimum','UpdatedAt'],
    MUTASI_STOK: ['MutasiId','ProdukId','VariasiId','Jenis','Qty','StokSebelum','StokSesudah','ReferensiId','Keterangan','CreatedBy','CreatedAt'],
    KERANJANG: ['KeranjangId','UserId','SantriId','ProdukId','VariasiId','Qty','CreatedAt','UpdatedAt'],
    PESANAN: ['PesananId','NomorPesanan','UserId','SantriId','Subtotal','Ongkir','Diskon','Total','Status','Catatan','CreatedAt','UpdatedAt'],
    DETAIL_PESANAN: ['DetailId','PesananId','ProdukId','VariasiId','SKU','NamaProduk','NamaVariasi','Harga','Qty','Subtotal'],
    PEMBAYARAN: ['PembayaranId','PesananId','Metode','Nominal','BuktiUrl','Status','VerifiedBy','VerifiedAt','CreatedAt','UpdatedAt','BuktiSumber','SubmittedBy','Catatan'],
    PENGIRIMAN: ['PengirimanId','PesananId','Metode','Tujuan','Status','DikirimAt','DiterimaAt','UpdatedBy','UpdatedAt'],
    NOTIFIKASI: ['NotifikasiId','UserId','PesananId','Judul','Pesan','Jenis','IsRead','CreatedAt'],
    PENGATURAN: ['Key','Value','Description','UpdatedAt'],
    AUDIT_LOG: ['AuditId','ActorUserId','ActorRole','Action','EntityType','EntityId','BeforeData','AfterData','Note','CreatedAt']
  }
});

function setupFMartDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka project FMart dari Spreadsheet yang akan digunakan, lalu jalankan setupFMartDatabase().');

  PropertiesService.getScriptProperties().setProperty(FMART_DB.PROPERTY_SPREADSHEET_ID, ss.getId());

  Object.keys(FMART_DB.SHEETS).forEach(function(key) {
    ensureSheet_(ss, FMART_DB.SHEETS[key], sheetNameForKey_(key));
  });

  seedSettings_(ss.getSheetByName('Pengaturan'));
  SpreadsheetApp.flush();
  return 'Database FMart siap: ' + ss.getName();
}

function ensureSheet_(ss, headers, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const needed = headers.length;
  if (sheet.getMaxColumns() < needed) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
  }

  const current = sheet.getRange(1, 1, 1, needed).getValues()[0];
  headers.forEach(function(header, i) {
    if (!String(current[i] || '').trim()) sheet.getRange(1, i + 1).setValue(header);
  });

  sheet.getRange(1, 1, 1, needed)
    .setFontWeight('bold')
    .setBackground('#eadcff')
    .setFontColor('#4c1d95');
  sheet.setFrozenRows(1);
  return sheet;
}

function sheetNameForKey_(key) {
  const map = {
    USERS:'Users', WALI_SANTRI:'WaliSantri', SANTRI:'Santri', WALI_SANTRI_SANTRI:'WaliSantriSantri',
    KATEGORI:'Kategori', PRODUK:'Produk', VARIASI_PRODUK:'VariasiProduk', STOK:'Stok', MUTASI_STOK:'MutasiStok',
    KERANJANG:'Keranjang', PESANAN:'Pesanan', DETAIL_PESANAN:'DetailPesanan', PEMBAYARAN:'Pembayaran',
    PENGIRIMAN:'Pengiriman', NOTIFIKASI:'Notifikasi', PENGATURAN:'Pengaturan', AUDIT_LOG:'AuditLog'
  };
  return map[key] || key;
}

function seedSettings_(sheet) {
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat().map(String)
    : [];
  const defaults = [
    ['APP_NAME','FMart','Nama aplikasi'],
    ['INTEGRATION_TABUNGAN_SPREADSHEET_ID','','Opsional: Spreadsheet Tabungan untuk integrasi baca/rekap'],
    ['REPORTING_DEFAULT_DAYS','30','Periode laporan default dalam hari'],
    ['TIMEZONE','Asia/Jakarta','Zona waktu aplikasi'],
    ['CURRENCY','IDR','Mata uang'],
    ['ORDER_STATUS_FLOW','MENUNGGU_PEMBAYARAN,DIBAYAR,DIPROSES,DISIAPKAN,DIANTAR,DITERIMA,DIBATALKAN','Urutan status pesanan'],
    ['PAYMENT_BANK_NAME','','Nama bank rekening pembayaran FMart'],
    ['PAYMENT_ACCOUNT_NUMBER','','Nomor rekening pembayaran FMart'],
    ['PAYMENT_ACCOUNT_NAME','','Nama pemilik rekening pembayaran FMart'],
    ['PAYMENT_ADMIN_WHATSAPP','','Nomor WhatsApp Admin/Kasir untuk konfirmasi pembayaran']
  ];
  defaults.forEach(function(row) {
    if (existing.indexOf(row[0]) === -1) sheet.appendRow(row.concat([new Date()]));
  });
}

/**
 * Membuat akun awal secara manual.
 * Jalankan dari editor Apps Script, lalu hapus data sensitif dari riwayat/log Anda sendiri.
 * Password tidak pernah ditulis ke Spreadsheet dalam bentuk plaintext.
 */
function createFMartUser(username, password, nama, role, email) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  nama = String(nama || '').trim();
  role = String(role || 'WALI_SANTRI').trim().toUpperCase();

  if (password.length < 10) throw new Error('Password minimal 10 karakter.');
  if (!nama) throw new Error('Nama wajib diisi.');
  email = String(email || '').trim().toLowerCase();
  if (['WALI_SANTRI','ADMIN','KASIR','GUDANG','SUPERADMIN'].indexOf(role) === -1) throw new Error('Role tidak valid.');
  if (['ADMIN','SUPERADMIN','KASIR','GUDANG'].indexOf(role) >= 0) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) {
      throw new Error('Email petugas wajib diisi dengan format yang valid.');
    }
    username = email;
  } else if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new Error('Username hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda minus.');
  }
  if (!username || username.length < 4) throw new Error('Username minimal 4 karakter.');

  const ss = getSetupSpreadsheet_();
  const sheet = ss.getSheetByName('Users');
  if (!sheet) throw new Error('Jalankan setupFMartDatabase() terlebih dahulu.');

  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues() : [];
  if (rows.some(function(r){ return String(r[1] || '').trim().toLowerCase() === username; })) {
    throw new Error('Username sudah digunakan.');
  }
  if (email && rows.some(function(r){ return String(r[10] || '').trim().toLowerCase() === email; })) throw new Error('Email sudah digunakan akun lain.');

  const userId = 'USR-' + Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase();
  const salt = Utilities.getUuid().replace(/-/g,'');
  const hash = hashPassword_(password, salt);
  const now = new Date();
  sheet.appendRow([userId,username,hash,salt,nama,role,'AKTIF',now,now,'',email,false]);
  SpreadsheetApp.flush();
  return {ok:true,userId:userId,username:username,role:role};
  } finally { lock.releaseLock(); }
}

/**
 * Bootstrap aman untuk akun Superadmin pertama.
 *
 * ATURAN:
 * - Hanya dapat berhasil jika BELUM ada Superadmin AKTIF.
 * - Username/password diberikan saat menjalankan fungsi dari editor Apps Script;
 *   tidak pernah ditulis ke source code atau Spreadsheet sebagai plaintext.
 * - Password langsung diproses menjadi hash + salt oleh createFMartUser().
 * - Setelah Superadmin pertama ada, fungsi ini terkunci dan tidak dapat membuat
 *   Superadmin kedua melalui jalur bootstrap.
 *
 * Cara penggunaan utama:
 *   Jalankan createInitialFMartSuperadmin() tanpa parameter dari Apps Script Editor.
 *   Sistem akan meminta username, nama, dan password melalui dialog Spreadsheet.
 *
 * Pemanggilan dengan parameter tetap didukung untuk kebutuhan administrasi terkontrol,
 * tetapi jangan menaruh password nyata di source code.
 */
function createInitialFMartSuperadmin(username, password, nama, email) {
  if (arguments.length === 0 || (!username && !password && !nama && !email)) {
    const ui = SpreadsheetApp.getUi();
    const u = ui.prompt('FMart — Buat Superadmin Pertama', 'Email Superadmin:', ui.ButtonSet.OK_CANCEL);
    if (u.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    const n = ui.prompt('FMart — Buat Superadmin Pertama', 'Nama Superadmin:', ui.ButtonSet.OK_CANCEL);
    if (n.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    const pw = ui.prompt('FMart — Buat Superadmin Pertama', 'Password Superadmin (minimal 10 karakter):', ui.ButtonSet.OK_CANCEL);
    if (pw.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    email = u.getResponseText();
    username = email;
    nama = n.getResponseText();
    password = pw.getResponseText();
  }
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  nama = String(nama || '').trim();
  email = String(email || username || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) throw new Error('Email Superadmin wajib valid.');
  username = email;
  if (!username || !password || !nama) throw new Error('Email, password, dan nama wajib diisi.');
  if (password.length < 10) throw new Error('Password Superadmin minimal 10 karakter. Gunakan password yang kuat dan unik.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSetupSpreadsheet_();
    const sheet = ss.getSheetByName('Users');
    if (!sheet) throw new Error('Sheet Users tidak ditemukan. Jalankan setupFMartDatabase() terlebih dahulu.');
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues() : [];
    if (rows.some(function(r){ return String(r[5]||'').trim().toUpperCase()==='SUPERADMIN' && String(r[6]||'').trim().toUpperCase()==='AKTIF'; })) {
      throw new Error('Bootstrap dikunci: sudah ada Superadmin aktif. Gunakan manajemen pengguna setelah login.');
    }
    if (rows.some(function(r){ return String(r[1]||'').trim().toLowerCase()===username; })) {
      throw new Error('Username sudah digunakan. Pilih username lain.');
    }

    const result = createFMartUser(username, password, nama, 'SUPERADMIN', email);
    SpreadsheetApp.flush();
    const lastRow = sheet.getLastRow();
    const savedRows = lastRow > 1 ? sheet.getRange(2,1,lastRow-1,12).getValues() : [];
    const saved = savedRows.some(function(r){ return String(r[0]||'').trim()===String(result.userId); });
    if (!saved) throw new Error('Akun gagal diverifikasi setelah penyimpanan. Periksa Spreadsheet tujuan FMart.');

    const audit = ss.getSheetByName('AuditLog');
    if (audit) {
      audit.appendRow(['AUD-'+Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase(),'','SYSTEM','BOOTSTRAP_SUPERADMIN','USER',result.userId,'',JSON.stringify({username:result.username,role:result.role}),'Superadmin pertama dibuat melalui bootstrap setup.',new Date()]);
      SpreadsheetApp.flush();
    }

    const message = 'Superadmin berhasil dibuat dan diverifikasi.\n\nUsername: '+result.username+'\nNama: '+nama+'\nSpreadsheet tujuan: '+ss.getName()+'\n\nSilakan login menggunakan akun tersebut.';
    try { SpreadsheetApp.getUi().alert('FMart — Bootstrap Berhasil', message, SpreadsheetApp.getUi().ButtonSet.OK); } catch(e) {}
    return {ok:true,userId:result.userId,username:result.username,role:result.role,spreadsheetName:ss.getName(),spreadsheetId:ss.getId(),message:message};
  } finally { lock.releaseLock(); }
}


/**
 * Migrasi email untuk Superadmin lama.
 *
 * Sebelum dijalankan, isi Script Property:
 *   FMART_INITIAL_SUPERADMIN_EMAIL = alamat email Superadmin
 *
 * Fungsi ini tidak memakai SpreadsheetApp.getUi(), sehingga dapat dijalankan
 * langsung dari Apps Script Editor pada project standalone.
 */
function prepareExistingSuperadminEmail_() {
  const properties = PropertiesService.getScriptProperties();
  const email = String(properties.getProperty('FMART_INITIAL_SUPERADMIN_EMAIL') || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) {
    throw new Error('Isi Script Property FMART_INITIAL_SUPERADMIN_EMAIL dengan alamat email yang valid terlebih dahulu.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSetupSpreadsheet_();
    const sheet = ss.getSheetByName('Users');
    if (!sheet || sheet.getLastRow() < 2) throw new Error('Data Users belum tersedia.');
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues();
    const admins = rows.map(function(r, i) {
      return {row: i + 2, values: r};
    }).filter(function(x) {
      return String(x.values[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
        String(x.values[6] || '').trim().toUpperCase() === 'AKTIF';
    });

    if (admins.length !== 1) {
      throw new Error('Migrasi hanya berjalan jika tepat satu Superadmin aktif. Periksa data Users terlebih dahulu.');
    }

    const target = admins[0];
    const targetId = String(target.values[0] || '');
    const duplicate = rows.some(function(r) {
      if (String(r[0] || '') === targetId) return false;
      const username = String(r[1] || '').trim().toLowerCase();
      const existingEmail = String(r[10] || '').trim().toLowerCase();
      return username === email || existingEmail === email;
    });
    if (duplicate) throw new Error('Email sudah digunakan sebagai username atau email akun lain.');

    const now = new Date();
    sheet.getRange(target.row, 2).setValue(email);
    sheet.getRange(target.row, 9).setValue(now);
    sheet.getRange(target.row, 11, 1, 2).setValues([[email, false]]);
    SpreadsheetApp.flush();

    const saved = sheet.getRange(target.row, 2, 1, 11).getValues()[0];
    if (String(saved[0] || '').trim().toLowerCase() !== email ||
        String(saved[9] || '').trim().toLowerCase() !== email ||
        saved[10] !== false) {
      throw new Error('Perubahan email belum berhasil diverifikasi pada sheet Users.');
    }

    properties.deleteProperty('FMART_INITIAL_SUPERADMIN_EMAIL');
    const message = 'Email Superadmin berhasil disiapkan. Login Admin berikutnya menggunakan email tersebut dan password lama. OTP akan dikirim ke alamat email ini.';
    return {
      ok: true,
      email: email,
      userId: targetId,
      emailVerified: false,
      spreadsheetName: ss.getName(),
      message: message
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fungsi publik untuk dijalankan dari daftar fungsi Apps Script Editor.
 */
function prepareExistingSuperadminEmail() {
  return prepareExistingSuperadminEmail_();
}

function getSetupSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(FMART_DB.PROPERTY_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet FMart tidak ditemukan.');
  return ss;
}


/**
 * Mengganti Superadmin lama melalui Apps Script Editor tanpa dialog dan tanpa
 * Script Property kredensial. Data sementara dimasukkan pada sheet khusus.
 *
 * Jalankan pertama kali untuk membuat sheet FMart_AdminSetup.
 * Isi B2 (email), B3 (nama), B4 (password), lalu jalankan fungsi ini lagi.
 * Setelah akun baru berhasil diverifikasi dan Superadmin lama dinonaktifkan,
 * nilai B2:B4 dikosongkan otomatis.
 */
function replaceFMartSuperadminFromEditor() {
  const ss = getSetupSpreadsheet_();
  const setupName = 'FMart_AdminSetup';
  let inputSheet = ss.getSheetByName(setupName);

  if (!inputSheet) {
    inputSheet = ss.insertSheet(setupName);
    inputSheet.getRange('A1:B4').setValues([
      ['FMart — Penggantian Superadmin', 'Isi kolom B, lalu jalankan fungsi lagi'],
      ['Email Superadmin baru', ''],
      ['Nama Superadmin baru', ''],
      ['Password baru (minimal 10 karakter)', '']
    ]);
    inputSheet.getRange('A1:B1').setFontWeight('bold').setBackground('#eadcff').setFontColor('#4c1d95');
    inputSheet.setColumnWidth(1, 260);
    inputSheet.setColumnWidth(2, 360);
    inputSheet.setFrozenRows(1);
    return {
      ok: true,
      readyForInput: true,
      spreadsheetName: ss.getName(),
      sheetName: setupName,
      message: 'Sheet FMart_AdminSetup telah dibuat. Isi B2 dengan email, B3 dengan nama, dan B4 dengan password baru. Setelah itu jalankan replaceFMartSuperadminFromEditor() sekali lagi.'
    };
  }

  const email = String(inputSheet.getRange('B2').getDisplayValue() || '').trim().toLowerCase();
  const nama = String(inputSheet.getRange('B3').getDisplayValue() || '').trim();
  const password = String(inputSheet.getRange('B4').getValue() || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(email)) {
    throw new Error('Isi B2 pada sheet FMart_AdminSetup dengan alamat email yang valid.');
  }
  if (!nama) throw new Error('Isi B3 pada sheet FMart_AdminSetup dengan nama Superadmin baru.');
  if (password.length < 10) throw new Error('Isi B4 dengan password minimal 10 karakter.');

  const users = ss.getSheetByName('Users');
  if (!users || users.getLastRow() < 2) throw new Error('Sheet Users belum tersedia atau belum memiliki data.');
  const beforeRows = users.getRange(2, 1, users.getLastRow() - 1, 12).getValues();
  const activeOld = beforeRows.map(function(row, index) {
    return {rowNumber: index + 2, values: row};
  }).filter(function(item) {
    return String(item.values[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
      String(item.values[6] || '').trim().toUpperCase() === 'AKTIF';
  });

  if (activeOld.length !== 1) {
    throw new Error('Penggantian dibatalkan: harus ada tepat satu Superadmin lama yang aktif. Tidak ada akun yang diubah.');
  }

  const oldUserId = String(activeOld[0].values[0] || '');
  const oldUsername = String(activeOld[0].values[1] || '');
  const newUsername = email;

  if (oldUsername.toLowerCase() === newUsername) {
    throw new Error('Email baru sama dengan username akun lama. Gunakan email berbeda untuk akun pengganti.');
  }

  // createFMartUser mengelola lock-nya sendiri. Akun lama tetap aktif sampai
  // akun baru tersimpan dan diverifikasi.
  const created = createFMartUser(newUsername, password, nama, 'SUPERADMIN', email);
  SpreadsheetApp.flush();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const latestLastRow = users.getLastRow();
    const latestRows = latestLastRow > 1 ? users.getRange(2, 1, latestLastRow - 1, 12).getValues() : [];
    const newRowIndex = latestRows.findIndex(function(row) {
      return String(row[0] || '') === String(created.userId) &&
        String(row[1] || '').trim().toLowerCase() === email &&
        String(row[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
        String(row[6] || '').trim().toUpperCase() === 'AKTIF' &&
        String(row[10] || '').trim().toLowerCase() === email;
    });
    if (newRowIndex < 0) {
      throw new Error('Akun baru belum dapat diverifikasi. Superadmin lama tetap aktif; periksa sheet Users.');
    }

    const oldRowIndex = latestRows.findIndex(function(row) {
      return String(row[0] || '') === oldUserId &&
        String(row[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
        String(row[6] || '').trim().toUpperCase() === 'AKTIF';
    });
    if (oldRowIndex < 0) {
      throw new Error('Akun baru berhasil dibuat, tetapi akun lama berubah selama proses. Periksa sheet Users sebelum melanjutkan.');
    }

    const oldSheetRow = oldRowIndex + 2;
    const now = new Date();
    users.getRange(oldSheetRow, 7).setValue('NONAKTIF');
    users.getRange(oldSheetRow, 9).setValue(now);
    SpreadsheetApp.flush();

    const savedOld = users.getRange(oldSheetRow, 1, 1, 12).getValues()[0];
    const savedNew = users.getRange(newRowIndex + 2, 1, 1, 12).getValues()[0];
    if (String(savedOld[6] || '').trim().toUpperCase() !== 'NONAKTIF' ||
        String(savedNew[6] || '').trim().toUpperCase() !== 'AKTIF') {
      throw new Error('Verifikasi akhir belum berhasil. Periksa status kedua akun pada sheet Users.');
    }

    const audit = ss.getSheetByName('AuditLog');
    if (audit) {
      audit.appendRow([
        'AUD-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16).toUpperCase(),
        '',
        'SYSTEM',
        'REPLACE_SUPERADMIN',
        'USER',
        oldUserId,
        JSON.stringify({username: oldUsername, role: 'SUPERADMIN', status: 'AKTIF'}),
        JSON.stringify({username: oldUsername, role: 'SUPERADMIN', status: 'NONAKTIF', replacementUserId: created.userId}),
        'Akun Superadmin diganti melalui Apps Script Editor.',
        now
      ]);
    }

    inputSheet.getRange('B2:B4').clearContent();
    SpreadsheetApp.flush();

    return {
      ok: true,
      oldUserId: oldUserId,
      oldStatus: 'NONAKTIF',
      newUserId: created.userId,
      newUsername: email,
      newRole: 'SUPERADMIN',
      newStatus: 'AKTIF',
      emailVerified: false,
      spreadsheetName: ss.getName(),
      message: 'Superadmin baru berhasil dibuat dan diverifikasi. Akun lama telah dinonaktifkan. Data input sementara sudah dikosongkan. Login berikutnya menggunakan email, password baru, dan OTP email.'
    };
  } finally {
    lock.releaseLock();
  }
}
