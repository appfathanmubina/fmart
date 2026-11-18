/**
 * FMart - SetupDatabase.gs
 *
 * Tugas file ini HANYA untuk menyiapkan struktur database dan konfigurasi awal.
 * Jalankan setupFMartDatabase_() sekali setelah project terhubung ke Spreadsheet.
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
    SANTRI: ['nis','nama_santri','kelas','asrama','saldo_fpay','limit_harian','nama_wali','no_wa_wali','SantriId','Status','CreatedAt','UpdatedAt'],
    WALI_SANTRI_SANTRI: ['RelasiId','WaliId','SantriId','Status','CreatedAt','Hubungan'],
    KATEGORI: ['KategoriId','NamaKategori','Deskripsi','Urutan','Status','CreatedAt','UpdatedAt'],
    PRODUK: ['ProdukId','KategoriId','SKU','NamaProduk','Deskripsi','Harga','StokMinimum','FotoUrl','Status','CreatedAt','UpdatedAt'],
    VARIASI_PRODUK: ['VariasiId','ProdukId','NamaVariasi','NilaiVariasi','HargaTambahan','Stok','Status','CreatedAt','UpdatedAt'],
    STOK: ['StokId','ProdukId','VariasiId','StokSaatIni','StokMinimum','UpdatedAt'],
    MUTASI_STOK: ['MutasiId','ProdukId','VariasiId','Jenis','Qty','StokSebelum','StokSesudah','ReferensiId','Keterangan','CreatedBy','CreatedAt'],
    PENERIMAAN_BARANG: ['PenerimaanId','NomorPenerimaan','Pemasok','ReferensiDokumen','TanggalTerima','Catatan','JumlahBaris','TotalQty','CreatedBy','CreatedAt'],
    DETAIL_PENERIMAAN_BARANG: ['DetailPenerimaanId','PenerimaanId','ProdukId','VariasiId','Qty','StokSebelum','StokSesudah','Catatan'],
    KERANJANG: ['KeranjangId','UserId','SantriId','ProdukId','VariasiId','Qty','CreatedAt','UpdatedAt'],
    PESANAN: ['PesananId','NomorPesanan','UserId','SantriId','Subtotal','Ongkir','Diskon','Total','Status','Catatan','CreatedAt','UpdatedAt'],
    DETAIL_PESANAN: ['DetailId','PesananId','ProdukId','VariasiId','SKU','NamaProduk','NamaVariasi','Harga','Qty','Subtotal'],
    PEMBAYARAN: ['PembayaranId','PesananId','Metode','Nominal','BuktiUrl','Status','VerifiedBy','VerifiedAt','CreatedAt','UpdatedAt','BuktiSumber','SubmittedBy','Catatan'],
    PENGIRIMAN: ['PengirimanId','PesananId','Metode','Tujuan','Status','DikirimAt','DiterimaAt','UpdatedBy','UpdatedAt'],
    PENGANTARAN: ['PengantaranId','PesananId','PetugasUserId','Status','DitugaskanOleh','DitugaskanAt','DiambilAt','MulaiAt','SelesaiAt','GagalAt','KodeGagal','Catatan','UpdatedAt'],
    BUKTI_PENGANTARAN: ['BuktiId','PesananId','PengantaranId','DriveFileId','FileUrl','FileName','MimeType','FileSizeBytes','Catatan','UploadedBy','UploadedAt'],
    KONFIRMASI_PENGANTARAN: ['KonfirmasiId','PesananId','BuktiUploadedAt','BatasKonfirmasiAt','Status','MetodeKonfirmasi','DikonfirmasiAt','DikonfirmasiOleh','KomplainAktif','UpdatedAt'],
    KOMPLAIN_PENGANTARAN: ['KomplainId','PesananId','KonfirmasiId','DilaporkanOleh','JenisMasalah','Keterangan','Status','DilaporkanAt','DitanganiOleh','Penyelesaian','DiselesaikanAt','UpdatedAt'],
    RIWAYAT_PENGANTARAN: ['RiwayatId','PesananId','PengantaranId','ActorUserId','ActorRole','Action','StatusSebelum','StatusSesudah','Catatan','CreatedAt'],
    NOTIFIKASI: ['NotifikasiId','UserId','PesananId','Judul','Pesan','Jenis','IsRead','CreatedAt'],
    PENGATURAN: ['Key','Value','Description','UpdatedAt'],
    RESERVASI_STOK: ['ReservasiId','PesananId','ProdukId','VariasiId','Qty','Status','CreatedAt','ExpiresAt','UpdatedAt'],
    PENJUALAN_TOKO: ['PenjualanId','NomorTransaksi','JenisPembeli','NamaPembeli','SantriId','Subtotal','Diskon','Total','MetodePembayaran','NominalDiterima','Kembalian','StatusPembayaran','StatusTransaksi','KasirUserId','Catatan','CreatedAt','UpdatedAt'],
    DETAIL_PENJUALAN_TOKO: ['DetailPenjualanId','PenjualanId','ProdukId','VariasiId','SKU','NamaProduk','NamaVariasi','Harga','Qty','Subtotal'],
    AUDIT_LOG: ['AuditId','ActorUserId','ActorRole','Action','EntityType','EntityId','BeforeData','AfterData','Note','CreatedAt']
  }
});

function setupFMartDatabase_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka project FMart dari Spreadsheet yang akan digunakan, lalu jalankan setupFMartDatabase_().');

  PropertiesService.getScriptProperties().setProperty(FMART_DB.PROPERTY_SPREADSHEET_ID, ss.getId());

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    Object.keys(FMART_DB.SHEETS).forEach(function(key) {
      ensureSheet_(ss, FMART_DB.SHEETS[key], sheetNameForKey_(key));
    });

    seedSettings_(ss.getSheetByName('Pengaturan'));
    SpreadsheetApp.flush();
    return 'Database FMart siap: ' + ss.getName();
  } finally {
    lock.releaseLock();
  }
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
    KATEGORI:'Kategori', PRODUK:'Produk', VARIASI_PRODUK:'VariasiProduk', STOK:'Stok', MUTASI_STOK:'MutasiStok', PENERIMAAN_BARANG:'PenerimaanBarang', DETAIL_PENERIMAAN_BARANG:'DetailPenerimaanBarang',
    KERANJANG:'Keranjang', PESANAN:'Pesanan', DETAIL_PESANAN:'DetailPesanan', PEMBAYARAN:'Pembayaran',
    PENGIRIMAN:'Pengiriman', PENGANTARAN:'Pengantaran', BUKTI_PENGANTARAN:'BuktiPengantaran',
    KONFIRMASI_PENGANTARAN:'KonfirmasiPengantaran', KOMPLAIN_PENGANTARAN:'KomplainPengantaran',
    RIWAYAT_PENGANTARAN:'RiwayatPengantaran', RESERVASI_STOK:'ReservasiStok',
    PENJUALAN_TOKO:'PenjualanToko', DETAIL_PENJUALAN_TOKO:'DetailPenjualanToko',
    NOTIFIKASI:'Notifikasi', PENGATURAN:'Pengaturan', AUDIT_LOG:'AuditLog'
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
    ['ORDER_STATUS_FLOW','MENUNGGU_PEMBAYARAN,DIBAYAR,DIPROSES,DISIAPKAN,SIAP_DIAMBIL,DIANTAR,DITERIMA,DIBATALKAN','Urutan status pesanan'],
    ['DELIVERY_CONFIRMATION_DAYS','7','Batas konfirmasi penerimaan setelah bukti pengantaran diunggah (hari kalender x 24 jam)'],
    ['DELIVERY_AUTO_CONFIRM_ENABLED','TRUE','Aktifkan auto konfirmasi setelah tenggat 7 hari dan tanpa komplain aktif'],
    ['PAYMENT_BANK_NAME','','Nama bank rekening pembayaran FMart'],
    ['PAYMENT_ACCOUNT_NUMBER','','Nomor rekening pembayaran FMart'],
    ['PAYMENT_ACCOUNT_NAME','','Nama pemilik rekening pembayaran FMart'],
    ['PAYMENT_ADMIN_WHATSAPP','','Nomor WhatsApp Admin/Kasir untuk konfirmasi pembayaran'],
    ['PAYMENT_QRIS_IMAGE_URL','','URL HTTPS gambar kode QRIS FMart'],
    ['STOCK_RESERVATION_MINUTES','30','Masa reservasi stok sejak checkout sebelum bukti pembayaran diajukan (menit)'],
    ['PAYMENT_RESERVATION_MINUTES','120','Masa reservasi stok setelah bukti pembayaran diajukan (menit)'],
    ['PAYMENT_VERIFICATION_QUEUE_LIMIT','50','Batas jumlah pengajuan pembayaran menunggu verifikasi']
  ];
  defaults.forEach(function(row) {
    if (existing.indexOf(row[0]) === -1) sheet.appendRow(row.concat([new Date()]));
  });
}

/**
 * Audit read-only untuk memeriksa struktur dan relasi database FMart.
 * Fungsi ini tidak mengubah sheet, header, maupun isi data.
 * Jalankan dari Apps Script Editor: auditFMartDatabaseIntegrity_()
 */
