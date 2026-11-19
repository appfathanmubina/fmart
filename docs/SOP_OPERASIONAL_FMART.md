# SOP Operasional FMart

**Status dokumen:** Draft operasional berbasis source repository, 19 November 2026.  
**Persetujuan:** Belum disahkan pemilik proses. Prosedur yang bergantung pada Drive, Spreadsheet, trigger, akun, dan perangkat harus dikonfirmasi melalui runtime sebelum dipakai sebagai SOP final.

Dokumen ini melengkapi [Checklist UAT Tahap 4](UAT-TAHAP-4-FMART.md). SOP menjelaskan alur kerja harian; checklist UAT tetap menjadi panduan pengujian terkontrol dan bukan bukti bahwa runtime sudah lulus.

## 1. Prinsip pengoperasian

1. Gunakan menu aplikasi sesuai role akun. Jangan berbagi akun, password, OTP, atau token.
2. Semua perubahan stok, pembayaran, penerimaan, dan pengantaran dilakukan melalui menu FMart. Jangan mengubah baris transaksi atau saldo stok langsung di Spreadsheet.
3. Simpan bukti dan referensi transaksi. Jika ada kegagalan, catat ID transaksi, waktu, role, dan pesan error tanpa membagikan data pribadi.
4. Jangan mengulang transaksi dengan request key baru sebelum memeriksa hasil permintaan sebelumnya. Retry harus memakai request key dan payload yang sama.
5. Jangan menjalankan setup, migrasi, pemasangan trigger, atau pemulihan data hanya untuk audit. Pastikan target Spreadsheet/Apps Script benar dan backup tersedia sebelum perubahan struktural.
6. Data transaksi produksi tidak boleh dipakai sebagai data uji. Uji transaksi gagal, duplikat, bersamaan, dan pemulihan harus memakai lingkungan terisolasi.

## 2. Role dan batas tanggung jawab

| Role | Tanggung jawab utama | Batas penting |
|---|---|---|
| SUPERADMIN | Pengaturan pembayaran, pengguna, seluruh operasional dan laporan | Lindungi akun ini; jangan dipakai untuk kegiatan rutin yang bisa dilakukan role lain |
| ADMIN | Operasional pesanan, pengguna sesuai hak, laporan, POS, stok dan distribusi | Tidak mengubah pengaturan pembayaran khusus Superadmin |
| KASIR | POS dan antrean verifikasi QRIS Wali | Hanya memverifikasi pembayaran QRIS Wali; transaksi POS yang dikelola Kasir dibatasi ke akun pembuat |
| GUDANG | Stok Gudang, penerimaan, pemenuhan pesanan, laporan Gudang, penugasan/pengantaran | Tidak dapat membatalkan pesanan; hanya memproses pesanan dengan pembayaran terverifikasi |
| PETUGAS_PENGANTAR | Menerima tugas, memulai perjalanan, memperbarui progres, melaporkan kegagalan, mengunggah bukti | Hanya dapat mengelola penugasan milik akun sendiri |
| WALI_SANTRI | Katalog, keranjang, checkout, pembayaran, pesanan, relasi Santri, konfirmasi pengantaran | Tidak melihat jumlah stok internal dan tidak dapat membaca pesanan Wali lain |

**Supervisor bukan role aktif yang didefinisikan backend saat ini.** Jangan membuat akun atau memberikan akses Supervisor sampai role tersebut disetujui dan didefinisikan secara eksplisit.

## 3. Akun dan akses awal

