# FMart PWA

Repositori ini berisi shell PWA mobile dan salinan antarmuka/backend Google Apps Script dari ZIP Fase 9. Shell memakai halaman Apps Script sebagai aplikasi utama, sehingga transaksi tetap membutuhkan koneksi internet.

## Menyiapkan Apps Script

1. Buat atau buka proyek Apps Script yang terikat pada Google Spreadsheet FMart.
2. Salin `apps-script/Code.gs`, `apps-script/SetupDatabase.gs`, dan `apps-script/Index.html` ke proyek Apps Script.
3. Jalankan `setupFMartDatabase()` dari editor Apps Script, lalu selesaikan otorisasi Google.
4. Deploy sebagai **Web app**. Pilih identitas eksekusi dan akses pengguna sesuai kebijakan organisasi.
5. Salin URL deployment yang berakhiran `/exec` ke `window.FMART_APP_URL` pada `config.js`.

## Integrasi PWA

Web App Apps Script tetap memakai `ALLOWALL` karena PWA memuatnya di dalam iframe lintas domain. Google Apps Script tidak menyediakan konfigurasi allowlist origin untuk header frame pada `HtmlOutput`; `DEFAULT` akan memblokir integrasi iframe. Sebagai mitigasi tambahan, shell PWA menolak dirinya sendiri jika disematkan oleh situs lain. Shell mengirim handshake `postMessage` saat iframe Apps Script selesai dimuat; halaman Apps Script hanya membuka UI jika pesan berasal dari parent langsung dengan origin `https://appfathanmubina.github.io`. Iframe Apps Script yang dibuka oleh origin lain atau tidak menerima handshake akan diblokir pada sisi antarmuka. Ini mengurangi risiko clickjacking umum, tetapi bukan pengganti header `frame-ancestors`/`X-Frame-Options` dan tidak melindungi jika origin PWA tepercaya diambil alih. Jika domain hosting berubah, allowlist di `apps-script/Index.html` dan konfigurasi iframe harus diperbarui bersamaan. Jangan mengubah `ALLOWALL` menjadi `DEFAULT` tanpa memindahkan arsitektur PWA dari iframe.

URL deployment disimpan di `config.js`. Host shell melalui HTTPS (misalnya GitHub Pages dari root branch utama). PWA menyimpan shell untuk dibuka offline, tetapi login dan data FMart tetap memerlukan koneksi.

## Migrasi hash password (bertahap)

Backend menyiapkan format versi `pbkdf2-sha256$600000$...` berbasis PBKDF2-HMAC-SHA256, dengan kompatibilitas verifikasi hash SHA-256 lama dan migrasi otomatis setelah login berhasil. Mode tetap `LEGACY` secara default agar waktu login tidak berubah sebelum benchmark pada runtime Apps Script sebenarnya. Jalankan `testPbkdf2Implementation_()` dan `benchmarkPbkdf2_()` dari editor Apps Script; aktifkan `PASSWORD_HASH_MODE: 'PBKDF2'` hanya setelah vektor uji RFC 8018 lolos dan estimasi 600.000 iterasi memenuhi target waktu login (disarankan kurang dari 1 detik). Setelah mode diaktifkan dan deployment diperbarui, akun lama dimigrasikan saat login sukses; akun baru, reset password, dan perubahan password langsung memakai PBKDF2. Jangan menghapus kompatibilitas SHA-256 sebelum seluruh akun lama selesai bermigrasi atau sudah diwajibkan reset password.