function auditFMartDatabaseIntegrity_() {
  const ss = getSetupSpreadsheet_();
  const issues = [];
  const rowsBySheet = {};
  const validSchema = {};
  const counts = {};
  const maxIssues = 500;

  function addIssue_(code, sheetName, rowNumber, detail) {
    if (issues.length >= maxIssues) return;
    issues.push({
      code: code,
      sheet: sheetName,
      row: rowNumber || '',
      detail: detail || ''
    });
  }

  function hasData_(row) {
    return row.some(function(value) {
      return value !== '' && value !== null;
    });
  }

  Object.keys(FMART_DB.SHEETS).forEach(function(key) {
    const sheetName = sheetNameForKey_(key);
    const expected = FMART_DB.SHEETS[key];
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      addIssue_('MISSING_SHEET', sheetName, '', 'Sheet wajib belum tersedia.');
      validSchema[sheetName] = false;
      rowsBySheet[sheetName] = [];
      counts[sheetName] = 0;
      return;
    }

    const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0]
      .map(function(value) { return String(value || '').trim(); });
    const mismatches = [];
    expected.forEach(function(header, index) {
      if (actual[index] !== header) {
        mismatches.push({
          column: index + 1,
          expected: header,
          actual: actual[index]
        });
      }
    });

    if (mismatches.length) {
      addIssue_('HEADER_MISMATCH', sheetName, 1, JSON.stringify(mismatches));
    }

    const lastColumn = sheet.getLastColumn();
    if (lastColumn > expected.length) {
      const extraHeaders = sheet.getRange(1, expected.length + 1, 1, lastColumn - expected.length)
        .getDisplayValues()[0]
        .map(function(value, index) {
          return String(value || '').trim() ? {
            column: expected.length + index + 1,
            header: String(value).trim()
          } : null;
        })
        .filter(function(value) { return value !== null; });
      if (extraHeaders.length) {
        addIssue_('UNEXPECTED_COLUMNS', sheetName, 1, JSON.stringify(extraHeaders));
      }
    }

    validSchema[sheetName] = mismatches.length === 0;
    const dataRows = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, expected.length).getValues()
      : [];
    rowsBySheet[sheetName] = dataRows;
    counts[sheetName] = dataRows.filter(hasData_).length;
  });

  Object.keys(FMART_DB.SHEETS).forEach(function(key) {
    const sheetName = sheetNameForKey_(key);
    if (!validSchema[sheetName]) return;
    const rows = rowsBySheet[sheetName];
    const seen = Object.create(null);
    rows.forEach(function(row, index) {
      if (!hasData_(row)) return;
      const idColumn = sheetName === 'Santri' ? 8 : 0;
      const id = String(row[idColumn] || '').trim();
      const rowNumber = index + 2;
      if (!id) {
        addIssue_('EMPTY_PRIMARY_ID', sheetName, rowNumber, 'Kolom ID utama kosong.');
      } else if (seen[id]) {
        addIssue_('DUPLICATE_PRIMARY_ID', sheetName, rowNumber, 'ID utama duplikat; baris pertama ' + seen[id] + '.');
      } else {
        seen[id] = rowNumber;
      }
    });
  });

  function checkUnique_(sheetName, columnIndex, label, normalize) {
    if (!validSchema[sheetName]) return;
    const seen = {};
    rowsBySheet[sheetName].forEach(function(row, index) {
      if (!hasData_(row)) return;
      const value = normalize ? normalize(row[columnIndex]) : String(row[columnIndex] || '').trim();
      if (!value) return;
      if (seen[value]) {
        addIssue_('DUPLICATE_' + label, sheetName, index + 2, label + ' duplikat; baris pertama ' + seen[value] + '.');
      } else {
        seen[value] = index + 2;
      }
    });
  }

  checkUnique_('Santri', 0, 'NIS', function(value) { return String(value || '').trim().toUpperCase(); });
  checkUnique_('Users', 1, 'USERNAME', function(value) { return String(value || '').trim().toLowerCase(); });
  checkUnique_('Users', 10, 'EMAIL', function(value) { return String(value || '').trim().toLowerCase(); });
  checkUnique_('WaliSantri', 1, 'WALI_USER_ID', function(value) { return String(value || '').trim(); });
  checkUnique_('WaliSantri', 3, 'WALI_PHONE', function(value) { return normalizePhone_(value) || String(value || '').trim(); });

  if (validSchema.Users) {
    const activeSuperadmins = rowsBySheet.Users.filter(function(row) {
      return String(row[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
        String(row[6] || '').trim().toUpperCase() === 'AKTIF';
    }).length;
    if (activeSuperadmins === 0) {
      addIssue_('NO_ACTIVE_SUPERADMIN', 'Users', '', 'Tidak ditemukan akun Superadmin aktif.');
    }
  }

  function idSet_(sheetName) {
    const result = Object.create(null);
    if (!validSchema[sheetName]) return result;
    const idColumn = sheetName === 'Santri' ? 8 : 0;
    rowsBySheet[sheetName].forEach(function(row) {
      const id = String(row[idColumn] || '').trim();
      if (id) result[id] = true;
    });
    return result;
  }

  function checkReference_(sourceName, sourceColumn, targetName, label, optional) {
    if (!validSchema[sourceName] || !validSchema[targetName]) return;
    const targets = idSet_(targetName);
    rowsBySheet[sourceName].forEach(function(row, index) {
      if (!hasData_(row)) return;
      const value = String(row[sourceColumn] || '').trim();
      if (!value && optional) return;
      if (!value || !targets[value]) {
        addIssue_('BROKEN_REFERENCE', sourceName, index + 2,
          label + ' tidak ditemukan pada sheet ' + targetName + '.');
      }
    });
  }

  checkReference_('WaliSantri', 1, 'Users', 'UserId WaliSantri', false);
  checkReference_('WaliSantriSantri', 1, 'WaliSantri', 'WaliId relasi', false);
  checkReference_('WaliSantriSantri', 2, 'Santri', 'SantriId relasi', false);
  checkReference_('Produk', 1, 'Kategori', 'KategoriId produk', false);
  checkReference_('VariasiProduk', 1, 'Produk', 'ProdukId variasi', false);
  checkReference_('Stok', 1, 'Produk', 'ProdukId stok', false);
  checkReference_('Stok', 2, 'VariasiProduk', 'VariasiId stok', true);
  checkReference_('MutasiStok', 1, 'Produk', 'ProdukId mutasi stok', false);
  checkReference_('MutasiStok', 2, 'VariasiProduk', 'VariasiId mutasi stok', true);
  checkReference_('Keranjang', 1, 'Users', 'UserId keranjang', false);
  checkReference_('Keranjang', 2, 'Santri', 'SantriId keranjang', false);
  checkReference_('Keranjang', 3, 'Produk', 'ProdukId keranjang', false);
  checkReference_('Keranjang', 4, 'VariasiProduk', 'VariasiId keranjang', true);
  checkReference_('Pesanan', 2, 'Users', 'UserId pesanan', false);
  checkReference_('Pesanan', 3, 'Santri', 'SantriId pesanan', false);
  checkReference_('DetailPesanan', 1, 'Pesanan', 'PesananId detail', false);
  checkReference_('DetailPesanan', 2, 'Produk', 'ProdukId detail', false);
  checkReference_('DetailPesanan', 3, 'VariasiProduk', 'VariasiId detail', true);
  checkReference_('Pembayaran', 1, 'Pesanan', 'PesananId pembayaran', false);
  checkReference_('Pengiriman', 1, 'Pesanan', 'PesananId pengiriman', false);
  checkReference_('Pengantaran', 1, 'Pesanan', 'PesananId penugasan pengantaran', false);
  checkReference_('Pengantaran', 2, 'Users', 'PetugasUserId pengantaran', true);
  checkReference_('BuktiPengantaran', 1, 'Pesanan', 'PesananId bukti pengantaran', false);
  checkReference_('BuktiPengantaran', 2, 'Pengantaran', 'PengantaranId bukti', false);
  checkReference_('BuktiPengantaran', 9, 'Users', 'UploadedBy bukti pengantaran', true);
  checkReference_('KonfirmasiPengantaran', 1, 'Pesanan', 'PesananId konfirmasi pengantaran', false);
  checkReference_('KomplainPengantaran', 1, 'Pesanan', 'PesananId komplain pengantaran', false);
  checkReference_('KomplainPengantaran', 2, 'KonfirmasiPengantaran', 'KonfirmasiId komplain', true);
  checkReference_('RiwayatPengantaran', 1, 'Pesanan', 'PesananId riwayat pengantaran', false);
  checkReference_('Notifikasi', 1, 'Users', 'UserId notifikasi', false);
  checkReference_('Notifikasi', 2, 'Pesanan', 'PesananId notifikasi', true);

  const report = {
    ok: issues.length === 0,
    spreadsheetName: ss.getName(),
    checkedAt: new Date().toISOString(),
    sheetCounts: counts,
    issueCount: issues.length,
    truncated: issues.length >= maxIssues,
    issues: issues
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}



/**
 * Memperbaiki hanya header metadata FMart pada kolom I-L.
 * Delapan kolom sumber FMPay wajib cocok persis dan tidak pernah disentuh.
 * Sel metadata yang sudah berisi header lain akan menyebabkan fungsi berhenti.
 */
function repairFMartSantriMasterHeaders_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSetupSpreadsheet_();
    const sheet = ss.getSheetByName('Santri');
    if (!sheet) throw new Error('Sheet Santri tidak ditemukan.');

    const sourceHeaders = ['nis','nama_santri','kelas','asrama','saldo_fpay','limit_harian','nama_wali','no_wa_wali'];
    const actualSource = sheet.getRange(1,1,1,8).getDisplayValues()[0]
      .map(function(value){return String(value || '').trim();});
    const sourceMismatch = [];
    sourceHeaders.forEach(function(expected,index){
      if (actualSource[index] !== expected) {
        sourceMismatch.push({column:index+1,expected:expected,actual:actualSource[index] || ''});
      }
    });
    if (sourceMismatch.length) {
      throw new Error('Perbaikan dihentikan. Delapan header sumber FMPay tidak sesuai: ' + JSON.stringify(sourceMismatch));
    }

    if (sheet.getMaxColumns() < 12) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
    }

    const metadataHeaders = ['SantriId','Status','CreatedAt','UpdatedAt'];
    const current = sheet.getRange(1,9,1,4).getDisplayValues()[0]
      .map(function(value){return String(value || '').trim();});
    const conflicts = [];
    current.forEach(function(value,index){
      if (value && value !== metadataHeaders[index]) {
        conflicts.push({column:index+9,expected:metadataHeaders[index],actual:value});
      }
    });
    if (conflicts.length) {
      throw new Error('Perbaikan dihentikan. Ada header lain pada kolom metadata: ' + JSON.stringify(conflicts));
    }

    const repaired = [];
    metadataHeaders.forEach(function(header,index){
      if (!current[index]) {
        sheet.getRange(1,index+9).setValue(header);
        repaired.push({column:index+9,header:header});
      }
    });
    sheet.getRange(1,9,1,4).setFontWeight('bold').setBackground('#eadcff').setFontColor('#4c1d95');
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();

    const result = {
      ok:true,
      spreadsheetName:ss.getName(),
      sourceColumnsPreserved:true,
      repairedHeaders:repaired,
      message:repaired.length ? 'Empat header metadata telah diperiksa dan header kosong dilengkapi.' : 'Semua header metadata sudah sesuai.'
    };
    Logger.log(JSON.stringify(result,null,2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Audit khusus master Santri bersama FMart/FMPay. Read-only.
 * Jalankan setelah setupFMartDatabase_() menambahkan 4 header internal di ujung kanan.
 */
function auditFMartSantriMaster_() {
  const ss = getSetupSpreadsheet_();
  const sheet = ss.getSheetByName('Santri');
  if (!sheet) throw new Error('Sheet Santri tidak ditemukan.');
  const expected = FMART_DB.SHEETS.SANTRI;
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), expected.length)).getDisplayValues()[0]
    .map(function(value) { return String(value || '').trim(); });
  const headerIssues = [];
  expected.forEach(function(header, index) {
    if (headers[index] !== header) headerIssues.push({column:index + 1, expected:header, actual:headers[index] || ''});
  });
  if (headerIssues.length) return {ok:false, checkedAt:new Date().toISOString(), headerIssues:headerIssues, rowCount:Math.max(0,sheet.getLastRow()-1), issues:[]};

  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,expected.length).getValues() : [];
  const displayRows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,expected.length).getDisplayValues() : [];
  const seenNis = Object.create(null), seenIds = Object.create(null), issues = [];
  let eligible = 0, alreadyPrepared = 0, blankRows = 0;
  rows.forEach(function(row,index) {
    const rowNumber = index + 2;
    const nis = String(displayRows[index][0] || '').trim();
    const name = String(displayRows[index][1] || '').trim();
    const id = String(row[8] || '').trim();
    const status = String(row[9] || '').trim();
    const hasData_ = row.slice(0,8).some(function(value){return value !== '' && value !== null;});
    if (!hasData_) { blankRows++; return; }
    if (!nis) issues.push({code:'EMPTY_NIS',row:rowNumber,detail:'Data Santri memiliki isi tetapi NIS kosong.'});
    else if (seenNis[nis]) issues.push({code:'DUPLICATE_NIS',row:rowNumber,detail:'NIS duplikat; baris pertama ' + seenNis[nis] + '.'});
    else seenNis[nis] = rowNumber;
    if (!name) issues.push({code:'EMPTY_NAME',row:rowNumber,detail:'Nama santri kosong.'});
    if (id && seenIds[id]) issues.push({code:'DUPLICATE_SANTRI_ID',row:rowNumber,detail:'SantriId duplikat; baris pertama ' + seenIds[id] + '.'});
    else if (id) seenIds[id] = rowNumber;
    if (nis && name) {
      if (id && status) alreadyPrepared++;
      else eligible++;
    }
  });
  const report = {
    ok:issues.length === 0,
    spreadsheetName:ss.getName(),
    checkedAt:new Date().toISOString(),
    rowCount:rows.filter(function(row){return row.some(function(value){return value !== '' && value !== null;});}).length,
    blankRows:blankRows,
    readyForMigration:eligible,
    alreadyPrepared:alreadyPrepared,
    issueCount:issues.length,
    issues:issues.slice(0,500),
    truncated:issues.length > 500
  };
  Logger.log(JSON.stringify(report,null,2));
  return report;
}

