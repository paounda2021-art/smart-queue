const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'fmo_smart_queue.db');
const db = new sqlite3.Database(dbPath);

// Promisified database helpers for async/await
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

async function initSchema() {
  await dbRun(`PRAGMA foreign_keys = ON;`);

  // Personnel Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS personnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_code VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      role_type VARCHAR(20) CHECK(role_type IN ('DIRECTOR', 'STAFF', 'ADMIN', 'OPERATOR')) NOT NULL,
      department VARCHAR(100) NOT NULL,
      position VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      email VARCHAR(100),
      line_user_id VARCHAR(100),
      password VARCHAR(255),
      menu_permissions TEXT,
      created_at DATETIME DEFAULT (datetime('now', '+7 hours'))
    );
  `);

  // Ensure missing columns exist
  try { await dbRun(`ALTER TABLE personnel ADD COLUMN password VARCHAR(255);`); } catch (e) {}
  try { await dbRun(`ALTER TABLE personnel ADD COLUMN menu_permissions TEXT;`); } catch (e) {}

  // Auto Migration: อัปเดต CHECK Constraint ให้รองรับ 'ADMIN' และ 'OPERATOR'
  try {
    const masterSql = await dbGet(`SELECT sql FROM sqlite_master WHERE type='table' AND name='personnel';`);
    if (masterSql && masterSql.sql && (!masterSql.sql.includes('ADMIN') || !masterSql.sql.includes('OPERATOR'))) {
      console.log('🔄 Migrating personnel table CHECK constraint to support ADMIN & OPERATOR roles...');
      await dbRun(`PRAGMA foreign_keys = OFF;`);
      await dbRun(`BEGIN TRANSACTION;`);
      await dbRun(`CREATE TABLE personnel_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_code VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        role_type VARCHAR(20) CHECK(role_type IN ('DIRECTOR', 'STAFF', 'ADMIN', 'OPERATOR')) NOT NULL,
        department VARCHAR(100) NOT NULL,
        position VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(100),
        line_user_id VARCHAR(100),
        password VARCHAR(255),
        menu_permissions TEXT,
        created_at DATETIME DEFAULT (datetime('now', '+7 hours'))
      );`);
      await dbRun(`INSERT INTO personnel_new (id, emp_code, name, role_type, department, position, phone, email, line_user_id, created_at) SELECT id, emp_code, name, role_type, department, position, phone, email, line_user_id, created_at FROM personnel;`);
      await dbRun(`DROP TABLE personnel;`);
      await dbRun(`ALTER TABLE personnel_new RENAME TO personnel;`);
      await dbRun(`COMMIT;`);
      await dbRun(`PRAGMA foreign_keys = ON;`);
      console.log('✅ Personnel table migrated to support ADMIN & OPERATOR roles successfully!');
    }

  } catch (mErr) {
    console.error('Migration error (personnel table):', mErr);
    try { await dbRun(`ROLLBACK;`); } catch (e) {}
  }



  // Queue State Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS queue_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_type VARCHAR(20) UNIQUE NOT NULL,
      current_round INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT (datetime('now', '+7 hours'))
    );
  `);

  // Queue Members Status Tracking
  await dbRun(`
    CREATE TABLE IF NOT EXISTS queue_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      personnel_id INTEGER UNIQUE NOT NULL,
      role_type VARCHAR(20) NOT NULL,
      current_round INTEGER DEFAULT 1,
      queue_order INTEGER NOT NULL,
      status VARCHAR(20) DEFAULT 'WAITING',
      hold_reason TEXT,
      hold_timestamp DATETIME,
      last_assigned_at DATETIME,
      FOREIGN KEY(personnel_id) REFERENCES personnel(id) ON DELETE CASCADE
    );
  `);

  // Missions Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_title VARCHAR(200) NOT NULL,
      description TEXT,
      location VARCHAR(200),
      dress_code VARCHAR(150),
      start_date DATETIME NOT NULL,
      end_date DATETIME NOT NULL,
      required_directors INTEGER DEFAULT 1,
      required_staff INTEGER DEFAULT 1,
      status VARCHAR(20) DEFAULT 'SCHEDULED',
      created_by VARCHAR(100) DEFAULT 'Admin',
      created_at DATETIME DEFAULT (datetime('now', '+7 hours'))
    );
  `);

  // Mission Assignments Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS mission_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      personnel_id INTEGER NOT NULL,
      role_type VARCHAR(20) NOT NULL,
      assigned_round INTEGER NOT NULL,
      is_leader BOOLEAN DEFAULT 0,
      assignment_status VARCHAR(20) DEFAULT 'JOINED',
      substituted_for_personnel_id INTEGER,
      notes TEXT,
      assigned_at DATETIME DEFAULT (datetime('now', '+7 hours')),
      FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE,
      FOREIGN KEY(personnel_id) REFERENCES personnel(id) ON DELETE CASCADE
    );
  `);

  // Ensure missing columns exist if table was previously created
  try { await dbRun(`ALTER TABLE missions ADD COLUMN dress_code VARCHAR(150);`); } catch (e) {}
  try { await dbRun(`ALTER TABLE missions ADD COLUMN attachment_file TEXT;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE missions ADD COLUMN attachment_name TEXT;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE missions ADD COLUMN schedule_details TEXT;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE mission_assignments ADD COLUMN substituted_for_personnel_id INTEGER;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE mission_assignments ADD COLUMN notes TEXT;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE mission_assignments ADD COLUMN ack_status VARCHAR(20) DEFAULT 'PENDING_ACK';`); } catch (e) {}
  try { await dbRun(`ALTER TABLE mission_assignments ADD COLUMN ack_at DATETIME;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE mission_assignments ADD COLUMN decline_reason TEXT;`); } catch (e) {}
  try { await dbRun(`ALTER TABLE missions ADD COLUMN mission_code VARCHAR(50);`); } catch (e) {}

  // Notification Logs Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER,
      personnel_id INTEGER,
      channel VARCHAR(20) NOT NULL, -- 'LINE_GROUP' or 'EMAIL'
      recipient VARCHAR(200) NOT NULL,
      subject_title TEXT,
      content_body TEXT,
      status VARCHAR(20) DEFAULT 'SENT',
      sent_at DATETIME DEFAULT (datetime('now', '+7 hours')),
      FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
    );
  `);

  // Queue Swaps Table (Peer Swap Request)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS queue_swaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      role_type VARCHAR(20) NOT NULL,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'APPROVED',
      approved_by VARCHAR(100) DEFAULT 'ADMIN',
      created_at DATETIME DEFAULT (datetime('now', '+7 hours')),
      FOREIGN KEY(requester_id) REFERENCES personnel(id) ON DELETE CASCADE,
      FOREIGN KEY(target_id) REFERENCES personnel(id) ON DELETE CASCADE
    );
  `);

  // Ensure Queue State entries exist

  await dbRun(`INSERT OR IGNORE INTO queue_state (role_type, current_round) VALUES ('DIRECTOR', 1);`);
  await dbRun(`INSERT OR IGNORE INTO queue_state (role_type, current_round) VALUES ('STAFF', 1);`);

  // Ensure default Auth Users exist in personnel table with correct initial passwords
  const authSeedUsers = [
    { emp_code: 'ADMIN', name: 'ผู้ดูแลระบบ (Admin)', role_type: 'ADMIN', department: 'อสป.', position: 'ผู้ดูแลระบบระบบจัดสรรคิว', email: 'admin@fmo.or.th', password: 'Fmo@2026#Adm!' },
    { emp_code: 'EMP-043', name: 'น.ส.พิมพ์ลดา อัศวเศรษฐชัย', role_type: 'ADMIN', department: 'ประชาสัมพันธ์', position: 'นักประชาสัมพันธ์', email: 'pimrada.a@fishmarket.co.th', password: 'Pim@043#Fmo!' },
    { emp_code: 'EMP-062', name: 'น.ส.อมรรัตน์ ขุนทอง', role_type: 'ADMIN', department: 'เทคโนโลยีสารสนเทศ', position: 'นักวิชาการคอมพิวเตอร์', email: 'amornrat.k@fishmarket.co.th', password: 'Amorn@062#Fmo!' },
    { emp_code: 'EMP-102', name: 'นายวาทิต แตงนวลจันทร์', role_type: 'OPERATOR', department: 'ปฏิบัติการ', position: 'เจ้าหน้าที่บันทึกคิว', email: 'watit.t@fishmarket.co.th', password: 'Watit@1234' }
  ];

  for (const u of authSeedUsers) {
    try {
      const existing = await dbGet(`SELECT id, password FROM personnel WHERE UPPER(emp_code) = ? OR UPPER(email) LIKE ?`, [u.emp_code.toUpperCase(), `%${u.emp_code.toLowerCase()}%`]);
      if (existing) {
        if (!existing.password) {
          await dbRun(`UPDATE personnel SET password = ?, role_type = ? WHERE id = ?`, [u.password, u.role_type, existing.id]);
        }
      } else {
        await dbRun(`
          INSERT INTO personnel (emp_code, name, role_type, department, position, email, password)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [u.emp_code, u.name, u.role_type, u.department, u.position, u.email, u.password]);
      }
    } catch (e) {}
  }

  // 🧹 ล้างลิงก์ SharePoint เก่าที่ติดสิทธิ์ล็อกออกจากฐานข้อมูล เพื่อไม่ให้เกิดปัญหาสิทธิ์ล็อกเข้าไม่ได้
  try {
    await dbRun(`
      UPDATE missions 
      SET attachment_file = NULL 
      WHERE attachment_file LIKE '%fmothai-my.sharepoint.com%' 
         OR attachment_file LIKE '%sharepoint.com/:b:/g/%';
    `);
  } catch (cleanErr) {}
}


module.exports = {
  db,
  dbRun,
  dbGet,
  dbAll,
  initSchema
};
