# FMart PWA

Repositori ini berisi shell PWA mobile dan salinan antarmuka/backend Google Apps Script dari ZIP Fase 9. Shell memakai halaman Apps Script sebagai aplikasi utama, sehingga transaksi tetap membutuhkan koneksi internet.

## Menyiapkan Apps Script

1. Buat atau buka proyek Apps Script yang terikat pada Google Spreadsheet FMart.
2. Salin `apps-script/Code.gs`, `apps-script/SetupDatabase.gs`, dan `apps-script/Index.html` ke proyek Apps Script.
3. Jalankan `setupFMartDatabase_()` dari editor Apps Script, lalu selesaikan otorisasi Google.
4. Deploy sebagai **Web app**. Pilih identitas eksekusi dan akses pengguna sesuai kebijakan organisasi.
5. Salin URL deployment yang berakhiran `/exec` ke `window.FMART_APP_URL` pada `config.js`.

## Audit runtime dan finalisasi (Tahap G)

Setelah file terbaru disinkronkan ke proyek Apps Script, jalankan dua pemeriksaan berikut secara manual dari Apps Script Editor:

1. `auditFMartRuntime_()` — pemeriksaan read-only terhadap Spreadsheet yang ditunjuk oleh Script Property `FMART_SPREADSHEET_ID`, ketersediaan sheet utama, jumlah akun aktif per role, ringkasan status transaksi, akses dan status berbagi folder bukti pembayaran/pengantaran, serta keberadaan trigger `processDeliveryAutoConfirmation_`.
2. `auditFMartDatabaseIntegrity_()` — pemeriksaan read-only terhadap header, ID utama, duplikasi, dan relasi antar-sheet.

Kedua fungsi tidak membuat/menghapus folder, tidak memasang trigger, tidak mengubah akun, tidak mengedit transaksi, dan tidak mengirim notifikasi. Hasil audit runtime tidak menampilkan username, email, nomor HP, password, ID Spreadsheet, atau ID folder. Simpan hasilnya dan bagikan hanya setelah memastikan tidak ada informasi sensitif.

Catatan batas audit:
- Pemeriksaan folder Drive menguji akses akun eksekusi dan tingkat berbagi folder; pemeriksaan ini tidak memeriksa ACL setiap file satu per satu.
- Keberadaan trigger tidak membuktikan trigger pernah berhasil berjalan. Periksa halaman **Executions** di Apps Script untuk riwayat sukses/gagal dan error aktual.
- Jumlah akun aktif per role bukan pengganti uji login. Login setiap role harus diuji dengan pemilik akun masing-masing; jangan membagikan password atau token.
- Ringkasan status transaksi bukan pengganti pencocokan transaksi dengan bukti transfer/bank, bukti Drive, stok fisik, dan penerimaan barang.
- Jangan jalankan `setupFMartDatabase_()` atau `installDeliveryAutomationTrigger_()` hanya untuk audit. Keduanya dapat mengubah konfigurasi/struktur atau trigger; jalankan hanya bila hasil pemeriksaan menunjukkan kebutuhan dan sudah dipastikan targetnya benar.

Status produksi hanya boleh dinyatakan setelah database aktif, izin Drive, trigger, seluruh role, transaksi end-to-end, dan hasil laporan dicocokkan pada runtime yang benar.

## Audit integritas database (Tahap 2)

Setelah struktur database tersedia, jalankan `auditFMartDatabaseIntegrity_()` dari Apps Script Editor. Fungsi ini bersifat **read-only**: tidak membuat sheet, mengubah header, memperbaiki relasi, atau menghapus data. Hasilnya memuat jumlah baris per sheet dan daftar temuan seperti sheet/header yang tidak sesuai, ID utama kosong/duplikat, username/email duplikat, relasi data yang terputus, serta ketiadaan Superadmin aktif.

Jika ditemukan `HEADER_MISMATCH` atau `UNEXPECTED_COLUMNS`, jangan mengubah atau memindahkan kolom secara manual sebelum struktur dan dampaknya diperiksa. Simpan hasil audit (hapus informasi sensitif bila ada) untuk menentukan migrasi yang aman. Audit ini belum menggantikan uji transaksi dan pemeriksaan langsung pada Apps Script runtime.

### Master data Santri bersama FMart dan FMPay

Sheet `Santri` dipertahankan sebagai satu master bersama. Delapan kolom sumber yang sudah ada tidak dipindahkan atau dihapus:

`nis, nama_santri, kelas, asrama, saldo_fpay, limit_harian, nama_wali, no_wa_wali`.

FMart menambahkan empat kolom internal di bagian paling kanan: `SantriId, Status, CreatedAt, UpdatedAt`. Backend FMart membaca data berdasarkan nama header, sehingga kolom saldo dan limit FMPay tidak tertukar dengan identitas Santri. `SantriId` menjadi kunci relasi internal yang stabil; NIS tetap menjadi nomor identitas sumber dan diperiksa keunikannya.

Urutan penerapan setelah file terbaru disalin ke Apps Script:

1. Jalankan `setupFMartDatabase_()`. Fungsi ini melengkapi empat header baru di ujung kanan tanpa mengubah delapan kolom sumber.
2. Jalankan `auditFMartSantriMaster_()`. Fungsi ini hanya membaca data. Pastikan tidak ada NIS kosong/duplikat, nama kosong, atau SantriId duplikat.
3. Setelah hasil audit bersih, jalankan `migrateFMartSantriMaster_()`. Fungsi ini mengisi SantriId deterministik dari NIS, metadata waktu, dan Status awal `AKTIF` untuk baris yang memiliki NIS serta nama. Baris tidak lengkap dilewati. Status awal ini mengasumsikan daftar sumber berisi santri aktif; jika sheet juga memuat alumni/nonaktif, hentikan sebelum migrasi dan petakan statusnya terlebih dahulu.
4. Jalankan kembali `auditFMartDatabaseIntegrity_()`. Temuan header Santri yang sebelumnya muncul seharusnya sudah tidak ada.

Migrasi tidak menulis ulang delapan kolom sumber FMPay. Jangan menjalankan migrasi sebelum memeriksa hasil audit khusus Santri. Setelah fungsi migrasi berhasil, uji pencarian Santri dan relasi Wali di runtime Apps Script sebelum melanjutkan ke tahap berikutnya.



### Fungsi pemeliharaan internal

Fungsi setup, audit, migrasi, pembuatan akun awal, dan pemasangan trigger yang hanya boleh dijalankan operator telah menggunakan akhiran `_`. Fungsi-fungsi tersebut tidak tersedia sebagai endpoint `google.script.run` dari browser. Jalankan dari Apps Script Editor setelah file terbaru disalin. Endpoint pembuatan akun staf untuk aplikasi tetap `createStaffUser()` dan dibatasi untuk Superadmin.

## Integrasi PWA

Web App Apps Script tetap memakai `ALLOWALL` karena PWA memuatnya di dalam iframe lintas domain. Google Apps Script tidak menyediakan konfigurasi allowlist origin untuk header frame pada `HtmlOutput`; `DEFAULT` akan memblokir integrasi iframe. Sebagai mitigasi tambahan, shell PWA menolak dirinya sendiri jika disematkan oleh situs lain. Komunikasi `postMessage` dibatasi dengan pemeriksaan `event.source` dan origin: shell hanya menerima pesan dari frame Apps Script pada host Google yang diizinkan, sedangkan halaman Apps Script hanya menerima pesan dari parent `https://appfathanmubina.github.io`. Pesan keluar dari Apps Script memakai target origin PWA yang eksplisit. Pengiriman dari shell ke iframe memakai target `*` karena origin akhir HtmlService dapat berubah pada redirect Google; penerima di iframe tetap memverifikasi origin dan sumber parent. Mitigasi shell ini bukan pengganti header `frame-ancestors`/`X-Frame-Options` dan tidak melindungi jika origin PWA tepercaya diambil alih. Jangan mengubah `ALLOWALL` menjadi `DEFAULT` tanpa memindahkan arsitektur PWA dari iframe.

URL deployment disimpan di `config.js`. Host shell melalui HTTPS (misalnya GitHub Pages dari root branch utama). PWA menyimpan shell untuk dibuka offline, tetapi login dan data FMart tetap memerlukan koneksi.

## Pemisahan jalur Pembeli dan Admin

- Jalur Pembeli memakai halaman utama PWA: `/`. Shell mengirim parameter portal `BUYER` ke Web App Apps Script.
- Jalur petugas memakai alamat khusus: `/adminFMart16720/` (pada GitHub Pages project site, tambahkan prefiks path repository jika hosting menggunakannya). Halaman ini berada pada folder `adminFMart16720/` dan mengirim parameter portal `ADMINFMART16720`.
- Login Pembeli hanya menerima role `WALI_SANTRI`. Jalur Admin menerima role petugas `ADMIN`, `SUPERADMIN`, `KASIR`, `GUDANG`, dan `PETUGAS_PENGANTAR`. Pemeriksaan dilakukan di backend pada saat login dan setiap pemulihan sesi; mengganti parameter dari browser tidak cukup untuk memperoleh role lain.
- Tombol pendaftaran Wali Santri tidak ditampilkan pada jalur Admin.
- Nama path yang tidak mudah ditebak hanya lapisan pengurangan paparan, bukan autentikasi. Keamanan tetap bergantung pada password, sesi, dan pemeriksaan role pada setiap fungsi backend. Jangan membagikan alamat Admin secara terbuka.
- Setelah perubahan ini, salin ulang `apps-script/Code.gs` dan `apps-script/Index.html` ke proyek Apps Script, lalu buat deployment version baru. PWA GitHub Pages juga harus memuat commit terbaru. URL Web App di `config.js` tidak berubah.



### Navigasi sidebar berdasarkan role

Sidebar workspace Admin memakai satu pola visual untuk desktop dan HP, tetapi item menu ditampilkan sesuai kewenangan akun:

- `SUPERADMIN`: Dashboard, Pesanan, Produk, Stok, Penerimaan, Riwayat Gudang, Distribusi, Komplain, Pengguna, Laporan, dan Pengaturan QRIS.
- `ADMIN`: seluruh menu operasional dan manajemen di atas kecuali Pengaturan QRIS.
- `KASIR`: Dashboard dan Kasir (workspace transaksi/verifikasi pembayaran).
- `GUDANG`: Dashboard, Pesanan, Stok, Penerimaan, Riwayat Gudang, dan Distribusi.
- `PETUGAS_PENGANTAR`: Dashboard dan Pengantaran saja.

Pembatasan menu di sidebar hanya untuk pengalaman pengguna; setiap endpoint backend tetap harus memeriksa sesi dan role agar pemanggilan langsung dari browser tidak melewati hak akses.

## Migrasi hash password (bertahap)

Backend menyiapkan format versi `pbkdf2-sha256:600000:...` berbasis PBKDF2-HMAC-SHA256, dengan kompatibilitas verifikasi hash SHA-256 lama dan migrasi otomatis setelah login berhasil. Mode tetap `LEGACY` secara default agar waktu login tidak berubah sebelum benchmark pada runtime Apps Script sebenarnya. Jalankan `testPbkdf2Implementation_()` dan `benchmarkPbkdf2_()` dari editor Apps Script; aktifkan `PASSWORD_HASH_MODE: 'PBKDF2'` hanya setelah vektor uji RFC 8018 lolos dan estimasi 600.000 iterasi memenuhi target waktu login (disarankan kurang dari 1 detik). Setelah mode diaktifkan dan deployment diperbarui, akun lama dimigrasikan saat login sukses; akun baru, reset password, dan perubahan password langsung memakai PBKDF2. Jangan menghapus kompatibilitas SHA-256 sebelum seluruh akun lama selesai bermigrasi atau sudah diwajibkan reset password.


## Login Admin tanpa OTP email (sementara)

- Jalur Admin menggunakan alamat email staf sebagai username untuk role `ADMIN`, `SUPERADMIN`, `KASIR`, dan `GUDANG`. Jalur Pembeli tetap menggunakan nomor HP Wali Santri.
- Untuk sementara, login Admin hanya memerlukan email dan password. Pengiriman dan verifikasi OTP email tidak dipanggil pada alur login.
- Pemeriksaan password, status akun, pembatasan percobaan login, sesi, dan pembatasan role tetap aktif. Penonaktifan OTP mengurangi satu lapis keamanan dan hanya merupakan konfigurasi sementara.
- Fungsi backend OTP dan verifikasi alamat email tetap disimpan untuk kemungkinan pengaktifan kembali setelah alur dan UI siap.
- Kolom tambahan pada sheet `Users`: `Email` dan `EmailVerified`. Jalankan `setupFMartDatabase_()` untuk melengkapi header yang belum ada; fungsi setup tidak menghapus data lama.
- Bootstrap Superadmin pertama meminta alamat email. Untuk Superadmin lama, buka **Project Settings → Script Properties**, tambahkan `FMART_INITIAL_SUPERADMIN_EMAIL` berisi email aktif Superadmin, lalu jalankan fungsi publik `prepareExistingSuperadminEmailFromEditor_()` dari Apps Script Editor. Fungsi ini tidak menggunakan dialog Spreadsheet, memeriksa keunikan email, memperbarui username + kolom `Email`, mengatur `EmailVerified` menjadi FALSE, memverifikasi hasil simpan, lalu menghapus Script Property tersebut setelah berhasil. Email staf lain dapat diisi pada kolom `Email` dengan alamat unik yang dapat diakses staf. Pada login OTP pertama yang berhasil, sistem menandai `EmailVerified` sebagai TRUE. Jangan mengaktifkan akun Admin tanpa email yang benar.
- Fungsi backend `setStaffEmail(token,userId,email)` dan `verifyStaffEmail(token,challengeId,code)` tersedia untuk alur pengelolaan/verifikasi email oleh Superadmin. Integrasi form pengelolaan staf akan diselesaikan pada tahap manajemen pengguna.
- OTP memakai layanan email Apps Script (`MailApp`) dan tunduk pada kuota pengiriman Google. OneSignal tetap digunakan untuk push notification, bukan OTP.
- Setelah pembaruan, sinkronkan file Apps Script dari repository dan deploy versi Web App baru. Perubahan pada repository saja tidak otomatis memperbarui deployment Apps Script.