/**
 * Menyiapkan ID dan metadata internal Santri tanpa mengubah 8 kolom sumber FMPay.
 * Jalankan hanya setelah auditFMartSantriMaster_() menunjukkan tidak ada masalah.
 * Status awal AKTIF diberikan untuk baris yang memiliki NIS dan nama; tinjau kembali
 * jika master sumber ternyata juga memuat alumni atau santri nonaktif.
 */
function migrateFMartSantriMaster_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSetupSpreadsheet_();
    const sheet = ss.getSheetByName('Santri');
    if (!sheet) throw new Error('Sheet Santri tidak ditemukan.');
    const audit = auditFMartSantriMaster_();
    if (!audit || audit.ok !== true) {
      const auditDetail = audit ? JSON.stringify(audit, null, 2) : 'Audit tidak mengembalikan laporan.';
      Logger.log('AUDIT MASTER SANTRI GAGAL:\n' + auditDetail);
      throw new Error('Migrasi dibatalkan karena audit master Santri belum lolos. Detail audit: ' + auditDetail);
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return {ok:true,updated:0,message:'Belum ada data Santri untuk dimigrasikan.'};
    const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0].map(function(v){return String(v||'').trim().toLowerCase();});
    const col = {};
    headers.forEach(function(value,index){if(value)col[value]=index;});
    const metadataRange = sheet.getRange(2, 9, lastRow - 1, 4);
    const metadataRows = metadataRange.getValues();
    const sourceDisplay = sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues();
    const now = new Date();
    let createdIds = 0, activated = 0, timestamped = 0, skipped = 0;
    metadataRows.forEach(function(row,index) {
      const nis = String(sourceDisplay[index][0] || '').trim();
      const name = String(sourceDisplay[index][1] || '').trim();
      if (!nis || !name) { skipped++; return; }
      if (!String(row[0] || '').trim()) {
        row[0] = makeSetupSantriId_(nis);
        createdIds++;
      }
      if (!String(row[1] || '').trim()) {
        row[1] = 'AKTIF';
        activated++;
      }
      if (!row[2]) { row[2] = now; timestamped++; }
      if (!row[3]) { row[3] = now; timestamped++; }
    });
    const ids = Object.create(null);
    metadataRows.forEach(function(row,index){
      const id=String(row[0]||'').trim();
      if(!id)return;
      if(ids[id]) throw new Error('Migrasi dibatalkan: SantriId duplikat pada baris ' + (index+2) + '.');
      ids[id]=true;
    });
    metadataRange.setValues(metadataRows);
    SpreadsheetApp.flush();
    const result = {ok:true,createdIds:createdIds,activated:activated,timestampedCells:timestamped,skippedIncomplete:skipped,totalRows:metadataRows.length};
    Logger.log(JSON.stringify(result,null,2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function makeSetupSantriId_(nis) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'FMART_SANTRI|' + String(nis).trim(), Utilities.Charset.UTF_8);
  return 'SNT-' + Utilities.base64EncodeWebSafe(digest).replace(/[^A-Z0-9]/gi,'').slice(0,20).toUpperCase();
}