1. Superadmin memastikan akun staf dibuat untuk petugas yang benar dan role sesuai tugas.
2. Buat akun ADMIN, KASIR, GUDANG, dan PETUGAS_PENGANTAR hanya ketika petugas sudah ditetapkan. Pembuatan akun staf melalui menu yang dibatasi untuk Superadmin.
3. Pastikan status akun AKTIF dan email/username benar. Jangan menulis password awal ke dokumen, chat, atau AuditLog.
4. Pemilik akun melakukan login sendiri dan mengganti password sesuai kebijakan lembaga.
5. Uji akses setiap role secara terpisah. Menu yang tersembunyi bukan satu-satunya pengaman; backend juga harus menolak endpoint yang tidak diizinkan.
6. Akun ADMIN dan PETUGAS_PENGANTAR yang belum dibuat merupakan prasyarat operasional sebelum alur role tersebut dapat diuji.

## 4. Master produk dan katalog

1. Admin memeriksa nama, kategori, satuan, status aktif, harga, dan variasi sebelum produk ditampilkan.
2. Produk nonaktif tidak boleh dijual atau dimutasi stok.
3. Wali hanya melihat produk aktif dan informasi yang diperlukan untuk belanja. Jumlah stok Gudang dan ambang stok internal tidak ditampilkan.
4. Perubahan harga atau variasi dilakukan melalui menu pengelolaan produk, bukan mengedit sheet secara langsung.
5. Fitur unggah foto langsung dari perangkat belum menjadi bagian SOP ini; pengembangan foto produk direncanakan setelah gerbang audit runtime.

## 5. Stok Gudang dan penerimaan barang

1. Gudang memeriksa produk dan variasi yang akan diterima. Setiap item harus mengacu pada produk aktif.
2. Buat Penerimaan Barang dengan pemasok/asal barang, tanggal, referensi dokumen, catatan, dan jumlah per item.
3. Gunakan jumlah hasil hitung fisik atau dokumen penerimaan yang sah. Jangan mengisi saldo nol hanya karena baris stok belum tersedia.
4. Sistem mencatat header, detail, mutasi masuk, saldo stok, dan jejak audit melalui alur penerimaan.
5. Jika penyimpanan terputus, periksa riwayat penerimaan terlebih dahulu. Retry dengan request key dan payload yang sama; jangan membuat penerimaan baru sebelum memastikan permintaan sebelumnya tidak tersimpan.
6. Transfer stok Gudang ke Kasir dilakukan melalui menu transfer. Stok Gudang dan stok Kasir adalah ledger terpisah.
7. Koreksi stok dilakukan sebagai mutasi yang memiliki alasan dan jejak audit. Jangan menghapus atau mengedit histori mutasi untuk menutup selisih.

**Catatan saldo awal:** seluruh 294 produk aktif yang telah dikonfirmasi operator memang dikelola sebagai persediaan Gudang. Pengisian saldo awal dilakukan bertahap melalui Penerimaan Barang berdasarkan hitung fisik/dokumen; aplikasi tidak boleh menginisialisasi saldo nol massal atau mengarang jumlah awal.

## 6. Alur Wali, relasi Santri, dan checkout

1. Wali mencari Santri melalui menu relasi anak.
2. Hubungan langsung menjadi AKTIF hanya jika nomor HP akun Wali cocok secara normalisasi dengan kolom `no_wa_wali` pada master Santri.
3. Jika nomor tidak cocok atau kosong, status menjadi `MENUNGGU_VERIFIKASI`. Admin memeriksa identitas dan bukti yang diperlukan sebelum menyetujui. Jangan mengaktifkan relasi hanya berdasarkan nama atau ID Santri.
4. Relasi aktif/pending dibatasi maksimal dua akun Wali unik per Santri. Pengajuan pending yang sudah ada tidak boleh dibuat berulang.
5. Checkout dapat memakai penerima/alamat manual dan tidak otomatis membuat relasi resmi Wali–Santri. Pastikan nama dan kontak penerima benar sebelum mengirim pesanan.
6. Wali memilih item keranjang yang akan dibeli, metode pengiriman yang tersedia, dan memeriksa total sebelum checkout.
7. Jika checkout gagal atau layar tidak menerima respons, periksa riwayat pesanan terlebih dahulu. Jangan menekan checkout berulang dengan request key baru sebelum memastikan status permintaan pertama.

