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
