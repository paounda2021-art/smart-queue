const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { dbRun, dbGet, dbAll } = require('../db/database');
const { sendMissionNotification, sendScheduleChangeNotification, formatDate24h } = require('../services/notification');
const onedriveService = require('../services/onedrive');

// Setup Upload Storage for Attachments
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'attach-' + uniqueSuffix + ext);
  }
});

function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/(https?:\/\/[^\s\n\r]+|(?:www\.|drive\.google\.|docs\.google\.|dropbox\.com|sharepoint\.com)[^\s\n\r]+)/i);
  if (!match) return null;
  let url = match[0];
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB Max
});

// POST /api/upload-attachment - อัปโหลดไฟล์แนบกำหนดการกิจกรรม (รองรับ OneDrive อัตโนมัติ & Fallback)
router.post('/upload-attachment', upload.single('attachment'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'ไม่พบไฟล์ที่อัปโหลด' });
    }
    let originalName = req.file.originalname;
    try {
      originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    } catch (e) {}

    // ☁️ หากมีการตั้งค่า 3 ค่าใน .env (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET) -> ส่งขึ้น OneDrive ทันที
    if (onedriveService.isOneDriveConfigured()) {
      try {
        const fileBuffer = fs.readFileSync(req.file.path);
        const odResult = await onedriveService.uploadToOneDrive(fileBuffer, originalName);

        // ลบไฟล์ชั่วคราวบน Server ออกทันที เพื่อป้องกันพื้นที่เต็ม
        try { fs.unlinkSync(req.file.path); } catch (e) {}

        if (odResult.success) {
          return res.json({
            success: true,
            file_url: odResult.file_url,
            file_name: originalName,
            storage: 'ONEDRIVE'
          });
        } else {
          console.warn('OneDrive upload failed, falling back to local file:', odResult.error);
        }
      } catch (odErr) {
        console.error('OneDrive upload exception, falling back to local file:', odErr);
      }
    }

    // 💻 กรณีที่ยังไม่ได้ตั้งค่า .env สำหรับ OneDrive -> ใช้ไฟล์ใน Local ตามปกติ (ไม่ขัดข้อง)
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({
      success: true,
      file_url: fileUrl,
      file_name: originalName,
      storage: 'LOCAL'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/download-onedrive-file/:itemId - Proxy ดาวน์โหลด/เปิดไฟล์จาก OneDrive โดยตรง ไม่ต้องล็อกอิน Microsoft 365
router.get('/download-onedrive-file/:itemId', async (req, res) => {
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
      console.warn('Could not fetch direct downloadUrl, falling back to stream:', urlErr.message);
    }

    // 2. หากไม่ได้ลิงก์ตรง ให้ใช้การสตรีมไฟล์ผ่านเซิร์ฟเวอร์
    const streamRes = await onedriveService.getOneDriveFileStream(itemId);
    const contentType = streamRes.headers['content-type'] || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);

    streamRes.data.pipe(res);
  } catch (err) {
    console.error('Error proxying OneDrive download:', err.message);
    res.status(500).send('ไม่สามารถดึงไฟล์จาก OneDrive ได้: ' + (err.message || 'เกิดข้อผิดพลาด'));
  }
});