/**
 * Membuat akun awal secara manual.
 * Jalankan dari editor Apps Script, lalu hapus data sensitif dari riwayat/log Anda sendiri.
 * Password tidak pernah ditulis ke Spreadsheet dalam bentuk plaintext.
 */
function createFMartUser_(username, password, nama, role, email) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  nama = String(nama || '').trim();
  role = String(role || 'WALI_SANTRI').trim().toUpperCase();

  if (password.length < 10) throw new Error('Password minimal 10 karakter.');
  if (!nama) throw new Error('Nama wajib diisi.');
  email = String(email || '').trim().toLowerCase();
  if (['WALI_SANTRI','ADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR','SUPERADMIN'].indexOf(role) === -1) throw new Error('Role tidak valid.');
  if (['ADMIN','SUPERADMIN','KASIR','GUDANG','PETUGAS_PENGANTAR'].indexOf(role) >= 0) {
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
  if (!sheet) throw new Error('Jalankan setupFMartDatabase_() terlebih dahulu.');

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
 * - Password langsung diproses menjadi hash + salt oleh createFMartUser_().
 * - Setelah Superadmin pertama ada, fungsi ini terkunci dan tidak dapat membuat
 *   Superadmin kedua melalui jalur bootstrap.
 *
 * Cara penggunaan utama:
 *   Jalankan createInitialFMartSuperadmin_() tanpa parameter dari Apps Script Editor.
 *   Sistem akan meminta username, nama, dan password melalui dialog Spreadsheet.
 *
 * Pemanggilan dengan parameter tetap didukung untuk kebutuhan administrasi terkontrol,
 * tetapi jangan menaruh password nyata di source code.
 */
function createInitialFMartSuperadmin_(username, password, nama, email) {
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
    if (!sheet) throw new Error('Sheet Users tidak ditemukan. Jalankan setupFMartDatabase_() terlebih dahulu.');
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues() : [];
    if (rows.some(function(r){ return String(r[5]||'').trim().toUpperCase()==='SUPERADMIN' && String(r[6]||'').trim().toUpperCase()==='AKTIF'; })) {
      throw new Error('Bootstrap dikunci: sudah ada Superadmin aktif. Gunakan manajemen pengguna setelah login.');
    }
    if (rows.some(function(r){ return String(r[1]||'').trim().toLowerCase()===username; })) {
      throw new Error('Username sudah digunakan. Pilih username lain.');
    }

    const result = createFMartUser_(username, password, nama, 'SUPERADMIN', email);
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
function prepareExistingSuperadminEmailFromEditor_() {
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
function replaceFMartSuperadminFromEditor_() {
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
      message: 'Sheet FMart_AdminSetup telah dibuat. Isi B2 dengan email, B3 dengan nama, dan B4 dengan password baru. Setelah itu jalankan replaceFMartSuperadminFromEditor_() sekali lagi.'
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

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let oldRowNumber = 0;
  let oldUsername = '';
  let oldEmail = '';
  let oldUpdatedAt = null;
  let oldUserId = '';
  let newRowNumber = 0;
  let newUserId = '';
  let oldTemporarilyChanged = false;

  try {
    const users = ss.getSheetByName('Users');
    if (!users || users.getLastRow() < 2) throw new Error('Sheet Users belum tersedia atau belum memiliki data.');
    const rows = users.getRange(2, 1, users.getLastRow() - 1, 12).getValues();
    const activeOld = rows.map(function(row, index) {
      return {rowNumber: index + 2, values: row};
    }).filter(function(item) {
      return String(item.values[5] || '').trim().toUpperCase() === 'SUPERADMIN' &&
        String(item.values[6] || '').trim().toUpperCase() === 'AKTIF';
    });

    if (activeOld.length !== 1) {
      throw new Error('Penggantian dibatalkan: harus ada tepat satu Superadmin lama yang aktif. Tidak ada akun yang diubah.');
    }

    const old = activeOld[0];
    oldRowNumber = old.rowNumber;
    oldUserId = String(old.values[0] || '');
    oldUsername = String(old.values[1] || '');
    oldEmail = String(old.values[10] || '');
    oldUpdatedAt = old.values[8];

    // Email boleh sama dengan milik Superadmin lama, tetapi tidak boleh dipakai akun lain.
    const duplicateOtherUser = rows.some(function(row) {
      if (String(row[0] || '') === oldUserId) return false;
      const username = String(row[1] || '').trim().toLowerCase();
      const existingEmail = String(row[10] || '').trim().toLowerCase();
      return username === email || existingEmail === email;
    });
    if (duplicateOtherUser) {
      throw new Error('Email tersebut sudah digunakan akun lain selain Superadmin lama.');
    }

    const now = new Date();
    const archiveTag = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toLowerCase();
    const archivedUsername = 'superadmin-lama-' + archiveTag;
    const archivedEmail = 'nonaktif-' + archiveTag + '@fmart.invalid';

    // Pindahkan sementara identitas login lama agar alamat email lama dapat
    // dipakai akun baru. Jika proses berikut gagal, data lama dipulihkan.
    users.getRange(oldRowNumber, 2).setValue(archivedUsername);
    users.getRange(oldRowNumber, 9).setValue(now);
    users.getRange(oldRowNumber, 11).setValue(archivedEmail);
    users.getRange(oldRowNumber, 12).setValue(false);
    SpreadsheetApp.flush();
    oldTemporarilyChanged = true;

    newUserId = 'USR-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16).toUpperCase();
    const salt = Utilities.getUuid().replace(/-/g, '');
    const hash = hashPassword_(password, salt);
    users.appendRow([newUserId, email, hash, salt, nama, 'SUPERADMIN', 'AKTIF', now, now, '', email, false]);
    SpreadsheetApp.flush();
    newRowNumber = users.getLastRow();

    const savedNew = users.getRange(newRowNumber, 1, 1, 12).getValues()[0];
    if (String(savedNew[0] || '') !== newUserId ||
        String(savedNew[1] || '').trim().toLowerCase() !== email ||
        String(savedNew[5] || '').trim().toUpperCase() !== 'SUPERADMIN' ||
        String(savedNew[6] || '').trim().toUpperCase() !== 'AKTIF' ||
        String(savedNew[10] || '').trim().toLowerCase() !== email ||
        !savedNew[2] || !savedNew[3]) {
      throw new Error('Akun baru belum dapat diverifikasi. Proses penggantian dibatalkan.');
    }

    users.getRange(oldRowNumber, 7).setValue('NONAKTIF');
    users.getRange(oldRowNumber, 9).setValue(new Date());
    SpreadsheetApp.flush();

    const savedOld = users.getRange(oldRowNumber, 1, 1, 12).getValues()[0];
    if (String(savedOld[6] || '').trim().toUpperCase() !== 'NONAKTIF') {
      throw new Error('Status akun lama belum berhasil dinonaktifkan.');
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
        JSON.stringify({username: oldUsername, email: oldEmail, role: 'SUPERADMIN', status: 'AKTIF'}),
        JSON.stringify({username: archivedUsername, email: archivedEmail, role: 'SUPERADMIN', status: 'NONAKTIF', replacementUserId: newUserId}),
        'Akun Superadmin diganti melalui Apps Script Editor.',
        new Date()
      ]);
    }

    inputSheet.getRange('B2:B4').clearContent();
    SpreadsheetApp.flush();

    return {
      ok: true,
      oldUserId: oldUserId,
      oldStatus: 'NONAKTIF',
      newUserId: newUserId,
      newUsername: email,
      newRole: 'SUPERADMIN',
      newStatus: 'AKTIF',
      emailVerified: false,
      spreadsheetName: ss.getName(),
      message: 'Superadmin baru berhasil dibuat menggunakan email yang sama dengan akun lama. Akun lama dinonaktifkan dan identitas loginnya diarsipkan. Data input sementara sudah dikosongkan.'
    };
  } catch (error) {
    // Pemulihan identitas akun lama jika penggantian belum selesai.
    if (oldTemporarilyChanged && oldRowNumber) {
      try {
        const users = ss.getSheetByName('Users');
        if (newRowNumber && newRowNumber > 1 && newUserId) {
          const candidate = users.getRange(newRowNumber, 1, 1, 1).getValue();
          if (String(candidate || '') === newUserId) users.deleteRow(newRowNumber);
        }
        users.getRange(oldRowNumber, 2).setValue(oldUsername);
        users.getRange(oldRowNumber, 7).setValue('AKTIF');
        users.getRange(oldRowNumber, 9).setValue(oldUpdatedAt);
        users.getRange(oldRowNumber, 11).setValue(oldEmail);
        SpreadsheetApp.flush();
      } catch (rollbackError) {
        throw new Error('Penggantian gagal dan pemulihan otomatis perlu diperiksa manual pada sheet Users. Penyebab: ' + error.message + '. Pemulihan: ' + rollbackError.message);
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