## Tahap 4 — Manajemen Pengguna dan Hak Akses

- Menu Pengguna memisahkan daftar **Akun Petugas** dan **Akun Wali Santri**.
- Daftar petugas hanya mengirim metadata akun yang aman ke antarmuka; hash dan salt password tidak dikirim.
- Admin dapat melihat daftar akun petugas. Pembuatan, perubahan peran, aktivasi/nonaktifasi, dan reset password tetap dibatasi ke Superadmin di backend.
- Akun Superadmin tidak dapat diedit, dinonaktifkan, atau direset dari menu ini.
- Form tambah petugas memakai email sebagai username dan menyediakan peran Admin, Kasir, atau Gudang. Pembuatan akun Superadmin tetap melalui prosedur setup yang terkontrol.
- Login OTP email tetap dinonaktifkan sementara sesuai keputusan pengembangan; fungsi OTP dipertahankan untuk diaktifkan kembali setelah Tahap 1–12 stabil.
- Pemeriksaan tahap ini bersifat statis. Sinkronisasi Apps Script, deployment, dan pengujian role aktual masih perlu dilakukan.


## Tahap 5 — Katalog Produk dan Kategori

- Halaman katalog Admin menampilkan ringkasan produk dan kategori, kartu kategori, serta daftar produk.
- Kategori dapat ditinjau, diedit, diurutkan, dan diaktifkan/nonaktifkan.
- Produk dapat dicari berdasarkan nama/SKU dan difilter berdasarkan kategori serta status.
- Form produk memuat kategori aktif, SKU, nama, deskripsi, harga, stok minimum, URL foto, dan status.
- Detail katalog diambil dari endpoint katalog yang sudah dilindungi untuk Admin/Superadmin; stok ringkas dipadukan dari dashboard operasional. Penyimpanan produk/kategori/variasi tetap menggunakan fungsi backend yang sudah ada.
- Variasi produk tetap dikelola melalui panel variasi. Stok variasi yang sudah ada tidak dapat diubah dari formulir variasi; gunakan Tahap Persediaan/Mutasi Stok.
- Pemeriksaan tahap ini bersifat statis; sinkronisasi Apps Script, deployment, dan uji coba browser masih diperlukan.

## Tahap 6 — Manajemen Persediaan dan Stok

- Panel Persediaan menampilkan jumlah item stok, total unit, stok menipis, dan stok habis.
- Daftar persediaan mencakup stok produk utama dan stok setiap variasi, dengan pencarian serta filter status.
- Mutasi stok masuk/keluar menggunakan endpoint adjustStock yang sudah ada, tetap menerapkan pemeriksaan role, validasi jumlah, penguncian penulisan, pencegahan stok negatif, pencatatan MutasiStok, dan audit log.
- Riwayat menampilkan hingga 100 mutasi terakhir, termasuk pengurangan stok otomatis dari transaksi yang pembayarannya telah diverifikasi.
- Endpoint getStockManagement hanya membaca data; tidak mengubah struktur sheet atau data stok.
- Stok penjualan tetap dikurangi oleh alur verifikasi pembayaran yang sudah ada. Jangan melakukan pengurangan manual untuk pesanan yang telah diverifikasi.
- Pemeriksaan tahap ini bersifat statis; sinkronisasi Apps Script, deployment, dan uji transaksi pada akun Admin/Gudang masih diperlukan.


## Tahap 7 — Manajemen Pesanan

- Workspace pesanan Admin menampilkan ringkasan status, daftar transaksi, pencarian nomor pesanan/nama Wali/nama Santri/kelas, filter status, dan rentang tanggal.
- Detail pesanan menampilkan identitas transaksi, tanggal, status, daftar barang/variasi, subtotal, pengiriman, diskon, total, dan catatan.
- Daftar Admin memakai data terbaru yang disediakan dashboard operasional (maksimal 60 pesanan). Filter bekerja pada data yang sudah dimuat; bukan pencarian seluruh arsip.
- Alur verifikasi pembayaran tetap terpisah dan hanya dilakukan oleh Admin/Kasir setelah pemeriksaan transaksi bank. Persetujuan pembayaran tetap menjadi satu-satunya alur yang mengurangi stok otomatis.
- Gudang tetap memperbarui tahapan pemenuhan melalui endpoint status operasional yang sudah ada; perubahan status mengikuti transisi yang diizinkan backend.
- Perbaikan layout fluid desktop: wrapper aplikasi dan header tidak lagi dibatasi 1180px; konten operasional memakai padding responsif. Filter dan tabel tetap dapat digulir pada layar kecil.
- Perubahan Tahap 7 berfokus pada UI. Tidak ada perubahan skema Spreadsheet atau aturan transaksi backend.
- Pemeriksaan dilakukan secara statis; uji browser, role aktual, dan runtime Apps Script tetap diperlukan setelah sinkronisasi dan deployment.


## Tahap 8 — Manajemen Pembayaran dan Verifikasi

- Menu Pembayaran menampilkan ringkasan pengajuan menunggu verifikasi, terverifikasi, dan ditolak.
- Riwayat pengajuan yang tersedia dapat dicari berdasarkan nomor pesanan, nama Wali, nama Santri, atau kelas, serta difilter berdasarkan status.
- Petugas yang berwenang dapat membuka bukti pembayaran melalui tautan file yang dikirim oleh endpoint dashboard. URL dibatasi ke HTTP/HTTPS.
- Tindakan Terima/Tolak hanya ditampilkan untuk pembayaran berstatus MENUNGGU_VERIFIKASI. Penolakan mewajibkan catatan agar alasan dapat diteruskan kepada Wali.
- Sebelum menerima, petugas diingatkan mencocokkan nominal dan identitas transaksi dengan dana yang benar-benar masuk. QRIS/transfer tidak diverifikasi otomatis.
- Backend verifyPayment yang sudah ada tetap menjadi otoritas: lock transaksi, pemeriksaan status agar tidak diproses dua kali, pemeriksaan stok, pengurangan stok satu kali, pembaruan status, notifikasi, dan audit log.
- Kasir/Admin/Superadmin memiliki akses verifikasi; Gudang tidak diberi akses verifikasi pembayaran.
- Data pembayaran mengikuti daftar pesanan terbaru yang dimuat dashboard (maksimal 60 pesanan); ini belum merupakan arsip seluruh transaksi.
- Perubahan tahap ini berfokus pada UI dan tidak mengubah struktur Spreadsheet atau aturan transaksi backend.
- Pemeriksaan statis saja; perlu uji browser, akses file bukti, role, verifikasi sukses/gagal, dan stok pada Apps Script runtime setelah sinkronisasi/deployment.


## Tahap 9 — Kasir dan Pemenuhan Pesanan

- Workspace Kasir memisahkan antrean pengajuan pembayaran yang menunggu pemeriksaan dari daftar pesanan dengan pembayaran terverifikasi yang siap diserahkan ke Gudang.
- Kasir dapat membuka detail pesanan dan memulai pemeriksaan pembayaran melalui alur verifikasi yang sama. Otorisasi server tetap membatasi verifikasi kepada ADMIN, SUPERADMIN, dan KASIR.
- Workspace Gudang menampilkan antrean pesanan yang sudah dibayar dengan ringkasan jumlah per tahapan: DIBAYAR, DIPROSES, DISIAPKAN, dan DIANTAR.
- Gudang dapat mencari nomor pesanan/nama Wali/nama Santri/kelas, memfilter tahapan, membuka rincian barang, serta memperbarui tahapan berurutan melalui endpoint updateOrderOperation yang sudah ada.
- Perubahan status Gudang meminta konfirmasi dan menyediakan catatan pemenuhan opsional; transisi tetap divalidasi backend dan dicatat pada audit log/notifikasi.
- Hak akses tetap dipisahkan: KASIR tidak dapat mengubah tahapan pemenuhan; GUDANG tidak dapat memverifikasi pembayaran. Gudang hanya memproses pesanan yang sudah berstatus dibayar.
- Tidak ada perubahan struktur Spreadsheet atau endpoint backend pada tahap ini.
- Layout antrean menggunakan tabel responsif dengan gulir horizontal pada layar sempit dan ringkasan kartu yang menyesuaikan lebar layar.
- Pemeriksaan statis JavaScript/CSS dilakukan; uji browser, alur aktual tiap role, dan runtime Apps Script tetap diperlukan setelah sinkronisasi/deployment.

## Tahap 10 — Laporan dan Aktivitas Audit

- Menu Laporan dan Aktivitas Audit tersedia untuk Admin dan Superadmin.
- Laporan dapat difilter berdasarkan tanggal dan menampilkan jumlah pesanan, nilai pesanan non-batal, pembayaran terverifikasi, belum terbayar, rata-rata pesanan, pesanan aktif, produk terlaris, penjualan per kategori, metode pembayaran terverifikasi, pergerakan stok, tren harian, dan status pesanan.
- Aktivitas Audit dapat difilter berdasarkan tanggal, peran, jenis aktivitas, dan pencarian; endpoint hanya mengirim metadata aktivitas yang diperlukan untuk tampilan. Kolom BeforeData/AfterData tidak dikirim ke browser.
- Riwayat audit dibatasi maksimal 200 catatan terbaru per permintaan agar antarmuka tetap ringan. Ini bukan ekspor arsip audit penuh.
- Endpoint audit bersifat read-only dan memerlukan role ADMIN/SUPERADMIN. Tidak ada perubahan struktur Spreadsheet atau data transaksi pada tahap ini.
- Angka laporan dihitung dari data yang tersedia pada Spreadsheet saat diminta. Nilai penjualan mengecualikan pesanan batal; angka pembayaran mengacu pada pembayaran berstatus TERVERIFIKASI. Pastikan konsistensi tanggal transaksi dan pembayaran saat membandingkan angka.
- Pemeriksaan tahap ini bersifat statis. Sinkronisasi Apps Script, deployment, dan uji data aktual per role tetap diperlukan.



## Tahap 11 — Penyempurnaan UI/UX dan PWA Admin

- Jalur Admin memiliki manifest PWA terpisah pada `/adminFMart16720/manifest.webmanifest`, dengan nama aplikasi, ikon, scope, dan start URL khusus Admin. Instalasi dari jalur Admin tidak diarahkan ke halaman Pembeli.
- Shell Admin menautkan manifest, favicon, dan ikon Apple Touch; iframe menggunakan dynamic viewport height dengan fallback agar area aman perangkat mobile tidak menambah overflow vertikal.
- Status koneksi langsung diperiksa saat shell dibuka, selain saat event online/offline. Pesan offline menjelaskan bahwa shell dapat dibuka, tetapi login dan data tetap memerlukan koneksi.
- Handshake postMessage berulang di shell dihapus karena gate handshake tidak lagi digunakan oleh backend. Ini menghindari timer dan pesan lintas origin yang tidak diperlukan.
- Service worker diperbarui ke cache v6 dan menyertakan manifest Admin untuk dukungan pembukaan shell Admin secara offline.
- Antarmuka Admin mendapat indikator fokus keyboard yang jelas, gulir tabel yang lebih aman pada layar sentuh, batas tinggi/gulir modal, dan aturan lebar konten untuk mengurangi overflow.
- Tidak ada perubahan alur transaksi, struktur Spreadsheet, autentikasi, atau hak akses. Portal Pembeli tetap memakai manifest dan start URL asalnya.
- Pemeriksaan tahap ini bersifat statis. Instalasi PWA, update service worker, mode offline, dan tampilan lintas perangkat tetap perlu diuji pada browser/perangkat nyata setelah commit dipublikasikan.

## Tahap 12 — Review Alur dan Kesiapan Produksi Admin

Review statis repository branch `main` dilakukan pada 16 November 2026. Tahap ini tidak mengubah alur bisnis atau struktur Spreadsheet.

### Hasil review statis

- Sintaks backend `apps-script/Code.gs`: lolos pemeriksaan parser JavaScript.
- Sintaks JavaScript frontend pada `apps-script/Index.html`: lolos setelah placeholder template Apps Script dinormalisasi untuk pemeriksaan.
- Keseimbangan blok CSS pada antarmuka Apps Script: lolos.
- Jalur Admin/Pembeli, portal role guard, dan pemisahan hak akses endpoint operasional diperiksa.
- Endpoint laporan dan audit menggunakan nama fungsi `getFMartReports` dan `getFMartAuditLog`; keduanya membatasi akses pada ADMIN/SUPERADMIN.
- Endpoint stok/mutasi membatasi akses pada GUDANG/ADMIN/SUPERADMIN; verifikasi pembayaran membatasi akses pada KASIR/ADMIN/SUPERADMIN.
- Endpoint audit hanya mengirim metadata aktivitas; kolom BeforeData/AfterData tidak dikirim ke UI.
- Service worker diperbarui ke cache v7. File `config.js` kini menggunakan strategi network-first saat online dan cache fallback saat offline agar URL deployment terbaru tidak tertahan cache lama.

### Batasan yang masih berlaku

- Daftar operasional pesanan pada dashboard masih dibatasi maksimal 60 pesanan terbaru; laporan membaca sheet transaksi untuk periode yang dipilih.
- Tampilan audit membatasi hasil maksimal 200 catatan per permintaan dan belum menyediakan ekspor arsip penuh.
- Login Admin masih menggunakan email + password tanpa OTP sesuai keputusan sementara. Aktifkan kembali OTP sebelum operasional produksi yang memerlukan lapisan autentikasi tambahan.
- Hash password masih dalam mode LEGACY. PBKDF2 belum boleh diaktifkan sebelum uji vektor RFC dan benchmark 600.000 iterasi dijalankan pada runtime Apps Script sebenarnya.
- PWA dapat menyimpan shell untuk dibuka offline, tetapi login, data, transaksi, dan sinkronisasi tetap memerlukan internet.
- Pemeriksaan statis tidak membuktikan integritas data Spreadsheet, izin Drive, kuota Apps Script/MailApp, atau perilaku browser/perangkat nyata.

