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
    USERS: ['UserId','Username','PasswordHash','PasswordSalt','Nama','Role','Status','CreatedAt','UpdatedAt','LastLoginAt'],
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
function createFMartUser(username, password, nama, role) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  nama = String(nama || '').trim();
  role = String(role || 'WALI_SANTRI').trim().toUpperCase();

  if (!username || username.length < 4) throw new Error('Username minimal 4 karakter.');
  if (!/^[a-z0-9._-]+$/.test(username)) throw new Error('Username hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda minus.');
  if (password.length < 6) throw new Error('Password minimal 6 karakter.');
  if (!nama) throw new Error('Nama wajib diisi.');
  if (['WALI_SANTRI','ADMIN','KASIR','GUDANG','SUPERADMIN'].indexOf(role) === -1) throw new Error('Role tidak valid.');

  const ss = getSetupSpreadsheet_();
  const sheet = ss.getSheetByName('Users');
  if (!sheet) throw new Error('Jalankan setupFMartDatabase() terlebih dahulu.');

  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,10).getValues() : [];
  if (rows.some(function(r){ return String(r[1] || '').trim().toLowerCase() === username; })) {
    throw new Error('Username sudah digunakan.');
  }

  const userId = 'USR-' + Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase();
  const salt = Utilities.getUuid().replace(/-/g,'');
  const hash = hashPassword_(password, salt);
  const now = new Date();
  sheet.appendRow([userId,username,hash,salt,nama,role,'AKTIF',now,now,'']);
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
function createInitialFMartSuperadmin(username, password, nama) {
  if (arguments.length === 0 || (!username && !password && !nama)) {
    const ui = SpreadsheetApp.getUi();
    const u = ui.prompt('FMart — Buat Superadmin Pertama', 'Username Superadmin:', ui.ButtonSet.OK_CANCEL);
    if (u.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    const n = ui.prompt('FMart — Buat Superadmin Pertama', 'Nama Superadmin:', ui.ButtonSet.OK_CANCEL);
    if (n.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    const pw = ui.prompt('FMart — Buat Superadmin Pertama', 'Password Superadmin (minimal 6 karakter):', ui.ButtonSet.OK_CANCEL);
    if (pw.getSelectedButton() !== ui.Button.OK) return {ok:false, cancelled:true};
    username = u.getResponseText();
    nama = n.getResponseText();
    password = pw.getResponseText();
  }
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  nama = String(nama || '').trim();
  if (!username || !password || !nama) throw new Error('Username, password, dan nama wajib diisi.');
  if (password.length < 6) throw new Error('Password Superadmin minimal 6 karakter. Gunakan password yang kuat dan unik.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSetupSpreadsheet_();
    const sheet = ss.getSheetByName('Users');
    if (!sheet) throw new Error('Sheet Users tidak ditemukan. Jalankan setupFMartDatabase() terlebih dahulu.');
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,10).getValues() : [];
    if (rows.some(function(r){ return String(r[5]||'').trim().toUpperCase()==='SUPERADMIN' && String(r[6]||'').trim().toUpperCase()==='AKTIF'; })) {
      throw new Error('Bootstrap dikunci: sudah ada Superadmin aktif. Gunakan manajemen pengguna setelah login.');
    }
    if (rows.some(function(r){ return String(r[1]||'').trim().toLowerCase()===username; })) {
      throw new Error('Username sudah digunakan. Pilih username lain.');
    }

    const result = createFMartUser(username, password, nama, 'SUPERADMIN');
    SpreadsheetApp.flush();
    const lastRow = sheet.getLastRow();
    const savedRows = lastRow > 1 ? sheet.getRange(2,1,lastRow-1,10).getValues() : [];
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

function getSetupSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(FMART_DB.PROPERTY_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet FMart tidak ditemukan.');
  return ss;
}