// POST /api/login - ตรวจสอบการเข้าสู่ระบบจากตาราง personnel ใน SQLite
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน' });
    }

    const cleanUser = String(username).trim();
    const cleanUserUpper = cleanUser.toUpperCase();

    // ค้นหาจาก emp_code, email เต็ม, หรือ username หน้า @ (รองรับ amornrat.k, EMP-062)
    const user = await dbGet(`
      SELECT * FROM personnel 
      WHERE UPPER(emp_code) = ? 
         OR UPPER(email) = ? 
         OR UPPER(email) LIKE ?
         OR UPPER(email) LIKE ?
    `, [cleanUserUpper, cleanUserUpper, `${cleanUserUpper}@%`, `%${cleanUserUpper}%`]);

    if (!user) {
      return res.status(401).json({ success: false, error: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
    }

    // ตรวจสอบรหัสผ่าน
    const dbPass = user.password || '123456';
    if (String(password) !== String(dbPass)) {
      return res.status(401).json({ success: false, error: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
    }

    const roleMap = {
      'ADMIN': { role: 'admin', roleLabel: 'ผู้ดูแลระบบ (Admin)' },
      'OPERATOR': { role: 'staff', roleLabel: 'เจ้าหน้าที่ปฏิบัติการ (Operator)' },
      'DIRECTOR': { role: 'staff', roleLabel: 'ผอ.ฝ่าย (Director)' },
      'STAFF': { role: 'staff', roleLabel: 'พนักงาน (Staff)' }
    };

    const rInfo = roleMap[user.role_type] || { role: 'staff', roleLabel: 'พนักงาน (Staff)' };

    res.json({
      success: true,
      message: `ยินดีต้อนรับ   ${user.name}`,
      user: {
        username: user.emp_code,
        label: user.name,
        empCode: user.emp_code,
        position: user.position || 'เจ้าหน้าที่ อสป.',
        department: user.department || 'อสป.',
        role: rInfo.role,
        roleLabel: rInfo.roleLabel,
        menu_permissions: user.menu_permissions ? JSON.parse(user.menu_permissions) : []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Helper: Generate Auto-Running Mission Code (FMO-ATMMYY-XXX)
async function generateMissionCode() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    // ดึงปีปัจจุบัน (เช่น 2026 + 543 = 2569) แล้วตัดเอาแค่ 2 หลักท้าย ('69')
    const thaiYear = now.getFullYear() + 543;
    const shortYear = String(thaiYear).slice(-2);
    const prefix = `FMO-AT${month}${shortYear}-`;

    try {
        // ใช้ dbGet ดึงข้อมูลรหัสล่าสุดของเดือนนี้
        const row = await dbGet(
            `SELECT mission_code FROM missions WHERE mission_code LIKE ? ORDER BY id DESC LIMIT 1`,
            [`${prefix}%`]
        );
        
        let nextNumber = 1;
        // ถ้าระบบค้นเจอข้อมูลเก่า ให้เอาเลข 3 หลักท้ายมาบวก 1
        if (row && row.mission_code) {
            const lastCode = row.mission_code;
            const lastNumberStr = lastCode.split('-').pop(); // ตัดเอาเฉพาะส่วนท้าย
            nextNumber = parseInt(lastNumberStr, 10) + 1;
        }
        
        // ประกอบร่างรหัสใหม่ พร้อมเติมเลข 0 ด้านหน้าให้ครบ 3 หลัก (001, 002, ...)
        return prefix + String(nextNumber).padStart(3, '0');
    } catch (error) {
        console.error('Error generating mission code:', error);
        throw error;
    }
}




// -------------------------------------------------------------
// Helper: Fisher–Yates Shuffle
// ใช้สุ่มลำดับพนักงานอย่างทั่วถึง
// -------------------------------------------------------------
function shuffleArray(items) {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    [shuffled[i], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[i]
    ];
  }

  return shuffled;
}


// -------------------------------------------------------------
// Helper: Auto-advance round if everyone completed
//
// DIRECTOR:
// - ใช้เฉพาะ DIR-01 ถึง DIR-08
// - DIR-09 และ DIR-10 เป็นสำรอง ไม่เข้าคิวอัตโนมัติ
// - เมื่อขึ้นรอบใหม่ เริ่มเรียงจาก DIR-01 เสมอ
//
// STAFF:
// - คนที่ได้รับจัดสรรแล้วเป็น COMPLETED
// - ไม่ถูกเลือกซ้ำภายในรอบเดิม
// - เมื่อครบทุกคน จึงขึ้นรอบใหม่และสุ่มลำดับใหม่ทั้งหมด
// -------------------------------------------------------------
async function checkAndAdvanceRound(roleType) {
  const normalizedRoleType = String(roleType || '').toUpperCase();

  if (!['DIRECTOR', 'STAFF'].includes(normalizedRoleType)) {
    throw new Error(`Invalid role type: ${roleType}`);
  }

  // อ่านรอบปัจจุบัน
  const state = await dbGet(
    `SELECT current_round
     FROM queue_state
     WHERE role_type = ?;`,
    [normalizedRoleType]
  );

  const currentRound = state ? state.current_round : 1;

  let remaining;

  // -----------------------------------------------------------
  // ตรวจจำนวนคนที่ยังไม่จบรอบ
  // -----------------------------------------------------------
  if (normalizedRoleType === 'DIRECTOR') {
    // DIR-09 และ DIR-10 เป็นสำรอง
    // จึงไม่นำมานับว่าต้อง COMPLETED ก่อนขึ้นรอบใหม่
    remaining = await dbGet(
      `SELECT COUNT(*) AS count
       FROM queue_members qm
       JOIN personnel p
         ON p.id = qm.personnel_id
       WHERE qm.role_type = 'DIRECTOR'
         AND qm.current_round = ?
         AND UPPER(p.emp_code) NOT IN ('DIR-09', 'DIR-10')
         AND qm.status != 'COMPLETED';`,
      [currentRound]
    );
  } else {
    // STAFF ทุกคนต้องได้รับการจัดสรรครบก่อนเริ่มสุ่มรอบใหม่
    remaining = await dbGet(
      `SELECT COUNT(*) AS count
       FROM queue_members qm
       WHERE qm.role_type = 'STAFF'
         AND qm.current_round = ?
         AND qm.status != 'COMPLETED';`,
      [currentRound]
    );
  }

  // ยังมีคนที่ไม่ได้รับการจัดสรรในรอบปัจจุบัน
  if (!remaining || remaining.count > 0) {
    return {
      roundAdvanced: false,
      currentRound,
      remainingCount: remaining ? remaining.count : 0
    };
  }

  // -----------------------------------------------------------
  // ทุกคนในรอบครบแล้ว → เริ่มรอบใหม่
  // -----------------------------------------------------------
  const nextRound = currentRound + 1;

  console.log(
    `🔄 ${normalizedRoleType}: ครบรอบ ${currentRound} แล้ว กำลังเริ่มรอบ ${nextRound}`
  );

  await dbRun(
    `UPDATE queue_state
     SET current_round = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE role_type = ?;`,
    [nextRound, normalizedRoleType]
  );

  // -----------------------------------------------------------
  // STAFF: สุ่มลำดับใหม่ทั้งหมดในรอบใหม่
  // -----------------------------------------------------------
  if (normalizedRoleType === 'STAFF') {
    const staffMembers = await dbAll(
      `SELECT
         qm.id AS queue_id,
         qm.personnel_id,
         p.emp_code,
         p.name
       FROM queue_members qm
       JOIN personnel p
         ON p.id = qm.personnel_id
       WHERE qm.role_type = 'STAFF'
       ORDER BY qm.queue_order ASC, p.emp_code ASC;`
    );

    const shuffledStaff = shuffleArray(staffMembers);

    for (let index = 0; index < shuffledStaff.length; index++) {
      const member = shuffledStaff[index];

      await dbRun(
        `UPDATE queue_members
         SET current_round = ?,
             queue_order = ?,
             status = 'WAITING',
             hold_reason = NULL,
             hold_timestamp = NULL
         WHERE id = ?;`,
        [
          nextRound,
          index + 1,
          member.queue_id
        ]
      );
    }

    console.log(
      `🎲 STAFF รอบ ${nextRound}: สุ่มลำดับพนักงานใหม่จำนวน ${shuffledStaff.length} คนเรียบร้อยแล้ว`
    );

    console.log(
      '🎲 ลำดับ STAFF ใหม่:',
      shuffledStaff.map((member, index) =>
        `${index + 1}. ${member.emp_code}`
      ).join(' | ')
    );
  }

  // -----------------------------------------------------------
  // DIRECTOR: เรียงใหม่จาก DIR-01 และกัน DIR-09, DIR-10 เป็นสำรอง
  // -----------------------------------------------------------
  if (normalizedRoleType === 'DIRECTOR') {
    const directors = await dbAll(
      `SELECT
         qm.id AS queue_id,
         p.emp_code,
         p.name
       FROM queue_members qm
       JOIN personnel p
         ON p.id = qm.personnel_id
       WHERE qm.role_type = 'DIRECTOR'
         AND UPPER(p.emp_code) NOT IN ('DIR-09', 'DIR-10')
       ORDER BY
         CAST(
           REPLACE(UPPER(p.emp_code), 'DIR-', '')
           AS INTEGER
         ) ASC;`
    );

    // กำหนด DIR-01 เป็นลำดับแรกทุกครั้งที่เริ่มรอบใหม่
    for (let index = 0; index < directors.length; index++) {
      const director = directors[index];

      await dbRun(
        `UPDATE queue_members
         SET current_round = ?,
             queue_order = ?,
             status = 'WAITING',
             hold_reason = NULL,
             hold_timestamp = NULL
         WHERE id = ?;`,
        [
          nextRound,
          index + 1,
          director.queue_id
        ]
      );
    }

    // DIR-09 และ DIR-10 เป็นสำรอง
    // ไม่ให้ระบบเลือกเข้าคิวอัตโนมัติ
    await dbRun(
      `UPDATE queue_members
       SET current_round = ?,
           status = 'HOLD',
           hold_reason = 'สำรอง ไม่เข้าคิวอัตโนมัติ',
           hold_timestamp = CURRENT_TIMESTAMP
       WHERE personnel_id IN (
         SELECT id
         FROM personnel
         WHERE UPPER(emp_code) IN ('DIR-09', 'DIR-10')
       );`,
      [nextRound]
    );

    console.log(
      `🔁 DIRECTOR รอบ ${nextRound}: เริ่มลำดับใหม่จาก DIR-01 และยกเว้น DIR-09, DIR-10`
    );
  }

  return {
    roundAdvanced: true,
    previousRound: currentRound,
    newRound: nextRound,
    roleType: normalizedRoleType
  };
}

// -------------------------------------------------------------
// 1. DASHBOARD OVERVIEW & ACTIVE QUEUE TRACKER
// -------------------------------------------------------------
router.get('/dashboard/stats', async (req, res) => {
  try {
    const dirState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'DIRECTOR';`);
    const staffState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'STAFF';`);

    const dirRound = dirState ? dirState.current_round : 1;
    const staffRound = staffState ? staffState.current_round : 1;

    // Next Director in Queue
    const nextDirector = await dbGet(
      `SELECT qm.*, p.emp_code, p.name, p.department, p.position 
       FROM queue_members qm
       JOIN personnel p ON qm.personnel_id = p.id
       WHERE qm.role_type = 'DIRECTOR' AND qm.status IN ('HOLD', 'WAITING')
       ORDER BY CASE qm.status WHEN 'HOLD' THEN 1 WHEN 'WAITING' THEN 2 END, qm.queue_order ASC
       LIMIT 1;`
    );

    // Next Staff in Queue
    const nextStaff = await dbGet(
      `SELECT qm.*, p.emp_code, p.name, p.department, p.position 
       FROM queue_members qm
       JOIN personnel p ON qm.personnel_id = p.id
       WHERE qm.role_type = 'STAFF' AND qm.status IN ('HOLD', 'WAITING')
       ORDER BY CASE qm.status WHEN 'HOLD' THEN 1 WHEN 'WAITING' THEN 2 END, qm.queue_order ASC
       LIMIT 1;`
    );

    // Participation Rate
    const totalPersonnel = await dbGet(`SELECT COUNT(*) as count FROM personnel;`);
    const activeParticipants = await dbGet(`SELECT COUNT(DISTINCT personnel_id) as count FROM mission_assignments;`);

    const totalCount = totalPersonnel ? totalPersonnel.count : 102;
    const activeCount = activeParticipants ? activeParticipants.count : 0;
    const participationRate = Math.round((activeCount / totalCount) * 100);

    const dirStats = await dbAll(`SELECT status, COUNT(*) as count FROM queue_members WHERE role_type = 'DIRECTOR' GROUP BY status;`);
    const staffStats = await dbAll(`SELECT status, COUNT(*) as count FROM queue_members WHERE role_type = 'STAFF' GROUP BY status;`);

    // Total Counts by Role
    const totalDirectorsCount = await dbGet(`SELECT COUNT(*) as count FROM personnel WHERE role_type = 'DIRECTOR';`);
    const totalStaffCount = await dbGet(`SELECT COUNT(*) as count FROM personnel WHERE role_type = 'STAFF';`);

    const totalMissions = await dbGet(`SELECT COUNT(*) as count FROM missions;`);
    const completedMissions = await dbGet(`SELECT COUNT(*) as count FROM missions WHERE status = 'COMPLETED';`);
    const scheduledMissions = await dbGet(`SELECT COUNT(*) as count FROM missions WHERE status = 'SCHEDULED';`);
    const totalHolds = await dbGet(`SELECT COUNT(*) as count FROM queue_members WHERE status = 'HOLD';`);

    res.json({
      success: true,
      data: {
        rounds: { directorRound: dirRound, staffRound: staffRound },
        totalDirectors: totalDirectorsCount ? totalDirectorsCount.count : 0,
        totalStaff: totalStaffCount ? totalStaffCount.count : 0,
        activeQueueTracker: {
          nextDirector: nextDirector || null,
          nextStaff: nextStaff || null
        },
        participationRate: {
          ratePct: participationRate,
          activeCount,
          totalCount
        },
        directorBreakdown: dirStats,
        staffBreakdown: staffStats,
        missions: {
          total: totalMissions ? totalMissions.count : 0,
          completed: completedMissions ? completedMissions.count : 0,
          scheduled: scheduledMissions ? scheduledMissions.count : 0
        },
        holdsCount: totalHolds ? totalHolds.count : 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 2. DUAL ROTATION QUEUE LIST
// -------------------------------------------------------------
router.get('/queue/:roleType', async (req, res) => {
  try {
    const roleType = req.params.roleType.toUpperCase();
    if (!['DIRECTOR', 'STAFF'].includes(roleType)) {
      return res.status(400).json({ success: false, error: 'Invalid role_type' });
    }

    const state = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = ?;`, [roleType]);
    const currentRound = state ? state.current_round : 1;

    let members = [];

    if (roleType === 'DIRECTOR') {
      const execs = await dbAll(`
        SELECT 
          0 as queue_id,
          p.id as personnel_id,
          'DIRECTOR' as role_type,
          1 as current_round,
          0 as queue_order,
          'RESERVE_EXEC' as status,
          NULL as hold_reason,
          NULL as hold_timestamp,
          NULL as last_assigned_at,
          p.emp_code,
          p.name,
          p.department,
          p.position,
          p.phone,
          p.email,
          (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status = 'JOINED') as total_missions_joined
        FROM personnel p
        WHERE UPPER(TRIM(p.emp_code)) IN ('DIR-10', 'DIR-09')
        ORDER BY CASE WHEN UPPER(TRIM(p.emp_code)) = 'DIR-10' THEN 1 ELSE 2 END;
      `);

      const regularDirs = await dbAll(`
        SELECT 
          qm.id as queue_id,
          qm.personnel_id,
          qm.role_type,
          qm.current_round,
          qm.queue_order,
          qm.status,
          qm.hold_reason,
          qm.hold_timestamp,
          qm.last_assigned_at,
          p.emp_code,
          p.name,
          p.department,
          p.position,
          p.phone,
          p.email,
          (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status = 'JOINED') as total_missions_joined
        FROM queue_members qm
        JOIN personnel p ON qm.personnel_id = p.id
        WHERE qm.role_type = 'DIRECTOR'
          AND UPPER(TRIM(p.emp_code)) NOT IN ('DIR-10', 'DIR-09')
        ORDER BY qm.queue_order ASC;

      `);

      members = [...execs, ...regularDirs];
    } else {
      members = await dbAll(
        `SELECT 
          qm.id as queue_id,
          qm.personnel_id,
          qm.role_type,
          qm.current_round,
          qm.queue_order,
          qm.status,
          qm.hold_reason,
          qm.hold_timestamp,
          qm.last_assigned_at,
          p.emp_code,
          p.name,
          p.department,
          p.position,
          p.phone,
          p.email,
          (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status = 'JOINED') as total_missions_joined
         FROM queue_members qm
         JOIN personnel p ON qm.personnel_id = p.id
         WHERE qm.role_type = 'STAFF'
         ORDER BY qm.queue_order ASC;`
      );
    }


    res.json({
      success: true,
      roleType,
      currentRound,
      totalCount: members.length,
      members
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 3. CANDIDATE PREVIEW FOR NEW MISSION
// -------------------------------------------------------------

// LINE Webhook Endpoint
router.post('/line-webhook', async (req, res) => {
  // ตอบ LINE ทันที ป้องกัน webhook timeout
  res.status(200).send('OK');

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  async function replyLine(replyToken, messages) {
    if (!replyToken || !Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    if (!lineToken) {
      console.error('❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN');
      return false;
    }

    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/reply',
        {
          replyToken,
          messages
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${lineToken}`
          }
        }
      );

      console.log('✅ ส่งข้อความตอบกลับ LINE สำเร็จ');
      return true;
    } catch (error) {
      console.error(
        '❌ LINE Reply API Error:',
        error.response?.data || error.message
      );
      return false;
    }
  }

  function createPdpaCard(person, empCode) {
    return {
      type: 'flex',
      altText: 'ขอความยินยอมการใช้ข้อมูลส่วนบุคคล (PDPA)',
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#0056A0',
          paddingAll: '18px',
          contents: [
            {
              type: 'text',
              text: 'นโยบายความเป็นส่วนตัว (PDPA)',
              weight: 'bold',
              color: '#FFFFFF',
              size: 'sm'
            },
            {
              type: 'text',
              text: 'FMO Smart Queue',
              weight: 'bold',
              size: 'xl',
              color: '#FFFFFF',
              margin: 'sm'
            }
          ]
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `สวัสดี   ${person.name || '-'}`,
              weight: 'bold',
              size: 'md',
              color: '#111111',
              wrap: true
            },
            {
              type: 'text',
              text:
                'เพื่อรับการแจ้งเตือนคิวและภารกิจ องค์การสะพานปลา (อสป.) ' +
                'มีความจำเป็นต้องจัดเก็บ LINE User ID ของท่าน',
              wrap: true,
              size: 'sm',
              color: '#666666',
              margin: 'md'
            },
            {
              type: 'text',
              text:
                'ข้อมูลนี้ใช้เฉพาะภายในระบบ FMO Smart Queue ' +
                'และจัดเก็บตามมาตรฐานความปลอดภัย',
              wrap: true,
              size: 'sm',
              color: '#666666',
              margin: 'md'
            },
            {
              type: 'text',
              text: 'ท่านยินยอมให้ระบบจัดเก็บข้อมูลหรือไม่?',
              wrap: true,
              weight: 'bold',
              size: 'sm',
              color: '#0056A0',
              margin: 'lg'
            }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#0056A0',
              action: {
                type: 'message',
                label: '✅ ยินยอม (ผูกบัญชี)',
                text: `CONFIRM-${empCode}`
              }
            },
            {
              type: 'button',
              style: 'secondary',
              action: {
                type: 'message',
                label: '❌ ไม่ยินยอม (ส่งเมลแทน)',
                text: `CANCEL-${empCode}`
              }
            }
          ]
        }
      }
    };
  }

  try {
    const events = Array.isArray(req.body?.events)
      ? req.body.events
      : [];

    for (const event of events) {
      try {
        const lineUserId = event.source?.userId || '';
        const replyToken = event.replyToken;

        // =============================================================
        // A. POSTBACK: ACK / BUSY
        // =============================================================
        if (event.type === 'postback') {
          const postbackData = String(event.postback?.data || '');
          let replyMessages = [];

          console.log('[DEBUG] 📩 LINE Postback:', postbackData);

          if (postbackData.startsWith('ACK|')) {
            const [, missionIdRaw, personnelIdRaw] =
              postbackData.split('|');

            const missionId =
              Number.parseInt(missionIdRaw, 10);

            const personnelId =
              Number.parseInt(personnelIdRaw, 10);

            if (
              !Number.isInteger(missionId) ||
              !Number.isInteger(personnelId)
            ) {
              replyMessages = [{
                type: 'text',
                text:
                  '❌ ข้อมูลการตอบรับไม่ถูกต้อง ' +
                  'กรุณาติดต่อเจ้าหน้าที่ค่ะ'
              }];
            } else {
              // ค้นหาด้วย missionId + personnelId จาก postback data ก่อน (แม่นยำที่สุด)
              let assignment = await dbGet(
                `
                SELECT
                  ma.*,
                  p.name AS person_name,
                  p.name,
                  m.mission_title,
                  m.description,
                  m.location,
                  m.start_date,
                  m.end_date,
                  m.dress_code,
                  m.attachment_file,
                  m.attachment_name
                FROM mission_assignments ma
                JOIN personnel p
                  ON p.id = ma.personnel_id
                JOIN missions m
                  ON m.id = ma.mission_id
                WHERE ma.mission_id = ?
                  AND ma.personnel_id = ?
                ORDER BY ma.id DESC
                LIMIT 1;
                `,
                [missionId, personnelId]
              );

              // fallback: ค้นหาด้วย missionId + line_user_id (กรณี personnelId ใน card ไม่ตรง)
              if (!assignment) {
                assignment = await dbGet(
                  `
                  SELECT
                    ma.*,
                    p.name AS person_name,
                    p.name,
                    m.mission_title,
                    m.description,
                    m.location,
                    m.start_date,
                    m.end_date,
                    m.dress_code,
                    m.attachment_file,
                    m.attachment_name
                  FROM mission_assignments ma
                  JOIN personnel p ON p.id = ma.personnel_id
                  JOIN missions m ON m.id = ma.mission_id
                  WHERE ma.mission_id = ?
                    AND p.line_user_id = ?
                    AND ma.ack_status = 'PENDING_ACK'
                    AND ma.assignment_status = 'JOINED'
                  ORDER BY ma.id ASC
                  LIMIT 1;
                  `,
                  [missionId, lineUserId]
                );
              }

              if (!assignment) {
                replyMessages = [{
                  type: 'text',
                  text:
                    '❌ ไม่พบข้อมูลการจัดสรรในระบบ ' +
                    'กรุณาติดต่อเจ้าหน้าที่ค่ะ'
                }];
              }
              else {
                const isAlreadyAck = (assignment.ack_status === 'ACKNOWLEDGED');

                if (!isAlreadyAck) {
                  await dbRun(
                    `
                    UPDATE mission_assignments
                    SET
                      ack_status = 'ACKNOWLEDGED',
                      ack_at = CURRENT_TIMESTAMP
                    WHERE id = ?;
                    `,
                    [assignment.id]
                  );

                  await checkAndUpdateMissionStatus(assignment.mission_id);
                }

                if (isAlreadyAck) {
                  replyMessages = [{
                    type: 'text',
                    text: `ℹ️ ท่านได้กดรับทราบกิจกรรมนี้แล้วค่ะ ขอบคุณค่ะ 🙏`
                  }];
                } else {
                  const missionDescription = String(
                    assignment.description || ''
                  ).trim();

                  const timeStr = (assignment.start_date && assignment.end_date)
                    ? `${formatDate24h(assignment.start_date)} - ${formatDate24h(assignment.end_date)}`
                    : '-';

                  const cleanName = String(assignment.person_name || assignment.name || '-').replace(/^คุณ\s+/i, '');
                  let fileUrl = null;
                  if (assignment.attachment_file && !assignment.attachment_file.includes('fmothai-my.sharepoint.com') && !assignment.attachment_file.includes('sharepoint.com/:b:/g/')) {
                    const rawBaseUrl = process.env.APP_BASE_URL || 'https://smart-queue.fishmarket.co.th/app';
                    const baseUrl = rawBaseUrl.replace(/\/app$/, '');
                    fileUrl = assignment.attachment_file.startsWith('http')
                      ? assignment.attachment_file
                      : `${baseUrl}${assignment.attachment_file}`;
                  } else {
                    const textSearch = `${assignment.schedule_details || ''} ${assignment.description || ''}`;
                    const match = textSearch.match(/(https?:\/\/[^\s]+)/i);
                    if (match && !match[0].includes('fmothai-my.sharepoint.com')) {
                      fileUrl = match[0];
                    }
                  }

                  if (fileUrl) {
                    replyMessages = [
                      {
                        type: 'text',
                        text:
                          `✅ รับทราบแล้วค่ะ ${cleanName}\n\n` +
                          `📋 กิจกรรม:\n${assignment.mission_title || '-'}\n\n` +
                          `📍 สถานที่: ${assignment.location || '-'}\n` +
                          `⏰ เวลา (24 ชม.): ${timeStr}\n` +
                          `👔 การแต่งกาย: ${assignment.dress_code || 'ชุดปฏิบัติงาน อสป.'}\n\n` +
                          `📝 รายละเอียด/กำหนดการ:\n${missionDescription || 'ไม่มีรายละเอียดเพิ่มเติม'}\n\n` +
                          `📎 ลิงก์ดาวน์โหลดเอกสารกำหนดการ:\n${fileUrl}\n\n` +
                          `ระบบได้บันทึกการตอบรับเรียบร้อยแล้ว ขอบคุณค่ะ 🙏`
                      }
                    ];
                  } else {
                    replyMessages = [{
                      type: 'text',
                      text:
                        `✅ รับทราบแล้วค่ะ ${cleanName}\n\n` +
                        `📋 กิจกรรม:\n${assignment.mission_title || '-'}\n\n` +
                        `📍 สถานที่: ${assignment.location || '-'}\n` +
                        `⏰ เวลา (24 ชม.): ${timeStr}\n` +
                        `👔 การแต่งกาย: ${assignment.dress_code || 'ชุดปฏิบัติงาน อสป.'}\n\n` +
                        `📝 รายละเอียด/กำหนดการ:\n${missionDescription || 'ไม่มีรายละเอียดเพิ่มเติม'}\n\n` +
                        `ระบบได้บันทึกการตอบรับเข้าร่วมกิจกรรมเรียบร้อยแล้ว ขอบคุณค่ะ 🙏`
                    }];
                  }
                }
              }
            }
          } else if (postbackData.startsWith('BUSY|')) {
            const [, missionIdRaw, personnelIdRaw] = postbackData.split('|');
            const missionId = Number.parseInt(missionIdRaw, 10);
            const personnelId = Number.parseInt(personnelIdRaw, 10);

            let assignment = await dbGet(
              `
              SELECT ma.*, p.name, m.mission_title
              FROM mission_assignments ma
              JOIN personnel p ON p.id = ma.personnel_id
              JOIN missions m ON m.id = ma.mission_id
              WHERE ma.mission_id = ?
                AND ma.personnel_id = ?
              ORDER BY ma.id DESC
              LIMIT 1;
              `,
              [missionId, personnelId]
            );

            // fallback: หาด้วย missionId + line_user_id (กรณี personnelId ไม่ตรง)
            if (!assignment) {
              assignment = await dbGet(
                `
                SELECT ma.*, p.name, m.mission_title
                FROM mission_assignments ma
                JOIN personnel p ON p.id = ma.personnel_id
                JOIN missions m ON m.id = ma.mission_id
                WHERE ma.mission_id = ?
                  AND p.line_user_id = ?
                  AND ma.assignment_status = 'JOINED'
                ORDER BY ma.id ASC
                LIMIT 1;
                `,
                [missionId, lineUserId]
              );
            }

            if (!assignment) {
              replyMessages = [{
                type: 'text',
                text: '❌ ไม่พบข้อมูลการจัดสรรในระบบ กรุณาติดต่อเจ้าหน้าที่ค่ะ'
              }];
            } else if (assignment.assignment_status === 'BUSY_PENDING') {
              // กดซ้ำขณะรอระบุผู้แทน
              replyMessages = [{
                type: 'flex',
                altText: '🔴 แจ้งติดภารกิจ / ระบุผู้แทน',
                contents: {
                  type: 'bubble',
                  header: {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#dc2626',
                    paddingAll: '14px',
                    contents: [
                      { type: 'text', text: 'FMO SMART QUEUE SYSTEM (Auto Reply)', color: '#fee2e2', size: 'xxs', weight: 'bold' },
                      { type: 'text', text: '🔴 แจ้งติดภารกิจ / ระบุผู้แทน', color: '#ffffff', weight: 'bold', size: 'md', margin: 'xs' }
                    ]
                  },
                  body: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '16px',
                    spacing: 'md',
                    contents: [
                      { type: 'text', text: `กิจกรรม: ${assignment.mission_title || '-'}`, weight: 'bold', size: 'sm', wrap: true },
                      { type: 'text', text: `เรียน ${String(assignment.name || '').replace(/^คุณ\s+/i, '')}`, size: 'xs', color: '#64748b' },
                      
                      // 💡 แถบสีส้มสำหรับกรณีมีผู้ปฏิบัติงานแทน
                      {
                        type: 'box',
                        layout: 'vertical',
                        backgroundColor: '#fff7ed',
                        borderColor: '#fed7aa',
                        borderWidth: '1px',
                        cornerRadius: '8px',
                        paddingAll: '10px',
                        contents: [
                          {
                            type: 'text',
                            text: 'กรณีมีผู้ปฏิบัติงานแทน :',
                            weight: 'bold',
                            size: 'xs',
                            color: '#c2410c'
                          },
                          {
                            type: 'text',
                            text: 'กรุณาพิมพ์รหัสพนักงาน (เช่น EMP-025)',
                            size: 'xs',
                            color: '#431407',
                            wrap: true,
                            margin: 'xs'
                          }
                        ]
                      },

                      // 💡 แถบสีฟ้าอ่อนสำหรับข้อความติดภารกิจ อสป.
                      {
                        type: 'box',
                        layout: 'vertical',
                        backgroundColor: '#f0f9ff',
                        borderColor: '#bae6fd',
                        borderWidth: '1px',
                        cornerRadius: '8px',
                        paddingAll: '10px',
                        contents: [
                          {
                            type: 'text',
                            text: 'หากติดภารกิจอื่น ๆ ที่เกี่ยวข้องกับงาน อสป. กรุณาติดต่อเจ้าหน้าที่ ผปส. เพื่อจัดสรรคิวแทนและบันทึกเหตุผลลงระบบ ก่อนกิจกรรมเริ่มอย่างน้อย 2 วัน',
                            size: 'xs',
                            color: '#0369a1',
                            wrap: true
                          }
                        ]
                      }
                    ]
                  },
                  footer: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '10px',
                    contents: [
                      {
                        type: 'text',
                        text: 'ระบบตอบกลับข้อความอัตโนมัติ',
                        size: 'xxs',
                        color: '#94a3b8',
                        align: 'end'
                      }
                    ]
                  }
                }
              }];
            } else if (['SUBSTITUTED', 'DECLINED_NO_SUBSTITUTE'].includes(assignment.assignment_status)) {
              // 🚀 หากกดปุ่มติดภารกิจซ้ำในภารกิจที่ดำเนินการแล้ว ➔ แสดงข้อความการตอบกลับเดิมซ้ำ 100%
              const replacementAssignment = await dbGet(
                `
                SELECT ma.*, p.name AS replacement_name, p.emp_code AS replacement_emp_code
                FROM mission_assignments ma
                JOIN personnel p ON p.id = ma.personnel_id
                WHERE ma.mission_id = ?
                  AND ma.substituted_for_personnel_id = ?
                ORDER BY ma.id DESC
                LIMIT 1;
                `,
                [assignment.mission_id, assignment.personnel_id]
              );

              if (replacementAssignment) {
                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `👤\nระบบได้จัดสรรพนักงานลำดับถัดไปคือ    ${replacementAssignment.replacement_name} (${replacementAssignment.replacement_emp_code}) ปฏิบัติงานแทนให้อัตโนมัติเรียบร้อยแล้วค่ะ\n\n` +
                    `📩 แจ้งเตือนผู้ปฏิบัติงานคนใหม่เรียบร้อยแล้ว ทางไลน์`
                }];
              } else {
                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `⚠️ ขณะนี้ไม่มีพนักงานคงเหลือในคิวเพื่อปฏิบัติงานแทน ระบบจึงลงประวัติขอลาไว้ให้เรียบร้อยค่ะ`
                }];
              }
            } else {

              await dbRun(
                `
                UPDATE mission_assignments
                SET assignment_status = 'BUSY_PENDING'
                WHERE id = ?;
                `,
                [assignment.id]
              );

              replyMessages = [{
                type: 'flex',
                altText: '🔴 แจ้งติดภารกิจ / ระบุผู้แทน',
                contents: {
                  type: 'bubble',
                  header: {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#dc2626',
                    paddingAll: '14px',
                    contents: [
                      { type: 'text', text: 'FMO SMART QUEUE SYSTEM (Auto Reply)', color: '#fee2e2', size: 'xxs', weight: 'bold' },
                      { type: 'text', text: '🔴 แจ้งติดภารกิจ / ระบุผู้แทน', color: '#ffffff', weight: 'bold', size: 'md', margin: 'xs' }
                    ]
                  },
                  body: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '16px',
                    spacing: 'md',
                    contents: [
                      { type: 'text', text: `กิจกรรม: ${assignment.mission_title || '-'}`, weight: 'bold', size: 'sm', wrap: true },
                      { type: 'text', text: `เรียน ${String(assignment.name || '').replace(/^คุณ\s+/i, '')}`, size: 'xs', color: '#64748b' },
                      
                      // 💡 แถบสีส้มสำหรับกรณีมีผู้ปฏิบัติงานแทน
                      {
                        type: 'box',
                        layout: 'vertical',
                        backgroundColor: '#fff7ed',
                        borderColor: '#fed7aa',
                        borderWidth: '1px',
                        cornerRadius: '8px',
                        paddingAll: '10px',
                        contents: [
                          {
                            type: 'text',
                            text: 'กรณีมีผู้ปฏิบัติงานแทน :',
                            weight: 'bold',
                            size: 'xs',
                            color: '#c2410c'
                          },
                          {
                            type: 'text',
                            text: 'กรุณาพิมพ์รหัสพนักงาน (เช่น EMP-025)',
                            size: 'xs',
                            color: '#431407',
                            wrap: true,
                            margin: 'xs'
                          }
                        ]
                      },

                      // 💡 แถบสีฟ้าอ่อนสำหรับข้อความติดภารกิจ อสป.
                      {
                        type: 'box',
                        layout: 'vertical',
                        backgroundColor: '#f0f9ff',
                        borderColor: '#bae6fd',
                        borderWidth: '1px',
                        cornerRadius: '8px',
                        paddingAll: '10px',
                        contents: [
                          {
                            type: 'text',
                            text: 'หากติดภารกิจอื่น ๆ ที่เกี่ยวข้องกับงาน อสป. กรุณาติดต่อเจ้าหน้าที่ ผปส. เพื่อจัดสรรคิวแทนและบันทึกเหตุผลลงระบบ ก่อนกิจกรรมเริ่มอย่างน้อย 2 วัน',
                            size: 'xs',
                            color: '#0369a1',
                            wrap: true
                          }
                        ]
                      }
                    ]
                  },
                  footer: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '10px',
                    contents: [
                      {
                        type: 'text',
                        text: 'ระบบตอบกลับข้อความอัตโนมัติ',
                        size: 'xxs',
                        color: '#94a3b8',
                        align: 'end'
                      }
                    ]
                  }
                }
              }];
            }
          } else if (postbackData.startsWith('NO_SUB|')) {
            const [, missionIdRaw, personnelIdRaw] = postbackData.split('|');
            const missionId = Number.parseInt(missionIdRaw, 10);
            const personnelId = Number.parseInt(personnelIdRaw, 10);

            let assignment = await dbGet(
              `
              SELECT ma.*, p.name, p.role_type, m.mission_title
              FROM mission_assignments ma
              JOIN personnel p ON p.id = ma.personnel_id
              JOIN missions m ON m.id = ma.mission_id
              WHERE ma.mission_id = ?
                AND ma.personnel_id = ?
              ORDER BY ma.id DESC
              LIMIT 1;
              `,
              [missionId, personnelId]
            );

            // fallback: หาด้วย missionId + line_user_id (กรณี personnelId ไม่ตรง)
            if (!assignment) {
              assignment = await dbGet(
                `
                SELECT ma.*, p.name, p.role_type, m.mission_title
                FROM mission_assignments ma
                JOIN personnel p ON p.id = ma.personnel_id
                JOIN missions m ON m.id = ma.mission_id
                WHERE ma.mission_id = ?
                  AND p.line_user_id = ?
                ORDER BY ma.id ASC
                LIMIT 1;
                `,
                [missionId, lineUserId]
              );
            }

            if (!assignment) {
              replyMessages = [{
                type: 'text',
                text: '❌ ไม่พบข้อมูลการจัดสรรในระบบ กรุณาติดต่อเจ้าหน้าที่ค่ะ'
              }];
            } else if (['DECLINED_NO_SUBSTITUTE', 'SUBSTITUTED'].includes(assignment.assignment_status)) {
              // 🚀 หากกดปุ่มไม่มีคนแทนซ้ำ ➔ แสดงข้อความเดิมซ้ำ 100%
              const replacementAssignment = await dbGet(
                `
                SELECT ma.*, p.name AS replacement_name, p.emp_code AS replacement_emp_code
                FROM mission_assignments ma
                JOIN personnel p ON p.id = ma.personnel_id
                WHERE ma.mission_id = ?
                  AND ma.substituted_for_personnel_id = ?
                ORDER BY ma.id DESC
                LIMIT 1;
                `,
                [assignment.mission_id, assignment.personnel_id]
              );

              if (replacementAssignment) {
                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `👤\nระบบได้จัดสรรพนักงานลำดับถัดไปคือ    ${replacementAssignment.replacement_name} (${replacementAssignment.replacement_emp_code}) ปฏิบัติงานแทนให้อัตโนมัติเรียบร้อยแล้วค่ะ\n\n` +
                    `📩 แจ้งเตือนผู้ปฏิบัติงานคนใหม่เรียบร้อยแล้ว ทางไลน์`
                }];
              } else {
                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `⚠️ ขณะนี้ไม่มีพนักงานคงเหลือในคิวเพื่อปฏิบัติงานแทน ระบบจึงลงประวัติขอลาไว้ให้เรียบร้อยค่ะ`
                }];
              }
            } else {
              await dbRun(
                `UPDATE mission_assignments 
                 SET assignment_status = 'DECLINED_NO_SUBSTITUTE', 
                     ack_status = 'DECLINED_BUSY', 
                     decline_reason = 'ติดภารกิจ/ขอลา (ไม่มีคนแทน)', 
                     ack_at = CURRENT_TIMESTAMP 
                 WHERE id = ?;`,
                [assignment.id]
              );

              await dbRun(
                `UPDATE queue_members 
                 SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
                 WHERE personnel_id = ?;`,
                [personnelId]
              );

              const nextCandidate = await dbGet(
                `SELECT qm.personnel_id, p.id, p.emp_code, p.name, p.role_type, p.department, p.position, p.email, p.phone, p.line_user_id
                 FROM queue_members qm
                 JOIN personnel p ON p.id = qm.personnel_id
                 WHERE UPPER(qm.role_type) = UPPER(?)
                   AND qm.status IN ('WAITING', 'HOLD')
                   AND qm.personnel_id != ?
                 ORDER BY qm.current_round ASC, qm.queue_order ASC
                 LIMIT 1;`,
                [assignment.role_type, personnelId]
              );

              if (nextCandidate) {
                await dbRun(
                  `INSERT INTO mission_assignments 
                   (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, substituted_for_personnel_id, notes, ack_status)
                   VALUES (?, ?, ?, ?, ?, 'JOINED', ?, ?, 'PENDING_ACK');`,
                  [
                    missionId,
                    nextCandidate.id,
                    assignment.role_type,
                    assignment.assigned_round,
                    assignment.is_leader,
                    personnelId,
                    `จัดสรรแทน [${assignment.name} ที่ขอลา (ไม่มีคนแทน)]`
                  ]
                );

                await dbRun(
                  `UPDATE queue_members 
                   SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
                   WHERE personnel_id = ?;`,
                  [nextCandidate.id]
                );

                await checkAndAdvanceRound(assignment.role_type);

                const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [missionId]);
                if (mission) {
                  sendMissionNotification(
                    mission,
                    [{ ...nextCandidate, personnel_id: nextCandidate.id }],
                    true
                  ).catch(e => console.error('Notification dispatch error:', e));
                }

                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `👤\nระบบได้จัดสรรพนักงานลำดับถัดไปคือ    ${nextCandidate.name} (${nextCandidate.emp_code}) ปฏิบัติงานแทนให้อัตโนมัติเรียบร้อยแล้วค่ะ\n\n` +
                    `📩 แจ้งเตือนผู้ปฏิบัติงานคนใหม่เรียบร้อยแล้ว ทางไลน์`
                }];
              } else {
                await checkAndAdvanceRound(assignment.role_type);
                replyMessages = [{
                  type: 'text',
                  text:
                    `🔴 บันทึกการติดภารกิจของ   ${assignment.name} เรียบร้อยแล้วค่ะ\n(ถือว่าใช้สิทธิ์ในรอบนี้แล้ว)\n\n` +
                    `⚠️ ขณะนี้ไม่มีพนักงานคงเหลือในคิวเพื่อปฏิบัติงานแทน ระบบจึงลงประวัติขอลาไว้ให้เรียบร้อยค่ะ`
                }];
              }
            }
          } else if (postbackData.startsWith('SCHED_DETAIL|')) {
            const [, missionIdRaw] = postbackData.split('|');
            const missionId = parseInt(missionIdRaw, 10);

            const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [missionId]);
            if (!mission) {
              replyMessages = [{
                type: 'text',
                text: '❌ ไม่พบข้อมูลกิจกรรมในระบบ กรุณาติดต่อเจ้าหน้าที่ค่ะ'
              }];
            } else {
              const timeStr = (mission.start_date && mission.end_date)
                ? `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`
                : '-';

              let cleanName = null;
              if (lineUserId) {
                const p = await dbGet(`SELECT name FROM personnel WHERE line_user_id = ?;`, [lineUserId]);
                if (p && p.name) {
                  cleanName = String(p.name).replace(/^คุณ\s+/i, '');
                }
              }

              const rawBaseUrl = process.env.APP_BASE_URL || 'https://smart-queue.fishmarket.co.th/app';
              const baseUrl = rawBaseUrl.replace(/\/app$/, '');
              let fileUrl = mission.attachment_file
                ? (mission.attachment_file.startsWith('http') ? mission.attachment_file : `${baseUrl}${mission.attachment_file}`)
                : null;

              if (!fileUrl) {
                fileUrl = extractUrl(`${mission.schedule_details || ''} ${mission.description || ''}`);
              }

              let msgText = `📋 รายละเอียดกำหนดการกิจกรรม (อัปเดตใหม่)\n\n`;
              if (cleanName) {
                msgText += `เรียน ${cleanName}\n\n`;
              }
              msgText += `📌 กิจกรรม:\n${mission.mission_title || '-'}\n\n` +
                         `📍 สถานที่: ${mission.location || '-'}\n` +
                         `⏰ เวลา (24 ชม.): ${timeStr}\n` +
                         `👔 การแต่งกาย: ${mission.dress_code || 'ชุดปฏิบัติงาน อสป.'}\n\n`;

              if (mission.schedule_details) {
                msgText += `📝 รายละเอียดการเปลี่ยนแปลงกำหนดการใหม่:\n${mission.schedule_details}\n\n`;
              } else if (mission.description) {
                msgText += `📝 รายละเอียด/กำหนดการ:\n${mission.description}\n\n`;
              }

              if (fileUrl) {
                msgText += `📎 ลิงก์ดาวน์โหลดเอกสารกำหนดการ:\n${fileUrl}\n\n`;
              }

              msgText += `ระบบได้ดึงข้อมูลรายละเอียดกำหนดการล่าสุดให้เรียบร้อยแล้วค่ะ ขอบคุณค่ะ 🙏`;

              replyMessages = [{
                type: 'text',
                text: msgText
              }];
            }
          } else if (postbackData.startsWith('SWAP_ACCEPT|')) {
            const [, swapIdRaw, reqIdRaw, targetIdRaw] = postbackData.split('|');
            const swapId = parseInt(swapIdRaw);
            const reqId = parseInt(reqIdRaw);
            const targetId = parseInt(targetIdRaw);

            const q1 = await dbGet(`SELECT qm.*, p.name, p.emp_code, p.line_user_id FROM queue_members qm JOIN personnel p ON qm.personnel_id = p.id WHERE qm.personnel_id = ?`, [reqId]);
            const q2 = await dbGet(`SELECT qm.*, p.name, p.emp_code, p.line_user_id FROM queue_members qm JOIN personnel p ON qm.personnel_id = p.id WHERE qm.personnel_id = ?`, [targetId]);

            if (!q1 || !q2) {
              replyMessages = [{ type: 'text', text: '❌ ไม่พบข้อมูลการสลับคิวในระบบ กรุณาติดต่อเจ้าหน้าที่ค่ะ' }];
            } else {
              await dbRun('BEGIN TRANSACTION;');
              try {
                await dbRun(`UPDATE queue_members SET queue_order = ?, current_round = ? WHERE personnel_id = ?`, [q2.queue_order, q2.current_round, q1.personnel_id]);
                await dbRun(`UPDATE queue_members SET queue_order = ?, current_round = ? WHERE personnel_id = ?`, [q1.queue_order, q1.current_round, q2.personnel_id]);
                await dbRun(`UPDATE queue_swaps SET status = 'APPROVED' WHERE id = ?`, [swapId]);
                await dbRun('COMMIT;');
              } catch (e) {
                await dbRun('ROLLBACK;');
                throw e;
              }

              if (process.env.LINE_CHANNEL_ACCESS_TOKEN && q1.line_user_id && q1.line_user_id.toLowerCase() !== 'email') {
                try {
                  await axios.post('https://api.line.me/v2/bot/message/push', {
                    to: q1.line_user_id,
                    messages: [{
                      type: 'text',
                      text: `🎉    ${q2.name} ได้กดยินยอมสลับคิวกับ  เรียบร้อยแล้วค่ะ!\n\nลำดับคิวใหม่ของ   ${q1.name}: คิวที่ #${q2.queue_order}\nลำดับคิวใหม่ของ   ${q2.name}: คิวที่ #${q1.queue_order}`
                    }]
                  }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
                } catch (e) { console.error('Error pushing swap notification:', e); }
              }

              replyMessages = [{
                type: 'text',
                text: `✅ อนุมัติสลับลำดับคิวสำเร็จเรียบร้อยแล้วค่ะ!\n\nลำดับคิวใหม่ของ   ${q2.name}: คิวที่ #${q1.queue_order}\nลำดับคิวใหม่ของ   ${q1.name}: คิวที่ #${q2.queue_order}`
              }];
            }
          } else if (postbackData.startsWith('SWAP_REJECT|')) {
            const [, swapIdRaw, reqIdRaw, targetIdRaw] = postbackData.split('|');
            const swapId = parseInt(swapIdRaw);
            const reqId = parseInt(reqIdRaw);

            await dbRun(`UPDATE queue_swaps SET status = 'REJECTED' WHERE id = ?`, [swapId]);

            const q1 = await dbGet(`SELECT p.name, p.line_user_id FROM personnel p WHERE p.id = ?`, [reqId]);
            if (q1 && process.env.LINE_CHANNEL_ACCESS_TOKEN && q1.line_user_id && q1.line_user_id.toLowerCase() !== 'email') {
              try {
                await axios.post('https://api.line.me/v2/bot/message/push', {
                  to: q1.line_user_id,
                  messages: [{
                    type: 'text',
                    text: `⚠️ คำขอสลับคิวของ  ถูกปฏิเสธเนื่องจากอีกฝ่ายไม่สะดวกสลับ ลำดับคิวของ  จึงยังคงเดิมค่ะ`
                  }]
                }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
              } catch (e) { console.error('Error pushing swap reject notification:', e); }
            }

            replyMessages = [{
              type: 'text',
              text: `❌ บันทึกการปฏิเสธคำขอสลับคิวเรียบร้อยแล้วค่ะ ลำดับคิวของทั้งสองฝ่ายยังคงเดิม`
            }];
          }


          await replyLine(replyToken, replyMessages);
          continue;
        }


        // =============================================================
        // B. MESSAGE TEXT
        // =============================================================
        if (event.type === 'message' && event.message?.type === 'text') {
          const rawText = String(event.message.text || '').trim();
          const userMessage = rawText.toUpperCase();
          let messagesPayload = [];

          console.log(`[DEBUG] 💬 ได้รับข้อความจาก LINE: "${rawText}"`);

          // -----------------------------------------------------------
          // B1. CONFIRM ผูกบัญชี
          // -----------------------------------------------------------
          if (userMessage.startsWith('CONFIRM-')) {
            const targetEmpCode = userMessage
              .replace('CONFIRM-', '')
              .trim();

            const person = await dbGet(
              `
              SELECT *
              FROM personnel
              WHERE UPPER(TRIM(emp_code)) = ?;
              `,
              [targetEmpCode]
            );

            if (!person) {
              messagesPayload = [{
                type: 'text',
                text: '❌ ไม่พบข้อมูลรหัสรับคิวค่ะ'
              }];
            } else {
              const savedLineUserId = String(person.line_user_id || '').trim();
              const currentLineUserId = String(lineUserId || '').trim();

              if (savedLineUserId === currentLineUserId && savedLineUserId && savedLineUserId.toLowerCase() !== 'email') {
                messagesPayload = [{
                  type: 'text',
                  text:
                    `✅ บัญชี LINE นี้ผูกกับรหัส ${targetEmpCode} เรียบร้อยแล้วค่ะ\n\n` +
                    `👤 ${person.name}\n\n` +
                    'สามารถใช้งานระบบ FMO Smart Queue ได้ตามปกติค่ะ'
                }];
              } else if (savedLineUserId && savedLineUserId.toLowerCase() !== 'email') {
                messagesPayload = [{
                  type: 'text',
                  text:
                    `⚠️ รหัส ${targetEmpCode} ถูกผูกกับบัญชี LINE อื่นแล้วค่ะ\n\n` +
                    'หากต้องการเปลี่ยนบัญชี กรุณาติดต่อทีม IT'
                }];
              } else {
                const bindResult = await dbRun(
                  `
                  UPDATE personnel
                  SET line_user_id = ?
                  WHERE id = ?
                    AND (line_user_id IS NULL OR line_user_id = '' OR line_user_id = 'email');
                  `,
                  [currentLineUserId, person.id]
                );

                if (bindResult?.changes > 0) {
                  messagesPayload = [{
                    type: 'text',
                    text:
                      `🎉 ยืนยันการผูกบัญชีสำเร็จค่ะ\n\n` +
                      `👤 ${person.name}\n\n` +
                      'พร้อมรับการแจ้งเตือนคิวและภารกิจทาง LINE แล้วค่ะ'
                  }];
                } else {
                  messagesPayload = [{
                    type: 'text',
                    text: '⚠️ ไม่สามารถผูกบัญชีได้ กรุณาลองใหม่อีกครั้งค่ะ'
                  }];
                }
              }
            }
          }

          // -----------------------------------------------------------
          // B2. CANCEL PDPA
          // -----------------------------------------------------------
          else if (userMessage.startsWith('CANCEL-')) {
            const targetEmpCode = userMessage
              .replace('CANCEL-', '')
              .trim();

            const person = await dbGet(
              `
              SELECT *
              FROM personnel
              WHERE UPPER(TRIM(emp_code)) = ?;
              `,
              [targetEmpCode]
            );

            if (person) {
              await dbRun(
                `
                UPDATE personnel
                SET line_user_id = 'email'
                WHERE id = ?;
                `,
                [person.id]
              );

              messagesPayload = [{
                type: 'text',
                text:
                  `❌ ท่านปฏิเสธการผูกบัญชี LINE (PDPA)\n\n` +
                  `📧 ระบบได้บันทึกช่องทางรับการแจ้งเตือนทางอีเมลเรียบร้อยแล้วค่ะ\n\n` +
                  `👤 ${person.name} (${person.emp_code})\n` +
                  `📮 การแจ้งเตือนคิวและภารกิจจะถูกจัดส่งไปยัง:\n` +
                  `👉 ${person.email || 'อีเมลองค์กรของ  '}`
              }];
            } else {
              messagesPayload = [{
                type: 'text',
                text: '❌ ยกเลิกการทำรายการเรียบร้อยแล้วค่ะ'
              }];
            }
          }

          // -----------------------------------------------------------
          // B3. พิมพ์แจ้งติดภารกิจ
          // -----------------------------------------------------------
          else if (rawText.includes('แจ้งติดภารกิจ')) {
            const latestAssignment = await dbGet(
              `
              SELECT ma.*, p.name, m.mission_title
              FROM mission_assignments ma
              JOIN personnel p ON p.id = ma.personnel_id
              JOIN missions m ON m.id = ma.mission_id
              WHERE p.line_user_id = ?
                AND ma.assignment_status NOT IN ('SUBSTITUTED', 'REPLACED')
              ORDER BY ma.id DESC
              LIMIT 1;
              `,
              [lineUserId]
            );

            if (!latestAssignment) {
              messagesPayload = [{
                type: 'text',
                text: '❌ ไม่พบรายการกิจกรรมที่ต้องปฏิบัติในขณะนี้ค่ะ'
              }];
            } else {
              await dbRun(
                `
                UPDATE mission_assignments
                SET assignment_status = 'BUSY_PENDING'
                WHERE id = ?;
                `,
                [latestAssignment.id]
              );

              messagesPayload = [{
                type: 'text',
                text:
                  `🔴 รับทราบการติดภารกิจ (${latestAssignment.mission_title || '-'})\n\n` +
                  `   ${latestAssignment.name} กรุณาพิมพ์รหัสพนักงาน ` +
                  '(เช่น EMP-025) ที่ต้องการให้ปฏิบัติงานแทนค่ะ'
              }];
            }
          }

          // -----------------------------------------------------------
          // B4.5 สลับคิว / SWAP
          // -----------------------------------------------------------
          else if (userMessage.startsWith('สลับ ') || userMessage.startsWith('SWAP ')) {
            const targetQuery = rawText.replace(/^สลับ\s+/i, '').replace(/^SWAP\s+/i, '').trim().toUpperCase();
            const senderPerson = await dbGet(`SELECT p.*, qm.queue_order, qm.role_type FROM personnel p JOIN queue_members qm ON p.id = qm.personnel_id WHERE p.line_user_id = ?`, [lineUserId]);

            if (!senderPerson) {
              messagesPayload = [{ type: 'text', text: '❌ ไม่พบบัญชี LINE ของ  ในระบบ กรุณาพิมพ์รหัสพนักงานเพื่อผูกบัญชีก่อนค่ะ (เช่น DIR-01 หรือ EMP-001)' }];
            } else {
              const targetPerson = await dbGet(`
                SELECT p.*, qm.queue_order, qm.role_type
                FROM personnel p
                JOIN queue_members qm ON p.id = qm.personnel_id
                WHERE (UPPER(TRIM(p.emp_code)) = ? OR p.name LIKE ?)
              `, [targetQuery, `%${targetQuery}%`]);

              if (!targetPerson) {
                messagesPayload = [{ type: 'text', text: `❌ ไม่พบข้อมูลพนักงาน "${targetQuery}" ในระบบค่ะ กรุณาตรวจสอบรหัสพนักงานอีกครั้งค่ะ` }];
              } else if (senderPerson.id === targetPerson.id) {
                messagesPayload = [{ type: 'text', text: '❌ ไม่สามารถยื่นขอสลับคิวกับตนเองได้ค่ะ' }];
              } else if (senderPerson.role_type !== targetPerson.role_type) {
                messagesPayload = [{ type: 'text', text: '❌ การสลับคิวทำได้เฉพาะบุคลากรในกลุ่มประเภทเดียวกันเท่านั้น (ผอ. สลับกับ ผอ. / พนักงาน สลับกับ พนักงาน)' }];
              } else if (['DIR-10', 'DIR-09'].includes(senderPerson.emp_code) || ['DIR-10', 'DIR-09'].includes(targetPerson.emp_code)) {
                messagesPayload = [{ type: 'text', text: '❌ ตำแหน่งผู้บริหารระดับสูง (DIR-10 และ DIR-09) ไม่เข้าคิวสลับถาวรในระบบค่ะ' }];
              } else {
                const swapRes = await dbRun(`
                  INSERT INTO queue_swaps (requester_id, target_id, role_type, reason, status, approved_by)
                  VALUES (?, ?, ?, 'ยื่นขอสลับคิวผ่าน LINE OA', 'PENDING_CONSENT', 'USER')
                `, [senderPerson.id, targetPerson.id, senderPerson.role_type]);

                const swapId = swapRes.lastID;
                const { createPeerSwapConsentFlexCard } = require('../services/notification');

                if (process.env.LINE_CHANNEL_ACCESS_TOKEN && targetPerson.line_user_id && targetPerson.line_user_id.toLowerCase() !== 'email') {
                  try {
                    const consentCard = createPeerSwapConsentFlexCard(swapId, senderPerson, targetPerson, 'ขอสลับคิวตามความสะดวกในการปฏิบัติงาน');
                    await axios.post('https://api.line.me/v2/bot/message/push', {
                      to: targetPerson.line_user_id,
                      messages: [consentCard]
                    }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
                  } catch (e) { console.error('Error pushing swap consent card:', e); }
                }

                messagesPayload = [{
                  type: 'text',
                  text: `📩 ส่งคำขอสลับคิวไปยัง ${targetPerson.name} (${targetPerson.emp_code}) ทาง LINE เรียบร้อยแล้วค่ะ!\n\nเมื่อ ${targetPerson.name} กดยินยอมใน LINE ระบบจะทำการสลับลำดับคิว 2 ทางให้อัตโนมัติทันทีค่ะ`
                }];
              }
            }
          }

          // -----------------------------------------------------------
          // B4. รหัส EMP-/DIR- หรือระบุตัวแทนขณะมี BUSY_PENDING
          // -----------------------------------------------------------
          else if (/^(EMP|DIR)-\d+$/i.test(userMessage) || /^\d{1,4}$/.test(userMessage) || (rawText.length >= 2 && !rawText.includes(' '))) {
            const pendingAssignment = await dbGet(
              `
              SELECT
                ma.*,
                p.name AS original_name,
                p.emp_code AS original_emp_code,
                (
                  SELECT leader.name
                  FROM mission_assignments leader_ma
                  JOIN personnel leader
                    ON leader.id = leader_ma.personnel_id
                  WHERE leader_ma.mission_id = ma.mission_id
                    AND leader_ma.is_leader = 1
                  ORDER BY leader_ma.id ASC
                  LIMIT 1
                ) AS team_leader_name
              FROM mission_assignments ma
              JOIN personnel p ON p.id = ma.personnel_id
              WHERE ma.assignment_status = 'BUSY_PENDING'
                AND p.line_user_id = ?
              ORDER BY ma.id DESC
              LIMIT 1;
              `,
              [lineUserId]
            );

            if (pendingAssignment) {
              let searchEmpCode = userMessage;
              if (/^\d+$/.test(userMessage)) {
                searchEmpCode = `EMP-${userMessage.padStart(3, '0')}`;
              }

              const substituteUser = await dbGet(
                `
                SELECT *
                FROM personnel
                WHERE UPPER(TRIM(emp_code)) = ?
                   OR UPPER(TRIM(emp_code)) = ?
                   OR name LIKE ?;
                `,
                [userMessage, searchEmpCode, `%${rawText}%`]
              );

              if (!substituteUser) {
                messagesPayload = [{
                  type: 'text',
                  text: `❌ ไม่พบข้อมูลพนักงาน "${rawText}" ในระบบค่ะ\n\nกรุณาพิมพ์รหัสพนักงาน (เช่น EMP-025) หรือชื่อพนักงานที่จะปฏิบัติงานแทน\nหรือกดปุ่ม 🟡 ไม่มีคนแทน ในการ์ดสีแดงด้านบนค่ะ`
                }];
              } else if (Number(substituteUser.id) === Number(pendingAssignment.personnel_id)) {
                messagesPayload = [{
                  type: 'text',

                  text: '⚠️ ไม่สามารถเลือกตนเองเป็นผู้ปฏิบัติงานแทนได้ค่ะ'
                }];
              } else {
                await dbRun(
                  `
                  UPDATE mission_assignments
                  SET assignment_status = 'SUBSTITUTED',
                      ack_status = 'DECLINED_BUSY',
                      decline_reason = ?,
                      notes = ?,
                      substituted_for_personnel_id = ?,
                      ack_at = CURRENT_TIMESTAMP
                  WHERE id = ?;
                  `,
                  [
                    `ติดภารกิจ ส่งตัวแทน ${substituteUser.name} (${substituteUser.emp_code})`,
                    `ส่ง ${substituteUser.name} (${substituteUser.emp_code}) ปฏิบัติงานแทน`,
                    substituteUser.id,
                    pendingAssignment.id
                  ]
                );

                const duplicateReplacement = await dbGet(
                  `
                  SELECT id
                  FROM mission_assignments
                  WHERE mission_id = ?
                    AND personnel_id = ?
                    AND assignment_status = 'JOINED'
                  ORDER BY id DESC
                  LIMIT 1;
                  `,
                  [pendingAssignment.mission_id, substituteUser.id]
                );

                if (!duplicateReplacement) {
                  await dbRun(
                    `
                    INSERT INTO mission_assignments
                    (
                      mission_id,
                      personnel_id,
                      role_type,
                      assigned_round,
                      is_leader,
                      assignment_status,
                      substituted_for_personnel_id,
                      ack_status,
                      notes
                    )
                    VALUES (?, ?, ?, ?, ?, 'JOINED', ?, 'PENDING_ACK', ?);
                    `,
                    [
                      pendingAssignment.mission_id,
                      substituteUser.id,
                      pendingAssignment.role_type,
                      pendingAssignment.assigned_round,
                      pendingAssignment.is_leader,
                      pendingAssignment.personnel_id,
                      `ปฏิบัติงานแทน ${pendingAssignment.original_name} (${pendingAssignment.original_emp_code || '-'})`
                    ]
                  );
                }

                const mission = await dbGet(
                  `SELECT * FROM missions WHERE id = ?;`,
                  [pendingAssignment.mission_id]
                );

                let replacementLineSent = false;

                if (mission) {
                  const notificationResult = await sendMissionNotification(
                    mission,
                    [{
                      ...substituteUser,
                      personnel_id: substituteUser.id,
                      role_type: pendingAssignment.role_type,
                      is_leader: pendingAssignment.is_leader,
                      substitute_for_name: pendingAssignment.original_name || '-',
                      team_leader_name: pendingAssignment.team_leader_name || '-'
                    }],
                    true
                  );

                  replacementLineSent = notificationResult === true;
                }

                messagesPayload = [{
                  type: 'text',
                  text:
                    `✅ ระบบได้บันทึกให้\n\n` +
                    `${substituteUser.name}\n` +
                    `(${substituteUser.emp_code})\n\n` +
                    `ปฏิบัติงานแทน: ${pendingAssignment.original_name}\n\n` +
                    `เรียบร้อยแล้วค่ะ\n\n` +
                    (replacementLineSent
                      ? '📩 ส่ง LINE แจ้งเตือนไปยังผู้ปฏิบัติงานแทนแล้วค่ะ'
                      : '⚠️ บันทึกตัวแทนสำเร็จ แต่ส่ง LINE แจ้งเตือนไม่สำเร็จ กรุณาตรวจสอบ Log')
                }];
              }
            } else {

              const person = await dbGet(
                `
                SELECT *
                FROM personnel
                WHERE UPPER(TRIM(emp_code)) = ?;
                `,
                [userMessage]
              );

              if (!person) {
                messagesPayload = [{
                  type: 'text',
                  text: `❌ ไม่พบรหัสรับคิว "${userMessage}" ในระบบค่ะ`
                }];
              } else {
                const savedLineUserId = String(person.line_user_id || '').trim();
                const currentLineUserId = String(lineUserId || '').trim();

                if (savedLineUserId === currentLineUserId && savedLineUserId && savedLineUserId.toLowerCase() !== 'email') {
                  messagesPayload = [{
                    type: 'text',
                    text:
                      `✅ บัญชี LINE นี้ผูกกับรหัส ${userMessage} เรียบร้อยแล้วค่ะ\n\n` +
                      `👤 ${person.name}\n\n` +
                      'สามารถใช้งานระบบและรับการแจ้งเตือนได้ตามปกติค่ะ'
                  }];
                } else if (savedLineUserId && savedLineUserId.toLowerCase() !== 'email') {
                  messagesPayload = [{
                    type: 'text',
                    text:
                      `⚠️ รหัส ${userMessage} ถูกผูกกับบัญชี LINE อื่นแล้วค่ะ\n\n` +
                      'หากต้องการเปลี่ยนบัญชี กรุณาติดต่อทีม IT'
                  }];
                } else {
                  messagesPayload = [createPdpaCard(person, userMessage)];
                }
              }
            }
          }

          // -----------------------------------------------------------
          // B5. ข้อความอื่น
          // -----------------------------------------------------------
          else {
            messagesPayload = [{
              type: 'text',
              text:
                'ℹ️ หากต้องการผูกบัญชี LINE กรุณาพิมพ์รหัสพนักงาน ' +
                'เช่น EMP-025 ค่ะ'
            }];
          }

          await replyLine(replyToken, messagesPayload);
        }
      } catch (eventError) {
        console.error(
          '❌ Event processing error:',
          eventError.response?.data || eventError.message || eventError
        );
      }
    }
  } catch (webhookError) {
    console.error(
      '❌ Webhook Error:',
      webhookError.response?.data || webhookError.message || webhookError
    );
  }
});