### Checklist wajib sebelum produksi

1. Sinkronkan file Apps Script terbaru dari repository, jalankan fungsi setup hanya bila memang diperlukan, lalu deploy versi Web App yang sesuai. Perubahan repository tidak otomatis memperbarui deployment Apps Script.
2. Login dan uji akses menggunakan akun SUPERADMIN, ADMIN, KASIR, dan GUDANG. Pastikan role yang tidak berwenang ditolak oleh server, bukan hanya disembunyikan oleh UI. Uji juga akun staf pada jalur Pembeli dan akun Wali pada jalur Admin.
3. Uji alur transaksi end-to-end dengan data uji yang disetujui: katalog, stok, keranjang/pesanan, bukti pembayaran, verifikasi terima/tolak, pengurangan stok satu kali, dan tahapan pemenuhan Gudang.
4. Cocokkan laporan dengan beberapa transaksi dan mutasi stok yang diketahui; cocokkan catatan AuditLog dengan tindakan yang dilakukan.
5. Uji instalasi PWA Admin, pembaruan service worker/cache, pembukaan ulang, mode offline shell, pemulihan koneksi, serta layar desktop/tablet/HP.
6. Pastikan akses Spreadsheet dan folder Drive bukti pembayaran hanya diberikan kepada akun pemilik/layanan yang diperlukan; jangan membagikan spreadsheet atau folder bukti secara publik.
7. Jalankan `testPbkdf2Implementation_()` dan `benchmarkPbkdf2_()` secara terpisah sebelum memutuskan migrasi hash. Tinjau kembali keputusan OTP Admin.

**Status review: LULUS PEMERIKSAAN STATIS, BELUM DINYATAKAN SIAP PRODUKSI.** Pengujian runtime Apps Script, Spreadsheet, akun role aktual, browser, perangkat, deployment, dan transaksi nyata masih wajib dilakukan sebelum menerima transaksi operasional.
## Pengembangan Portal Wali Santri — Tahap 1

### Login dan registrasi Wali Santri

- Jalur Pembeli tetap menggunakan nomor HP dan password untuk akun WALI_SANTRI. Jalur Admin tetap menggunakan email dan password dengan tampilan serta pengaturan portal Admin tersendiri.
- Login Wali menampilkan instruksi yang lebih spesifik, dengan identitas dan tombol yang disesuaikan untuk Wali Santri.
- Form registrasi mandiri diperjelas: nama lengkap, nomor HP aktif, password minimal 10 karakter, konfirmasi password, email opsional, dan alamat opsional.
- Nomor HP pada form registrasi dinormalisasi ke format 08xxxxxxxxxx; format 08, 8, 62, dan +62 diterima selama hasil akhirnya valid.
- Validasi dasar dilakukan sebelum request server: kelengkapan data, format nomor HP, panjang password, kecocokan konfirmasi, dan format email opsional.
- Registrasi tetap memakai endpoint registerWaliSantri yang sudah ada. Akun tidak otomatis dihubungkan ke data santri; pengaitan tetap melalui proses yang tersedia dan verifikasi Admin.
- Styling tambahan dibatasi pada body.buyer-portal dan modal registrasi Wali agar tampilan Admin tidak ikut berubah.
- Tidak ada perubahan pada skema Spreadsheet, autentikasi server, endpoint operasional Admin, atau hak akses role.

### Pemeriksaan Tahap 1

- Pemeriksaan perubahan dilakukan secara statis pada markup, CSS, dan alur JavaScript.
- Belum dilakukan uji browser, registrasi ke Spreadsheet aktif, login akun Wali aktual, maupun deploy Apps Script.
- Perubahan di GitHub tidak otomatis memperbarui deployment Apps Script; sinkronisasi dan deploy tetap mengikuti prosedur yang berlaku.
## Pengembangan Portal Wali Santri — Tahap 2

### Dashboard Wali Santri

- Dashboard Wali ditambahkan pada area utama portal Pembeli, tepat setelah sambutan akun dan sebelum katalog produk.
- Ringkasan akun menampilkan nama Wali, jumlah santri terhubung, pesanan aktif, pesanan yang belum dibayar, dan pembayaran yang menunggu verifikasi.
- Daftar santri menampilkan maksimal empat pilihan awal; pemilihan santri tetap menggunakan mekanisme relasi Wali yang sudah ada.
- Pesanan terbaru menampilkan maksimal lima transaksi dengan nomor pesanan, santri, tanggal, nominal, dan status. Tombol baris membuka detail melalui endpoint pesanan yang sudah ada.
- Status pembayaran terbaru ikut ditampilkan pada daftar pesanan; jika ada pembayaran ditolak, dashboard menampilkan peringatan dan akses langsung ke riwayat pesanan.
- Akses cepat disediakan untuk Mulai Belanja, Pesanan Saya, Keranjang, dan Data Santri/Profil.
- Tombol muat ulang mengambil ringkasan terbaru tanpa memuat ulang seluruh aplikasi. Dashboard juga diperbarui saat Wali kembali ke Beranda.
- Endpoint getWaliDashboard hanya mengizinkan role WALI_SANTRI, mengambil UserId dari sesi tervalidasi, dan membatasi pesanan pada UserId sesi tersebut. Data santri berasal dari relasi aktif WaliSantri dan WaliSantriSantri.
- Ringkasan pembayaran menggunakan pembayaran terbaru per pesanan. Pesanan yang memiliki pengajuan pembayaran menunggu verifikasi tidak dihitung sebagai tagihan yang belum dibayar.
- CSS dan markup dashboard dibatasi pada portal Pembeli melalui selector body.buyer-portal. Tampilan dan fungsi portal Admin tidak diubah.
- Tidak ada perubahan skema Spreadsheet dan tidak ada perubahan pada proses checkout, verifikasi pembayaran, stok, atau pemenuhan pesanan.

### Pemeriksaan Tahap 2

- Sintaks Code.gs diperiksa dengan parser JavaScript: lulus.
- Sintaks JavaScript pada Index.html diperiksa setelah mengambil blok script: lulus.
- Pemeriksaan statis memastikan endpoint memakai role guard WALI_SANTRI, pesanan difilter berdasarkan UserId sesi, dashboard dan tombol akses cepat tersedia, serta styling dibatasi pada portal Pembeli.
- Belum dilakukan pengujian browser, pengujian akun Wali/relasi santri pada Spreadsheet aktif, uji data transaksi langsung, atau deployment Apps Script.
## Pengembangan Portal Wali Santri — Tahap 3

### Profil Wali dan Manajemen Data Santri

- Profil Wali kini dapat menampilkan dan memperbarui nama, email, dan alamat. Nomor HP/username ditampilkan read-only karena menjadi identitas login; perubahan nomor tetap melalui Admin agar tidak memutus sesi atau menimbulkan benturan akun.
- Endpoint getWaliProfileManagement membatasi akses ke role WALI_SANTRI dan mengambil identitas Wali dari sesi, bukan dari parameter browser.
- Data hubungan menampilkan santri dengan relasi AKTIF serta pengajuan MENUNGGU_VERIFIKASI. NIS untuk pengajuan pending disamarkan; data santri aktif mengikuti data relasi yang diverifikasi.
- Wali dapat membatalkan pengajuan relasi miliknya sendiri selama status masih MENUNGGU_VERIFIKASI. Wali tidak dapat membatalkan pengajuan yang sudah diproses atau melepas relasi aktif.
- Persetujuan, penolakan, dan pelepasan relasi aktif tetap menggunakan alur Admin/Superadmin yang sudah ada.
- Endpoint updateMyWaliProfile memperbarui data milik sesi aktif, menyinkronkan nama pada Users, menjaga nomor login tetap, memakai ScriptLock, dan mencatat AuditLog.
- Perubahan profil dan relasi tidak mengubah struktur Spreadsheet, checkout, keranjang, pembayaran, stok, atau fitur Admin.
- Setelah pengajuan dikirim atau dibatalkan, daftar relasi, daftar santri aktif, dan Dashboard Wali diperbarui kembali dari server.
- UI profil dan manajemen santri menggunakan selector body.buyer-portal sehingga styling dan alur profil petugas/Admin tetap terpisah.

### Pemeriksaan Tahap 3

- Sintaks Code.gs dan JavaScript Index.html diperiksa dengan parser: lulus.
- CSS diperiksa keseimbangan kurung kurawal: lulus.
- Pemeriksaan statis memastikan role guard WALI_SANTRI, update profil berbasis sesi, pembatalan hanya untuk relasi pending milik Wali, NIS pending disamarkan, serta styling khusus portal Pembeli.
- Belum dilakukan uji browser, uji data pada Spreadsheet aktif, akun Wali nyata, alur persetujuan Admin, atau deployment Apps Script.
## Pengembangan Portal Wali Santri — Tahap 4

### Katalog Produk, Kategori, dan Pencarian

- Area katalog Wali disusun ulang dengan pengantar katalog, kolom pencarian, pilihan pengurutan, kategori, dan ringkasan hasil.
- Kategori menampilkan jumlah produk yang termasuk pada setiap kategori; pilihan kategori memfilter daftar produk.
- Pencarian mencakup nama produk, SKU, dan deskripsi, dengan tombol hapus pencarian serta aksi reset seluruh filter.
- Pengurutan tersedia untuk rekomendasi (urutan sumber), nama A–Z, harga terendah/tertinggi, dan stok terbanyak.
- Hasil kosong menampilkan informasi dan tombol untuk menampilkan kembali semua produk.
- Navigasi Belanja membuka katalog tanpa mewajibkan pemilihan santri. Wali dapat menjelajahi produk dan membuka detail terlebih dahulu; pemilihan santri tetap diwajibkan saat menambahkan produk ke keranjang.
- Katalog tetap menggunakan getCatalog yang memuat produk dan kategori aktif dari database FMart serta stok hasil agregasi produk/variasi. Tidak ada perubahan backend atau skema Spreadsheet pada tahap ini.
- Perubahan visual dibatasi pada body.buyer-portal; tampilan dan menu katalog operasional Admin tidak diubah.

### Pemeriksaan Tahap 4

- JavaScript pada Index.html diperiksa dengan parser: lulus.
- CSS diperiksa keseimbangan kurung kurawal: lulus.
- Pemeriksaan statis memastikan pencarian nama/SKU/deskripsi, filter kategori, jumlah produk per kategori, pengurutan, keadaan hasil kosong, dan kewajiban memilih santri hanya pada proses keranjang.
- Belum dilakukan pengujian browser pada perangkat, validasi data produk/stok Spreadsheet aktif, atau deployment Apps Script.

## Pengembangan Portal Wali Santri — Tahap 5

### Detail Produk, Foto, Stok, dan Variasi

- Detail produk disusun menjadi tampilan foto dan informasi yang lebih jelas: kategori, nama, SKU, harga, deskripsi, serta ketersediaan stok.
- Foto produk ditampilkan lebih besar dengan mode contain agar gambar tidak terpotong. Jika URL foto kosong atau tidak tersedia, area foto menampilkan placeholder.
- Produk dengan variasi menampilkan pilihan variasi, tambahan harga, dan stok masing-masing variasi. Variasi yang stoknya habis dinonaktifkan sehingga tidak dapat dipilih.
- Setelah variasi dipilih, harga dan stok yang ditampilkan mengikuti variasi tersebut; jumlah maksimum ikut menyesuaikan stok variasi.
- Produk tanpa variasi menggunakan stok produk. Produk/variasi tanpa stok menonaktifkan kontrol jumlah dan tombol tambah ke keranjang/beli sekarang.
- Jumlah pembelian dibatasi minimal satu dan maksimal stok yang tersedia. Validasi stok tetap diperiksa kembali oleh endpoint addToCart di server.
- Pemilihan santri tetap diwajibkan sebelum menambahkan produk ke keranjang. Wali tetap dapat membuka detail produk sebelum memilih santri.
- Backend getProductDetail dan addToCart yang sudah ada tetap digunakan. Tidak ada perubahan skema Spreadsheet, data katalog, maupun fungsi/antarmuka Admin.
- Styling detail produk dibatasi pada body.buyer-portal.

### Pemeriksaan Tahap 5

- Perubahan frontend disimpan pada apps-script/Index.html; Code.gs dan struktur Spreadsheet tidak diubah.
- Pemeriksaan statis perlu memastikan sintaks JavaScript, struktur CSS, dan selector portal Pembeli tetap valid.
- Belum dilakukan uji browser/perangkat, pemuatan foto dari Drive/URL aktual, uji variasi dan stok pada Spreadsheet aktif, transaksi keranjang nyata, atau deployment Apps Script.


## Pengembangan Portal Wali Santri — Tahap 6

### Keranjang umum per akun Wali

- Keranjang kini menjadi milik akun Wali, bukan milik santri tertentu. Wali dapat menambahkan produk dari katalog tanpa memilih santri terlebih dahulu.
- Kolom SantriId pada sheet Keranjang tetap dipertahankan untuk kompatibilitas data lama; item baru tidak mengisi kolom tersebut dan pembacaan/perubahan item dibatasi berdasarkan UserId sesi.
- Item keranjang lama yang sebelumnya tersimpan dengan SantriId tertentu tetap dapat dibaca oleh pemilik akun Wali yang sama. Tidak ada penghapusan atau migrasi massal terhadap data lama.
- Keranjang mendukung pemilihan seluruh atau sebagian item untuk checkout. Perhitungan subtotal dan jumlah barang mengikuti item yang dipilih; item yang tidak dipilih tetap tersimpan.
- Pemilihan santri dilakukan pada checkout. Satu checkout membuat satu pesanan untuk satu santri dan hanya mengeluarkan item yang dipilih dari keranjang. Item lain tetap berada di keranjang untuk checkout berikutnya.
- Backend memvalidasi relasi santri aktif, kepemilikan setiap item keranjang, status produk/variasi, harga, stok, dan jumlah terbaru di bawah ScriptLock sebelum membuat pesanan.
- Setiap pesanan tetap menyimpan SantriId pada sheet Pesanan. Pembayaran, pemenuhan, dan riwayat tetap mengikuti PesananId sehingga setiap transaksi memiliki santri tujuan yang pasti.
- Perubahan styling hanya menggunakan selector body.buyer-portal. Fungsi Admin, Kasir, Gudang, struktur pesanan, pembayaran, dan pengurangan stok saat verifikasi tidak diubah.