## 7. Pembayaran dan verifikasi

1. Pembayaran Wali menggunakan QRIS. Bukti pembayaran yang diunggah harus JPG, PNG, WEBP, atau PDF dengan ukuran maksimal 5 MB.
2. Nominal harus sesuai tagihan. Screenshot bukti bukan pengganti pencocokan dana pada merchant/akun QRIS.
3. Kasir memeriksa antrean QRIS Wali dan hanya memverifikasi transaksi QRIS. Admin/Superadmin mengikuti hak akses server yang berlaku.
4. Terima pembayaran hanya setelah dana cocok. Jika ditolak, isi alasan penolakan yang jelas agar Wali dapat menindaklanjuti.
5. Pembayaran POS QRIS berbeda dari pembayaran Wali. Stok transaksi POS QRIS baru diselesaikan setelah konfirmasi pembayaran yang sah.
6. Jangan menghapus bukti pembayaran atau mengubah status pembayaran langsung pada Spreadsheet.

## 8. Pemenuhan pesanan dan pengantaran

1. Gudang memproses pesanan setelah pembayaran terverifikasi dan stok tersedia.
2. Status pemenuhan mengikuti alur yang diizinkan sistem. Gudang tidak dapat membatalkan pesanan dan tidak boleh memaksa status di luar alur.
3. Pesanan metode Antar Pesantren dapat ditugaskan setelah siap diproses, pembayaran terverifikasi, dan akun petugas aktif.
4. Petugas Pengantar menerima atau menolak tugas. Penolakan wajib disertai alasan. Petugas hanya dapat mengubah tugas miliknya sendiri.
5. Perjalanan dimulai setelah tugas diterima dan prasyarat pesanan/pengiriman terpenuhi. Catatan progres harus faktual.
6. Jika pengantaran gagal, isi alasan dan jangan membuat bukti pengantaran palsu. Ikuti alur pemulihan melalui Admin bila diperlukan.
7. Foto bukti pengantaran harus JPG, PNG, atau WEBP dengan ukuran maksimal 10 MB. File disimpan pada folder khusus pengantaran, terpisah dari folder bukti pembayaran.
8. Wali hanya dapat melihat bukti untuk pesanan miliknya. Wali memeriksa barang dan mengonfirmasi penerimaan melalui aplikasi.
9. Untuk Ambil di FMart, Wali mengonfirmasi penerimaan setelah barang benar-benar diserahkan.

## 9. POS Kasir

1. Kasir memeriksa saldo stok Kasir sebelum transaksi.
2. Pilih jenis pembeli, item, jumlah, dan metode pembayaran dengan benar.
3. Transaksi tunai diselesaikan berdasarkan uang diterima dan kembalian yang dihitung sistem.
4. Transaksi QRIS berstatus menunggu konfirmasi sampai pembayaran benar-benar diterima. Jangan menyerahkan barang atau menganggap lunas hanya dari screenshot.
5. Kasir hanya dapat membatalkan/mengonfirmasi transaksi QRIS yang dibuat oleh akunnya sendiri. Minta bantuan Admin jika transaksi dibuat akun lain.
6. Jika transaksi ganda atau stok tidak sesuai, hentikan transaksi terkait dan minta Admin/Superadmin memeriksa AuditLog serta ledger stok.

## 10. Backup, pemulihan, dan insiden

### Backup sebelum perubahan

Repository saat ini tidak menyediakan fungsi backup/restore otomatis yang dapat dijadikan prosedur pemulihan penuh. Sampai mekanisme resmi tersedia:

1. Sebelum migrasi header, perubahan struktur, atau deployment berisiko, buat salinan Google Spreadsheet melalui Google Drive.
2. Catat tanggal/waktu backup, nama file salinan, commit source, dan tujuan perubahan.
3. Simpan salinan source Apps Script yang sesuai dan catat versi/deployment yang sedang digunakan.
4. Catat nama Script Properties dan pastikan nilainya benar di tempat penyimpanan rahasia yang disetujui. Jangan menaruh password, token, OTP, atau ID sensitif di dokumen publik.
5. Pastikan folder bukti pembayaran/pengantaran tetap privat dan dapat diakses akun eksekusi yang benar.
6. Uji pemulihan pada salinan terpisah. Jangan menimpa Spreadsheet produksi sebelum transaksi setelah waktu backup direkonsiliasi.

### Saat terjadi kegagalan

1. Hentikan pengulangan tindakan yang gagal.
2. Catat waktu, role, ID pesanan/pembayaran/penerimaan/penjualan, langkah terakhir, dan pesan error. Jangan sertakan password, OTP, token, atau data pribadi yang tidak diperlukan.
3. Periksa status transaksi pada aplikasi dan AuditLog. Untuk pemeriksaan read-only, operator dapat menjalankan `runFMartReadinessAudit_()` dari Apps Script Editor setelah memastikan project dan Spreadsheet target benar.
4. Jangan mengedit baris Pesanan, Pembayaran, Stok, MutasiStok, Pengiriman, atau AuditLog langsung untuk memperbaiki status.
5. Jika ada indikasi transaksi terpotong, stok ganda, bukti hilang, atau status tidak konsisten, hentikan proses terkait dan eskalasi ke Superadmin/pengelola Apps Script.
6. Pemulihan harus memakai prosedur yang sesuai dan bukti sumber. Jangan menjalankan fungsi setup/migrasi atau membuat transaksi pengganti tanpa audit dan persetujuan.

## 11. Pemeriksaan rutin

### Sebelum operasional
- Pastikan akun staf yang bertugas aktif dan role benar.
- Pastikan koneksi internet, URL PWA, dan Web App Apps Script tersedia.
- Pastikan folder bukti pembayaran dan pengantaran terpisah, privat, dan dapat diakses akun eksekusi.
- Pastikan stok Gudang dan stok Kasir sesuai catatan fisik.
- Pastikan tidak ada masalah kritis pada hasil audit terakhir.

### Saat pergantian shift
- Cocokkan transaksi POS tunai/QRIS dan antrean QRIS Wali.
- Periksa pesanan yang menunggu pembayaran, stok, atau penugasan.
- Periksa tugas pengantaran aktif, bukti yang belum diunggah, dan konfirmasi Wali yang belum selesai.
- Serahkan catatan insiden dan transaksi tertunda ke petugas berikutnya.

### Penutupan harian
- Cocokkan penerimaan, mutasi, transfer Gudang–Kasir, penjualan POS, dan saldo fisik.
- Periksa pembayaran pending/ditolak dan pesanan yang belum selesai.
- Periksa penugasan pengantaran dan komplain.
- Simpan bukti rekonsiliasi dan tindak lanjut tanpa mengubah histori transaksi.

## 12. Prasyarat persetujuan SOP

SOP ini baru dapat disahkan setelah:
- akun ADMIN dan PETUGAS_PENGANTAR tersedia dan diuji oleh pemiliknya;
- konfigurasi Spreadsheet, Script Properties, folder Drive, dan trigger terverifikasi pada runtime;
- saldo awal seluruh produk Gudang diinput berdasarkan bukti fisik/dokumen dan direkonsiliasi;
- alur Wali, Kasir, Gudang, Admin, Superadmin, dan Petugas Pengantar lulus UAT pada lingkungan terkontrol;
- prosedur backup/restore diuji pada salinan terpisah;
- pemilik proses menyetujui tanggung jawab, eskalasi, dan batas kewenangan setiap role.

**Jangan menandai FMart siap produksi hanya karena PR sudah merge atau CI lulus.** Status produksi harus berdasarkan bukti runtime, rekonsiliasi data, UAT perangkat, dan persetujuan pemilik proses.