// -------------------------------------------------------------
// 3. PREVIEW CANDIDATES
// -------------------------------------------------------------
router.post('/missions/preview-candidates', async (req, res) => {
  try {
    const {
      required_directors = 1,
      required_staff = 1
    } = req.body;

    const directorCount = Math.max(
      0,
      Number.parseInt(required_directors, 10) || 0
    );

    const staffCount = Math.max(
      0,
      Number.parseInt(required_staff, 10) || 0
    );

    //----------------------------------------------------------
    // ตรวจว่าคิวเดิมครบรอบหรือยัง
    // ถ้าครบ ระบบจะเริ่มรอบใหม่ก่อนเลือกผู้สมัคร
    //----------------------------------------------------------
    await checkAndAdvanceRound('DIRECTOR');
    await checkAndAdvanceRound('STAFF');

    //----------------------------------------------------------
    // อ่านรอบปัจจุบัน
    //----------------------------------------------------------
    const directorState = await dbGet(`
      SELECT current_round
      FROM queue_state
      WHERE role_type = 'DIRECTOR';
    `);

    const staffState = await dbGet(`
      SELECT current_round
      FROM queue_state
      WHERE role_type = 'STAFF';
    `);

    const currentDirectorRound =
      directorState?.current_round || 1;

    const currentStaffRound =
      staffState?.current_round || 1;

    //----------------------------------------------------------
    // เลือก ผอ.ฝ่าย
    //
    // - เลือกเฉพาะ WAITING
    // - เฉพาะรอบปัจจุบัน
    // - ไม่เลือก DIR-09 และ DIR-10
    // - เรียงตามลำดับ DIR-01 → DIR-08
    //----------------------------------------------------------
    let directors = [];

      if (directorCount > 0) {
        directors = await dbAll(
          `
          SELECT
            qm.personnel_id,
            qm.role_type,
            qm.current_round,
            qm.queue_order,
            qm.status AS queue_status,
            p.emp_code,
            p.name,
            p.department,
            p.position,
            p.email,
            p.phone
          FROM queue_members qm
          JOIN personnel p
            ON p.id = qm.personnel_id
          WHERE UPPER(qm.role_type) = 'DIRECTOR'
            AND qm.current_round = ?
            AND qm.status = 'WAITING'

            -- ระบบอัตโนมัติใช้เฉพาะ DIR-01 ถึง DIR-08
            AND CAST(
              REPLACE(UPPER(TRIM(p.emp_code)), 'DIR-', '')
              AS INTEGER
            ) BETWEEN 1 AND 8

          ORDER BY
            qm.queue_order ASC,
            qm.personnel_id ASC
          LIMIT ?;

          `,
          [
            currentDirectorRound,
            directorCount
          ]
        );
      }

    //----------------------------------------------------------
// เลือกพนักงานแบบผสม
//
// 1. เลือกจากหัวคิวปัจจุบัน 2 คน
// 2. เลือกจากท้ายคิวให้ครบจำนวนที่ระบุ
// 3. ไม่ให้ personnel_id ซ้ำกัน
//----------------------------------------------------------
let staff = [];

if (staffCount > 0) {
  // จำนวนที่เลือกจากหัวคิว
  const frontCount = Math.min(
    2,
    staffCount
  );

  // จำนวนที่ต้องเลือกเพิ่มจากท้ายคิว
  const backCount = Math.max(
    0,
    staffCount - frontCount
  );

  //--------------------------------------------------------
  // 1. ดึงจากหัวคิว 2 คนแรก
  //--------------------------------------------------------
  const frontStaff = await dbAll(
    `
    SELECT
      qm.personnel_id,
      qm.role_type,
      qm.current_round,
      qm.queue_order,
      qm.status AS queue_status,
      p.emp_code,
      p.name,
      p.department,
      p.position,
      p.email,
      p.phone
    FROM queue_members qm
    JOIN personnel p
      ON p.id = qm.personnel_id
    WHERE UPPER(qm.role_type) = 'STAFF'
      AND qm.current_round = ?
      AND qm.status = 'WAITING'
    ORDER BY
      qm.queue_order ASC,
      qm.personnel_id ASC
    LIMIT ?;
    `,
    [
      currentStaffRound,
      frontCount
    ]
  );

  //--------------------------------------------------------
  // 2. ดึงจากท้ายคิว
  //
  // ต้องไม่ซ้ำกับคนที่เลือกจากหัวคิวแล้ว
  //--------------------------------------------------------
  let backStaff = [];

  if (backCount > 0) {
    const frontIds = frontStaff.map(
      person => person.personnel_id
    );

    let excludeSql = '';
    const backParams = [
      currentStaffRound
    ];

    if (frontIds.length > 0) {
      const placeholders = frontIds
        .map(() => '?')
        .join(',');

      excludeSql = `
        AND qm.personnel_id
            NOT IN (${placeholders})
      `;

      backParams.push(...frontIds);
    }

    backParams.push(backCount);

    backStaff = await dbAll(
      `
      SELECT
        qm.personnel_id,
        qm.role_type,
        qm.current_round,
        qm.queue_order,
        qm.status AS queue_status,
        p.emp_code,
        p.name,
        p.department,
        p.position,
        p.email,
        p.phone
      FROM queue_members qm
      JOIN personnel p
        ON p.id = qm.personnel_id
      WHERE UPPER(qm.role_type) = 'STAFF'
        AND qm.current_round = ?
        AND qm.status = 'WAITING'
        ${excludeSql}
      ORDER BY
        qm.queue_order DESC,
        qm.personnel_id DESC
      LIMIT ?;
      `,
      backParams
    );
  }

  //--------------------------------------------------------
  // 3. รวมตามลำดับที่ต้องการ
  //
  // หัวคิวก่อน แล้วตามด้วยท้ายคิว
  //--------------------------------------------------------
  staff = [
    ...frontStaff,
    ...backStaff
  ];

  console.log(
    '👥 STAFF จากหัวคิว:',
    frontStaff.map(person =>
      person.emp_code
    )
  );

  console.log(
    '🔚 STAFF จากท้ายคิว:',
    backStaff.map(person =>
      person.emp_code
    )
  );

  console.log(
    '✅ STAFF ที่จัดสรรทั้งหมด:',
    staff.map(person =>
      person.emp_code
    )
  );
}

   res.json({
  success: true,
  data: {
    directors,
    staff
  }
});

  } catch (err) {
    console.error('Preview Candidates Error:', err);

    res.status(500).json({
      success: false,
      message: 'Internal Server Error',
      error: err.message
    });
  }
});

