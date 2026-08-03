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
  res.setHeader('ngrok-skip-browser-warning', 'true');
  const itemId = req.params.itemId;
  const fileName = req.query.name || 'document.pdf';

  if (!itemId) {
    return res.status(400).send('Invalid file item id');
  }

  // 1. ดึงลิงก์ดาวน์โหลดตรงชั่วคราว (@microsoft.graph.downloadUrl) จาก Graph API
  if (onedriveService.isOneDriveConfigured()) {
    try {
      const directDownloadUrl = await onedriveService.getOneDriveDownloadUrl(itemId);
      if (directDownloadUrl && directDownloadUrl.startsWith('http')) {
        return res.redirect(302, directDownloadUrl);
      }
    } catch (urlErr) {
      console.warn('Could not fetch direct downloadUrl, trying stream:', urlErr.message);
    }

    try {
      // 2. สตรีมไฟล์ตรงจาก OneDrive หากไม่ได้ลิงก์ตรง
      const streamRes = await onedriveService.getOneDriveFileStream(itemId);
      const contentType = streamRes.headers['content-type'] || 'application/pdf';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);

      return streamRes.data.pipe(res);
    } catch (streamErr) {
      console.warn('OneDrive stream failed, checking local fallback:', streamErr.message);
    }
  }

  // 3. Fallback: ตรวจหาไฟล์สำรองในโฟลเดอร์ public/uploads หาก OneDrive ไม่พร้อมใช้งาน
  try {
    const fs = require('fs');
    const uploadsFolder = path.join(__dirname, 'public', 'uploads');
    if (fs.existsSync(uploadsFolder)) {
      const files = fs.readdirSync(uploadsFolder);
      const matchedFile = files.find(f => f.includes(itemId) || (fileName && f.toLowerCase().includes(fileName.toLowerCase().substring(0, 8))));
      if (matchedFile) {
        const fullLocalPath = path.join(uploadsFolder, matchedFile);
        return res.sendFile(fullLocalPath);
      }
    }
  } catch (localErr) {
    console.error('Local fallback check error:', localErr);
  }

  // 4. กรณีไม่พบไฟล์ทั้งบน OneDrive และในเซิร์ฟเวอร์ แสดงหน้าแจ้งเตือนที่สวยงาม
  res.status(404).send(`
    <div style="font-family: 'Sarabun', sans-serif; padding: 30px; text-align: center; background: #f8fafc; border-radius: 12px; max-width: 500px; margin: 40px auto; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <h3 style="color: #ea580c; margin-bottom: 10px;">📄 เอกสารไฟล์แนบไม่อยู่ในระบบ</h3>
      <p style="color: #475569; font-size: 0.95rem; line-height: 1.5;">ไฟล์เอกสารกำหนดการนี้อาจถูกอัปเดตใหม่ หรือไฟล์ต้นทางถูกย้ายในระบบแล้ว</p>
      <div style="margin-top: 20px;">
        <a href="${process.env.APP_BASE_URL || '/'}" style="display: inline-block; background: #0284c7; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">🏠 เข้าสู่ระบบ FMO Smart Queue</a>
      </div>
      <hr style="margin: 20px 0; border: 0; border-top: 1px solid #cbd5e1;">
      <small style="color: #94a3b8;">องค์การสะพานปลา (อสป.) • FMO Smart Queue System</small>
    </div>
  `);
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