### Pemeriksaan Tahap 6

- Pemeriksaan statis sintaks backend/frontend, selector CSS, kepemilikan keranjang, validasi checkout, dan penghapusan hanya item terpilih perlu dilakukan.
- Belum dilakukan uji browser, uji akun Wali/Spreadsheet aktif, transaksi checkout aktual, atau deployment Apps Script.

## Pengembangan Portal Wali Santri — Tahap 7

### Checkout dan Pilihan Pengambilan/Pengantaran

- Checkout menampilkan kembali rincian setiap barang terpilih, variasi, jumlah, harga satuan, dan subtotal sebelum pesanan dibuat.
- Wali wajib memilih satu santri aktif sebagai penerima. Satu checkout tetap menghasilkan satu pesanan untuk satu santri; item yang tidak dipilih tetap tersimpan di keranjang.
- Pilihan pemenuhan terdiri dari antar ke pesantren atau ambil langsung di FMart.
- Untuk pengantaran ke pesantren, Wali wajib mengisi titik atau pihak penerima agar petugas mengetahui tujuan penyerahan. Untuk pengambilan langsung, keterangan tambahan bersifat opsional.
- Catatan pesanan tersedia terpisah dari keterangan tujuan/pengambilan.
- Ringkasan akhir memperlihatkan subtotal, biaya pemenuhan, dan total tagihan. Biaya pemenuhan masih mengikuti konfigurasi saat ini yaitu Rp 0; belum ada tarif dinamis.
- Backend checkout memvalidasi ulang santri aktif, kepemilikan item keranjang, status produk, harga, dan stok di bawah ScriptLock. Backend juga menolak pengantaran tanpa tujuan dan menyimpan metode serta tujuan pada sheet Pengiriman.
- Tidak ada perubahan header atau struktur Spreadsheet. Data tujuan disimpan pada kolom Tujuan yang sudah tersedia di sheet Pengiriman. Fungsi Admin/Kasir/Gudang tidak diubah.

### Pemeriksaan Tahap 7

- Pemeriksaan statis dilakukan pada penggantian alur checkout frontend dan validasi backend.
- Belum dilakukan uji browser, transaksi pada Spreadsheet aktif, pengujian proses pemenuhan oleh Gudang, atau deployment Apps Script.


## Pengembangan Portal Wali Santri — Tahap 8

### Pembayaran, QRIS, Transfer, dan Unggah Bukti

- Halaman pembayaran menampilkan nomor pesanan, santri penerima, dan nominal tagihan yang dikunci mengikuti total pesanan.
- Wali dapat memilih Transfer Bank atau QRIS. Transfer menampilkan bank, nomor rekening, dan nama pemilik rekening; QRIS menampilkan gambar QRIS dari URL HTTPS yang dikonfigurasi Superadmin.
- Pengaturan pembayaran Superadmin kini memiliki URL gambar QRIS. Nilai disimpan sebagai key `PAYMENT_QRIS_IMAGE_URL` pada sheet Pengaturan; tidak menambah atau mengubah header Spreadsheet.
- Kedua metode tetap berupa pembayaran manual. Tidak ada integrasi payment gateway, callback bank, atau konfirmasi otomatis; Admin/Kasir harus memeriksa transaksi aktual sebelum verifikasi.
- Bukti wajib diunggah dalam JPG, PNG, WEBP, atau PDF dengan batas maksimal 5 MB. Frontend memberi informasi nama dan ukuran file; backend memvalidasi MIME, ukuran, nominal harus sama persis dengan total, kepemilikan pesanan, dan status pesanan sebelum menyimpan file ke folder bukti pembayaran.
- Backend hanya menerima metode `TRANSFER` atau `QRIS`, menyimpan metode yang dipilih pada sheet Pembayaran, dan tetap membatasi pengajuan satu pembayaran aktif per pesanan. Hak verifikasi Admin/Kasir yang sudah ada tidak diubah.
- Detail pesanan Wali menampilkan metode, nominal, status, dan informasi bahwa bukti sudah tersimpan. File bukti tetap tidak dibuka untuk role lain selain alur operasional yang berwenang.
- Tidak ada perubahan struktur kolom sheet Pembayaran atau sheet lain. Pengaturan QRIS menggunakan mekanisme key-value yang sudah tersedia.

### Pemeriksaan Tahap 8

- Pemeriksaan statis dilakukan pada blok pembayaran frontend, validasi metode di backend, konfigurasi QRIS, dan struktur CSS.
- Belum dilakukan uji unggah file ke Drive aktif, pemindaian QRIS aktual, pembayaran bank/QRIS, verifikasi oleh Kasir, uji browser, atau deployment Apps Script.
- QRIS hanya dapat digunakan setelah Superadmin mengisi URL gambar QRIS HTTPS yang valid dan dapat diakses Wali.


## Pengembangan Portal Wali Santri — Tahap 9

### Riwayat dan Detail Pesanan

- Riwayat pesanan Wali menampilkan nomor pesanan, santri penerima, kelas, tanggal, total, status pesanan, status/metode pembayaran, dan status pemenuhan.
- Pencarian dapat dilakukan berdasarkan nomor pesanan, nama santri, atau kelas. Filter tersedia untuk status pesanan, santri penerima, dan status pembayaran.
- Ringkasan riwayat menghitung jumlah pesanan yang sesuai filter dan total nilai pesanan yang sedang ditampilkan.
- Detail pesanan menampilkan santri penerima, tanggal dibuat/diperbarui, seluruh item dan variasi, jumlah, harga, subtotal, biaya pemenuhan, diskon, total, serta catatan pesanan.
- Informasi pembayaran menampilkan metode, nominal, status, waktu pengajuan/verifikasi jika tersedia, dan catatan penolakan. Wali tidak diberi akses untuk mengubah status verifikasi.
- Informasi pemenuhan menampilkan metode ambil/antar, tujuan, status, waktu pengiriman/penyerahan, dan waktu diterima jika tersedia.
- Tombol bayar ulang ditampilkan jika pengajuan pembayaran sebelumnya ditolak; status pesanan dan validasi server tetap menjadi penentu akhir.
- Backend riwayat/detail yang sudah membatasi data berdasarkan UserId Wali tetap digunakan. Tidak ada perubahan backend atau struktur Spreadsheet pada tahap ini.

### Pemeriksaan Tahap 9

- Pemeriksaan statis dilakukan pada renderer riwayat/detail, filter, status pembayaran, dan selector CSS buyer-only.
- Belum dilakukan pengujian browser, akun Wali nyata, data transaksi Spreadsheet aktif, atau deployment Apps Script.


## Pembaruan Kebijakan Pembayaran FMart — QRIS Saja

- Wali tidak lagi ditawari pilihan transfer bank. Pengajuan pembayaran baru hanya menerima metode `QRIS`; backend menolak metode selain QRIS.
- Halaman pembayaran menampilkan gambar QRIS, nominal tagihan yang dapat disalin, dan tautan untuk membuka/mengunduh gambar QRIS. Wali tetap wajib mengunggah bukti pembayaran.
- Backend memvalidasi nominal sama persis dengan total pesanan, kepemilikan pesanan, status pesanan, konfigurasi QRIS, jenis file, dan ukuran maksimal 5 MB.
- Pengaturan pembayaran Superadmin disederhanakan menjadi URL gambar QRIS HTTPS dan WhatsApp Admin/Kasir opsional. Pengaturan rekening bank lama tetap tersimpan di sheet tetapi tidak digunakan pada alur pembayaran baru.
- Pembayaran lama yang pernah tercatat sebagai Transfer tetap ditampilkan sebagai histori; tidak diubah atau dihapus.

## Pengembangan Portal Wali Santri — Tahap 10

### Pelacakan Pemenuhan Pesanan dan Konfirmasi Penerimaan

- Detail pesanan kini menampilkan timeline dari pesanan dibuat, pembayaran diverifikasi, diproses, disiapkan, dalam pengantaran/siap diserahkan, hingga diterima.
- Timeline memakai status pesanan dan timestamp pembayaran/pengiriman yang sudah dicatat sistem. Tahap yang belum dicapai ditampilkan sebagai belum selesai; waktu tidak direkayasa jika belum tersedia.
- Untuk pesanan yang dibatalkan, Wali mendapat keterangan pembatalan, bukan timeline penyelesaian normal.
- Tombol konfirmasi penerimaan hanya muncul saat status pesanan `DIANTAR`. Backend `markOrderReceived` tetap memvalidasi sesi Wali, kepemilikan pesanan, dan status sebelum mengubahnya menjadi `DITERIMA`, mencatat waktu penerimaan, notifikasi, dan AuditLog.
- Setelah konfirmasi, riwayat dan detail dimuat ulang agar status terbaru terlihat.
- Tidak ada perubahan skema Spreadsheet atau alur perubahan status Gudang. Tahap operasional tetap DIBAYAR → DIPROSES → DISIAPKAN → DIANTAR.

### Pemeriksaan Tahap 10 dan QRIS

- Pemeriksaan statis dilakukan pada frontend pembayaran, pembatasan metode QRIS backend, pengaturan QRIS, timeline, dan CSS buyer-only.
- Belum dilakukan uji browser, unduh QRIS pada perangkat nyata, salin nominal pada browser perangkat, unggah bukti ke Drive, pemindaian/pembayaran QRIS aktual, maupun uji transaksi penerimaan pada Spreadsheet aktif.
- Tautan gambar QRIS harus dapat diakses tanpa login. Atribut unduh dapat diperlakukan browser sebagai buka gambar pada tab baru jika server gambar tidak mengizinkan unduhan lintas-origin; Wali tetap dapat menyimpan gambar dari tab tersebut.


## Pengembangan Portal Wali Santri — Tahap 11

### Notifikasi, Pengaturan Akun, dan Bantuan

- Header Wali memiliki ikon notifikasi dengan badge jumlah notifikasi belum dibaca.
- Notifikasi diambil dari sheet `Notifikasi`, dibatasi berdasarkan UserId sesi aktif, diurutkan terbaru, dan ditampilkan maksimal 100 notifikasi terbaru.
- Wali dapat menandai satu notifikasi atau seluruh notifikasi sebagai sudah dibaca. Backend memvalidasi kepemilikan notifikasi dan menggunakan ScriptLock saat memperbarui status baca.
- Menu Profil menyediakan akses cepat ke notifikasi, pusat bantuan, dan ganti password.
- Pusat bantuan berisi panduan pembayaran QRIS, pengiriman ulang bukti yang ditolak, pemilihan santri saat checkout, pelacakan pesanan, dan penggantian password. Kontak WhatsApp ditampilkan jika sudah dikonfigurasi.
- Pengaturan akun memakai profil Wali yang sudah tersedia sejak Tahap 3: nama, email, alamat, dan nomor HP/username hanya-baca. Ganti password memakai endpoint yang sudah tersedia.
- Tidak ada perubahan struktur Spreadsheet atau alur Admin/Kasir/Gudang.

### Pemeriksaan Tahap 11

- Pemeriksaan statis dilakukan pada tampilan notifikasi, pembatasan UserId, operasi tandai dibaca, profil, pusat bantuan, dan CSS buyer-only.
- Belum dilakukan pengujian browser, akun Wali aktif, data notifikasi Spreadsheet, WhatsApp, atau deployment Apps Script.


## Pengembangan Portal Wali Santri — Tahap 12

### Penyempurnaan UI/UX, PWA, Responsivitas, dan Audit Alur

- Warna tema browser dan PWA Buyer/Admin diselaraskan dengan identitas FMart `#800080`; ID dan scope manifest Buyer serta Admin tetap terpisah.
- Cache shell PWA dinaikkan ke `fmart-shell-v11` agar perubahan shell, manifest, dan aset terbaru dapat diambil setelah service worker diperbarui.
- Aksesibilitas portal Wali diperkuat dengan indikator fokus keyboard yang terlihat, batas tinggi modal yang mengikuti viewport dinamis, area tabel yang dapat digulir horizontal, dan batas lebar gambar.
- Audit statis alur Wali mencakup login/registrasi, dashboard, profil/relasi santri, katalog dan pencarian, detail produk/variasi/stok, keranjang umum, checkout satu santri per pesanan, pembayaran QRIS saja, riwayat/detail, pelacakan dan konfirmasi penerimaan, notifikasi, pengaturan akun, serta pusat bantuan.
- Shell Buyer dan Admin tetap memakai manifest, start URL, dan rute portal yang berbeda. Handshake tombol instalasi dari iframe ke shell diperiksa pada kedua portal.
- Service worker menyimpan shell statis untuk pembukaan offline, tetapi login, data, transaksi, QRIS, dan unggah bukti tetap membutuhkan koneksi internet karena aplikasi utama berjalan melalui Google Apps Script.
- Styling tambahan Tahap 12 pada antarmuka Wali dibatasi dengan selector `body.buyer-portal`. Tidak ada perubahan skema Spreadsheet atau proses operasional Admin/Kasir/Gudang.

### Hasil audit dan batas pengujian

