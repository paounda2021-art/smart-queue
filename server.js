require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initSchema } = require('./db/database');
const apiRoutes = require('./routes/api');
const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 💡 Bypass ngrok free warning page automatically
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const onedriveService = require('./services/onedrive');

// Route พิเศษส่งไฟล์อัปโหลดตรงข้ามหน้าเตือน ngrok
app.get('/uploads/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'uploads', req.params.filename);
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).send('ไม่พบไฟล์เอกสารที่ระบุ');
    }
  });
});

// ☁️ Route เปิด/ดาวน์โหลดไฟล์จาก OneDrive โดยตรง ไม่ต้องผ่าน Login และไม่ติดหน้าจอ Login
app.get(['/download-file/:itemId', '/api/download-onedrive-file/:itemId'], async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const fileName = req.query.name || 'document.pdf';

    if (!itemId) {
      return res.status(400).send('Invalid file item id');
    }

    // 1. ดึงลิงก์ดาวน์โหลดตรงชั่วคราว (@microsoft.graph.downloadUrl) จาก Graph API
    try {
      const directDownloadUrl = await onedriveService.getOneDriveDownloadUrl(itemId);
      if (directDownloadUrl && directDownloadUrl.startsWith('http')) {
        return res.redirect(302, directDownloadUrl);
      }
    } catch (urlErr) {
      console.warn('Could not fetch direct downloadUrl, trying stream:', urlErr.message);
    }

    // 2. สตรีมไฟล์ตรงจาก OneDrive หากไม่ได้ลิงก์ตรง
    const streamRes = await onedriveService.getOneDriveFileStream(itemId);
    const contentType = streamRes.headers['content-type'] || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);

    streamRes.data.pipe(res);
  } catch (err) {
    console.error('Error proxying OneDrive download:', err.message);
    res.status(500).send(`
      <div style="font-family: sans-serif; padding: 30px; text-align: center; background: #f8fafc; border-radius: 12px; max-width: 500px; margin: 40px auto; border: 1px solid #e2e8f0;">
        <h3 style="color: #dc2626; margin-bottom: 10px;">❌ ไม่สามารถเปิดไฟล์จาก OneDrive ได้</h3>
        <p style="color: #475569; font-size: 0.9rem;">สาเหตุ: ${err.message || 'สิทธิ์การเข้าถึงหมดอายุ หรือรหัสตั้งค่าใน .env ไม่ถูกต้อง'}</p>
        <hr style="margin: 20px 0; border: 0; border-top: 1px solid #cbd5e1;">
        <small style="color: #94a3b8;">FMO Smart Queue System</small>
      </div>
    `);
  }
});

// Serve static frontend files (Disable default index.html serving)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Mount API routes
app.use('/api', apiRoutes);

// Redirect หน้าแรก (/) ไปที่หน้า login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve main app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for SPA routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'API route not found' });
  }
  if (req.path.includes('.')) {
    res.status(404).send('Not found');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// Initialize DB and start server
initSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 FMO Smart Queue Server is running on port ${PORT}`);
    console.log(`🌐 Open Web Browser at: http://localhost:${PORT}`);
    console.log(`====================================================`);

    // 🔔 Start Automated Pre-Event Reminder Background Task (Every 15 mins)
    const { dispatchPreEventReminders } = require('./services/notification');
    setInterval(async () => {
      try {
        const result = await dispatchPreEventReminders();
        if (result && result.count > 0) {
          console.log(`[AUTOMATED CRON] 🔔 Auto pre-event reminders dispatched: ${result.count} notifications`);
        }
      } catch (err) {
        console.error('[AUTOMATED CRON] Error in auto pre-event reminder:', err.message);
      }
    }, 15 * 60 * 1000);
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
});