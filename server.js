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