- Pemeriksaan statis memastikan guard role portal, kebijakan QRIS-only pada backend, endpoint konfirmasi penerimaan, endpoint notifikasi milik Wali, pemisahan manifest Buyer/Admin, handshake instalasi, dan versi cache service worker.
- Pemeriksaan CSS menemukan media query untuk desktop, tablet, dan mobile serta dukungan `prefers-reduced-motion`; aturan fokus keyboard tambahan diterapkan pada kontrol Wali.
- Belum dilakukan uji browser lintas perangkat, instalasi PWA aktual, Lighthouse, uji offline/online nyata, akun multi-role, transaksi Spreadsheet/Drive, pembayaran QRIS aktual, atau deployment Apps Script. Karena itu hasil ini merupakan audit statis repository, bukan sertifikasi siap produksi.
- Sebelum penggunaan produksi, sinkronkan file Apps Script dari repository dan deploy versi terbaru; kemudian uji akun Wali dan semua role petugas, alur pesanan end-to-end, unggah bukti, konfirmasi penerimaan, serta instalasi Buyer dan Admin pada perangkat nyata.


## Identitas Visual FMart — Amethyst

- Tema visual diperkuat pada Portal Wali dan Admin dengan primary purple `#800080`, deep purple `#4F0054`, amethyst `#A64CA6`, lilac `#EBD8EF`, dan soft background `#F7EFF9`.
- Header dan navigasi utama memakai gradasi ungu sebagai elemen identitas yang mudah dikenali; dashboard hero, judul bagian, kategori aktif, kartu produk/pesanan, panel pembayaran, tabel, dan menu profil mendapat aksen ungu/lilac yang konsisten.
- Portal Admin menggunakan nuansa lebih dalam dan tegas, sedangkan Portal Wali lebih cerah dan ramah. Keduanya tetap berbagi sistem warna FMart.
- Status transaksi tetap mempertahankan warna semantik sukses/peringatan/gagal agar tidak tertukar dengan warna merek.
- Warna latar shell dan manifest PWA diselaraskan; service worker dinaikkan ke `fmart-shell-v12` untuk memperbarui cache shell.
- Perubahan hanya pada CSS, warna shell/manifest, cache version, dan dokumentasi. Tidak ada perubahan JavaScript bisnis, endpoint Apps Script, struktur Spreadsheet, checkout, pembayaran QRIS, maupun hak akses.
- Pemeriksaan yang dilakukan bersifat statis terhadap isi repository. Tampilan akhir tetap perlu ditinjau pada browser desktop dan perangkat mobile setelah sinkronisasi/deploy.


## Audit Konsistensi Spacing — Portal Wali dan Admin
- Pemeriksaan statis mencakup Dashboard Wali, katalog, keranjang umum, checkout, riwayat/detail pesanan, pembayaran, profil, serta workspace Admin.
- Ritme jarak diseragamkan untuk heading/deskripsi, isi kartu, item daftar, ringkasan subtotal/total, label/input, panel, tabel, dan modal.
- Tampilan mobile mendapat penyesuaian padding dan gap; tabel tetap menggunakan area horizontal-scroll yang sudah tersedia.
- Perubahan hanya pada CSS presentasi di `apps-script/Index.html`; tidak mengubah endpoint, aturan role, checkout, QRIS, stok, maupun alur transaksi.
- Pemeriksaan statis: keseimbangan kurung CSS dan keberadaan aturan responsive diperiksa. Belum dilakukan screenshot/browser test atau pengujian runtime Apps Script; hasil visual final perlu dikonfirmasi setelah sinkronisasi/deployment.


## Finalisasi Alur Pesanan — Tahap B

### Metode Ambil di FMart (AMBIL_FMART)
- Setelah pembayaran diverifikasi, pesanan mengikuti tahapan Gudang: DIBAYAR → DIPROSES → DISIAPKAN → SIAP_DIAMBIL.
- Pada status SIAP_DIAMBIL, status Pengiriman juga SIAP_DIAMBIL dan Wali menerima notifikasi bahwa barang siap diambil.
- Setelah barang diserahkan secara langsung, Wali mengonfirmasi penerimaan dari detail pesanan. Server memvalidasi kepemilikan pesanan dan kedua status SIAP_DIAMBIL, lalu menyinkronkan Pesanan dan Pengiriman menjadi DITERIMA.
- Metode ambil langsung tidak membuat penugasan Petugas Pengantar, tidak memerlukan foto bukti pengantaran, dan tidak menggunakan auto-konfirmasi 7 hari.

### Metode Antar ke Pesantren (ANTAR_PESANTREN)
- Setelah disiapkan Gudang, pesanan masuk Distribusi untuk ditugaskan kepada Petugas Pengantar.
- Petugas menerima tugas dan memulai perjalanan; pada saat itu status Pesanan dan Pengiriman berubah menjadi DIANTAR.
- Petugas mengunggah bukti foto. Wali mengonfirmasi penerimaan atau mengajukan komplain; auto-konfirmasi tetap mengikuti tenggat 7 hari dan hanya berlaku untuk metode antar.
- Jika pengantaran gagal sebelum bukti diunggah, penugasan menjadi GAGAL dan Pesanan serta Pengiriman kembali ke DISIAPKAN untuk penugasan ulang.

### Sinkronisasi
- Perubahan tahap pembayaran dan pemenuhan memperbarui status Pengiriman terkait bersama status Pesanan.
- Status SIAP_DIAMBIL hanya berlaku untuk AMBIL_FMART. Status DIANTAR hanya dicapai melalui perjalanan Petugas Pengantar untuk ANTAR_PESANTREN.
- Pemeriksaan Tahap B yang dilakukan pada repository bersifat statis; uji transaksi pada Spreadsheet aktif, browser/perangkat, dan deployment Apps Script tetap perlu dilakukan setelah sinkronisasi sumber.


## Pembayaran dan Persediaan — Tahap C

### Akses bukti pembayaran
- File bukti pembayaran tetap disimpan pada folder Drive FMart tanpa membagikan file secara publik.
- Admin, Kasir, dan Superadmin membuka bukti melalui endpoint server getPaymentProofData; server memvalidasi role, ID pembayaran, lokasi file di folder bukti FMart, MIME, dan ukuran sebelum mengirim data file ke viewer internal.
- URL Drive tidak lagi dikirim pada ringkasan antrean operasional. Wali tidak mendapat akses ke bukti milik pesanan lain.
- Viewer mendukung JPG, PNG, WEBP, dan PDF. File yang tidak ditemukan atau tidak berada di folder bukti FMart akan ditolak.

### Kebijakan reservasi stok
- Saat checkout berhasil, jumlah setiap produk/variasi dicatat pada sheet ReservasiStok dengan status AKTIF.
- Masa reservasi awal default 30 menit (STOCK_RESERVATION_MINUTES). Setelah bukti pembayaran berhasil diajukan, masa reservasi diperpanjang default 120 menit (PAYMENT_RESERVATION_MINUTES) agar petugas punya waktu memeriksa transaksi.
- Katalog, detail produk, keranjang, dan checkout Wali menghitung stok tersedia setelah dikurangi reservasi aktif. Checkout tetap memvalidasi ulang di bawah ScriptLock.
- Mutasi stok keluar manual ditolak jika akan menurunkan stok fisik di bawah total stok yang sedang direservasi.
- Ketika pembayaran diverifikasi, reservasi ditandai DIGUNAKAN dan stok fisik dikurangi satu kali. Jika pembayaran ditolak, reservasi dilepas (DILEPAS) agar Wali dapat mengajukan ulang.
- Reservasi yang kedaluwarsa dilepas; jika pesanan masih menunggu pembayaran, pesanan dan pengiriman ditandai DIBATALKAN, pengajuan pembayaran tertunda ditolak, dan Wali diberi notifikasi. Pengecekan kedaluwarsa berjalan saat checkout, pengajuan pembayaran, dan verifikasi pembayaran.
- Setup database menambahkan sheet ReservasiStok dan pengaturan masa reservasi. Setup bersifat idempotent dan tidak menghapus data sheet lain.

### Antrean verifikasi pembayaran
- Batas antrean default 50 pengajuan (PAYMENT_VERIFICATION_QUEUE_LIMIT).
- Pengajuan baru ditolak sementara saat jumlah pengajuan MENUNGGU_VERIFIKASI mencapai batas; Wali mendapat pesan agar mencoba kembali setelah antrean diproses.
- Dashboard dan workspace Kasir menampilkan antrean terlama lebih dahulu, maksimal sesuai batas, dan menampilkan jumlah total yang menunggu serta kapasitas antrean.
- Pembayaran tetap diverifikasi manual setelah dana QRIS benar-benar diterima; tidak ada verifikasi otomatis.

### Pemeriksaan Tahap C dan batas pengujian
- Pemeriksaan statis mencakup akses bukti berbasis role, validasi folder Drive, reservasi checkout, pengurangan stok tersedia, pelepasan reservasi, pengamanan mutasi stok, pembatasan antrean, dan sintaks frontend/backend.
- Belum dilakukan uji unggah/buka file pada Drive aktif, uji checkout bersamaan dari beberapa akun, simulasi reservasi kedaluwarsa, transaksi pembayaran nyata, atau uji browser dan deployment Apps Script.
- Setelah sinkronisasi, jalankan setupFMartDatabase_() sekali agar sheet ReservasiStok dan tiga pengaturan kebijakan dibuat. Periksa izin akses akun deployment ke folder Drive bukti. Tidak perlu membagikan folder atau file bukti kepada publik.

- Pembayaran lama yang sudah menunggu verifikasi sebelum sheet ReservasiStok tersedia akan mencoba membuat reservasi saat petugas memverifikasi. Jika stok sudah tidak cukup, sistem menolak verifikasi agar tidak terjadi penjualan melebihi stok.
- Pembatalan manual oleh Admin juga langsung melepas reservasi dan menolak pengajuan pembayaran yang masih menunggu keputusan.

## Fondasi POS Kasir Penjualan Langsung — Tahap 1

Tahap 1 menyiapkan struktur data untuk penjualan langsung di toko FMart tanpa mencampur transaksi toko dengan pesanan Wali Santri.

### Sheet baru
- `PenjualanToko`: satu baris per transaksi toko, mencatat nomor transaksi, jenis dan identitas pembeli opsional, subtotal/diskon/total, metode pembayaran, uang diterima/kembalian, status pembayaran/transaksi, kasir, catatan, dan waktu transaksi.
- `DetailPenjualanToko`: rincian produk/variasi, SKU, snapshot nama dan harga saat transaksi, jumlah, serta subtotal per baris.

### Kebijakan data awal
- Pembeli dapat dipilih sebagai UMUM, diisi nama, atau dipilih dari data Santri. Relasi Santri bersifat opsional.
- Kasir yang membuat transaksi wajib tercatat sebagai referensi akun Users.
- Rincian transaksi terhubung ke PenjualanToko, Produk, dan VariasiProduk (jika ada).
- Skema ini belum menjalankan transaksi, mengurangi stok, memproses tunai/QRIS, atau membuat struk. Fungsi-fungsi tersebut dibangun bertahap setelah fondasi data siap.
- Sheet baru ditambahkan secara non-destruktif oleh `setupFMartDatabase_()`; fungsi setup mengisi header sheet yang belum ada dan tidak menghapus data sheet yang sudah ada.
- `auditFMartDatabaseIntegrity_()` kini memeriksa keberadaan, header, ID utama, dan relasi dasar kedua sheet POS.

### Langkah sinkronisasi
1. Sinkronkan file `apps-script/SetupDatabase.gs` dari repository ke project Apps Script.
2. Jalankan `setupFMartDatabase_()` satu kali dari Apps Script Editor untuk membuat dua sheet POS yang baru.
3. Jalankan `auditFMartDatabaseIntegrity_()` dan periksa bahwa `PenjualanToko` serta `DetailPenjualanToko` muncul tanpa masalah skema/relasi.
4. Jangan membuat transaksi uji pada database aktif sebelum endpoint POS dan prosedur pembatalan/pemulihan selesai dibuat pada tahap berikutnya.

Pemeriksaan pada tahap ini bersifat statis terhadap repository. Belum ada perubahan pada `Code.gs` atau `Index.html`, dan belum dilakukan pengujian runtime Apps Script/Spreadsheet aktif.

## Mesin Transaksi POS Kasir — Tahap 2

### Endpoint server
- `getCashierPOSData(token, searchText)`: katalog produk/variasi untuk Kasir, harga dan stok dari server, stok tersedia setelah dikurangi reservasi pesanan Wali dan reservasi QRIS toko, serta 12 transaksi terakhir.
- `searchCashierSantri(token, searchText)`: pencarian santri aktif berdasarkan nama/NIS untuk identitas pembeli opsional.
- `createCashierSale(token, payload)`: validasi item, kuantitas, harga, stok, identitas pembeli, metode pembayaran, dan kunci idempotensi. Harga tidak pernah diterima dari browser.
- `confirmCashierQrisPayment(token, saleId, reference)`: konfirmasi manual oleh Kasir/Admin setelah dana QRIS benar-benar terlihat masuk.
- `cancelCashierQrisSale(token, saleId, reason)`: membatalkan transaksi QRIS yang belum dibayar dan melepas reservasi stok.

### Aturan transaksi dan stok
- Penjualan tunai dicatat LUNAS dan stok langsung dikurangi satu kali; kembalian dihitung di server.
- Penjualan QRIS dicatat MENUNGGU_KONFIRMASI dan stok ditahan selama 15 menit. Stok baru dikurangi ketika Kasir mengonfirmasi dana masuk. Jika belum dibayar, Kasir dapat membatalkan transaksi.
- Kunci `requestKey` wajib unik dari sisi klien untuk mencegah transaksi ganda akibat klik berulang atau pengulangan permintaan jaringan.
- Harga, variasi, status produk, jumlah, dan ketersediaan stok diperiksa ulang di bawah ScriptLock. Identitas pembeli dapat UMUM, NAMA, atau SANTRI.
- Setiap penjualan yang mengurangi stok menulis MutasiStok dengan referensi PenjualanId dan mencatat AuditLog.
- Reservasi QRIS toko diperhitungkan dalam ketersediaan katalog/keranjang Wali, checkout Wali, dan mutasi keluar Gudang agar stok tidak dijanjikan dua kali.
- Metode QRIS pada tahap ini masih menggunakan konfirmasi manual; belum ada integrasi payment gateway, webhook, atau pembuatan QR dinamis.
- Tahap ini belum membuat antarmuka POS, cetak struk, laporan penjualan, refund, atau pembatalan transaksi tunai.