// -------------------------------------------------------------
// 4. CREATE MISSION & CONFIRM ASSIGNMENTS
// -------------------------------------------------------------
/*router.post('/missions/create', async (req, res) => {
  try {
    const {
      mission_title,
      description,
      location,
      dress_code,
      start_date,
      end_date,
      required_directors,
      required_staff,
      assigned_director_ids = [],
      assigned_staff_ids = [],
      skipped_personnel = []
    } = req.body;

    if (!mission_title || !start_date || !end_date) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อกิจกรรม วันที่เริ่มต้น และวันที่สิ้นสุด' });
    }

    // 1. Process Skipped Personnel (Set status to HOLD / Hold_In_Round)
    for (const skipItem of skipped_personnel) {
      if (skipItem.personnel_id) {
        await dbRun(
          `UPDATE queue_members 
           SET status = 'HOLD', hold_reason = ?, hold_timestamp = CURRENT_TIMESTAMP 
           WHERE personnel_id = ?;`,
          [skipItem.reason || 'ติดกิจกรรมซ้อน (Hold_In_Round)', skipItem.personnel_id]
        );
      }
    }

    // -------------------------------------------------------------
    // สร้างรหัสกิจกรรมอัตโนมัติ (เช่น FMO-AT0769-001)
    // -------------------------------------------------------------
    const newMissionCode = await generateMissionCode();

    // 2. Insert Mission Record (เพิ่ม mission_code เข้าไปในฐานข้อมูล)
    const mRes = await dbRun(
      `INSERT INTO missions (mission_code, mission_title, description, location, dress_code, start_date, end_date, required_directors, required_staff, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED');`,
      [
        newMissionCode,  // <--- แทรกตัวแปรรหัสกิจกรรมตรงนี้
        mission_title,
        description || '',
        location || '',
        dress_code || 'ชุดสุภาพ / ชุดปฏิบัติงาน อสป.',
        start_date,
        end_date,
        required_directors || assigned_director_ids.length,
        required_staff || assigned_staff_ids.length
      ]
    );
    const missionId = mRes.lastID;

    // 3. Assign Directors
    const dirState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'DIRECTOR';`);
    const currentDirRound = dirState ? dirState.current_round : 1;

    for (const pId of assigned_director_ids) {
      await dbRun(
        `INSERT INTO mission_assignments (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, ack_status)
         VALUES (?, ?, 'DIRECTOR', ?, 1, 'JOINED', 'PENDING_ACK');`,
        [missionId, pId, currentDirRound]
      );

      await dbRun(
        `UPDATE queue_members 
         SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ?;`,
        [pId]
      );
    }

    // 4. Assign Staff
    const staffState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'STAFF';`);
    const currentStaffRound = staffState ? staffState.current_round : 1;

    for (const pId of assigned_staff_ids) {
      await dbRun(
        `INSERT INTO mission_assignments (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, ack_status)
         VALUES (?, ?, 'STAFF', ?, 0, 'JOINED', 'PENDING_ACK');`,
        [missionId, pId, currentStaffRound]
      );

      await dbRun(
        `UPDATE queue_members 
         SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ?;`,
        [pId]
      );
    }

    // 5. ส่งแจ้งเตือน LINE & Email ให้คิวที่ถูกจัดสรร
    try {
      const allAssignedIds = [...assigned_director_ids, ...assigned_staff_ids];
      if (allAssignedIds.length > 0) {
        // ดึงข้อมูล personnel ของทุกคนที่ถูกจัดสรร
        const placeholders = allAssignedIds.map(() => '?').join(',');
        const assignedPersonnel = await dbAll(
          `SELECT p.*, qm.status as queue_status
           FROM personnel p
           LEFT JOIN queue_members qm ON p.id = qm.personnel_id
           WHERE p.id IN (${placeholders});`,
          allAssignedIds
        );

        // สร้าง assignedList พร้อม role_type และ is_leader
        const assignedList = assignedPersonnel.map(p => ({
          ...p,
          personnel_id: p.id,
          role_type: assigned_director_ids.includes(p.id) ? 'DIRECTOR' : 'STAFF',
          is_leader: assigned_director_ids.includes(p.id) ? 1 : 0
        }));

        const missionData = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [missionId]);
        if (missionData) {
          sendMissionNotification(missionData, assignedList, false)
            .catch(e => console.error('❌ Notification dispatch error (create mission):', e));
          console.log(`📢 ส่งแจ้งเตือนกิจกรรม "${mission_title}" ให้ ${assignedList.length} คน (LINE + Email)`);
        }
      }
    } catch (notifErr) {
      console.error('❌ เกิดข้อผิดพลาดตอนส่งแจ้งเตือน:', notifErr);
      // ไม่ block response ถ้า notification ล้มเหลว
    }

    res.json({
      success: true,
      message: `สร้างกิจกรรม "${mission_title}" สำเร็จ! ส่งแจ้งเตือน LINE & Email ให้ผู้ที่ถูกจัดสรรแล้ว`,
      mission_id: missionId,
      mission_code: newMissionCode
    });

  } catch (error) {
    console.error('Error creating mission:', error);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการสร้างกิจกรรม' });
  }
});*/
// -------------------------------------------------------------
// 4. CREATE MISSION & CONFIRM ASSIGNMENTS
// -------------------------------------------------------------
router.post('/missions/create', async (req, res) => {
  try {
    const {
      mission_title,
      description,
      location,
      dress_code,
      start_date,
      end_date,
      required_directors,
      required_staff,
      assigned_director_ids = [],
      assigned_staff_ids = [],
      skipped_personnel = [],
      attachment_file,
      attachment_name,
      schedule_details
    } = req.body;

    //----------------------------------------------------------
    // ปรับ ID ให้เป็นตัวเลขทั้งหมด
    //----------------------------------------------------------
    const directorIds = assigned_director_ids
      .map(id => Number(id))
      .filter(Number.isInteger);

    const staffIds = assigned_staff_ids
      .map(id => Number(id))
      .filter(Number.isInteger);

    if (!mission_title || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error:
          'กรุณากรอกชื่อกิจกรรม วันที่เริ่มต้น และวันที่สิ้นสุด'
      });
    }

    //----------------------------------------------------------
    // 1. พักผู้ที่ถูกข้าม
    //
    // HOLD จะไม่ถูกเลือกซ้ำในรอบปัจจุบัน
    // เมื่อระบบขึ้นรอบใหม่ จึงกลับเป็น WAITING
    //----------------------------------------------------------
    for (const skipItem of skipped_personnel) {
      const personnelId = Number(skipItem.personnel_id);

      if (!Number.isInteger(personnelId)) {
        continue;
      }

      await dbRun(
        `
        UPDATE queue_members
        SET
          status = 'HOLD',
          hold_reason = ?,
          hold_timestamp = CURRENT_TIMESTAMP
        WHERE personnel_id = ?;
        `,
        [
          skipItem.reason ||
            'ติดกิจกรรมซ้อน (Hold_In_Round)',
          personnelId
        ]
      );
    }

    //----------------------------------------------------------
    // 2. สร้างรหัสกิจกรรม
    //----------------------------------------------------------
    const newMissionCode = await generateMissionCode();

    //----------------------------------------------------------
    // 3. บันทึกกิจกรรม
    //----------------------------------------------------------
    let finalAttachmentFile = attachment_file || null;
    let finalAttachmentName = attachment_name || null;

    if (!finalAttachmentFile) {
      const extractedUrl = extractUrl(`${schedule_details || ''} ${description || ''}`);
      if (extractedUrl) {
        finalAttachmentFile = extractedUrl;
        finalAttachmentName = 'เอกสารแนบกำหนดการ (ลิงก์แชร์ภายนอก)';
      }
    }

    const missionResult = await dbRun(
      `
      INSERT INTO missions
      (
        mission_code,
        mission_title,
        description,
        location,
        dress_code,
        start_date,
        end_date,
        required_directors,
        required_staff,
        status,
        attachment_file,
        attachment_name,
        schedule_details
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?);
      `,
      [
        newMissionCode,
        mission_title,
        description || schedule_details || '',
        location || '',
        dress_code ||
          'ชุดสุภาพ / ชุดปฏิบัติงาน อสป.',
        start_date,
        end_date,
        Number(required_directors) || directorIds.length,
        Number(required_staff) || staffIds.length,
        finalAttachmentFile,
        finalAttachmentName,
        schedule_details || description || null
      ]
    );

    const missionId = missionResult.lastID;

    //----------------------------------------------------------
    // อ่านรอบปัจจุบัน
    //----------------------------------------------------------
    const directorState = await dbGet(`
      SELECT current_round
      FROM queue_state
      WHERE role_type = 'DIRECTOR';
    `);

    const staffState = await dbGet(`
      SELECT current_round
      FROM queue_state
      WHERE role_type = 'STAFF';
    `);

    const currentDirectorRound =
      directorState?.current_round || 1;

    const currentStaffRound =
      staffState?.current_round || 1;

    //----------------------------------------------------------
    // 4. บันทึก ผอ.ฝ่าย
    //----------------------------------------------------------
    for (const personnelId of directorIds) {
      //--------------------------------------------------------
      // ป้องกัน DIR-09 และ DIR-10 ถูกจัดอัตโนมัติ
      //--------------------------------------------------------
      const director = await dbGet(
        `
        SELECT id, emp_code, name
        FROM personnel
        WHERE id = ?;
        `,
        [personnelId]
      );

      if (!director) {
        console.warn(
          `⚠️ ไม่พบข้อมูล DIRECTOR personnel_id=${personnelId}`
        );
        continue;
      }

      await dbRun(
        `
        INSERT INTO mission_assignments
        (
          mission_id,
          personnel_id,
          role_type,
          assigned_round,
          is_leader,
          assignment_status,
          ack_status
        )
        VALUES
        (
          ?, ?, 'DIRECTOR', ?, 1,
          'JOINED',
          'PENDING_ACK'
        );
        `,
        [
          missionId,
          personnelId,
          currentDirectorRound
        ]
      );

      //--------------------------------------------------------
      // เปลี่ยนเป็น COMPLETED
      // ทำให้ไม่ถูกเลือกซ้ำในรอบเดิม
      //--------------------------------------------------------
      await dbRun(
        `
        UPDATE queue_members
        SET
          status = 'COMPLETED',
          hold_reason = NULL,
          hold_timestamp = NULL,
          last_assigned_at = CURRENT_TIMESTAMP
        WHERE personnel_id = ?
          AND UPPER(role_type) = 'DIRECTOR'
          AND current_round = ?;
        `,
        [
          personnelId,
          currentDirectorRound
        ]
      );
    }

    //----------------------------------------------------------
    // 5. บันทึกพนักงาน
    //----------------------------------------------------------
    for (const personnelId of staffIds) {
      //--------------------------------------------------------
      // ตรวจว่ายังเป็น WAITING จริง
      // ป้องกันการส่ง ID ซ้ำหรือเลือกซ้ำจากหน้าจอเก่า
      //--------------------------------------------------------
      const queueMember = await dbGet(
        `
        SELECT id, status, current_round
        FROM queue_members
        WHERE personnel_id = ?
          AND UPPER(role_type) = 'STAFF'
          AND current_round = ?;
        `,
        [
          personnelId,
          currentStaffRound
        ]
      );

      if (!queueMember) {
        console.warn(
          `⚠️ ไม่พบ STAFF personnel_id=${personnelId} ` +
          `ในรอบ ${currentStaffRound}`
        );
        continue;
      }

      if (queueMember.status !== 'WAITING') {
        console.warn(
          `⏭️ ข้าม STAFF personnel_id=${personnelId} ` +
          `เพราะสถานะเป็น ${queueMember.status}`
        );
        continue;
      }

      await dbRun(
        `
        INSERT INTO mission_assignments
        (
          mission_id,
          personnel_id,
          role_type,
          assigned_round,
          is_leader,
          assignment_status,
          ack_status
        )
        VALUES
        (
          ?, ?, 'STAFF', ?, 0,
          'JOINED',
          'PENDING_ACK'
        );
        `,
        [
          missionId,
          personnelId,
          currentStaffRound
        ]
      );

      //--------------------------------------------------------
      // เปลี่ยนเป็น COMPLETED
      // พนักงานคนนี้จะไม่ถูกสุ่มซ้ำในรอบเดิม
      //--------------------------------------------------------
      await dbRun(
        `
        UPDATE queue_members
        SET
          status = 'COMPLETED',
          hold_reason = NULL,
          hold_timestamp = NULL,
          last_assigned_at = CURRENT_TIMESTAMP
        WHERE id = ?;
        `,
        [queueMember.id]
      );
    }

    //----------------------------------------------------------
    // 6. ตรวจว่าครบรอบหลังบันทึกหรือยัง
    //
    // ถ้าครบ:
    // DIRECTOR → รอบใหม่เริ่ม DIR-01
    // STAFF    → รอบใหม่สุ่ม queue_order ใหม่ทั้งหมด
    //----------------------------------------------------------
    const directorRoundResult =
      await checkAndAdvanceRound('DIRECTOR');

    const staffRoundResult =
      await checkAndAdvanceRound('STAFF');

    if (directorRoundResult.roundAdvanced) {
      console.log(
        `🔁 DIRECTOR ขึ้นรอบใหม่ ` +
        `${directorRoundResult.newRound}`
      );
    }

    if (staffRoundResult.roundAdvanced) {
      console.log(
        `🎲 STAFF ขึ้นรอบใหม่และสุ่มใหม่ รอบ ` +
        `${staffRoundResult.newRound}`
      );
    }

    //----------------------------------------------------------
    // 7. ส่ง LINE และ Email
    //
    // ใช้เฉพาะคนที่บันทึก Assignment สำเร็จจริง
    //----------------------------------------------------------
    try {
      const insertedAssignments = await dbAll(
        `
        SELECT
          ma.personnel_id,
          ma.role_type,
          ma.is_leader
        FROM mission_assignments ma
        WHERE ma.mission_id = ?;
        `,
        [missionId]
      );

      const allAssignedIds = insertedAssignments.map(
        item => item.personnel_id
      );

      if (allAssignedIds.length > 0) {
        const placeholders = allAssignedIds
          .map(() => '?')
          .join(',');

        const assignedPersonnel = await dbAll(
          `
          SELECT p.*
          FROM personnel p
          WHERE p.id IN (${placeholders});
          `,
          allAssignedIds
        );

        const assignmentMap = new Map(
          insertedAssignments.map(item => [
            Number(item.personnel_id),
            item
          ])
        );

        const assignedList = assignedPersonnel.map(person => {
          const assignment =
            assignmentMap.get(Number(person.id));

          return {
            ...person,
            personnel_id: person.id,
            role_type:
              assignment?.role_type || 'STAFF',
            is_leader:
              assignment?.is_leader || 0
          };
        });

        const missionData = await dbGet(
          `
          SELECT *
          FROM missions
          WHERE id = ?;
          `,
          [missionId]
        );

        if (missionData) {
          sendMissionNotification(
            missionData,
            assignedList,
            false
          ).catch(error => {
            console.error(
              '❌ Notification dispatch error:',
              error
            );
          });

          console.log(
            `📢 ส่งแจ้งเตือนกิจกรรม "${mission_title}" ` +
            `ให้ ${assignedList.length} คน`
          );
        }
      }
    } catch (notificationError) {
      console.error(
        '❌ เกิดข้อผิดพลาดตอนส่งแจ้งเตือน:',
        notificationError
      );
    }

    res.json({
      success: true,
      message:
        `สร้างกิจกรรม "${mission_title}" สำเร็จ! ` +
        `ส่งแจ้งเตือนให้ผู้ที่ถูกจัดสรรแล้ว`,
      mission_id: missionId,
      mission_code: newMissionCode,
      round_status: {
        director: directorRoundResult,
        staff: staffRoundResult
      }
    });
  } catch (error) {
    console.error('Error creating mission:', error);

    res.status(500).json({
      success: false,
      error: 'เกิดข้อผิดพลาดในการสร้างกิจกรรม',
      details: error.message
    });
  }
});

