# FMart PWA

Repositori ini berisi shell PWA mobile dan salinan antarmuka/backend Google Apps Script dari ZIP Fase 9. Shell memakai halaman Apps Script sebagai aplikasi utama, sehingga transaksi tetap membutuhkan koneksi internet.

## Menyiapkan Apps Script

1. Buat atau buka proyek Apps Script yang terikat pada Google Spreadsheet FMart.
2. Salin `apps-script/Code.gs`, `apps-script/SetupDatabase.gs`, dan `apps-script/Index.html` ke proyek Apps Script.
3. Jalankan `setupFMartDatabase()` dari editor Apps Script, lalu selesaikan otorisasi Google.
4. Deploy sebagai **Web app**. Pilih identitas eksekusi dan akses pengguna sesuai kebijakan organisasi.
5. Salin URL deployment yang berakhiran `/exec` ke `window.FMART_APP_URL` pada `config.js`.

## Audit integritas database (Tahap 2)

Setelah struktur database tersedia, jalankan `auditFMartDatabaseIntegrity()` dari Apps Script Editor. Fungsi ini bersifat **read-only**: tidak membuat sheet, mengubah header, memperbaiki relasi, atau menghapus data. Hasilnya memuat jumlah baris per sheet dan daftar temuan seperti sheet/header yang tidak sesuai, ID utama kosong/duplikat, username/email duplikat, relasi data yang terputus, serta ketiadaan Superadmin aktif.

Jika ditemukan `HEADER_MISMATCH` atau `UNEXPECTED_COLUMNS`, jangan mengubah atau memindahkan kolom secara manual sebelum struktur dan dampaknya diperiksa. Simpan hasil audit (hapus informasi sensitif bila ada) untuk menentukan migrasi yang aman. Audit ini belum menggantikan uji transaksi dan pemeriksaan langsung pada Apps Script runtime.

### Master data Santri bersama FMart dan FMPay

Sheet `Santri` dipertahankan sebagai satu master bersama. Delapan kolom sumber yang sudah ada tidak dipindahkan atau dihapus:

`nis, nama_santri, kelas, asrama, saldo_fpay, limit_harian, nama_wali, no_wa_wali`.

FMart menambahkan empat kolom internal di bagian paling kanan: `SantriId, Status, CreatedAt, UpdatedAt`. Backend FMart membaca data berdasarkan nama header, sehingga kolom saldo dan limit FMPay tidak tertukar dengan identitas Santri. `SantriId` menjadi kunci relasi internal yang stabil; NIS tetap menjadi nomor identitas sumber dan diperiksa keunikannya.

Urutan penerapan setelah file terbaru disalin ke Apps Script:

1. Jalankan `setupFMartDatabase()`. Fungsi ini melengkapi empat header baru di ujung kanan tanpa mengubah delapan kolom sumber.
2. Jalankan `auditFMartSantriMaster()`. Fungsi ini hanya membaca data. Pastikan tidak ada NIS kosong/duplikat, nama kosong, atau SantriId duplikat.
3. Setelah hasil audit bersih, jalankan `migrateFMartSantriMaster()`. Fungsi ini mengisi SantriId deterministik dari NIS, metadata waktu, dan Status awal `AKTIF` untuk baris yang memiliki NIS serta nama. Baris tidak lengkap dilewati. Status awal ini mengasumsikan daftar sumber berisi santri aktif; jika sheet juga memuat alumni/nonaktif, hentikan sebelum migrasi dan petakan statusnya terlebih dahulu.
4. Jalankan kembali `auditFMartDatabaseIntegrity()`. Temuan header Santri yang sebelumnya muncul seharusnya sudah tidak ada.

Migrasi tidak menulis ulang delapan kolom sumber FMPay. Jangan menjalankan migrasi sebelum memeriksa hasil audit khusus Santri. Setelah fungsi migrasi berhasil, uji pencarian Santri dan relasi Wali di runtime Apps Script sebelum melanjutkan ke tahap berikutnya.

## Integrasi PWA

Web App Apps Script tetap memakai `ALLOWALL` karena PWA memuatnya di dalam iframe lintas domain. Google Apps Script tidak menyediakan konfigurasi allowlist origin untuk header frame pada `HtmlOutput`; `DEFAULT` akan memblokir integrasi iframe. Sebagai mitigasi tambahan, shell PWA menolak dirinya sendiri jika disematkan oleh situs lain. Gate handshake di halaman Apps Script telah dihapus karena tidak andal pada redirect lintas domain Apps Script; otorisasi tetap ditegakkan di backend melalui pemeriksaan portal, role, dan sesi. Mitigasi shell ini bukan pengganti header `frame-ancestors`/`X-Frame-Options` dan tidak melindungi jika origin PWA tepercaya diambil alih. Jangan mengubah `ALLOWALL` menjadi `DEFAULT` tanpa memindahkan arsitektur PWA dari iframe.