### Sinkronisasi dan pemeriksaan
1. Sinkronkan `apps-script/Code.gs` dan `apps-script/SetupDatabase.gs` dari branch `main` ke project Apps Script.
2. Jalankan `setupFMartDatabase_()` satu kali. Fungsi ini menambahkan kolom `RequestKey` dan `ReferensiPembayaran` ke `PenjualanToko`, serta sheet `ReservasiStokToko` tanpa menghapus baris data lama.
3. Jalankan `auditFMartDatabaseIntegrity_()`; pastikan header dan relasi POS tidak bermasalah.
4. Belum dilakukan transaksi uji pada Spreadsheet aktif. Sebelum dipakai, lakukan uji terkontrol untuk tunai, uang kurang, QRIS menunggu/konfirmasi/batal/kedaluwarsa, duplikasi request, stok terbatas, variasi, dan persaingan dengan checkout Wali.
5. QRIS hanya boleh dikonfirmasi setelah petugas memeriksa dana masuk di kanal merchant. Jangan menyamakan tampilan QR atau screenshot pelanggan dengan bukti dana diterima.

Pemeriksaan pada Tahap 2 bersifat statis terhadap repository. Tidak ada akses runtime ke Spreadsheet aktif, sehingga transaksi nyata dan konsistensi hasil stok belum teruji.

### Audit runtime POS
- `auditFMartRuntime_()` kini memeriksa keberadaan tiga sheet POS dan menampilkan agregat status transaksi serta status pembayaran penjualan toko.
- Kunci idempotensi transaksi terikat pada akun kasir pembuatnya; kunci yang sama tidak dapat dipakai akun lain untuk membaca hasil transaksi.

## Antarmuka POS Kasir — Tahap 3

### Antarmuka dan alur penggunaan
- Workspace Kasir kini memiliki menu **Kasir POS** tersendiri. Menu juga tersedia bagi Admin dan Superadmin sesuai izin endpoint POS; role lain tidak mendapat akses menu tersebut.
- Katalog POS dimuat melalui `getCashierPOSData`, dengan pencarian nama produk, SKU, dan variasi. Harga dan stok yang ditampilkan berasal dari server.
- Kasir dapat menambahkan produk/variasi ke keranjang, mengubah kuantitas, melihat subtotal/total, dan mengosongkan keranjang.
- Identitas pembeli bersifat opsional: **Umum**, **Nama pembeli**, atau **Santri**. Pencarian santri menggunakan endpoint `searchCashierSantri`.
- Kasir dapat memilih **Tunai** atau **QRIS**. Untuk tunai, kasir memasukkan nominal diterima dan UI menghitung estimasi kembalian; server tetap memvalidasi nominal dan menghitung kembalian final.
- Tombol proses transaksi mengirim item dan identitas pembeli ke `createCashierSale`. Harga tidak dikirim sebagai sumber kebenaran; server mengambil ulang harga dan memeriksa stok.
- Kunci idempotensi dibuat sekali per percobaan checkout dan dipertahankan jika permintaan gagal, agar retry tidak membuat transaksi ganda. Kunci baru dibuat setelah transaksi berhasil atau keranjang diubah.
- Setelah transaksi tunai berhasil, UI mengosongkan keranjang dan memuat ulang katalog. Untuk QRIS, UI memberi tahu bahwa transaksi masih menunggu konfirmasi manual; UI tidak menampilkan QR dinamis atau menganggap screenshot pelanggan sebagai bukti dana masuk.
- Antrean verifikasi pembayaran pesanan Wali dan daftar pesanan siap dipenuhi yang sebelumnya ada di Workspace Kasir tetap dipertahankan di bawah panel POS.

### Responsivitas
- Katalog dan keranjang menggunakan layout dua kolom pada layar lebar dan bertumpuk pada tablet/ponsel.
- Daftar produk memiliki area gulir tersendiri; kontrol kuantitas, metode pembayaran, dan checkout disesuaikan untuk layar kecil.
- Perubahan UI dibatasi pada portal Admin/Kasir dan tidak mengubah tampilan Portal Wali.

### Pemeriksaan Tahap 3
- Pemeriksaan sintaks JavaScript inline pada `Index.html` berhasil.
- Pemeriksaan statis memastikan menu POS ditambahkan pada navigasi role Kasir/Admin/Superadmin, endpoint POS dipanggil sesuai kontrak, serta workspace antrean pembayaran Wali tetap ada.
- Belum dilakukan pengujian browser, akun Kasir nyata, koneksi Google Apps Script, transaksi pada Spreadsheet aktif, atau pembayaran tunai/QRIS aktual. Uji perangkat dan runtime tetap wajib sebelum operasional.
- QRIS tetap membutuhkan konfirmasi manual setelah petugas memeriksa dana masuk. Fitur antrean konfirmasi dan pembatalan QRIS khusus penjualan toko disempurnakan pada Tahap 4.

## Konfirmasi QRIS Penjualan Toko — Tahap 4

### Antrean QRIS Kasir
- Endpoint `getCashierQrisQueue(token)` menyediakan antrean khusus penjualan toko dengan metode QRIS dan status pembayaran `MENUNGGU_KONFIRMASI`. Endpoint hanya dapat diakses Kasir, Admin, dan Superadmin.
- Data antrean meliputi nomor transaksi, pembeli, kasir pembuat, waktu transaksi, total, catatan, rincian barang, jumlah reservasi aktif, serta waktu kedaluwarsa reservasi.
- Antrean diurutkan dari transaksi yang paling lama menunggu agar pemeriksaan dapat dilakukan secara FIFO.
- UI POS menampilkan kartu antrean, rincian barang, nominal, referensi pembayaran opsional, dan sisa waktu reservasi yang diperbarui setiap detik.
- Reservasi stok QRIS berlaku 15 menit sejak transaksi dibuat. Setelah waktu habis, UI menandai transaksi **Reservasi Habis** dan menonaktifkan tindakan konfirmasi. Petugas tetap dapat membatalkan transaksi untuk melepas baris reservasinya.
- Antrean QRIS hanya dimuat saat workspace pertama kali dibuka, ketika kasir meminta pembaruan, atau setelah transaksi QRIS dikonfirmasi/dibatalkan/dibuat. Pencarian katalog tidak memanggil ulang antrean pada setiap ketikan.

### Konfirmasi pembayaran
- Sebelum tombol konfirmasi dapat digunakan, kasir wajib mencentang pernyataan bahwa dana sudah diperiksa dan benar-benar masuk pada kanal merchant.
- UI menampilkan konfirmasi tindakan sekali lagi sebelum memanggil `confirmCashierQrisPayment(token, saleId, reference)`.
- Server memeriksa ulang status transaksi, metode QRIS, keberadaan detail transaksi, masa berlaku dan cakupan reservasi untuk setiap item, status aktif produk/variasi, serta kecukupan stok fisik di bawah ScriptLock.
- Jika valid, stok dikurangi, MutasiStok dicatat, reservasi ditandai `DIGUNAKAN`, status pembayaran menjadi `LUNAS`, status transaksi menjadi `SELESAI`, dan referensi pembayaran disimpan pada PenjualanToko. Kasir pembuat tetap tercatat; petugas yang mengonfirmasi dicatat pada AuditLog.
- Referensi pembayaran bersifat opsional karena sebagian kanal merchant tidak menampilkan nomor referensi yang mudah disalin. Catatan tersebut bukan pengganti pemeriksaan dana masuk.

### Pembatalan dan reservasi kedaluwarsa
- Tombol **Batalkan & Lepas Stok** meminta persetujuan petugas sebelum memanggil `cancelCashierQrisSale`.
- Server hanya menerima pembatalan transaksi ber-metode QRIS yang masih berstatus `MENUNGGU_KONFIRMASI`. Reservasi aktif ditandai `DILEPAS`, status pembayaran dan transaksi menjadi `DIBATALKAN`, serta alasan pembatalan dicatat.
- Reservasi yang sudah melewati waktu 15 menit tidak lagi mengurangi stok tersedia karena pemetaan reservasi hanya menghitung reservasi aktif yang belum kedaluwarsa. Status penjualan tetap menunggu sampai petugas membatalkan; tidak ada pembatalan otomatis.
- Transaksi dengan reservasi kedaluwarsa tidak dapat dikonfirmasi. Jika dana ternyata baru terlihat setelah reservasi habis, petugas harus mengikuti prosedur toko untuk penjualan baru dan tidak mengaktifkan kembali transaksi kedaluwarsa secara manual.
- Pembatalan dibatasi pada transaksi QRIS; transaksi tunai yang sudah selesai tidak dapat dibatalkan melalui endpoint ini.

### Pemeriksaan Tahap 4 dan batas pengujian
- Pemeriksaan statis: sintaks JavaScript inline `Index.html` dan sintaks `Code.gs` berhasil diperiksa; role guard antrean, filter QRIS pending, pemeriksaan reservasi, konfirmasi manual, pembatalan khusus QRIS, indikator waktu, dan layout mobile diperiksa.
- Antrean QRIS penjualan toko ditampilkan terpisah dari antrean verifikasi pembayaran pesanan Wali; komponen dan aksi verifikasi pesanan Wali tetap dipertahankan.
- Tidak ada perubahan skema Spreadsheet pada Tahap 4. Sheet `PenjualanToko`, `DetailPenjualanToko`, dan `ReservasiStokToko` tetap memakai skema Tahap 1–2.
- Belum dilakukan pengujian browser, akun petugas aktif, Spreadsheet/Drive aktif, transaksi QRIS merchant, simulasi waktu kedaluwarsa, atau deployment Apps Script. Pemeriksaan ini adalah audit statis repository, bukan bukti transaksi live sudah berhasil.
- Setelah sinkronisasi, uji skenario: QRIS baru dibuat; antrean tampil; konfirmasi ditolak bila checkbox belum dicentang; konfirmasi berhasil saat dana sudah masuk dan reservasi masih berlaku; konfirmasi ditolak setelah 15 menit; pembatalan melepas stok; transaksi tunai tidak muncul di antrean QRIS; dan antrean verifikasi pembayaran pesanan Wali tetap berfungsi.

## Struk dan Riwayat Penjualan Kasir — Tahap 5

### Riwayat transaksi
- Endpoint `getCashierSalesHistory(token, filters)` menyediakan daftar penjualan toko dan rincian barang dari `PenjualanToko` serta `DetailPenjualanToko`.
- Pencarian server-side mendukung nomor transaksi, nama pembeli, nama kasir, metode/status pembayaran, nama produk, variasi, dan SKU.
- Filter tanggal awal/akhir tersedia; hasil diurutkan terbaru lebih dahulu dan dibatasi maksimal 150 transaksi per permintaan.
- Kasir hanya dapat melihat transaksi yang dibuat oleh akun Kasir tersebut. Admin dan Superadmin dapat melihat seluruh transaksi penjualan toko.
- Detail transaksi menampilkan daftar produk/variasi, kuantitas, harga satuan, subtotal item, subtotal transaksi, diskon, total, metode pembayaran, uang diterima/kembalian untuk tunai, referensi QRIS bila tersedia, pembeli, kasir, dan waktu transaksi.
- Riwayat memuat status pembayaran. Transaksi QRIS yang belum lunas tetap dapat dilihat, tetapi tidak dapat dicetak sebagai struk final.

### Struk dan cetak
- Tombol **Cetak Struk** hanya aktif untuk transaksi berstatus pembayaran `LUNAS`.
- Struk memuat identitas FMart Fathan Mubina, nomor dan waktu transaksi, kasir, pembeli, rincian item, subtotal, diskon, total, metode pembayaran, serta uang diterima dan kembalian untuk tunai.
- Untuk QRIS, struk menampilkan status LUNAS dan referensi pembayaran jika ada.
- Struk dibuka pada jendela cetak browser agar dapat dicetak melalui printer biasa atau printer thermal yang didukung browser/perangkat. Ukuran cetak mengikuti pengaturan printer/browser; belum ada integrasi langsung ESC/POS atau pemilihan lebar kertas otomatis.
- Jika browser memblokir jendela baru, kasir perlu mengizinkan pop-up untuk aplikasi FMart.

### Pemeriksaan Tahap 5 dan batas pengujian
- Pemeriksaan sintaks JavaScript inline `Index.html` dan `Code.gs` dilakukan setelah perubahan.
- Pemeriksaan statis memastikan role guard, pembatasan data per Kasir, filter pencarian/tanggal, detail transaksi, dan pembatasan cetak hanya untuk pembayaran lunas.
- Riwayat diperbarui setelah POS dibuka, transaksi berhasil dibuat, dan pembayaran QRIS dikonfirmasi. Tombol muat ulang dan filter juga tersedia.
- Tidak ada perubahan skema Spreadsheet pada Tahap 5.
- Belum dilakukan pengujian browser/printer, pengujian akun Kasir/Admin, atau pengujian data transaksi pada Spreadsheet aktif. Hasil ini adalah pemeriksaan statis kode, bukan bukti cetak struk atau riwayat live telah diuji.

## Audit dan Penyempurnaan POS Kasir — Tahap 6

### Penguatan idempotensi
- Penggunaan ulang `requestKey` kini diverifikasi terhadap isi transaksi yang tersimpan: pemilik/kasir, jenis dan identitas pembeli, metode pembayaran, nominal tunai, catatan, serta daftar produk/variasi dan kuantitas.
- Retry dengan payload yang sama mengembalikan transaksi lama tanpa membuat penjualan baru.
- Jika keranjang atau data pembayaran berubah tetapi `requestKey` masih sama, server menolak permintaan. Kasir harus memuat ulang alur dan membuat transaksi baru; jangan mengubah payload saat mengulang permintaan yang hasilnya belum diketahui.