// POST /api/missions/:id/update-schedule - อัปเดตเปลี่ยนแปลงกำหนดการและส่ง LINE OA แจ้งเตือนทุกคนในกิจกรรมโดยอัตโนมัติ
router.post('/missions/:id/update-schedule', async (req, res) => {
  try {
    const missionId = req.params.id;
    const {
      mission_title,
      description,
      location,
      dress_code,
      start_date,
      end_date,
      schedule_details,
      attachment_file,
      attachment_name,
      notify_line = true
    } = req.body;

    const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [missionId]);
    if (!mission) {
      return res.status(404).json({ success: false, error: 'ไม่พบกิจกรรมที่ระบุ' });
    }

    let finalAttachmentFile = attachment_file || null;
    let finalAttachmentName = attachment_name || null;

    if (attachment_file) {
      // หากมีการอัปโหลดไฟล์ใหม่ ให้เขียนทับไฟล์เดิมใน DB ทันที
      await dbRun(
        `UPDATE missions SET attachment_file = ?, attachment_name = ? WHERE id = ?;`,
        [attachment_file, attachment_name || 'เอกสารแนบกำหนดการใหม่', missionId]
      );
    } else {
      const extractedUrl = extractUrl(`${schedule_details || ''} ${description || ''}`);
      // ข้ามการดึงลิงก์ SharePoint เก่าที่ติดสิทธิ์ล็อก
      if (extractedUrl && !extractedUrl.includes('fmothai-my.sharepoint.com')) {
        finalAttachmentFile = extractedUrl;
        finalAttachmentName = 'เอกสารแนบกำหนดการ (ลิงก์แชร์ภายนอก)';
      }
    }

    await dbRun(
      `UPDATE missions
       SET mission_title = COALESCE(?, mission_title),
           description = COALESCE(?, description),
           location = COALESCE(?, location),
           dress_code = COALESCE(?, dress_code),
           start_date = COALESCE(?, start_date),
           end_date = COALESCE(?, end_date),
           schedule_details = COALESCE(?, schedule_details),
           attachment_file = CASE WHEN ? IS NOT NULL THEN ? ELSE attachment_file END,
           attachment_name = CASE WHEN ? IS NOT NULL THEN ? ELSE attachment_name END
       WHERE id = ?;`,
      [
        mission_title || null,
        description || null,
        location || null,
        dress_code || null,
        start_date || null,
        end_date || null,
        schedule_details || null,
        finalAttachmentFile,
        finalAttachmentFile,
        finalAttachmentName,
        finalAttachmentName,
        missionId
      ]
    );

    const updatedMission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [missionId]);

    // ดึงผู้เข้าร่วมทุกคนที่มีสถานะเข้าร่วมในกิจกรรมนี้
    const assignedPersonnel = await dbAll(
      `SELECT p.* 
       FROM mission_assignments ma
       JOIN personnel p ON ma.personnel_id = p.id
       WHERE ma.mission_id = ? AND (ma.assignment_status IN ('JOINED', 'SUBSTITUTED') OR ma.assignment_status IS NULL);`,
      [missionId]
    );

    if (notify_line && assignedPersonnel.length > 0) {
      try {
        await sendScheduleChangeNotification(updatedMission, assignedPersonnel);
      } catch (notifErr) {
        console.error('❌ Error sending schedule change notification:', notifErr);
      }
    }

    res.json({
      success: true,
      message: `อัปเดตกำหนดการสำเร็จ${notify_line ? ' และแจ้งเตือนผู้เข้าร่วมทาง LINE เรียบร้อยแล้ว' : ''}`,
      mission: updatedMission,
      notified_count: assignedPersonnel.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// -------------------------------------------------------------
// 5. EMERGENCY SUBSTITUTION (การเปลี่ยนตัวกะทันหัน)
// -------------------------------------------------------------

async function getStaffPositionGroup(missionId, personnelId, roleType) {
  if (roleType === 'DIRECTOR') {
    return {
      label: 'กลุ่มฟิก 2 คนบน (ผู้บริหาร/ผอ.ฝ่าย)',
      sortOrder: 'ASC'
    };
  }

  const staffAssignments = await dbAll(
    `SELECT personnel_id FROM mission_assignments 
     WHERE mission_id = ? AND role_type = 'STAFF' AND assignment_status != 'CANCELLED'
     ORDER BY id ASC;`,
    [missionId]
  );

  const idx = staffAssignments.findIndex(a => Number(a.personnel_id) === Number(personnelId));

  if (idx !== -1 && idx < 2) {
    return {
      label: 'กลุ่ม Staff 2 คนรอบน (ดึงคิวว่างหัวคิว)',
      sortOrder: 'ASC'
    };
  } else {
    return {
      label: 'กลุ่ม Staff ท้ายคิว (ดึงคิวว่างท้ายคิว)',
      sortOrder: 'DESC'
    };
  }
}

// GET /api/missions/substitute-candidates - ดึงข้อมูลพนักงานถัดไปและรายชื่อพนักงานทั้งหมดในกลุ่มเพื่อใช้ใน Modal เปลี่ยนตัว
router.get('/missions/substitute-candidates', async (req, res) => {
  try {
    const { mission_id, original_personnel_id } = req.query;
    if (!mission_id || !original_personnel_id) {
      return res.status(400).json({ success: false, error: 'mission_id and original_personnel_id are required' });
    }

    const origPerson = await dbGet(`SELECT * FROM personnel WHERE id = ?;`, [original_personnel_id]);
    if (!origPerson) return res.status(404).json({ success: false, error: 'ไม่พบบุคลากรเดิม' });

    const roleType = origPerson.role_type;
    const posGroup = await getStaffPositionGroup(mission_id, original_personnel_id, roleType);

    // ดึงรายชื่อ ID ที่ถูกจัดสรรในกิจกรรมนี้อยู่แล้ว (เพื่อไม่ให้เลือกซ้ำ)
    const existingAssigned = await dbAll(
      `SELECT personnel_id FROM mission_assignments WHERE mission_id = ? AND assignment_status IN ('JOINED', 'BUSY_PENDING');`,
      [mission_id]
    );
    const excludeIds = existingAssigned.map(a => a.personnel_id);
    if (!excludeIds.includes(Number(original_personnel_id))) {
      excludeIds.push(Number(original_personnel_id));
    }

    const dirExcludeCondition = roleType === 'DIRECTOR' 
      ? " AND qm.personnel_id NOT IN (SELECT id FROM personnel WHERE UPPER(emp_code) IN ('DIR-09', 'DIR-10'))" 
      : "";

    // 1. ดึงพนักงานคิวถัดไปอัตโนมัติ (Auto) แบ่งตาม 2 คนรอบน (ASC) และ Staff ท้ายคิว (DESC)
    // สำหรับ DIRECTOR จะวนเฉพาะ DIR-01 ถึง DIR-08 เท่านั้น (ยกเว้น DIR-09 และ DIR-10)
    const autoCandidate = await dbGet(
      `SELECT qm.*, p.name, p.emp_code, p.department, p.position 
       FROM queue_members qm
       JOIN personnel p ON qm.personnel_id = p.id
       WHERE qm.role_type = ? AND qm.personnel_id NOT IN (${excludeIds.join(',')})${dirExcludeCondition}
       ORDER BY CASE qm.status WHEN 'WAITING' THEN 1 WHEN 'HOLD' THEN 2 ELSE 3 END, qm.queue_order ${posGroup.sortOrder}
       LIMIT 1;`,
      [roleType]
    );

    // 2. ดึงรายชื่อพนักงานทั้งหมดในกลุ่มเดียวกัน (Manual Selection)
    const availablePersonnel = await dbAll(
      `SELECT p.id, p.name, p.emp_code, p.department, p.position, qm.queue_order, qm.status AS queue_status
       FROM personnel p
       LEFT JOIN queue_members qm ON p.id = qm.personnel_id
       WHERE p.role_type = ? AND p.id NOT IN (${excludeIds.join(',')})
       ORDER BY CASE qm.status WHEN 'WAITING' THEN 1 WHEN 'HOLD' THEN 2 ELSE 3 END, qm.queue_order ${posGroup.sortOrder}, p.name ASC;`,
      [roleType]
    );

    res.json({
      success: true,
      role_type: roleType,
      role_group_label: posGroup.label,
      sort_order: posGroup.sortOrder,
      auto_candidate: autoCandidate ? {
        id: autoCandidate.personnel_id,
        name: autoCandidate.name,
        emp_code: autoCandidate.emp_code,
        queue_order: autoCandidate.queue_order,
        queue_status: autoCandidate.status
      } : null,
      available_candidates: availablePersonnel
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/missions/substitute - ดำเนินการเปลี่ยนตัวพนักงานกะทันหัน
router.post('/missions/substitute', async (req, res) => {
  try {
    const { mission_id, original_personnel_id, mode, substitute_personnel_id, reason } = req.body;

    if (!mission_id || !original_personnel_id) {
      return res.status(400).json({ success: false, error: 'mission_id and original_personnel_id are required' });
    }

    const origPerson = await dbGet(`SELECT * FROM personnel WHERE id = ?;`, [original_personnel_id]);
    if (!origPerson) return res.status(404).json({ success: false, error: 'ไม่พบบุคลากรเดิม' });

    // ตรวจสอบว่ากิจกรรมสิ้นสุดแล้วหรือยัง
    const missionData = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [mission_id]);
    if (missionData && missionData.end_date) {
      const endDate = new Date(String(missionData.end_date).replace(' ', 'T'));
      if (!isNaN(endDate.getTime()) && new Date() > endDate) {
        return res.status(400).json({ success: false, error: 'กิจกรรมนี้สิ้นสุดวันเวลาที่กำหนดแล้ว ไม่สามารถดำเนินการเปลี่ยนตัวได้' });
      }
    }

    const roleType = origPerson.role_type;
    const posGroup = await getStaffPositionGroup(mission_id, original_personnel_id, roleType);
    let targetSubstituteId = substitute_personnel_id;

    if (mode === 'AUTO' || !targetSubstituteId) {
      const existingAssigned = await dbAll(
        `SELECT personnel_id FROM mission_assignments WHERE mission_id = ? AND assignment_status IN ('JOINED', 'BUSY_PENDING');`,
        [mission_id]
      );
      const excludeIds = existingAssigned.map(a => a.personnel_id);
      if (!excludeIds.includes(Number(original_personnel_id))) {
        excludeIds.push(Number(original_personnel_id));
      }

      const dirExcludeCondition = roleType === 'DIRECTOR' 
        ? " AND qm.personnel_id NOT IN (SELECT id FROM personnel WHERE UPPER(emp_code) IN ('DIR-09', 'DIR-10'))" 
        : "";

      const autoCandidate = await dbGet(
        `SELECT qm.personnel_id 
         FROM queue_members qm
         JOIN personnel p ON qm.personnel_id = p.id
         WHERE qm.role_type = ? AND qm.personnel_id NOT IN (${excludeIds.join(',')})${dirExcludeCondition}
         ORDER BY CASE qm.status WHEN 'WAITING' THEN 1 WHEN 'HOLD' THEN 2 ELSE 3 END, qm.queue_order ${posGroup.sortOrder}
         LIMIT 1;`,
        [roleType]
      );

      if (!autoCandidate) {
        return res.status(400).json({ success: false, error: 'ไม่พบบุคลากรสำรองในคิวที่สามารถปฏิบัติงานแทนได้' });
      }
      targetSubstituteId = autoCandidate.personnel_id;
    }

    const substitutePerson = await dbGet(`SELECT * FROM personnel WHERE id = ?;`, [targetSubstituteId]);
    if (!substitutePerson) {
      return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลบุคลากรที่จะปฏิบัติงานแทน' });
    }

    const reasonText = reason || 'เหตุฉุกเฉินกะทันหัน';

    // 1. ปลดพนักงานคนเดิมออกใน mission_assignments
    await dbRun(
      `UPDATE mission_assignments 
       SET assignment_status = 'SUBSTITUTED', 
           ack_status = 'DECLINED_BUSY',
           decline_reason = ?,
           notes = ?,
           ack_at = CURRENT_TIMESTAMP
       WHERE mission_id = ? AND personnel_id = ? AND assignment_status IN ('JOINED', 'BUSY_PENDING');`,
      [`เปลี่ยนตัวกะทันหัน: ${reasonText}`, `เปลี่ยนตัวให้ ${substitutePerson.name} (${substitutePerson.emp_code}) ปฏิบัติงานแทน`, mission_id, original_personnel_id]
    );

    // 2. ปรับสถานะพนักงานเดิมในคิวเป็น HOLD
    await dbRun(
      `UPDATE queue_members 
       SET status = 'HOLD', hold_reason = ?, hold_timestamp = CURRENT_TIMESTAMP 
       WHERE personnel_id = ?;`,
      [`เปลี่ยนตัวกะทันหันในกิจกรรม #${mission_id} (${reasonText})`, original_personnel_id]
    );

    // 3. ดึง round ปัจจุบันและบทบาทหัวหน้า
    const state = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = ?;`, [roleType]);
    const currentRound = state ? state.current_round : 1;

    const origAssignment = await dbGet(
      `SELECT is_leader FROM mission_assignments WHERE mission_id = ? AND personnel_id = ?;`,
      [mission_id, original_personnel_id]
    );
    const isLeader = origAssignment ? origAssignment.is_leader : (roleType === 'DIRECTOR' ? 1 : 0);

    // 4. เพิ่มพนักงานตัวแทนคนใหม่เข้ากิจกรรม
    await dbRun(
      `INSERT INTO mission_assignments (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, substituted_for_personnel_id, ack_status, notes)
       VALUES (?, ?, ?, ?, ?, 'JOINED', ?, 'PENDING_ACK', ?);`,
      [
        mission_id,
        substitutePerson.id,
        roleType,
        currentRound,
        isLeader,
        original_personnel_id,
        `ปฏิบัติงานแทน ${origPerson.name} (${origPerson.emp_code || '-'})`
      ]
    );

    // 5. อัปเดตสถานะคิวของตัวแทนคนใหม่
    // - ถ้าเป็น WAITING ให้ปรับเป็น COMPLETED คิวเลย (ถือว่าใช้สิทธิ์รอบนี้แล้ว)
    // - ถ้าเป็น COMPLETED ให้คงคิวปกติไว้ จนกว่าจะถึงรอบรันใหม่
    const subQueueMember = await dbGet(
      `SELECT status FROM queue_members WHERE personnel_id = ? AND UPPER(role_type) = UPPER(?);`,
      [substitutePerson.id, roleType]
    );

    if (subQueueMember && subQueueMember.status !== 'COMPLETED') {
      await dbRun(
        `UPDATE queue_members 
         SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ? AND UPPER(role_type) = UPPER(?);`,
        [substitutePerson.id, roleType]
      );
      await checkAndAdvanceRound(roleType);
    } else {
      await dbRun(
        `UPDATE queue_members 
         SET last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ? AND UPPER(role_type) = UPPER(?);`,
        [substitutePerson.id, roleType]
      );
    }

    // 6. ส่ง LINE Notification การ์ดด่วน (isReallocation = true) ไปยังพนักงานคนใหม่ทันที
    try {
      const missionData = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [mission_id]);
      if (missionData && substitutePerson) {
        const cleanOrigName = String(origPerson.name || '').replace(/^คุณ\s+/i, '');
        await sendMissionNotification(missionData, [{
          ...substitutePerson,
          personnel_id: substitutePerson.id,
          role_type: roleType,
          is_leader: isLeader,
          substitute_for_name: cleanOrigName
        }], true);
      }
    } catch (notifErr) {
      console.error('Error sending emergency substitution LINE notification:', notifErr.message);
    }

    res.json({
      success: true,
      message: `เปลี่ยนตัวเรียบร้อยแล้ว: ${substitutePerson.name} ได้รับจัดสรรปฏิบัติงานแทน ${origPerson.name}`,
      substitute: {
        id: substitutePerson.id,
        name: substitutePerson.name,
        emp_code: substitutePerson.emp_code
      }
    });
  } catch (err) {
    console.error('Error in /missions/substitute:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 6. SKIP & UNHOLD QUEUE CONTROLS
// -------------------------------------------------------------
router.post('/queue/skip', async (req, res) => {
  try {
    const { personnel_id, reason } = req.body;
    if (!personnel_id) return res.status(400).json({ success: false, error: 'personnel_id is required' });

    await dbRun(
      `UPDATE queue_members 
       SET status = 'HOLD', hold_reason = ?, hold_timestamp = CURRENT_TIMESTAMP 
       WHERE personnel_id = ?;`,
      [reason || 'ติดกิจกรรมซ้อน (Hold_In_Round)', personnel_id]
    );

    res.json({ success: true, message: 'บันทึกสถานะ Hold_In_Round เรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/queue/unhold', async (req, res) => {
  try {
    const { personnel_id, id } = req.body;
    const targetId = Number.parseInt(personnel_id || id, 10);
    if (!targetId) return res.status(400).json({ success: false, error: 'personnel_id is required' });

    // 1. อัปเดตตาราง queue_members ให้สถานะกลับเป็น WAITING และล้าง hold_reason
    await dbRun(
      `UPDATE queue_members 
       SET status = 'WAITING', hold_reason = NULL, hold_timestamp = NULL 
       WHERE personnel_id = ? OR id = ?;`,
      [targetId, targetId]
    );

    // 2. อัปเดตภารกิจคงค้าง BUSY_PENDING ของคนนี้ ให้พ้นจากสถานะรอดำเนินการ
    await dbRun(
      `UPDATE mission_assignments
       SET assignment_status = 'DECLINED_NO_SUBSTITUTE', decline_reason = 'คืนสิทธิ์ปกติโดยผู้ดูแลระบบ', ack_status = 'DECLINED_BUSY'
       WHERE personnel_id = ? AND assignment_status = 'BUSY_PENDING';`,
      [targetId]
    );

    res.json({ success: true, message: 'ยกเลิกสถานะ Hold คืนสิทธิ์เข้าคิวปกติเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/queue/peer-swap - ยื่นคำขอและอนุมัติสลับลำดับคิวระหว่างพนักงาน 2 ท่าน (Peer Swap)
router.post('/queue/peer-swap', async (req, res) => {
  try {
    const { requester_id, target_id, reason } = req.body;
    if (!requester_id || !target_id) {
      return res.status(400).json({ success: false, error: 'กรุณาระบุผู้ขอสลับคิวและผู้รับสลับคิวให้ครบถ้วน' });
    }

    if (parseInt(requester_id) === parseInt(target_id)) {
      return res.status(400).json({ success: false, error: 'ไม่สามารถเลือกสลับคิวกับตนเองได้' });
    }

    const q1 = await dbGet(`SELECT qm.*, p.name, p.emp_code, p.line_user_id, p.email FROM queue_members qm JOIN personnel p ON qm.personnel_id = p.id WHERE qm.personnel_id = ?`, [requester_id]);
    const q2 = await dbGet(`SELECT qm.*, p.name, p.emp_code, p.line_user_id, p.email FROM queue_members qm JOIN personnel p ON qm.personnel_id = p.id WHERE qm.personnel_id = ?`, [target_id]);

    if (!q1 || !q2) {
      return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลบุคลากรในตารางคิว' });
    }

    if (q1.role_type !== q2.role_type) {
      return res.status(400).json({ success: false, error: 'การสลับคิวทำได้เฉพาะบุคลากรในกลุ่มประเภทเดียวกันเท่านั้น (ผอ. สลับกับ ผอ. / พนักงาน สลับกับ พนักงาน)' });
    }

    // สลับคิว SQLite แบบ 2 ทางด้วย Atomic Transaction
    await dbRun('BEGIN TRANSACTION;');
    try {
      await dbRun(`UPDATE queue_members SET queue_order = ?, current_round = ? WHERE personnel_id = ?`, [q2.queue_order, q2.current_round, q1.personnel_id]);
      await dbRun(`UPDATE queue_members SET queue_order = ?, current_round = ? WHERE personnel_id = ?`, [q1.queue_order, q1.current_round, q2.personnel_id]);

      await dbRun(`
        INSERT INTO queue_swaps (requester_id, target_id, role_type, reason, status, approved_by)
        VALUES (?, ?, ?, ?, 'APPROVED', 'ADMIN')
      `, [requester_id, target_id, q1.role_type, reason || 'สลับคิวถั่วเฉลี่ยภารกิจ']);

      await dbRun('COMMIT;');
    } catch (txErr) {
      await dbRun('ROLLBACK;');
      throw txErr;
    }


    try {
      const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      const swapNoticeText = `🔄 แจ้งเตือนอนุมัติสลับลำดับคิว (Peer Swap)\nระหว่าง ${q1.name} (#${q1.queue_order} ➔ #${q2.queue_order})\nและ ${q2.name} (#${q2.queue_order} ➔ #${q1.queue_order})\nเหตุผล: ${reason || '-'}`;

      if (lineToken && q1.line_user_id && q1.line_user_id.toLowerCase() !== 'email') {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: q1.line_user_id,
          messages: [{ type: 'text', text: swapNoticeText }]
        }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken}` } });
      }

      if (lineToken && q2.line_user_id && q2.line_user_id.toLowerCase() !== 'email') {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: q2.line_user_id,
          messages: [{ type: 'text', text: swapNoticeText }]
        }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken}` } });
      }
    } catch (e) {
      console.error('Error sending swap notification:', e.message);
    }

    res.json({
      success: true,
      message: `อนุมัติสลับลำดับคิวระหว่าง   ${q1.name} และ   ${q2.name} เรียบร้อยแล้ว`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -------------------------------------------------------------
// 7. INDIVIDUAL HISTORY VIEW (หน้าประวัติย้อนหลังรายบุคคล)
// -------------------------------------------------------------
router.get('/history/individual/:id', async (req, res) => {
  try {
    const personId = req.params.id;

    const person = await dbGet(`SELECT * FROM personnel WHERE id = ?;`, [personId]);
    if (!person) return res.status(404).json({ success: false, error: 'ไม่พบบุคลากร' });

    const queueStatus = await dbGet(`SELECT * FROM queue_members WHERE personnel_id = ?;`, [personId]);

    const history = await dbAll(
      `SELECT 
        ma.id as assignment_id,
        ma.assigned_round,
        ma.is_leader,
        ma.assignment_status,
        ma.notes,
        ma.assigned_at,
        m.id as mission_id,
        m.mission_title,
        m.description as mission_description,
        m.location,
        m.dress_code,
        m.start_date,
        m.end_date,
        m.status as mission_status
       FROM mission_assignments ma
       JOIN missions m ON ma.mission_id = m.id
       WHERE ma.personnel_id = ?
       ORDER BY ma.assigned_round ASC, m.start_date DESC;`,
      [personId]
    );

    let totalJoined = 0;
    let totalHours = 0;
    let absentOrSubstituted = 0;

    history.forEach(h => {
      let dur = 8;
      if (h.start_date && h.end_date) {
        const s = new Date(h.start_date);
        const e = new Date(h.end_date);
        const diffMs = e.getTime() - s.getTime();
        if (diffMs > 0) dur = Math.round((diffMs / 3600000) * 10) / 10;
      }
      h.duration_hours = dur;

      if (h.assignment_status === 'JOINED') {
        totalJoined++;
        totalHours += dur;
      } else if (h.assignment_status === 'SUBSTITUTED') {
        absentOrSubstituted++;
      }
    });

    for (const h of history) {
      if (person.role_type === 'STAFF') {
        const leader = await dbGet(
          `SELECT p.name, p.position 
           FROM mission_assignments ma
           JOIN personnel p ON ma.personnel_id = p.id
           WHERE ma.mission_id = ? AND ma.is_leader = 1
           LIMIT 1;`,
          [h.mission_id]
        );
        if (leader) {
          h.director_leader_name = leader.name;
          h.director_leader_position = leader.position;
        }
      }
    }

    const historyByRound = {};
    history.forEach(h => {
      const r = h.assigned_round || 1;
      if (!historyByRound[r]) historyByRound[r] = [];
      historyByRound[r].push(h);
    });

    const activeRound = queueStatus ? queueStatus.current_round : 1;

    res.json({
      success: true,
      person,
      queueStatus,
      summary: {
        totalJoined,
        totalHours: Math.round(totalHours * 10) / 10,
        absentOrSubstituted,
        attendanceNote: absentOrSubstituted === 0 ? 'ไม่เคยขาด/ลา' : `ลา/เปลี่ยนตัว ${absentOrSubstituted} ครั้ง`
      },
      activeRound,
      historyByRound,
      history
    });
  } catch (err) {
    console.error('❌ Individual history error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function checkAndUpdateMissionStatus(missionId) {
  if (!missionId) return;

  try {
    // นับจำนวนคนที่ยังค้าง PENDING_ACK หรือยังไม่ได้ตอบรับ
    const pendingRow = await dbGet(
      `SELECT COUNT(*) AS pending_count 
       FROM mission_assignments 
       WHERE mission_id = ? 
         AND assignment_status = 'JOINED' 
         AND (ack_status IS NULL OR ack_status = 'PENDING_ACK' OR ack_status != 'ACKNOWLEDGED');`,
      [missionId]
    );

    // นับจำนวนคนที่ปฏิบัติงานจริงทั้งหมดของกิจกรรมนี้ (สถานะ JOINED)
    const totalRow = await dbGet(
      `SELECT COUNT(*) AS total_count 
       FROM mission_assignments 
       WHERE mission_id = ? 
         AND assignment_status = 'JOINED';`,
      [missionId]
    );

    const pendingCount = pendingRow ? Number(pendingRow.pending_count) : 0;
    const totalCount = totalRow ? Number(totalRow.total_count) : 0;

    // หากมีพนักงานปฏิบัติงานอยู่ และทุกคนตอบรับครบทั้งหมดแล้ว (pendingCount === 0)
    if (totalCount > 0 && pendingCount === 0) {
      await dbRun(`UPDATE missions SET status = 'SUCCESS' WHERE id = ?;`, [missionId]);
      console.log(`🎉 อัปเดตสถานะกิจกรรม #${missionId} เป็น SUCCESS (ทุกคนตอบรับ/ปฏิบัติงานครบถ้วนแล้ว ป้าย NEW จะซ่อนอัตโนมัติ)`);
    } else {
      await dbRun(`UPDATE missions SET status = 'SCHEDULED' WHERE id = ?;`, [missionId]);
    }
  } catch (err) {
    console.error('Error checking mission status:', err);
  }
}


// -------------------------------------------------------------
// 8. ALL MISSIONS & PERSONNEL LISTS
// -------------------------------------------------------------
router.get('/missions', async (req, res) => {
  try {
    const allMissions = await dbAll(`SELECT id FROM missions;`);
    for (const m of allMissions) {
      await checkAndUpdateMissionStatus(m.id);
    }

    const missions = await dbAll(
      `SELECT 
        m.*,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.mission_id = m.id AND ma.role_type = 'DIRECTOR' AND ma.assignment_status = 'JOINED') as directors_count,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.mission_id = m.id AND ma.role_type = 'STAFF' AND ma.assignment_status = 'JOINED') as staff_count
       FROM missions m
       ORDER BY m.start_date DESC;`
    );

    res.json({ success: true, missions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/missions/calendar-events - ดึงกิจกรรมในรูปแบบ FullCalendar Events
router.get('/missions/calendar-events', async (req, res) => {
  try {
    const missions = await dbAll(`
      SELECT m.*, 
        COUNT(DISTINCT CASE WHEN p.role_type = 'DIRECTOR' THEN ma.personnel_id END) AS directors_count,
        COUNT(DISTINCT CASE WHEN p.role_type = 'STAFF' THEN ma.personnel_id END) AS staff_count
      FROM missions m
      LEFT JOIN mission_assignments ma ON m.id = ma.mission_id AND ma.assignment_status IN ('JOINED', 'SUBSTITUTED')
      LEFT JOIN personnel p ON ma.personnel_id = p.id
      GROUP BY m.id
      ORDER BY m.start_date DESC
    `);

    const events = missions.map(m => {
      const isSuccess = (m.status === 'SUCCESS' || m.status === 'COMPLETED');
      return {
        id: m.id,
        title: m.mission_title,
        start: m.start_date,
        end: m.end_date || m.start_date,
        backgroundColor: isSuccess ? '#10b981' : '#d97706',
        borderColor: isSuccess ? '#059669' : '#b45309',
        extendedProps: {
          location: m.location || 'สะพานปลา อสป.',
          dressCode: m.dress_code || 'ชุดปฏิบัติงาน อสป.',
          status: m.status,
          directorsCount: m.directors_count,
          staffCount: m.staff_count,
          description: m.description || '-'
        }
      };
    });

    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


router.get('/missions/:id', async (req, res) => {
  try {
    const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [req.params.id]);
    if (!mission) return res.status(404).json({ success: false, error: 'ไม่พบกิจกรรม' });

    const assigned = await dbAll(
      `SELECT 
        ma.id as assignment_id,
        ma.assigned_round,
        ma.is_leader,
        ma.assignment_status,
        ma.ack_status,
        ma.ack_at,
        ma.decline_reason,
        ma.notes,
        ma.assigned_at,
        p.id as personnel_id,
        p.emp_code,
        p.name,
        p.role_type,
        p.department,
        p.position,
        p.phone
       FROM mission_assignments ma
       JOIN personnel p ON ma.personnel_id = p.id
       WHERE ma.mission_id = ?
       ORDER BY ma.is_leader DESC, p.name ASC;`,
      [req.params.id]
    );

    res.json({ success: true, mission, assigned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/personnel', async (req, res) => {
  try {
    const { search = '', role = '', department = '' } = req.query;

    let query = `
      SELECT 
        p.*,
        qm.current_round,
        qm.queue_order,
        qm.status as queue_status,
        qm.hold_reason,
        qm.hold_timestamp,
        qm.last_assigned_at,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status = 'JOINED') as total_missions_joined
      FROM personnel p
      LEFT JOIN queue_members qm ON p.id = qm.personnel_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (p.name LIKE ? OR p.emp_code LIKE ? OR p.position LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (role) {
      query += ` AND p.role_type = ?`;
      params.push(role.toUpperCase());
    }

    if (department) {
      query += ` AND p.department = ?`;
      params.push(department);
    }

    query += ` ORDER BY p.role_type DESC, qm.queue_order ASC;`;

    const list = await dbAll(query, params);
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 9. EMPLOYEE ACKNOWLEDGEMENT & AUTO RE-ALLOCATION ON CONFLICT
// -------------------------------------------------------------
router.post('/missions/respond', async (req, res) => {
  try {
    const { mission_id, personnel_id, response_status, substitute_emp_code, decline_reason } = req.body;

    if (!mission_id || !personnel_id || !response_status) {
      return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' });
    }

    const assignment = await dbGet(
      `SELECT ma.*, p.name, p.role_type, p.emp_code 
       FROM mission_assignments ma
       JOIN personnel p ON ma.personnel_id = p.id
       WHERE ma.mission_id = ? AND ma.personnel_id = ? AND ma.assignment_status = 'JOINED';`,
      [mission_id, personnel_id]
    );

    if (!assignment) {
      return res.status(404).json({ success: false, error: 'ไม่พบรายการจัดสรรที่ใช้งานอยู่ของบุคลากรท่านนี้' });
    }

    if (response_status === 'ACKNOWLEDGED') {
      await dbRun(
        `UPDATE mission_assignments 
         SET ack_status = 'ACKNOWLEDGED', ack_at = CURRENT_TIMESTAMP 
         WHERE id = ?;`,
        [assignment.id]
      );

      await checkAndUpdateMissionStatus(mission_id);

      return res.json({
        success: true,
        message: `บันทึกการรับทราบเข้าร่วมกิจกรรมของ ${assignment.name} เรียบร้อยแล้ว`
      });


    // =========================================================
    // กรณีที่ 1: ติดภารกิจ/ขอลา แบบ "ไม่มีคนแทน" (รูปแบบ B)
    // =========================================================
    } else if (response_status === 'DECLINED_NO_SUBSTITUTE') {
      const reasonText = decline_reason || 'ติดภารกิจ/ขอลา (ไม่มีคนแทน)';

      // 1. อัปเดตแถวของคนเดิม (ผู้ขอลา)
      await dbRun(
        `UPDATE mission_assignments 
         SET assignment_status = 'DECLINED_NO_SUBSTITUTE', 
             ack_status = 'DECLINED_BUSY', 
             decline_reason = ?, 
             ack_at = CURRENT_TIMESTAMP 
         WHERE id = ?;`,
        [reasonText, assignment.id]
      );

      // 2. รูปแบบ B: ถือว่าใช้สิทธิ์ในรอบนี้แล้ว -> อัปเดตคิวผู้ลาเป็น COMPLETED
      await dbRun(
        `UPDATE queue_members 
         SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ?;`,
        [personnel_id]
      );

      // 3. ค้นหาพนักงานคนถัดไปในคิว (Auto-Reallocate Next Candidate)
      const nextCandidate = await dbGet(
        `SELECT qm.personnel_id, p.id, p.emp_code, p.name, p.role_type, p.department, p.position, p.email, p.phone, p.line_user_id
         FROM queue_members qm
         JOIN personnel p ON p.id = qm.personnel_id
         WHERE UPPER(qm.role_type) = UPPER(?)
           AND qm.status IN ('WAITING', 'HOLD')
           AND qm.personnel_id != ?
         ORDER BY qm.current_round ASC, qm.queue_order ASC
         LIMIT 1;`,
        [assignment.role_type, personnel_id]
      );

      let replacementMessage = '';
      let replacementPersonName = null;

      if (nextCandidate) {
        // เพิ่มแถวให้พนักงานคนใหม่
        await dbRun(
          `INSERT INTO mission_assignments 
           (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, substituted_for_personnel_id, notes, ack_status)
           VALUES (?, ?, ?, ?, ?, 'JOINED', ?, ?, 'PENDING_ACK');`,
          [
            mission_id,
            nextCandidate.id,
            assignment.role_type,
            assignment.assigned_round,
            assignment.is_leader,
            personnel_id,
            `จัดสรรแทน [${assignment.name} ที่ขอลา (ไม่มีคนแทน)]`
          ]
        );

        // อัปเดตคิวของพนักงานคนใหม่เป็น COMPLETED
        await dbRun(
          `UPDATE queue_members 
           SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
           WHERE personnel_id = ?;`,
          [nextCandidate.id]
        );

        // ตรวจสอบการเลื่อนรอบ
        await checkAndAdvanceRound(assignment.role_type);

        // ส่งการแจ้งเตือน (ส่ง LINE/Email ตามช่องทางที่พนักงานผูกไว้)
        const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [mission_id]);
        if (mission) {
          sendMissionNotification(
            mission,
            [{ ...nextCandidate, personnel_id: nextCandidate.id, substitute_for_name: assignment.name }],
            true
          ).catch(e => console.error('Notification dispatch error:', e));
        }


        const channelNotice = (nextCandidate.line_user_id && nextCandidate.line_user_id.toLowerCase() !== 'email') 
          ? 'ทาง LINE และ อีเมล' 
          : 'ทางอีเมล';

        replacementPersonName = nextCandidate.name;
        replacementMessage = `ระบบได้จัดสรรพนักงานลำดับถัดไปคือ    ${nextCandidate.name} (${nextCandidate.emp_code}) ปฏิบัติงานแทนให้อัตโนมัติแล้ว (ส่งแจ้งเตือน ${channelNotice})`;
      } else {
        await checkAndAdvanceRound(assignment.role_type);
        replacementMessage = `ขณะนี้ไม่มีพนักงานในคิวที่สามารถปฏิบัติงานแทนได้ ระบบจึงลงประวัติขอลาไว้เรียบร้อยแล้ว`;
      }

      return res.json({
        success: true,
        message: `บันทึกการขอลาของ ${assignment.name} เรียบร้อยแล้ว (ถือว่าใช้สิทธิ์ในรอบนี้แล้ว) ${replacementMessage}`,
        replacementPerson: replacementPersonName
      });

    // =========================================================
    // กรณีที่ 2: ติดภารกิจ แบบ "มีผู้ปฏิบัติงานแทน" (ระบุรหัสตัวแทน)
    // =========================================================
    } else if (response_status === 'DECLINED_BUSY') {
      if (!substitute_emp_code) {
        return res.status(400).json({ success: false, error: '📝 กรุณาพิมพ์รหัสผู้ปฏิบัติงานแทน' });
      }

      const substitutePerson = await dbGet(`SELECT * FROM personnel WHERE emp_code = ?;`, [substitute_emp_code]);
      
      if (!substitutePerson) {
        return res.status(404).json({ success: false, error: 'ไม่พบรหัสพนักงานตัวแทนนี้ในระบบ' });
      }

      await dbRun(
        `UPDATE mission_assignments 
         SET assignment_status = 'SUBSTITUTED', ack_status = 'DECLINED_BUSY', decline_reason = ?, ack_at = CURRENT_TIMESTAMP 
         WHERE id = ?;`,
        [`ให้ ${substitutePerson.name} ทำแทน`, assignment.id]
      );

      await dbRun(
        `UPDATE queue_members 
         SET status = 'COMPLETED', hold_reason = NULL, hold_timestamp = NULL, last_assigned_at = CURRENT_TIMESTAMP 
         WHERE personnel_id = ?;`,
        [personnel_id]
      );

      await dbRun(
        `INSERT INTO mission_assignments 
         (mission_id, personnel_id, role_type, assigned_round, is_leader, assignment_status, substituted_for_personnel_id, notes, ack_status)
         VALUES (?, ?, ?, ?, ?, 'JOINED', ?, ?, 'PENDING_ACK');`,
        [
          mission_id,
          substitutePerson.id,
          assignment.role_type,
          assignment.assigned_round,
          assignment.is_leader,
          personnel_id,
          `มาเป็นตัวแทนของ [${assignment.name}]`
        ]
      );

      await checkAndAdvanceRound(assignment.role_type);

      const mission = await dbGet(`SELECT * FROM missions WHERE id = ?;`, [mission_id]);
      if (mission) {
        sendMissionNotification(
          mission,
          [{ ...substitutePerson, personnel_id: substitutePerson.id, substitute_for_name: assignment.name }],
          true
        ).catch(e => console.error('Notification dispatch error:', e));
      }


      return res.json({
        success: true,
        message: `ส่งตัวแทนสำเร็จ! เพิ่มชื่อ ${substitutePerson.name} เข้าสู่กิจกรรมแล้ว และส่งแจ้งเตือนให้ตัวแทนเรียบร้อย`,
        replacementPerson: substitutePerson.name
      });
    }

    res.status(400).json({ success: false, error: 'สถานะตอบรับไม่ถูกต้อง' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -------------------------------------------------------------
// 10. EXPORT SUMMARY REPORT DATA
// -------------------------------------------------------------
router.get('/reports/export', async (req, res) => {
  try {
    const dirState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'DIRECTOR';`);
    const staffState = await dbGet(`SELECT current_round FROM queue_state WHERE role_type = 'STAFF';`);

    const missions = await dbAll(
      `SELECT m.*,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.mission_id = m.id AND ma.role_type = 'DIRECTOR' AND ma.assignment_status = 'JOINED') as directors_count,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.mission_id = m.id AND ma.role_type = 'STAFF' AND ma.assignment_status = 'JOINED') as staff_count
       FROM missions m ORDER BY m.start_date DESC;`
    );

    const personnel = await dbAll(
      `SELECT p.emp_code, p.name, p.role_type, p.department, p.position, qm.queue_order, qm.status as queue_status, qm.last_assigned_at,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status = 'JOINED') as total_missions_joined,
        (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND (ma.assignment_status = 'SUBSTITUTED' OR ma.ack_status = 'DECLINED_BUSY')) as total_substituted
       FROM personnel p
       LEFT JOIN queue_members qm ON p.id = qm.personnel_id
       ORDER BY p.role_type DESC, qm.queue_order ASC;`
    );

    // 💡 สิ่งที่เพิ่มใหม่ 1: ดึงประวัติการส่งตัวแทนและการสลับคิวทั้งหมด
    const swapHistory = await dbAll(
      `SELECT 
         m.mission_title, 
         p.emp_code, 
         p.name as original_person, 
         ma.assignment_status, 
         ma.decline_reason as substitute_note, 
         ma.notes as additional_notes,
         ma.ack_at as action_date
       FROM mission_assignments ma
       JOIN personnel p ON ma.personnel_id = p.id
       JOIN missions m ON ma.mission_id = m.id
       WHERE ma.ack_status = 'DECLINED_BUSY' 
          OR ma.assignment_status = 'SUBSTITUTED'
          OR ma.notes LIKE '%มาเป็นตัวแทน%'
       ORDER BY ma.ack_at DESC;`
    );

    const notificationLogs = await dbAll(
      `SELECT nl.channel, nl.recipient, nl.subject_title, nl.status, nl.sent_at 
       FROM notification_logs nl ORDER BY nl.sent_at DESC LIMIT 50;`
    );

    res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      system: 'FMO Smart Queue (องค์การสะพานปลา - อสป.)',
      rounds: {
        directorRound: dirState ? dirState.current_round : 1,
        staffRound: staffState ? staffState.current_round : 1
      },
      missions,
      personnel,
      swapHistory, // 💡 สิ่งที่เพิ่มใหม่ 2: ส่งข้อมูลประวัติการสลับคิวออกไปพร้อมกับ JSON
      notificationLogs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notifications/logs', async (req, res) => {
  try {
    const logs = await dbAll(
      `SELECT nl.*, m.mission_title
       FROM notification_logs nl
       LEFT JOIN missions m ON nl.mission_id = m.id
       ORDER BY nl.sent_at DESC 
       LIMIT 50;`
    );

    const acknowledgements = await dbAll(
      `SELECT 
        ma.id as assignment_id,
        ma.mission_id,
        ma.personnel_id,
        ma.ack_status,
        ma.ack_at,
        ma.assignment_status,
        p.name as person_name,
        p.emp_code,
        p.line_user_id,
        p.email,
        m.mission_title,
        m.start_date
       FROM mission_assignments ma
       JOIN personnel p ON ma.personnel_id = p.id
       JOIN missions m ON ma.mission_id = m.id
       WHERE ma.assignment_status IN ('JOINED', 'SUBSTITUTED', 'DECLINED_NO_SUBSTITUTE')
       ORDER BY ma.ack_at DESC, ma.id DESC
       LIMIT 100;`
    );

    res.json({ success: true, logs, acknowledgements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/upcoming-notice - แจ้งเตือนเตรียมพร้อมคิวถัดไปทาง LINE / Email
router.post('/notifications/upcoming-notice', async (req, res) => {
  try {
    const { sendUpcomingQueueNotice } = require('../services/notification');
    const result = await sendUpcomingQueueNotice();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/pre-event-reminders - ยิงเตือนความจำกิจกรรมล่วงหน้า (24 ชม.)
router.post('/notifications/pre-event-reminders', async (req, res) => {
  try {
    const { dispatchPreEventReminders } = require('../services/notification');
    const result = await dispatchPreEventReminders();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});







// -------------------------------------------------------------
// 11. IMPORT REAL PERSONNEL DATA (CSV)
// -------------------------------------------------------------
router.post('/personnel/import-csv', async (req, res) => {
  try {
    const { personnelList } = req.body;
    if (!Array.isArray(personnelList) || personnelList.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบข้อมูลรายชื่อบุคลากรในไฟล์' });
    }

    await dbRun(`DELETE FROM mission_assignments;`);
    await dbRun(`DELETE FROM queue_members;`);
    await dbRun(`DELETE FROM personnel;`);
    await dbRun(`UPDATE queue_state SET current_round = 1;`);

    let dirOrder = 1;
    let staffOrder = 1;
    const usedEmpCodes = new Set();

    for (const p of personnelList) {
      const rawName = (p.name || '').trim();
      const rawCode = (p.emp_code || '').trim();

      if (!rawName || rawName.includes('===') || rawName.includes('ลำดับ') || rawName.includes('รหัสพนักงาน')) continue;

      const role = (p.role_type || '').toUpperCase().includes('DIR') ? 'DIRECTOR' : 'STAFF';
      let empCode = rawCode;

      if (!empCode || empCode.includes('===') || empCode.includes('ลำดับ') || empCode.includes('รหัสพนักงาน')) {
        empCode = role === 'DIRECTOR' ? `DIR-${String(dirOrder).padStart(2, '0')}` : `EMP-${String(staffOrder).padStart(3, '0')}`;
      }

      let uniqueEmpCode = empCode;
      let dupCounter = 1;
      while (usedEmpCodes.has(uniqueEmpCode)) {
        uniqueEmpCode = `${empCode}_${dupCounter++}`;
      }
      usedEmpCodes.add(uniqueEmpCode);

      const name = rawName;
      const pos = p.position || (role === 'DIRECTOR' ? 'ผู้อำนวยการฝ่าย' : 'พนักงาน');
      const dept = p.department || 'อสป.';
      const email = p.email || '';
      const phone = p.phone || '';

      const pRes = await dbRun(
        `INSERT INTO personnel (emp_code, name, position, department, role_type, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [uniqueEmpCode, name, pos, dept, role, email, phone]
      );

      const pId = pRes.lastID;
      const order = role === 'DIRECTOR' ? dirOrder++ : staffOrder++;

      await dbRun(
        `INSERT INTO queue_members (personnel_id, role_type, current_round, queue_order, status) VALUES (?, ?, 1, ?, 'WAITING');`,
        [pId, role, order]
      );
    }

    res.json({
      success: true,
      message: `นำเข้าข้อมูลรายชื่อบุคลากรจริงสำเร็จเรียบร้อยแล้ว จำนวนรวม ${usedEmpCodes.size} ท่าน! (ผอ.ฝ่าย ${dirOrder - 1} ท่าน / พนักงาน ${staffOrder - 1} ท่าน)`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 12. LINE OA WEBHOOK ENDPOINT
// -------------------------------------------------------------
router.post('/line-webhook', async (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const lineUserId = event.source.userId;
      const userText = event.message.text.trim().toUpperCase();
      const replyToken = event.replyToken;

      try {
        const person = await dbGet(`SELECT * FROM personnel WHERE UPPER(emp_code) = ?`, [userText]);

        let replyMsg = '';
        if (person) {
          await dbRun(`UPDATE personnel SET line_user_id = ? WHERE id = ?`, [lineUserId, person.id]);
          replyMsg = `✅ ผูกบัญชีสำเร็จ!\n\nสวัสดี   ${person.name}\nระบบ FMO Smart Queue ได้เชื่อมต่อกับ LINE ของ  เรียบร้อยแล้วค่ะ`;
        } else {
          replyMsg = `❌ ไม่พบรหัสพนักงาน "${userText}" ในระบบ\n\nกรุณาพิมพ์รหัสพนักงานใหม่อีกครั้ง เช่น EMP-001 หรือ DIR-01 ค่ะ`;
        }

        if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: replyMsg }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
            }
          });
        }
      } catch (err) {
        console.error('Error handling LINE Webhook:', err);
      }
    }
  }
});


// GET /api/missions/:id/pdf - ออกเอกสารคำสั่งจัดสรรกิจกรรม (PDF Mission Order Document)
router.get('/missions/:id/pdf', async (req, res) => {

  try {
    const missionId = req.params.id;
    const mission = await dbGet(`SELECT * FROM missions WHERE id = ?`, [missionId]);
    if (!mission) {
      return res.status(404).send('<h2>ไม่พบข้อมูลกิจกรรม</h2>');
    }

    const assigned = await dbAll(`
      SELECT ma.*, p.emp_code, p.name, p.position, p.department, p.role_type
      FROM mission_assignments ma
      JOIN personnel p ON ma.personnel_id = p.id
      WHERE ma.mission_id = ?
        AND ma.assignment_status IN ('JOINED', 'SUBSTITUTED')
      ORDER BY 
        CASE p.role_type WHEN 'DIRECTOR' THEN 1 ELSE 2 END,
        p.emp_code ASC
    `, [missionId]);

    const directors = assigned.filter(a => a.role_type === 'DIRECTOR');
    const staff = assigned.filter(a => a.role_type === 'STAFF');

    const formatDateStr = (dateVal) => {
      if (!dateVal) return '-';
      const d = new Date(dateVal);
      const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
      return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543} เวลา ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} น.`;
    };

    let directorsRowsHtml = directors.map((d, i) => `
      <tr>
        <td style="text-align:center; padding:8px; border:1px solid #cbd5e1;">${i + 1}</td>
        <td style="padding:8px; border:1px solid #cbd5e1;"><strong>${d.name}</strong></td>
        <td style="padding:8px; border:1px solid #cbd5e1;">${d.position || '-'}</td>
        <td style="padding:8px; border:1px solid #cbd5e1;">${d.department || '-'}</td>
        <td style="text-align:center; padding:8px; border:1px solid #cbd5e1; font-weight:bold; color:#0284c7;">หัวหน้าคณะ</td>
      </tr>
    `).join('');

    let staffRowsHtml = staff.map((s, i) => `
      <tr>
        <td style="text-align:center; padding:8px; border:1px solid #cbd5e1;">${i + 1}</td>
        <td style="padding:8px; border:1px solid #cbd5e1;"><strong>${s.name}</strong></td>
        <td style="padding:8px; border:1px solid #cbd5e1;">${s.position || '-'}</td>
        <td style="padding:8px; border:1px solid #cbd5e1;">${s.department || '-'}</td>
        <td style="text-align:center; padding:8px; border:1px solid #cbd5e1;">คณะทำงาน</td>
      </tr>
    `).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="th">
      <head>
        <meta charset="UTF-8">
        <title>คำสั่งองค์การสะพานปลา ที่ ${mission.id}/${new Date().getFullYear() + 543}</title>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap">
        <style>
          @page { size: A4; margin: 20mm; }
          body { font-family: 'Sarabun', sans-serif; color: #0f172a; line-height: 1.6; font-size: 14pt; margin: 0; padding: 20px; }
          .header { text-align: center; margin-bottom: 25px; }
          .logo { height: 85px; margin-bottom: 10px; }
          .title { font-size: 18pt; font-weight: 700; color: #0f172a; margin: 5px 0; }
          .subtitle { font-size: 15pt; font-weight: 600; color: #334155; }
          .info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px 20px; margin: 20px 0; }
          .info-row { margin: 6px 0; }
          .info-label { font-weight: 700; color: #0284c7; width: 140px; display: inline-block; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12pt; }
          th { background: #0284c7; color: #ffffff; padding: 10px; border: 1px solid #0284c7; text-align: center; }
          .section-head { font-size: 14pt; font-weight: 700; color: #0f172a; margin-top: 25px; margin-bottom: 10px; border-bottom: 2px solid #0284c7; padding-bottom: 4px; }
          .signature-section { margin-top: 50px; display: flex; justify-content: flex-end; }
          .sig-box { text-align: center; width: 280px; }
          .sig-line { border-bottom: 1px dotted #475569; margin: 40px 0 10px 0; }
          @media print {
            .no-print { display: none !important; }
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="no-print" style="margin-bottom:20px; text-align:right;">
          <button onclick="window.print()" style="background:#0284c7; color:white; border:none; padding:10px 20px; font-size:14px; border-radius:8px; cursor:pointer; font-family:Sarabun,sans-serif; font-weight:bold;">
            🖨️ พิมพ์คำสั่ง / เซฟเป็น PDF
          </button>
        </div>

        <div class="header">
          <img src="/logoFMO.png" class="logo" alt="อสป. Logo">
          <div class="title">บันทึกข้อความ / คำสั่งองค์การสะพานปลา</div>
          <div class="subtitle">เรื่อง การจัดสรรบุคลากรเข้าร่วมกิจกรรมตามคำสั่งทางการ</div>
          <div>ที่ อสป. ${mission.id}/${new Date().getFullYear() + 543}</div>
        </div>

        <div class="info-box">
          <div class="info-row"><span class="info-label">📌 ชื่อกิจกรรม:</span> <strong>${mission.mission_title}</strong></div>
          <div class="info-row"><span class="info-label">📍 สถานที่ปฏิบัติงาน:</span> ${mission.location || 'สะพานปลา อสป.'}</div>
          <div class="info-row"><span class="info-label">⏰ กำหนดการ (24 ชม.):</span> ${formatDateStr(mission.start_date)} - ${formatDateStr(mission.end_date)}</div>
          <div class="info-row"><span class="info-label">👔 การแต่งกาย:</span> ${mission.dress_code || 'ชุดปฏิบัติงาน อสป.'}</div>
          <div class="info-row"><span class="info-label">📝 รายละเอียด:</span> ${mission.description || '-'}</div>
        </div>

        <div class="section-head">👑 1. รายชื่อหัวหน้าคณะปฏิบัติงาน (ระดับผู้บริหาร/ผอ.ฝ่าย)</div>
        <table>
          <thead>
            <tr>
              <th style="width:8%;">ลำดับ</th>
              <th style="width:30%;">ชื่อ - นามสกุล</th>
              <th style="width:25%;">ตำแหน่ง</th>
              <th style="width:22%;">สังกัด/ฝ่าย</th>
              <th style="width:15%;">บทบาท</th>
            </tr>
          </thead>
          <tbody>
            ${directorsRowsHtml || '<tr><td colspan="5" style="text-align:center; padding:10px;">- ไม่ระบุหัวหน้าคณะ -</td></tr>'}
          </tbody>
        </table>

        <div class="section-head">👥 2. รายชื่อคณะทำงานปฏิบัติงาน (พนักงาน อสป.)</div>
        <table>
          <thead>
            <tr>
              <th style="width:8%;">ลำดับ</th>
              <th style="width:30%;">ชื่อ - นามสกุล</th>
              <th style="width:25%;">ตำแหน่ง</th>
              <th style="width:22%;">สังกัด/ฝ่าย</th>
              <th style="width:15%;">บทบาท</th>
            </tr>
          </thead>
          <tbody>
            ${staffRowsHtml || '<tr><td colspan="5" style="text-align:center; padding:10px;">- ไม่มีรายชื่อพนักงาน -</td></tr>'}
          </tbody>
        </table>

        <div class="signature-section">
          <div class="sig-box">
            <div>อนุมัติให้ดำเนินการตามคำสั่งนี้</div>
            <div class="sig-line"></div>
            <div>( ................................................................ )</div>
            <div style="margin-top:5px;">ผู้อำนวยการองค์การสะพานปลา</div>
            <div>วันที่ ........ เดือน ........................ พ.ศ. ...........</div>
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(htmlContent);
  } catch (err) {
    res.status(500).send(`Error generating document: ${err.message}`);
  }
});


// -------------------------------------------------------------
// 13. USER & ROLE MANAGEMENT ENDPOINTS (ข้อ 6)
// -------------------------------------------------------------

// GET /api/users - ดึงรายชื่อผู้ใช้งานและบุคลากรทั้งหมด
router.get('/users', async (req, res) => {
  try {
    const users = await dbAll(`
      SELECT p.*, qm.queue_order, qm.status as queue_status, qm.current_round,
             (SELECT COUNT(*) FROM mission_assignments ma WHERE ma.personnel_id = p.id AND ma.assignment_status IN ('JOINED', 'SUBSTITUTED')) as total_missions
      FROM personnel p
      LEFT JOIN queue_members qm ON p.id = qm.personnel_id
      ORDER BY 
        CASE p.role_type WHEN 'DIRECTOR' THEN 1 ELSE 2 END,
        qm.queue_order ASC,
        p.emp_code ASC
    `);

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users - เพิ่มผู้ใช้งาน/บุคลากรใหม่
router.post('/users', async (req, res) => {
  try {
    const { emp_code, name, role_type, department, position, phone, email, password, menu_permissions } = req.body;
    if (!emp_code || !name || !role_type) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกรหัสพนักงาน/Username ชื่อ-นามสกุล และประเภทสิทธิ์ให้ครบถ้วน' });
    }

    const codeClean = String(emp_code).trim().toUpperCase();
    const existing = await dbGet(`SELECT id FROM personnel WHERE UPPER(emp_code) = ?`, [codeClean]);
    if (existing) {
      return res.status(400).json({ success: false, error: `รหัสพนักงาน/Username "${codeClean}" มีอยู่ในระบบแล้ว` });
    }

    const maxQueueObj = await dbGet(`SELECT MAX(queue_order) as max_order FROM queue_members WHERE role_type = ?`, [role_type]);
    const nextQueueOrder = (maxQueueObj && maxQueueObj.max_order) ? maxQueueObj.max_order + 1 : 1;

    const permsJson = Array.isArray(menu_permissions) ? JSON.stringify(menu_permissions) : menu_permissions || '[]';

    await dbRun('BEGIN TRANSACTION;');
    try {
      const pRes = await dbRun(`
        INSERT INTO personnel (emp_code, name, role_type, department, position, phone, email, password, menu_permissions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        codeClean, 
        name.trim(), 
        role_type, 
        department || 'อสป.', 
        position || (role_type === 'ADMIN' ? 'ผู้ดูแลระบบ' : (role_type === 'OPERATOR' ? 'เจ้าหน้าที่ปฏิบัติการ' : (role_type === 'DIRECTOR' ? 'ผอ.ฝ่าย' : 'พนักงาน'))), 
        phone || '', 
        email || '',
        password || '123456',
        permsJson
      ]);

      const pId = pRes.lastID;

      if (['DIRECTOR', 'STAFF'].includes(role_type)) {
        await dbRun(`
          INSERT INTO queue_members (personnel_id, role_type, current_round, queue_order, status)
          VALUES (?, ?, 1, ?, 'WAITING')
        `, [pId, role_type, nextQueueOrder]);
      }

      await dbRun('COMMIT;');
      res.json({ success: true, message: `เพิ่มผู้ใช้งาน   ${name} (${codeClean}) เรียบร้อยแล้ว` });
    } catch (txErr) {
      await dbRun('ROLLBACK;');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/users/:id - แก้ไขข้อมูลผู้ใช้งาน
router.put('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { emp_code, name, role_type, department, position, phone, email, password, menu_permissions, queue_order } = req.body;

    const person = await dbGet(`SELECT * FROM personnel WHERE id = ?`, [userId]);
    if (!person) return res.status(404).json({ success: false, error: 'ไม่พบผู้ใช้งานในระบบ' });

    const codeClean = String(emp_code || person.emp_code).trim().toUpperCase();
    const permsJson = Array.isArray(menu_permissions) ? JSON.stringify(menu_permissions) : (menu_permissions || person.menu_permissions);

    if (password && String(password).trim()) {
      await dbRun(`
        UPDATE personnel 
        SET emp_code = ?, name = ?, role_type = ?, department = ?, position = ?, phone = ?, email = ?, password = ?, menu_permissions = ?
        WHERE id = ?
      `, [codeClean, name, role_type, department, position, phone, email, String(password).trim(), permsJson, userId]);
    } else {
      await dbRun(`
        UPDATE personnel 
        SET emp_code = ?, name = ?, role_type = ?, department = ?, position = ?, phone = ?, email = ?, menu_permissions = ?
        WHERE id = ?
      `, [codeClean, name, role_type, department, position, phone, email, permsJson, userId]);
    }

    if (queue_order && ['DIRECTOR', 'STAFF'].includes(role_type)) {
      await dbRun(`UPDATE queue_members SET queue_order = ?, role_type = ? WHERE personnel_id = ?`, [parseInt(queue_order), role_type, userId]);
    }

    res.json({ success: true, message: `อัปเดตข้อมูล   ${name} เรียบร้อยแล้ว` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// DELETE /api/users/:id - ลบผู้ใช้งาน
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const person = await dbGet(`SELECT name, emp_code FROM personnel WHERE id = ?`, [userId]);
    if (!person) return res.status(404).json({ success: false, error: 'ไม่พบผู้ใช้งานในระบบ' });

    await dbRun('BEGIN TRANSACTION;');
    try {
      await dbRun(`DELETE FROM queue_members WHERE personnel_id = ?`, [userId]);
      await dbRun(`DELETE FROM mission_assignments WHERE personnel_id = ?`, [userId]);
      await dbRun(`DELETE FROM personnel WHERE id = ?`, [userId]);
      await dbRun('COMMIT;');
      res.json({ success: true, message: `ลบผู้ใช้งาน   ${person.name} (${person.emp_code}) เรียบร้อยแล้ว` });
    } catch (txErr) {
      await dbRun('ROLLBACK;');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/:id/unbind-line - ยกเลิกการผูกบัญชี LINE OA
router.post('/users/:id/unbind-line', async (req, res) => {
  try {
    const userId = req.params.id;
    const person = await dbGet(`SELECT name, emp_code FROM personnel WHERE id = ?`, [userId]);
    if (!person) return res.status(404).json({ success: false, error: 'ไม่พบผู้ใช้งานในระบบ' });

    await dbRun(`UPDATE personnel SET line_user_id = NULL WHERE id = ?`, [userId]);
    res.json({ success: true, message: `ยกเลิกการผูกบัญชี LINE OA ของ   ${person.name} เรียบร้อยแล้ว` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;