URL deployment disimpan di `config.js`. Host shell melalui HTTPS (misalnya GitHub Pages dari root branch utama). PWA menyimpan shell untuk dibuka offline, tetapi login dan data FMart tetap memerlukan koneksi.

## Pemisahan jalur Pembeli dan Admin

- Jalur Pembeli memakai halaman utama PWA: `/`. Shell mengirim parameter portal `BUYER` ke Web App Apps Script.
- Jalur petugas memakai alamat khusus: `/adminFMart16720/` (pada GitHub Pages project site, tambahkan prefiks path repository jika hosting menggunakannya). Halaman ini berada pada folder `adminFMart16720/` dan mengirim parameter portal `ADMINFMART16720`.
- Login Pembeli hanya menerima role `WALI_SANTRI`. Jalur Admin menerima role petugas `ADMIN`, `SUPERADMIN`, `KASIR`, dan `GUDANG`. Pemeriksaan dilakukan di backend pada saat login dan setiap pemulihan sesi; mengganti parameter dari browser tidak cukup untuk memperoleh role lain.
- Tombol pendaftaran Wali Santri tidak ditampilkan pada jalur Admin.
- Nama path yang tidak mudah ditebak hanya lapisan pengurangan paparan, bukan autentikasi. Keamanan tetap bergantung pada password, sesi, dan pemeriksaan role pada setiap fungsi backend. Jangan membagikan alamat Admin secara terbuka.
- Setelah perubahan ini, salin ulang `apps-script/Code.gs` dan `apps-script/Index.html` ke proyek Apps Script, lalu buat deployment version baru. PWA GitHub Pages juga harus memuat commit terbaru. URL Web App di `config.js` tidak berubah.

## Migrasi hash password (bertahap)

Backend menyiapkan format versi `pbkdf2-sha256:600000:...` berbasis PBKDF2-HMAC-SHA256, dengan kompatibilitas verifikasi hash SHA-256 lama dan migrasi otomatis setelah login berhasil. Mode tetap `LEGACY` secara default agar waktu login tidak berubah sebelum benchmark pada runtime Apps Script sebenarnya. Jalankan `testPbkdf2Implementation_()` dan `benchmarkPbkdf2_()` dari editor Apps Script; aktifkan `PASSWORD_HASH_MODE: 'PBKDF2'` hanya setelah vektor uji RFC 8018 lolos dan estimasi 600.000 iterasi memenuhi target waktu login (disarankan kurang dari 1 detik). Setelah mode diaktifkan dan deployment diperbarui, akun lama dimigrasikan saat login sukses; akun baru, reset password, dan perubahan password langsung memakai PBKDF2. Jangan menghapus kompatibilitas SHA-256 sebelum seluruh akun lama selesai bermigrasi atau sudah diwajibkan reset password.


## Login Admin tanpa OTP email (sementara)

- Jalur Admin menggunakan alamat email staf sebagai username untuk role `ADMIN`, `SUPERADMIN`, `KASIR`, dan `GUDANG`. Jalur Pembeli tetap menggunakan nomor HP Wali Santri.
- Untuk sementara, login Admin hanya memerlukan email dan password. Pengiriman dan verifikasi OTP email tidak dipanggil pada alur login.
- Pemeriksaan password, status akun, pembatasan percobaan login, sesi, dan pembatasan role tetap aktif. Penonaktifan OTP mengurangi satu lapis keamanan dan hanya merupakan konfigurasi sementara.
- Fungsi backend OTP dan verifikasi alamat email tetap disimpan untuk kemungkinan pengaktifan kembali setelah alur dan UI siap.
- Kolom tambahan pada sheet `Users`: `Email` dan `EmailVerified`. Jalankan `setupFMartDatabase()` untuk melengkapi header yang belum ada; fungsi setup tidak menghapus data lama.
- Bootstrap Superadmin pertama meminta alamat email. Untuk Superadmin lama, buka **Project Settings → Script Properties**, tambahkan `FMART_INITIAL_SUPERADMIN_EMAIL` berisi email aktif Superadmin, lalu jalankan fungsi publik `prepareExistingSuperadminEmail()` dari Apps Script Editor. Fungsi ini tidak menggunakan dialog Spreadsheet, memeriksa keunikan email, memperbarui username + kolom `Email`, mengatur `EmailVerified` menjadi FALSE, memverifikasi hasil simpan, lalu menghapus Script Property tersebut setelah berhasil. Email staf lain dapat diisi pada kolom `Email` dengan alamat unik yang dapat diakses staf. Pada login OTP pertama yang berhasil, sistem menandai `EmailVerified` sebagai TRUE. Jangan mengaktifkan akun Admin tanpa email yang benar.
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