### Audit integritas POS
- Fungsi baru `auditCashierPOSIntegrity_()` merupakan audit read-only untuk data POS.
- Audit memeriksa ID penjualan dan `RequestKey` duplikat, detail transaksi yang hilang, kecocokan subtotal/total, konsistensi status tunai dan QRIS, cakupan reservasi QRIS yang masih berlaku, reservasi aktif yang tidak semestinya, serta keberadaan/duplikasi mutasi stok untuk transaksi lunas.
- Hasil audit menampilkan waktu pemeriksaan, jumlah baris yang diperiksa, daftar kode masalah, dan maksimal 500 temuan. Fungsi ini tidak memperbaiki data secara otomatis.

### Cara menjalankan audit
1. Sinkronkan `apps-script/Code.gs` dari branch `main` ke Apps Script.
2. Dari Apps Script Editor, pilih dan jalankan `auditCashierPOSIntegrity_()`.
3. Periksa objek hasil eksekusi pada log. Jika ada temuan, cocokkan nomor transaksi dengan sheet `PenjualanToko`, `DetailPenjualanToko`, `ReservasiStokToko`, dan `MutasiStok` sebelum melakukan koreksi manual.
4. Jalankan kembali audit setelah koreksi untuk memastikan temuan terkait sudah tidak muncul.

### Batasan yang tetap perlu diperhatikan
- Google Sheets tidak menyediakan transaksi database multi-sheet yang benar-benar atomik. Jika eksekusi terputus setelah sebagian penulisan (misalnya baris penjualan sudah tersimpan tetapi rincian atau mutasi stok belum lengkap), audit dapat mendeteksi sebagian ketidaksesuaian tetapi tidak melakukan rollback atau pemulihan otomatis.
- Jangan menghapus atau mengubah transaksi yang terindikasi tidak lengkap sebelum memeriksa seluruh sheet dan catatan mutasinya. Lakukan pemulihan dengan prosedur administrasi yang terdokumentasi agar stok tidak dikurangi/dikembalikan dua kali.
- Konfirmasi QRIS tetap manual setelah dana benar-benar diterima pada kanal merchant. Tahap ini tidak menambahkan payment gateway atau webhook.
- Pemeriksaan sintaks repository berhasil dilakukan. Belum ada uji runtime pada Spreadsheet aktif, uji transaksi bersamaan, browser/perangkat kasir, atau printer fisik. Audit live harus dijalankan setelah file disinkronkan ke Apps Script.

## Uji Operasional POS dan Validasi Akhir — Tahap 7

### Penyempurnaan hasil audit
- Konfirmasi QRIS sekarang menggabungkan ulang detail yang memiliki produk/variasi sama sebelum memeriksa reservasi dan menyusun pengurangan stok. Ini mencegah baris detail ganda (misalnya data lama atau hasil koreksi manual) memakai snapshot stok yang sama lebih dari sekali.
- Pembatalan QRIS oleh role Kasir dibatasi pada transaksi yang dibuat oleh akun Kasir tersebut. Admin dan Superadmin tetap dapat membantu pembatalan transaksi Kasir lain.
- Audit POS menghitung mutasi stok keluar bertipe `KELUAR` saja, membandingkan jumlah mutasi dengan kuantitas detail, mendeteksi mutasi ganda, dan mendeteksi mutasi penjualan yang tidak memiliki pasangan detail.
- Hasil retry POS ditampilkan lebih akurat: transaksi QRIS yang ternyata sudah LUNAS tidak lagi diberi pesan seolah-olah masih menunggu konfirmasi. Refresh riwayat setelah konfirmasi QRIS juga tidak dilakukan dua kali.

### Matriks uji operasional yang wajib dijalankan

**Persiapan aman**
1. Gunakan Spreadsheet khusus uji, bukan database operasional.
2. Siapkan satu akun Kasir A, Kasir B, Admin, dan Superadmin yang aktif.
3. Siapkan produk tanpa variasi dan produk dengan variasi; masing-masing memiliki stok cukup serta stok terbatas.
4. Catat stok awal, lalu pastikan tidak ada reservasi Wali atau QRIS lain yang mengganggu skenario.
5. Gunakan nominal uji kecil dan jangan menggunakan pembayaran QRIS nyata. Untuk uji alur QRIS, transaksi boleh dibuat pending; lakukan konfirmasi hanya bila benar-benar ada dana masuk ke kanal merchant uji.

| No. | Skenario | Langkah | Hasil yang diharapkan |
|---|---|---|---|
| 1 | Tunai tepat | Buat transaksi tunai dengan uang diterima sama dengan total | LUNAS/SELESAI; stok berkurang sesuai qty; satu mutasi KELUAR per produk/variasi |
| 2 | Tunai lebih | Bayar lebih besar dari total | LUNAS/SELESAI; kembalian tepat; stok berkurang satu kali |
| 3 | Tunai kurang | Masukkan uang di bawah total | UI/server menolak; tidak ada penjualan, detail, mutasi, atau reservasi baru |
| 4 | Stok kurang | Masukkan qty melebihi stok tersedia | Ditolak; stok fisik tidak berubah |
| 5 | Pembeli opsional | Uji UMUM, NAMA, dan SANTRI aktif | Identitas tersimpan benar; NAMA wajib diisi; SANTRI wajib dipilih |
| 6 | QRIS pending | Buat transaksi QRIS | MENUNGGU_KONFIRMASI; stok fisik belum berkurang; reservasi aktif 15 menit muncul di antrean |
| 7 | QRIS konfirmasi | Periksa dana benar-benar masuk, lalu konfirmasi | LUNAS/SELESAI; stok berkurang sekali; reservasi menjadi DIGUNAKAN; referensi tersimpan bila diisi |
| 8 | QRIS batal | Batalkan QRIS pending | DIBATALKAN; reservasi menjadi DILEPAS; stok fisik tidak berubah |
| 9 | QRIS kedaluwarsa | Tunggu melewati 15 menit | Konfirmasi ditolak; stok tersedia kembali; transaksi harus dibatalkan, bukan diaktifkan ulang |
| 10 | Retry jaringan | Ulangi payload yang sama dengan RequestKey yang sama setelah respons pertama tidak diketahui | Transaksi yang sama dikembalikan; tidak ada penjualan atau mutasi ganda |
| 11 | RequestKey berbeda payload | Ubah qty/pembeli/metode tetapi tetap memakai RequestKey lama | Server menolak permintaan |
| 12 | Dua kasir | Kasir A membuat QRIS; Kasir B mencoba membatalkan | Kasir B ditolak; Admin/Superadmin dapat membantu |
| 13 | Sinkronisasi Wali/Gudang | Buat reservasi Wali, lalu coba jual stok yang sama; ulangi dengan mutasi keluar Gudang | POS tidak menjual stok yang sudah direservasi; Gudang tidak mengurangi stok di bawah total reservasi aktif |
| 14 | Riwayat role | Kasir A dan B membuka riwayat; Admin/Superadmin membuka riwayat | Setiap Kasir hanya melihat transaksi miliknya; Admin/Superadmin melihat seluruh transaksi toko |
| 15 | Struk | Cetak transaksi LUNAS dan coba cetak QRIS pending | Struk LUNAS memuat rincian dan nominal benar; transaksi pending tidak dapat dicetak sebagai struk final |
| 16 | Audit akhir | Jalankan `auditCashierPOSIntegrity_()` setelah semua skenario | Tidak ada temuan baru yang tidak dapat dijelaskan; jumlah stok dan mutasi cocok dengan transaksi uji |

### Pemeriksaan yang sudah dilakukan pada repository
- Sintaks backend dan frontend diperiksa kembali setelah perubahan Tahap 7.
- Pemeriksaan statis memeriksa penggabungan detail QRIS, pembatasan pembatalan Kasir, perbandingan kuantitas mutasi, respons retry, dan tidak adanya refresh riwayat ganda.
- Tampilan POS, antrean QRIS, riwayat, dan cetak struk yang telah ada tetap dipertahankan.

### Status pengujian runtime
**Belum dinyatakan lulus operasional.** Akses repository tidak menjalankan Apps Script, tidak membuka Spreadsheet aktif, dan tidak dapat menguji printer fisik atau kanal merchant. Karena itu, semua skenario pada matriks di atas masih berstatus **MENUNGGU UJI LIVE** sampai dijalankan pada database uji dan perangkat kasir. Jangan menandai POS siap operasional hanya berdasarkan pemeriksaan sintaks.

### Prosedur setelah uji
1. Jalankan `auditFMartDatabaseIntegrity_()` dan `auditCashierPOSIntegrity_()` pada Spreadsheet uji.
2. Cocokkan stok awal + mutasi masuk - mutasi keluar dengan stok akhir untuk setiap produk/variasi yang diuji.
3. Pastikan tidak ada reservasi QRIS berstatus AKTIF yang tertinggal dari transaksi selesai/batal.
4. Ulangi uji riwayat dan cetak pada perangkat kasir yang benar-benar akan digunakan.
5. Setelah seluruh hasil tercatat dan temuan ditutup, baru lakukan sinkronisasi ke deployment operasional.



## Tahap 8 — Integrasi Operasional dan Sinkronisasi Data

Tahap ini menyamakan aturan pembacaan stok lintas katalog Wali, POS Kasir, dashboard operasional, dan modul Gudang tanpa mengubah skema database.

### Aturan sumber data
- Sheet `Stok` menjadi sumber utama jumlah stok fisik untuk kombinasi `ProdukId|VariasiId`.
- Kolom `VariasiProduk.Stok` dipertahankan sebagai mirror/kompatibilitas. Pembacaan stok variasi menggunakan baris `Stok` lebih dahulu; kolom variasi hanya menjadi fallback jika baris stok belum tersedia.
- Jika ditemukan baris stok ganda untuk kombinasi yang sama, pembacaan operasional memakai baris pertama (sesuai perilaku pencarian/perubahan stok yang sudah ada). Audit akan melaporkan duplikasi agar dapat diperiksa dan diselesaikan secara manual.
- Produk tanpa variasi menggunakan kunci `ProdukId|`; produk yang memiliki variasi menggunakan stok per variasi dan tidak mencampur stok induk dengan stok variasi.
- Mutasi barang masuk/keluar tetap tercatat pada `MutasiStok`; penerimaan Gudang juga tercatat pada `PenerimaanBarang` dan `DetailPenerimaanBarang`.
- Data santri tetap bersumber dari sheet master `Santri`, dipetakan berdasarkan nama header. POS menyimpan `SantriId` sebagai referensi, bukan menyalin atau membuat data santri baru.

### Penyempurnaan
- POS Kasir dan katalog Gudang memakai fallback stok variasi yang sama.
- Katalog Gudang, manajemen stok, POS, dan dashboard memilih baris stok kanonis pertama secara konsisten ketika data lama memiliki duplikasi.
- Variasi yang sudah dibuat tidak dapat dipindahkan ke ProdukId lain melalui edit. Buat variasi baru pada produk tujuan agar referensi stok lama tidak menjadi yatim.
- Ditambahkan `auditFMartOperationalSync_()` sebagai pemeriksaan read-only untuk master Produk/Kategori/Variasi, baris stok, mirror stok variasi, aritmetika MutasiStok, serta referensi Santri pada pesanan dan penjualan POS.
- Audit tidak memperbaiki data otomatis. Temuan harus ditinjau sebelum koreksi manual agar riwayat stok dan transaksi tidak berubah tanpa jejak.

### Cara validasi setelah sinkronisasi Apps Script
1. Sinkronkan `apps-script/Code.gs` dari branch `main` ke project Apps Script.
2. Jalankan `auditFMartOperationalSync_()` dari Apps Script Editor.
3. Periksa `issueCount` dan setiap kode temuan. Khusus `STOCK_KEY_DUPLICATE`, `VARIATION_STOCK_MIRROR_MISMATCH`, dan `MUTATION_ARITHMETIC_INVALID`, jangan menghapus atau mengubah baris sebelum mencocokkan bukti mutasi/penerimaan/penjualan.
4. Jalankan juga `auditFMartDatabaseIntegrity_()` dan `auditCashierPOSIntegrity_()`.
5. Lakukan UAT dengan akun Gudang, Kasir, Admin, dan Wali pada Spreadsheet uji: penerimaan barang, mutasi MASUK/KELUAR, penjualan tunai, QRIS, reservasi Wali, katalog, dan pencarian santri.

**Status:** perubahan repository dan pemeriksaan statis; menunggu eksekusi audit serta UAT pada runtime Apps Script/Spreadsheet. Tidak ada data operasional yang diubah oleh audit Tahap 8.


## Tahap 9 — Hak Akses Kasir, Admin, dan Superadmin

Tahap ini mempertegas pembatasan menu dan otorisasi server. Pemeriksaan role di antarmuka hanya membantu navigasi; setiap endpoint sensitif tetap memvalidasi sesi dan role pada server.

### Matriks akses operasional

| Fitur | Kasir | Admin | Superadmin |
|---|---|---|---|
| Dashboard | Ringkasan POS milik sendiri | Ringkasan operasional | Ringkasan operasional |
| POS penjualan | Ya | Ya | Ya |
| Riwayat penjualan | Transaksi sendiri | Semua kasir | Semua kasir |
| Antrean QRIS | Transaksi sendiri | Semua kasir | Semua kasir |
| Konfirmasi QRIS | Transaksi sendiri | Semua kasir | Semua kasir |
| Pembatalan QRIS | Transaksi sendiri | Semua kasir | Semua kasir |
| Pesanan Wali & detail | Tidak | Ya | Ya |
| Verifikasi pembayaran pesanan Wali | Tidak | Ya | Ya |
| Bukti pembayaran Wali | Tidak | Ya | Ya |
| Katalog produk/kategori | Tidak | Kelola | Kelola |
| Stok/penerimaan/gudang | Tidak | Ya | Ya |
| Laporan dan audit log | Tidak | Ya | Ya |
| Lihat daftar akun staf | Tidak | Lihat saja | Kelola |
| Buat/ubah/nonaktifkan/reset akun staf | Tidak | Tidak | Ya |
| Pengaturan QRIS | Tidak | Tidak | Ya |
| Pengaturan integrasi Tabungan | Tidak | Ya | Ya |

### Perubahan pengamanan
- Menu Kasir disederhanakan: tidak lagi menampilkan menu Pesanan yang sebelumnya membuka panel POS yang sama. Kasir memakai menu Dashboard dan Kasir POS.
- Dashboard Kasir hanya mengembalikan metrik POS akun tersebut: antrean QRIS miliknya, jumlah transaksi hari ini, dan transaksi lunas hari ini. Data pesanan Wali, daftar pembayaran, daftar produk, dan kategori tidak dikirim melalui respons dashboard Kasir.
- Riwayat penjualan dan daftar QRIS Kasir dibatasi pada transaksi yang dibuat oleh akun Kasir tersebut.
- Kasir hanya dapat mengonfirmasi atau membatalkan transaksi QRIS miliknya. Admin dan Superadmin tetap dapat menangani antrean lintas kasir.
- Kasir tidak lagi dapat membuka detail pesanan Wali, mengambil file bukti pembayaran Wali, atau memverifikasi pembayaran pesanan Wali melalui pemanggilan endpoint langsung.
- Admin tetap dapat melihat daftar akun staf, tetapi tindakan pembuatan akun, perubahan role/nama, penonaktifan, dan reset password tetap khusus Superadmin.
- Pengaturan QRIS tetap khusus Superadmin. Pengaturan integrasi Tabungan tetap dapat diakses Admin dan Superadmin.
- Menu dan endpoint lain yang memang diperlukan oleh Admin/Superadmin dipertahankan.

### Uji akses yang harus dilakukan pada runtime
1. Login sebagai Kasir: hanya Dashboard dan Kasir POS terlihat; riwayat/antrean QRIS hanya berisi transaksi akun tersebut.
2. Kasir mencoba membuka detail pesanan Wali, bukti pembayaran, dan endpoint verifikasi pembayaran: server harus menolak.
3. Kasir mencoba mengonfirmasi atau membatalkan QRIS milik Kasir lain: server harus menolak.
4. Kasir dapat menyelesaikan penjualan tunai dan QRIS miliknya sesuai alur POS.
5. Login sebagai Admin: dapat melihat operasional, mengelola katalog/stok, memeriksa pembayaran Wali, laporan, dan daftar akun staf; tidak dapat mengubah akun staf atau pengaturan QRIS.
6. Login sebagai Superadmin: dapat melakukan seluruh tindakan Admin serta pengelolaan akun staf dan pengaturan QRIS.
7. Pastikan menu tersembunyi tidak menjadi satu-satunya perlindungan: ulangi pengujian dengan pemanggilan endpoint langsung dan pastikan penolakan berasal dari server.

**Status:** perubahan repository dan pemeriksaan statis; uji role langsung di Apps Script/Spreadsheet masih menunggu UAT. Matriks ini mendokumentasikan izin yang diterapkan, bukan bukti bahwa seluruh akun produksi sudah diuji.


## Tahap 10 — Audit UI/UX Kasir POS

Penyempurnaan difokuskan pada pengalaman Kasir di layar desktop dan HP. Tidak ada perubahan pada skema database, perhitungan transaksi, reservasi stok, atau aturan hak akses.

### Perubahan antarmuka
- Area keranjang dibuat tetap terlihat saat menggulir pada layout desktop yang cukup lebar, agar total dan tindakan checkout lebih mudah dijangkau.
- Pada HP, katalog dan checkout tersusun satu kolom; kartu produk tetap dua kolom pada lebar umum dan berubah satu kolom pada layar sangat sempit.
- Area tombol tambah produk, pengatur kuantitas, konfirmasi QRIS, dan tindakan riwayat diperbesar untuk kemudahan sentuhan.
- Pilihan identitas pembeli ditampilkan lebih jelas, sementara warna dan gaya Amethyst yang sudah ada dipertahankan.
- Label stok katalog POS diubah menjadi "Tersedia" karena angka tersebut sudah mengurangi reservasi aktif Wali dan QRIS, bukan stok fisik mentah.
- Fokus keyboard terlihat lebih jelas pada tombol dan input POS, QRIS, serta riwayat.
- Input pada layar kecil menggunakan ukuran font 16px untuk mengurangi pembesaran otomatis browser mobile.
- Area kosong dan informasi status diberi line-height yang lebih nyaman dibaca.

### Penyempurnaan notifikasi dan pencarian
- Toast menggunakan atribut aksesibilitas status/alert; pesan error diumumkan secara assertive, sedangkan informasi dan keberhasilan diumumkan secara polite.
- Notifikasi ditampilkan sedikit lebih lama agar pesan transaksi dapat dibaca.
- Ikon dekoratif pada toast dikecualikan dari pembaca layar.
- Pencarian katalog memakai nomor urut permintaan; respons pencarian lama yang datang terlambat tidak menimpa hasil pencarian terbaru.

### Pemeriksaan
- Pemeriksaan sintaks JavaScript inline dan struktur perubahan CSS dilakukan pada repository.
- Tidak ada perubahan pada endpoint, tabel database, atau proses create/confirm/cancel transaksi.
- Pemeriksaan visual lintas ukuran layar dan interaksi sentuh tetap memerlukan uji browser pada perangkat HP serta desktop sebenarnya.

**Status:** penyempurnaan repository selesai; verifikasi visual dan uji perangkat nyata masih menunggu UAT.


## Tahap 11 — Audit Integrasi dan Keamanan POS

Tahap ini memperkuat validasi sisi server, pemeriksaan status pembayaran, reservasi stok, dan konsistensi mutasi. Perubahan tidak mengubah skema sheet maupun aturan hak akses role.

### Perbaikan server-side
- Konfirmasi QRIS sekarang memeriksa metode pembayaran QRIS sebelum mengembalikan respons idempoten transaksi LUNAS. Endpoint tidak lagi menganggap transaksi tunai LUNAS sebagai konfirmasi QRIS yang berhasil.
- Respons idempoten QRIS LUNAS hanya diterima bila status transaksi juga SELESAI.
- Konfirmasi QRIS mensyaratkan status awal MENUNGGU_KONFIRMASI dan MENUNGGU_PEMBAYARAN.
- Jumlah reservasi QRIS harus berupa bilangan bulat positif dan harus sama persis dengan total kuantitas detail per kombinasi ProdukId/VariasiId.
- Reservasi aktif yang tidak memiliki pasangan detail transaksi menyebabkan konfirmasi dihentikan.
- Penjualan POS menolak baris stok yang hilang, duplikat, negatif, pecahan, atau bukan bilangan bulat aman.
- Sebelum pengurangan stok, seluruh item diperiksa lebih dahulu: indeks baris, kuantitas, stok awal, duplikasi item, kecocokan stok aktual, dan validitas variasi. Penulisan baru dimulai setelah seluruh rencana lolos preflight.
- Audit integritas POS kini memeriksa metode pembayaran yang dikenal, aritmetika harga × kuantitas per detail, kuantitas reservasi QRIS yang harus sama persis, serta reservasi untuk item yang tidak ada pada detail.

### Konkurensi dan batas jaminan
- LockService ScriptLock tetap digunakan pada pembuatan penjualan, konfirmasi/pembatalan QRIS, checkout Wali, verifikasi pembayaran Wali, dan mutasi stok gudang. Ini menyerialkan eksekusi yang menggunakan lock yang sama dalam proyek Apps Script FMart.
- RequestKey tetap menjadi kunci idempotensi untuk retry pembuatan POS; payload bisnis dan pemilik transaksi harus cocok.
- Preflight stok mengurangi risiko kesalahan data menyebabkan sebagian item diproses sebelum item lain tervalidasi.
- Google Sheets tidak menyediakan transaksi database multi-sheet yang atomik. Jika layanan gagal di tengah beberapa operasi tulis, rollback otomatis belum dijamin. Eksekusi dari proyek Apps Script lain atau edit manual langsung pada Spreadsheet juga tidak berbagi ScriptLock proyek ini. Audit dan rekonsiliasi tetap diperlukan.

### Audit read-only
Jalankan dari Apps Script Editor setelah Code.gs terbaru disinkronkan:
- `auditCashierPOSIntegrity_()` — memeriksa transaksi, detail, RequestKey, reservasi QRIS, dan mutasi stok POS.
- `auditFMartOperationalSync_()` — memeriksa konsistensi master produk, variasi, stok, mutasi, dan referensi santri.

Kedua fungsi audit tersebut bersifat read-only; hasilnya tidak memperbaiki atau mengubah data. Simpan hasil audit dan tindak lanjuti setiap issue sebelum operasional.

### Matriks UAT keamanan dan integrasi
1. Transaksi tunai valid mengurangi stok tepat satu kali.
2. Nominal tunai kurang ditolak tanpa membuat transaksi.
3. Retry dengan RequestKey dan payload identik mengembalikan transaksi yang sama.
4. RequestKey sama dengan payload berbeda ditolak.
5. Dua permintaan serentak dengan RequestKey sama tidak membuat dua penjualan.
6. Dua kasir memperebutkan stok terakhir; hanya transaksi yang masih memiliki stok tersedia yang boleh berhasil.
7. Penjualan QRIS membuat reservasi tanpa mengurangi stok fisik.
8. Konfirmasi QRIS kedua kali menghasilkan respons idempoten tanpa mutasi stok kedua.
9. Endpoint konfirmasi QRIS terhadap transaksi tunai ditolak.
10. Reservasi QRIS kurang, berlebih, atau berisi item tak dikenal menolak konfirmasi.
11. Baris stok duplikat atau kuantitas stok tidak valid menolak transaksi.
12. Mutasi gudang keluar tidak boleh menurunkan stok di bawah reservasi aktif.
13. Kasir tidak dapat mengonfirmasi atau membatalkan transaksi milik kasir lain.
14. Admin/Superadmin tetap dapat menjalankan kewenangan sesuai matriks hak akses.

**Status:** perbaikan repository selesai dan pemeriksaan sintaks/static berhasil. UAT multi-akun, simulasi konkurensi nyata, dan audit terhadap Spreadsheet aktif belum dijalankan. Jangan menganggap hasil live terverifikasi sebelum UAT.


## Tahap 12 — Audit Rekonsiliasi Stok dan Pemulihan Transaksi

Tahap ini menambahkan fungsi `auditFMartStockReconciliation_()` di `apps-script/Code.gs`.

### Cakupan pemeriksaan
- Membandingkan rantai saldo pada `MutasiStok` berdasarkan urutan baris pencatatan: saldo sesudah mutasi sebelumnya harus sama dengan saldo sebelum mutasi berikutnya.
- Membandingkan saldo stok saat ini pada sheet `Stok` dengan saldo sesudah mutasi terakhir.
- Mendeteksi baris stok yang hilang/duplikat, saldo stok tidak valid, ID mutasi duplikat, dan aritmetika mutasi yang tidak benar.
- Menghitung reservasi aktif pesanan Wali dan QRIS POS terhadap stok fisik.
- Memeriksa apakah transaksi POS berstatus `LUNAS` memiliki mutasi keluar yang kuantitasnya sama dengan detail penjualan.
- Memeriksa apakah pesanan yang sudah dibayar/diproses/disiapkan/diantar/diterima memiliki mutasi keluar yang sesuai dengan detail pesanan.
- Menghasilkan `recoveryCandidates` yang berisi kode masalah dan saran pemeriksaan/pemulihan.

### Menjalankan audit
Setelah Code.gs terbaru disinkronkan ke Apps Script Editor, jalankan:

```javascript
auditFMartStockReconciliation_()
```

Fungsi mengembalikan `mode: 'READ_ONLY'`, jumlah data yang diperiksa, `issues`, dan `recoveryCandidates`. Maksimal 1.000 temuan ditampilkan agar hasil tidak terlalu besar.

### Kebijakan pemulihan
- Fungsi audit tidak mengubah saldo Stok, VariasiProduk, MutasiStok, PenjualanToko, Pesanan, reservasi, maupun AuditLog.
- Tidak ada penambahan mutasi atau pengurangan/penambahan saldo otomatis. Status transaksi saja tidak cukup untuk membuktikan apakah pengurangan stok sudah terjadi.
- Jika mutasi penjualan hilang, periksa saldo fisik, histori mutasi setelah transaksi, bukti penjualan/pembayaran, dan dokumen penerimaan sebelum melakukan koreksi.
- Koreksi saldo dilakukan melalui prosedur penyesuaian stok resmi oleh petugas berwenang, dengan bukti stock opname dan catatan alasan. Jangan mengedit histori mutasi lama secara langsung.
- Jika rantai mutasi putus, urutan baris sheet digunakan sebagai urutan pencatatan. Audit tidak menyimpulkan tanggal/waktu sebagai urutan mutlak ketika timestamp sama atau data lama tidak lengkap.

### Batasan dan status
- Audit bersifat read-only dan hanya membaca database yang ditunjuk oleh konfigurasi Apps Script saat fungsi dijalankan.
- Audit tidak membuktikan stok fisik di rak; tetap diperlukan stock opname.
- Google Sheets tidak menyediakan transaksi multi-sheet atomik. Audit ini membantu mendeteksi sebagian kondisi penulisan terhenti, tetapi tidak menyediakan rollback otomatis.
- Perubahan repository telah diperiksa secara statis. Uji terhadap Spreadsheet aktif dan pemulihan operasional nyata masih harus dilakukan sebelum FMart dinyatakan lolos rekonsiliasi.
