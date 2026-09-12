// Notification Service (LINE Flex Message Card & Email Notification Dispatcher)
require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
const { dbRun } = require('../db/database');

// 💡 ตั้งค่า URL หลักของระบบ ใช้สำหรับใส่ในลิงก์ปุ่มของ Flex Message / Email
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://smart-queue.fishmarket.co.th/app';

const { exec } = require('child_process');

// Email dispatcher disabled by design - relying 100% on LINE OA Flex Cards
async function sendEmailNotification() { return false; }
function sendEmailViaPowerShell() { return Promise.resolve(); }










function formatDate24h(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes} น.`;
}

function formatLeaderTitle(person) {
  if (!person) return '-';
  const name = person.name || person.person_name || '-';
  const pos = String(person.position || person.department || '').trim();
  const empCode = String(person.emp_code || '').trim().toUpperCase();

  const cleanName = name.replace(/\s*\([^)]*\)/g, '').trim();

  let title = '';
  if (empCode === 'DIR-10' || pos.includes('ผออ.') || (pos.includes('ผู้อำนวยการ') && !pos.includes('รอง') && !pos.includes('รผอ.'))) {
    title = 'ผออ.';
  } else if (empCode === 'DIR-09' || pos.includes('รผอ.บร.') || pos.includes('รองผู้อำนวยการ') || pos.includes('รผอ.')) {
    title = 'รผอ.บร.';
  } else if (pos) {
    title = pos;
  } else {
    title = 'ผอ.ฝ่าย';
  }

  return title ? `${cleanName} (${title})` : cleanName;
}


function resolveLeaderPerson(directors = [], assignedList = []) {
  if (Array.isArray(directors) && directors.length > 0) {
    const execLeader = directors.find(p => {
      const code = String(p.emp_code || '').trim().toUpperCase();
      const pos = String(p.position || p.department || '').trim();
      return (
        code === 'DIR-09' ||
        code === 'DIR-10' ||
        pos.includes('ผู้อำนวยการองค์การสะพานปลา') ||
        pos.includes('ผออ.') ||
        pos.includes('รองผู้อำนวยการ') ||
        pos.includes('รผอ.')
      );
    });
    if (execLeader) return execLeader;

    const isLeaderPerson = directors.find(p => Number(p.is_leader) === 1);
    if (isLeaderPerson) return isLeaderPerson;

    return directors[0] || null;
  }

  if (Array.isArray(assignedList) && assignedList.length > 0) {
    const isLeaderPerson = assignedList.find(p => Number(p.is_leader) === 1);
    if (isLeaderPerson) return isLeaderPerson;
  }

  return null;
}

/**
 * Helper to build participants Flex Text list (Directly after 'การแต่งกาย')
 */
function buildParticipantsFlexContents(directors = [], staff = [], assignedList = []) {
  let allList = [];
  if (Array.isArray(assignedList) && assignedList.length > 0) {
    allList = assignedList;
  } else {
    const dirs = Array.isArray(directors) ? directors : [];
    const stff = Array.isArray(staff) ? staff : [];
    allList = [...dirs, ...stff];
  }

  const uniqueMap = new Map();
  for (const p of allList) {
    if (!p) continue;
    const key = p.id || p.personnel_id || p.emp_code || p.name;
    if (key && !uniqueMap.has(key)) {
      uniqueMap.set(key, p);
    }
  }
  const uniquePersons = Array.from(uniqueMap.values());

  if (uniquePersons.length === 0) {
    return [{
      type: 'text',
      text: '-',
      color: '#64748b',
      size: 'xs'
    }];
  }

  return uniquePersons.map(p => {
    const roleUpper = String(p.role_type || '').toUpperCase();
    const isLeader = Number(p.is_leader) === 1 || roleUpper === 'DIRECTOR';
    const cleanName = String(p.name || p.person_name || '').replace(/^คุณ\s+/i, '').replace(/\s*\([^)]*\)/g, '').trim();
    const infoStr = String(p.position || p.department || (isLeader ? 'ผอ.ฝ่าย' : 'พนักงาน')).trim();

    const tObj = {
      type: 'text',
      text: `• ${cleanName}${infoStr ? ' (' + infoStr + ')' : ''}`,
      size: 'xs',
      color: isLeader ? '#0f172a' : '#334155',
      wrap: true
    };
    if (isLeader) {
      tObj.weight = 'bold';
    }
    return tObj;
  });
}

/**
 * Generate LINE Flex Message Card JSON Payload
 */
function createLineFlexCardPayload(mission, directors = [], staff = [], isReallocation = false, assignedList = []) {
  const teamLeader = resolveLeaderPerson(directors, assignedList);
  const teamLeaderName = formatLeaderTitle(teamLeader);

  const headerTitle = isReallocation
  ? '🚨 แจ้งเตือนจัดสรรคิวแทน'
  : '📢 แจ้งคำสั่งจัดสรรคิวกิจกรรม อสป.';
  const headerBgColor = isReallocation ? '#d97706' : '#0284c7';
  const timeStr = `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`;

  const leaderContents = (Array.isArray(directors) && directors.length > 0)
    ? directors.map(d => ({
        type: 'text',
        text: formatLeaderTitle(d),
        color: '#1e293b',
        size: 'xs',
        wrap: true,
        weight: 'bold'
      }))
    : [{
        type: 'text',
        text: teamLeaderName || '-',
        color: '#1e293b',
        size: 'xs',
        wrap: true,
        weight: 'bold'
      }];

  const participantContents = buildParticipantsFlexContents(directors, staff, assignedList);

  const flexCardObj = {
    type: 'flex',
    altText: `${headerTitle}: ${mission.mission_title}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerBgColor,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: '#e0f2fe', size: 'xxs', weight: 'bold' },
          { type: 'text', text: headerTitle, color: '#ffffff', size: 'md', weight: 'bold', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          { type: 'text', text: mission.mission_title, weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '👔 หัวหน้าคณะ:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: leaderContents
                  }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '📍 สถานที่:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: mission.location || 'สะพานปลา อสป.',
                    color: '#1e293b',
                    size: 'xs',
                    flex: 5,
                    wrap: true,
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '⏰ เวลา:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: timeStr,
                    color: headerBgColor,
                    size: 'xs',
                    flex: 5,
                    wrap: true,
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👔 การแต่งกาย:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: mission.dress_code || 'ชุดปฏิบัติงาน อสป.', color: '#a855f7', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👥 ผู้ร่วมกิจกรรม:', color: '#64748b', size: 'xs', flex: 2 },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: participantContents
                  }
                ]
              }
            ]
          },
          {
            type: 'text',
            text: 'หมายเหตุ : หากรับทราบกิจกรรมแล้ว ให้ท่านเข้าร่วมงานตามวัน เวลา และสถานที่ดังกล่าว ตามที่แจ้ง ไม่สามารถส่งผู้แทนได้',
            size: 'xs',
            color: '#dc2626',
            weight: 'bold',
            wrap: true,
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#fef3c7',
            paddingAll: '10px',
            cornerRadius: '8px',
            margin: 'sm',
            contents: [
              { type: 'text', text: '⏱️ ข้อปฏิบัติตน:', size: 'xxs', color: '#d97706', weight: 'bold' },
              { type: 'text', text: 'กรุณาเดินทางมาถึงสถานที่ปฏิบัติงานก่อนเวลาเริ่มอย่างน้อย 30 นาที', size: 'xxs', color: '#b45309', wrap: true, margin: 'xs' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#10b981',
                height: 'sm',
                action: { type: 'uri', label: '\ud83d\udfe2 ดูรายละเอียด', uri: APP_BASE_URL }
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: { type: 'uri', label: '\ud83d\udd14 เปิดเว็บ', uri: APP_BASE_URL }
              }
            ]
          },
          {
            type: 'text',
            text: 'ระบบตอบกลับข้อความอัตโนมัติ',
            size: 'xxs',
            color: '#94a3b8',
            align: 'end',
            margin: 'xs'
          }
        ]
      }
    }
  };

  return JSON.stringify(flexCardObj);
}


function generateGoogleCalendarUrl(mission) {
  if (!mission) return 'https://calendar.google.com';
  
  const titleStr = String(mission.mission_title || 'กิจกรรม อสป.').slice(0, 80);
  const locationStr = String(mission.location || 'สะพานปลา อสป.').slice(0, 80);
  const dressStr = String(mission.dress_code || 'ชุดปฏิบัติงาน อสป.').slice(0, 60);
  const descStr = String(mission.description || '-').slice(0, 120);

  const title = encodeURIComponent(titleStr);
  const location = encodeURIComponent(locationStr);
  const details = encodeURIComponent(`การแต่งกาย: ${dressStr}\nรายละเอียด: ${descStr}`);
  
  const formatDateToGCal = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace(/-|:|\.\d\d\d/g, '');
  };

  const startGCal = formatDateToGCal(mission.start_date);
  const endGCal = formatDateToGCal(mission.end_date) || startGCal;

  if (!startGCal) return 'https://calendar.google.com';

  let url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startGCal}/${endGCal}&details=${details}&location=${location}`;
  
  if (url.length > 950) {
    url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startGCal}/${endGCal}`;
  }
  return url;
}


/**
 * Generate per-person Flex Card with personalized postback buttons
 * missionId and personnelId embedded so LINE webhook can handle ACK directly
 */
function createPersonalizedFlexCard(
  mission,
  person,
  isReallocation = false,
  directors = [],
  staff = [],
  assignedList = []
) {
  const missionId = mission.id;
  const personnelId = person.personnel_id || person.id;

  const headerTitle = isReallocation
    ? '🚨 แจ้งเตือนจัดสรรคิวแทน'
    : '📢 แจ้งคำสั่งจัดสรรคิวกิจกรรม อสป.';

  const headerBgColor = isReallocation
    ? '#d97706'
    : '#0284c7';

  const timeStr =
    `${formatDate24h(mission.start_date)} - ` +
    `${formatDate24h(mission.end_date)}`;

  const leaderContents = (Array.isArray(directors) && directors.length > 0)
    ? directors.map(d => ({
        type: 'text',
        text: formatLeaderTitle(d),
        color: '#1e293b',
        size: 'xs',
        wrap: true,
        weight: 'bold'
      }))
    : [{
        type: 'text',
        text: person.team_leader_name || (typeof directors === 'string' && directors !== '-' ? directors : '-'),
        color: '#1e293b',
        size: 'xs',
        wrap: true,
        weight: 'bold'
      }];

  const participantContents = buildParticipantsFlexContents(directors, staff, assignedList);

  const baseUrl = APP_BASE_URL.replace(/\/app$/, '');
  let fileUrl = null;
  if (mission.attachment_file && !mission.attachment_file.includes('fmothai-my.sharepoint.com') && !mission.attachment_file.includes('sharepoint.com/:b:/g/')) {
    fileUrl = mission.attachment_file.startsWith('http') ? mission.attachment_file : `${baseUrl}${mission.attachment_file}`;
  }
  const fileName = mission.attachment_name || 'ดาวน์โหลดเอกสารกำหนดการ';

  const cleanPersonName = String(person.name || '').replace(/^คุณ\s+/i, '');
  const cleanSubForName = String(person.substitute_for_name || '').replace(/^คุณ\s+/i, '');

  return {
    type: 'flex',

    altText: `${headerTitle}: ${mission.mission_title}`,

    contents: {
      type: 'bubble',
      size: 'mega',

      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerBgColor,
        paddingAll: '16px',

        contents: [
          {
            type: 'text',
            text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue',
            color: '#e0f2fe',
            size: 'xxs',
            weight: 'bold'
          },
          {
            type: 'text',
            text: headerTitle,
            color: '#ffffff',
            size: 'md',
            weight: 'bold',
            margin: 'xs',
            wrap: true
          },

          ...(isReallocation
            ? [
                {
                  type: 'separator',
                  color: '#fbbf24',
                  margin: 'md'
                },
                {
                  type: 'text',
                  text:
                    `👤 ปฏิบัติงานแทน : ` +
                    `${cleanSubForName || '-'}`,
                  color: '#ffffff',
                  size: 'xs',
                  weight: 'bold',
                  wrap: true,
                  margin: 'md'
                }
              ]
            : [])
        ]
      },

      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',

        contents: [
          {
            type: 'text',
            text: mission.mission_title || '-',
            weight: 'bold',
            size: 'md',
            color: '#0f172a',
            wrap: true
          },
          {
            type: 'text',
            text: `👤 เรียน: ${cleanPersonName || '-'}`,
            size: 'sm',
            color: headerBgColor,
            weight: 'bold',
            margin: 'sm',
            wrap: true
          },

          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'xs',

            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',

                contents: [
                  {
                    type: 'text',
                    text: '👔 หัวหน้าคณะ:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: leaderContents
                  }
                ]
              },

              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '📍 สถานที่:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text:
                      mission.location ||
                      'สะพานปลา อสป.',
                    color: '#1e293b',
                    size: 'xs',
                    flex: 5,
                    wrap: true,
                    weight: 'bold'
                  }
                ]
              },

              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '⏰ เวลา:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: timeStr,
                    color: headerBgColor,
                    size: 'xs',
                    flex: 5,
                    wrap: true,
                    weight: 'bold'
                  }
                ]
              },

              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '👔 การแต่งกาย:',
                    color: '#64748b',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text:
                      mission.dress_code ||
                      'ชุดปฏิบัติงาน อสป.',
                    color: '#a855f7',
                    size: 'xs',
                    flex: 5,
                    wrap: true,
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👥 ผู้ร่วมกิจกรรม:', color: '#64748b', size: 'xs', flex: 2 },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: participantContents
                  }
                ]
              }
            ]
          },



          {
            type: 'text',
            text: 'หมายเหตุ : หากรับทราบกิจกรรมแล้ว ให้ท่านเข้าร่วมงานตามวัน เวลา และสถานที่ดังกล่าว ตามที่แจ้ง ไม่สามารถส่งผู้แทนได้',
            size: 'xs',
            color: '#dc2626',
            weight: 'bold',
            wrap: true,
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#fef3c7',
            paddingAll: '10px',
            cornerRadius: '8px',
            margin: 'sm',
            contents: [
              {
                type: 'text',
                text: '⏱️ ข้อปฏิบัติตน:',
                size: 'xxs',
                color: '#d97706',
                weight: 'bold'
              },
              {
                type: 'text',
                text:
                  'กรุณาเดินทางมาถึงสถานที่ปฏิบัติงาน' +
                  'ก่อนเวลาเริ่มอย่างน้อย 30 นาที',
                size: 'xxs',
                color: '#b45309',
                wrap: true,
                margin: 'xs'
              }
            ]
          }
        ]
      },

      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: isReallocation
              ? [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#10b981',
                    height: 'sm',
                    action: {
                      type: 'postback',
                      label: '🟢 กดรับทราบ',
                      data: `ACK|${missionId}|${personnelId}`,
                      displayText: '✅ รับทราบกิจกรรมแล้ว'
                    }
                  }
                ]
              : [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#10b981',
                    height: 'sm',
                    action: {
                      type: 'postback',
                      label: '🟢 กดรับทราบ',
                      data: `ACK|${missionId}|${personnelId}`,
                      displayText: '✅ รับทราบกิจกรรมแล้ว'
                    }
                  },
                  {
                    type: 'button',
                    style: 'secondary',
                    height: 'sm',
                    action: {
                      type: 'postback',
                      label: '🔴 ติดภารกิจ',
                      data: `BUSY|${missionId}|${personnelId}`,
                      displayText: '🔴 กรุณาเลือกเหตุผลของท่าน'
                    }
                  }
                ]
          },
          {
            type: 'text',
            text: 'ระบบตอบกลับข้อความอัตโนมัติ',
            size: 'xxs',
            color: '#94a3b8',
            align: 'end',
            margin: 'xs'
          }
        ]
      }
    }
  };
}



async function sendMissionNotification(mission, assignedList, isReallocation = false) {
  try {
    const directors = assignedList.filter(
      a =>
        String(a.role_type || '').trim().toUpperCase() === 'DIRECTOR' ||
        Number(a.is_leader) === 1
    );

    const staff = assignedList.filter(
      a =>
        String(a.role_type || '').trim().toUpperCase() === 'STAFF' &&
        Number(a.is_leader) !== 1
    );

    let allDirectors = [];
    if (mission?.id) {
      try {
        const { dbAll } = require('../db/database');
        allDirectors = await dbAll(`
          SELECT p.id, p.name, p.position, p.department, p.emp_code, ma.is_leader, ma.role_type
          FROM mission_assignments ma
          JOIN personnel p ON p.id = ma.personnel_id
          WHERE ma.mission_id = ? AND (ma.is_leader = 1 OR UPPER(ma.role_type) = 'DIRECTOR')
          ORDER BY 
            CASE WHEN UPPER(TRIM(p.emp_code)) = 'DIR-10' THEN 1
                 WHEN UPPER(TRIM(p.emp_code)) = 'DIR-09' THEN 2
                 ELSE 3 END, p.id ASC;
        `, [mission.id]);
      } catch (e) {
        console.error('Error fetching directors from DB:', e);
      }
    }

    if (!allDirectors || allDirectors.length === 0) {
      allDirectors = directors;
    }

    const timeStr = `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`;
    const lineHeader = isReallocation ? '🚨 [แจ้งเตือนจัดสรรแทนด่วน]' : '📢 [คำสั่งจัดสรรกิจกรรม อสป.]';

    // 1. GENERATE BEAUTIFUL LINE FLEX CARD JSON
    
    const flexCardJson = createLineFlexCardPayload(
      mission,
      allDirectors,
      staff,
      isReallocation,
      assignedList
    );


    // 💡 ส่งจริงเข้ากลุ่ม LINE ถ้ามีการตั้งค่า LINE_GROUP_ID + LINE_CHANNEL_ACCESS_TOKEN ไว้ใน .env
    // (เดิมโค้ดส่วนนี้แค่บันทึกลง log แต่ไม่เคยส่งเข้ากลุ่มจริงเลย เพราะไม่มี groupId ให้ยิงไป)
    const groupToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const lineGroupId = process.env.LINE_GROUP_ID;
    let groupSendStatus = 'SENT'; // สถานะที่จะบันทึกลง notification_logs

    if (lineGroupId && groupToken) {
      try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: lineGroupId,
          messages: [JSON.parse(flexCardJson)]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groupToken}`
          }
        });
        console.log('✅ ส่ง LINE เข้ากลุ่มสำเร็จ');
      } catch (groupError) {
        console.error('❌ ส่ง LINE เข้ากลุ่มไม่สำเร็จ:', groupError.response?.data || groupError.message);
        groupSendStatus = 'FAILED';
      }
    } else {
      console.warn('⚠️ ไม่ได้ตั้งค่า LINE_GROUP_ID ใน .env ระบบจะบันทึก log ไว้เฉยๆ แต่ไม่ได้ส่งเข้ากลุ่ม LINE จริง');
    }

    // Log LINE Group Dispatch with full Flex Message Card JSON
    await dbRun(`
      INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
      VALUES (?, NULL, 'LINE_GROUP', 'กลุ่มไลน์แจ้งเตือนภารกิจ อสป. (FMO Line Flex Card Group)', ?, ?, ?)
    `, [mission.id, `${lineHeader} ${mission.mission_title}`, flexCardJson, groupSendStatus]);

    // 2. DISPATCH LINE PUSH FLEX CARDS TO ASSIGNED PERSONNEL (ส่ง LINE เป็นอันดับแรกสุดเสมอ!)
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    if (!lineToken) {
      console.warn('⚠️ ไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน .env ระบบจะไม่ส่ง LINE push message ให้ใครเลย');
    }

    for (const person of assignedList) {
      if (!lineToken) continue;

      const targetLineId = String(person.line_user_id || '').trim();
      if (!targetLineId || !targetLineId.startsWith('U')) {
        console.log(`ℹ️ ${person.name} (${person.emp_code || '-'}) ยังไม่ได้ผูก LINE User ID จึงข้ามการส่ง Push ส่วนตัวให้คนนี้`);
        continue;
      }

      // ดึงชื่อคนที่ถูกแทนถ้าไม่มี substitute_for_name
      let substituteForName = person.substitute_for_name || null;
      if (!substituteForName && isReallocation && mission?.id && (person.personnel_id || person.id)) {
        try {
          const { dbGet } = require('../db/database');
          const subRecord = await dbGet(`
            SELECT orig_p.name AS orig_name
            FROM mission_assignments ma
            JOIN personnel orig_p ON orig_p.id = ma.substituted_for_personnel_id
            WHERE ma.mission_id = ? AND ma.personnel_id = ? AND ma.substituted_for_personnel_id IS NOT NULL;
          `, [mission.id, person.personnel_id || person.id]);

          if (subRecord && subRecord.orig_name) {
            substituteForName = subRecord.orig_name;
          }
        } catch (e) {
          console.error('Error fetching substitute_for_name:', e);
        }
      }

      const personWithSubName = {
        ...person,
        substitute_for_name: substituteForName || person.substitute_for_name || '-'
      };

      // สร้าง Flex Card เฉพาะบุคคล พร้อมปุ่ม postback (ACK|missionId|personnelId)
      const personalCard = createPersonalizedFlexCard(
        mission,
        personWithSubName,
        isReallocation,
        allDirectors,
        staff,
        assignedList
      );

      try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: person.line_user_id,
          messages: [personalCard]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${lineToken}`
          }
        });
        console.log(`✅ ส่ง LINE Flex Card ให้ ${person.name} สำเร็จ (isReallocation = ${isReallocation})`);

        await dbRun(`
          INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
          VALUES (?, ?, 'LINE', ?, ?, ?, 'SENT')
        `, [mission.id, person.personnel_id || person.id, person.name, `${lineHeader} ${mission.mission_title}`, JSON.stringify(personalCard)]);
      } catch (lineError) {
        console.error(`❌ ส่ง LINE ให้ ${person.name} ไม่สำเร็จ:`, lineError.response?.data || lineError.message);
        await dbRun(`
          INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
          VALUES (?, ?, 'LINE', ?, ?, ?, 'FAILED')
        `, [mission.id, person.personnel_id || person.id, person.name, `${lineHeader} ${mission.mission_title}`, lineError.message]);
      }
    }


    return true;



  } catch (err) {
    console.error('Notification dispatch error:', err);
    return false;
  }
}

/**
 * Send Upcoming Queue Notice to Top Candidates in WAITING queue via mapped channel (LINE or Email)
 */
async function sendUpcomingQueueNotice() {
  try {
    const { dbAll } = require('../db/database');
    
    const topDirectors = await dbAll(`
      SELECT p.*, q.current_round, q.queue_order, q.status AS queue_status
      FROM queue_state q
      JOIN personnel p ON p.id = q.personnel_id
      WHERE p.role_type = 'DIRECTOR' AND q.status = 'WAITING'
      ORDER BY q.queue_order ASC
      LIMIT 3
    `);

    const topStaff = await dbAll(`
      SELECT p.*, q.current_round, q.queue_order, q.status AS queue_status
      FROM queue_state q
      JOIN personnel p ON p.id = q.personnel_id
      WHERE p.role_type = 'STAFF' AND q.status = 'WAITING'
      ORDER BY q.queue_order ASC
      LIMIT 5
    `);

    const candidates = [...topDirectors, ...topStaff];
    if (candidates.length === 0) {
      return { success: true, count: 0, message: 'ไม่พบบุคลากรที่รอคิวในระบบ' };
    }

    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    let sentCount = 0;

    for (const person of candidates) {
      const lineId = String(person.line_user_id || '').trim();
      const roleLabel = person.role_type === 'DIRECTOR' ? 'ผอ.ฝ่าย' : 'พนักงาน';
      const orderText = `ลำดับที่ #${person.queue_order} (${roleLabel})`;

      if (lineToken && lineId && lineId.toLowerCase() !== 'email') {
        const upcomingFlexPayload = {
          type: 'flex',
          altText: `📢 แจ้งเตือนเตรียมพร้อมลำดับคิว อสป.:  อยู่อันดับ ${orderText}`,
          contents: {
            type: 'bubble',
            header: {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#0284c7',
              paddingAll: '16px',
              contents: [
                { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: '#e0f2fe', size: 'xxs', weight: 'bold' },
                { type: 'text', text: '📢 แจ้งเตือนเตรียมพร้อมลำดับคิว (อสป.)', color: '#ffffff', size: 'sm', weight: 'bold', margin: 'xs', wrap: true }
              ]
            },
            body: {
              type: 'box',
              layout: 'vertical',
              paddingAll: '16px',
              spacing: 'md',
              contents: [
                { type: 'text', text: `👤 เรียน: ${person.name}`, weight: 'bold', size: 'sm', color: '#0f172a', wrap: true },
                {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#f0f9ff',
                  paddingAll: '12px',
                  cornerRadius: '10px',
                  contents: [
                    { type: 'text', text: `📊 ตำแหน่งคิวปัจจุบัน: ${orderText}`, size: 'xs', color: '#0284c7', weight: 'bold' },
                    { type: 'text', text: `🔄 รอบปฏิบัติงาน: รอบที่ ${person.current_round || 1}`, size: 'xs', color: '#64748b', margin: 'xs' },
                    { type: 'text', text: '💡 ท่านกำลังจะถึงคิวได้รับการจัดสรรในกิจกรรมถัดไป', size: 'xs', color: '#0f172a', margin: 'sm', wrap: true }
                  ]
                },
                { type: 'text', text: 'หากท่านติดภารกิจล่วงหน้า สามารถเตรียมการหาคนแทนหรือยื่นแจ้งลาล่วงหน้าได้ค่ะ', size: 'xs', color: '#475569', wrap: true }
              ]
            }
          }
        };

        try {
          await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineId,
            messages: [upcomingFlexPayload]
          }, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken}` }
          });

          await dbRun(`
            INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
            VALUES (NULL, ?, 'LINE', ?, '📢 แจ้งเตือนเตรียมพร้อมลำดับคิว', 'ส่งการ์ดแจ้งเตือนคิวถัดไปทาง LINE สำเร็จ', 'SENT')
          `, [person.id, lineId]);

          sentCount++;
        } catch (lineErr) {
          console.error(`Error pushing upcoming queue LINE to ${person.name}:`, lineErr.message);
        }
      } else {
        const targetEmail = person.email || `${String(person.emp_code).toLowerCase()}@fishmarket.co.th`;
        const emailSubject = `📢 แจ้งเตือนเตรียมพร้อมลำดับคิว อสป. ( อยู่ในลำดับคิวถัดไป)`;
        const emailBody = `
          <div style="font-family: Sarabun, sans-serif; padding: 20px; border: 1px solid #0284c7; border-radius: 10px; max-width: 600px;">
            <h2 style="color: #0284c7;">📢 แจ้งเตือนเตรียมความพร้อมลำดับคิว (อสป.)</h2>
            <p>เรียน <strong>${person.name}</strong> (${person.position || 'พนักงาน อสป.'}),</p>
            <div style="background: #f0f9ff; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #bae6fd;">
              <p style="margin: 4px 0; color: #0284c7;"><strong>📊 ตำแหน่งคิวปัจจุบัน:</strong> ${orderText}</p>
              <p style="margin: 4px 0; color: #64748b;"><strong>🔄 รอบปฏิบัติงาน:</strong> รอบที่ ${person.current_round || 1}</p>
              <p style="margin: 4px 0; color: #0f172a;"><strong>💡 ท่านกำลังจะถึงคิวได้รับการจัดสรรในกิจกรรมถัดไป</strong></p>
            </div>
            <p style="color: #475569;">หากท่านติดภารกิจล่วงหน้า สามารถเตรียมการหาคนแทนหรือยื่นแจ้งลาล่วงหน้าได้ค่ะ</p>
          </div>
        `;

        await dbRun(`
          INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
          VALUES (NULL, ?, 'EMAIL', ?, ?, ?, 'SENT')
        `, [person.id, targetEmail, emailSubject, emailBody]);

        sentCount++;
      }
    }

    return { success: true, count: sentCount, message: `ส่งแจ้งเตือนเตรียมพร้อมคิวถัดไปสำเร็จ ${sentCount} ท่าน` };
  } catch (err) {
    console.error('Error sending upcoming queue notice:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Dispatch Pre-Event Reminders Automatically via mapped channel (LINE/Email)
 * Conditions requested by User:
 * 1. ก่อนกิจกรรม 1 วัน : '🔔 เตือนความจำล่วงหน้า (1 วัน)'
 * 2. ก่อนเริ่มกิจกรรม 30 นาที อีกครั้ง: '🚨 เตือนความจำใกล้ถึงเวลา (อีก 30 นาที)'
 */
async function dispatchPreEventReminders() {
  try {
    const { dbAll, dbRun } = require('../db/database');

    // 💡 ป้องกันส่งซ้ำ และป้องกันยิงกิจกรรมที่เริ่มไปแล้ว:
    // ดึงกิจกรรมที่กำลังจะจัดขึ้นในอนาคต (ระหว่างเวลาปัจจุบัน จนถึงอีก 30 ชั่วโมงข้างหน้า)
    const upcomingMissions = await dbAll(`
      SELECT m.*
      FROM missions m
      WHERE m.start_date > datetime('now', '+7 hours')
        AND m.start_date <= datetime('now', '+7 hours', '+30 hours')
        AND m.created_at <= datetime('now', '+7 hours', '-3 minutes')
        AND m.status IN ('SCHEDULED', 'SUCCESS')
        AND EXISTS (
          SELECT 1 FROM notification_logs nl 
          WHERE nl.mission_id = m.id 
            AND (nl.subject_title LIKE '%คำสั่งจัดสรร%' OR nl.subject_title LIKE '%แจ้งเตือนจัดสรร%')
        )
    `);

    if (upcomingMissions.length === 0) {
      return { success: true, count: 0, message: 'ไม่พบกิจกรรมที่จะจัดขึ้นในอีก 30 ชั่วโมงข้างหน้า' };
    }

    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    let totalReminded = 0;

    for (const mission of upcomingMissions) {
      const assigned = await dbAll(`
        SELECT ma.*, p.name, p.emp_code, p.position, p.email, p.line_user_id
        FROM mission_assignments ma
        JOIN personnel p ON ma.personnel_id = p.id
        WHERE ma.mission_id = ?
          AND ma.assignment_status IN ('JOINED', 'SUBSTITUTED')
      `, [mission.id]);

      const timeStr = `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`;

      // คำนวณส่วนต่างเวลาระหว่างปัจจุบันกับเวลาเริ่มงานเป็นนาที (Thailand Local Time)
      const nowMs = new Date().getTime();
      let startMs = new Date(mission.start_date).getTime();
      if (typeof mission.start_date === 'string' && !mission.start_date.includes('Z') && !mission.start_date.includes('+')) {
        startMs = new Date(mission.start_date.replace(' ', 'T') + '+07:00').getTime();
      }

      const diffMinutes = (startMs - nowMs) / (1000 * 60);

      // กิจกรรมที่จบ/เริ่มไปแล้ว ไม่ส่งเตือนย้อนหลัง
      if (diffMinutes < 0) continue;

      let reminderTag = null;
      let isUrgent30m = false;
      let headerBgColor = '#eab308';
      let headerSubColor = '#fefce8';
      let textHighlightColor = '#ca8a04';
      let footerNoticeText = '⏱️ กรุณามาถึงสถานที่ปฏิบัติงานก่อนเวลาเริ่มอย่างน้อย 30 นาที';

      if (diffMinutes >= 0 && diffMinutes <= 45) {
        // เงื่อนไขที่ 2: เตือนล่วงหน้า 30 นาที
        isUrgent30m = true;
        reminderTag = '🚨 เตือนความจำใกล้ถึงเวลา (อีก 30 นาที)';
        headerBgColor = '#d97706';
        headerSubColor = '#fef3c7';
        textHighlightColor = '#b45309';
        footerNoticeText = '🚨 อีกประมาณ 30 นาทีจะถึงเวลาเริ่มปฏิบัติงาน! กรุณาเตรียมพร้อมและเดินทางถึงสถานที่ปฏิบัติงานทันทีค่ะ';
      } else if (diffMinutes >= 12 * 60 && diffMinutes <= 28 * 60) {
        // เงื่อนไขที่ 1: เตือนล่วงหน้า 1 วัน
        reminderTag = '🔔 เตือนความจำล่วงหน้า (1 วัน)';
        headerBgColor = '#eab308';
        headerSubColor = '#fefce8';
        textHighlightColor = '#ca8a04';
        footerNoticeText = '⏱️ กรุณามาถึงสถานที่ปฏิบัติงานก่อนเวลาเริ่มอย่างน้อย 30 นาที';
      }

      // หากไม่อยู่ในเงื่อนไขการเตือน 1 วัน หรือ 30 นาที ให้ข้ามไป
      if (!reminderTag) continue;

      for (const person of assigned) {
        const alreadySent = await dbAll(`
          SELECT id FROM notification_logs
          WHERE mission_id = ? AND personnel_id = ? AND subject_title LIKE ?
        `, [mission.id, person.id, `%${reminderTag}%`]);

        if (alreadySent.length > 0) continue;

        const lineId = String(person.line_user_id || '').trim();

        if (lineToken && lineId && lineId.toLowerCase() !== 'email') {
          const reminderCard = {
            type: 'flex',
            altText: `${reminderTag}: ${mission.mission_title}`,
            contents: {
              type: 'bubble',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: headerBgColor,
                paddingAll: '16px',
                contents: [
                  { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: headerSubColor, size: 'xxs', weight: 'bold' },
                  { type: 'text', text: `${reminderTag}`, color: '#ffffff', size: 'md', weight: 'bold', margin: 'xs', wrap: true }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                paddingAll: '16px',
                spacing: 'md',
                contents: [
                  { type: 'text', text: mission.mission_title, weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
                  { type: 'text', text: `👤 เรียน: ${person.name}`, size: 'sm', color: textHighlightColor, weight: 'bold', wrap: true },
                  {
                    type: 'box',
                    layout: 'vertical',
                    margin: 'sm',
                    spacing: 'xs',
                    contents: [
                      {
                        type: 'box',
                        layout: 'horizontal',
                        spacing: 'sm',
                        contents: [
                          { type: 'text', text: '📍 สถานที่:', color: '#64748b', size: 'xs', flex: 2 },
                          { type: 'text', text: mission.location || 'สะพานปลา อสป.', color: '#1e293b', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                        ]
                      },
                      {
                        type: 'box',
                        layout: 'horizontal',
                        spacing: 'sm',
                        contents: [
                          { type: 'text', text: '⏰ เวลา:', color: '#64748b', size: 'xs', flex: 2 },
                          { type: 'text', text: timeStr, color: textHighlightColor, size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                        ]
                      },
                      {
                        type: 'box',
                        layout: 'horizontal',
                        spacing: 'sm',
                        contents: [
                          { type: 'text', text: '👔 การแต่งกาย:', color: '#64748b', size: 'xs', flex: 2 },
                          { type: 'text', text: mission.dress_code || 'ชุดปฏิบัติงาน อสป.', color: '#8b5cf6', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                        ]
                      },
                      {
                        type: 'box',
                        layout: 'horizontal',
                        spacing: 'sm',
                        contents: [
                          { type: 'text', text: '👥 ผู้ร่วมกิจกรรม:', color: '#64748b', size: 'xs', flex: 2 },
                          {
                            type: 'box',
                            layout: 'vertical',
                            flex: 5,
                            spacing: 'xs',
                            contents: buildParticipantsFlexContents([], [], assigned)
                          }
                        ]
                      }
                    ]
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: isUrgent30m ? '#fff7ed' : '#fefce8',
                    borderColor: isUrgent30m ? '#ffedd5' : '#fef08a',
                    borderWidth: '1px',
                    paddingAll: '10px',
                    cornerRadius: '8px',
                    margin: 'md',
                    contents: [
                      { type: 'text', text: footerNoticeText, size: 'xxs', color: isUrgent30m ? '#9a3412' : '#854d0e', wrap: true }
                    ]
                  }
                ]
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                paddingAll: '12px',
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
          };

          try {
            await axios.post('https://api.line.me/v2/bot/message/push', {
              to: lineId,
              messages: [reminderCard]
            }, {
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken}` }
            });

            await dbRun(`
              INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
              VALUES (?, ?, 'LINE', ?, ?, 'ส่งระบบแจ้งเตือนอัตโนมัติล่วงหน้าสำเร็จ', 'SENT')
            `, [mission.id, person.id, lineId, reminderTag]);

            totalReminded++;
          } catch (err) {
            console.error(`Error sending LINE reminder to ${person.name}:`, err.message);
          }
        } else {
          const targetEmail = person.email || `${String(person.emp_code).toLowerCase()}@fishmarket.co.th`;
          const emailSubject = `${reminderTag}: ${mission.mission_title}`;
          const emailBody = `
            <div style="font-family: Sarabun, sans-serif; padding: 20px; border: 1px solid ${isUrgent30m ? '#d97706' : '#eab308'}; border-radius: 10px; max-width: 600px;">
              <h2 style="color: ${isUrgent30m ? '#d97706' : '#eab308'};">${reminderTag}</h2>
              <p>เรียน <strong>${person.name}</strong>,</p>
              <p>ระบบอัตโนมัติขอแจ้งเตือนความจำปฏิบัติหน้าที่ในกิจกรรม <strong>${mission.mission_title}</strong></p>
              <div style="background: ${isUrgent30m ? '#fff7ed' : '#fffbeb'}; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid ${isUrgent30m ? '#ffedd5' : '#fde68a'};">
                <p style="margin: 4px 0;"><strong>📍 สถานที่:</strong> ${mission.location || '-'}</p>
                <p style="margin: 4px 0;"><strong>⏰ เวลา :</strong> ${timeStr}</p>
                <p style="margin: 4px 0;"><strong>👔 การแต่งกาย:</strong> ${mission.dress_code || 'ชุดปฏิบัติงาน อสป.'}</p>
              </div>
              <p style="color: ${isUrgent30m ? '#9a3412' : '#b45309'}; font-weight: bold;">
                ${footerNoticeText}
              </p>
            </div>
          `;

          await dbRun(`
            INSERT INTO notification_logs (mission_id, personnel_id, channel, recipient, subject_title, content_body, status)
            VALUES (?, ?, 'EMAIL', ?, ?, ?, 'SENT')
          `, [mission.id, person.id, targetEmail, emailSubject, emailBody]);

          totalReminded++;
        }
      }
    }

    return { success: true, count: totalReminded, message: `ส่งเตือนความจำล่วงหน้าอัตโนมัติสำเร็จ ${totalReminded} รายการ` };
  } catch (err) {
    console.error('Error dispatching pre-event reminders:', err);
    return { success: false, error: err.message };
  }
}

/**
 * สร้าง LINE Flex Card สีม่วง ขอคำยินยอมสลับลำดับคิวถาวร (Peer Swap Consent Card)
 */
function createPeerSwapConsentFlexCard(swapId, requester, target, reason) {
  return {
    type: 'flex',
    altText: `🔄 คำขอสลับลำดับคิวถาวรจาก ${requester.name}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#a855f7',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue',
            color: '#f3e8ff',
            size: 'xxs',
            weight: 'bold'
          },
          {
            type: 'text',
            text: '🔄 คำขอสลับลำดับคิวถาวร (Peer Swap)',
            color: '#ffffff',
            size: 'md',
            weight: 'bold',
            margin: 'xs',
            wrap: true
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `👤 ผู้ขอสลับคิว: ${requester.name} (${requester.emp_code})`,
            weight: 'bold',
            size: 'sm',
            color: '#0f172a',
            wrap: true
          },
          {
            type: 'text',
            text: `📊 ลำดับคิวปัจจุบันของผู้ขอ: คิวที่ #${requester.queue_order}`,
            size: 'xs',
            color: '#0284c7',
            weight: 'bold'
          },
          {
            type: 'separator',
            color: '#e2e8f0',
            margin: 'md'
          },
          {
            type: 'text',
            text: `🔁 มีความประสงค์ขอสลับคิวกับ: ${target.name} (คิวที่ #${target.queue_order})`,
            size: 'xs',
            color: '#a855f7',
            weight: 'bold',
            wrap: true
          },
          {
            type: 'text',
            text: `📝 เหตุผลที่ระบุ: ${reason || 'ขอสลับคิวตามข้อตกลงร่วมกัน'}`,
            size: 'xs',
            color: '#475569',
            wrap: true
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#f3e8ff',
            paddingAll: '10px',
            cornerRadius: '8px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '📌 หมายเหตุการสลับคิว:',
                size: 'xxs',
                color: '#7e22ce',
                weight: 'bold'
              },
              {
                type: 'text',
                text: `หากกดยินยอม ลำดับคิวของคุณ (${target.name}) จะเปลี่ยนเป็น #${requester.queue_order} และลำดับคิวของคุณ (${requester.name}) จะเปลี่ยนเป็น #${target.queue_order} ในรอบปัจจุบัน`,
                size: 'xxs',
                color: '#6b21a8',
                wrap: true,
                margin: 'xs'
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#10b981',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: '🟢 ยินยอมสลับคิว',
                  data: `SWAP_ACCEPT|${swapId}|${requester.id}|${target.id}`,
                  displayText: '✅ ยินยอมสลับลำดับคิว'
                }
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: '🔴 ปฏิเสธการสลับ',
                  data: `SWAP_REJECT|${swapId}|${requester.id}|${target.id}`,
                  displayText: '❌ ไม่สะดวกสลับคิว'
                }
              }
            ]
          },
          {
            type: 'text',
            text: 'ระบบตอบกลับข้อความอัตโนมัติ',
            size: 'xxs',
            color: '#94a3b8',
            align: 'end',
            margin: 'xs'
          }
        ]
      }
    }
  };
}

function createScheduleChangeFlexCardPayload(mission, person = null, directors = [], staff = [], assignedList = []) {
  const timeStr = `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`;
  const cleanName = person?.name ? String(person.name).replace(/^คุณ\s+/i, '') : null;
  const participantContents = buildParticipantsFlexContents(directors, staff, assignedList);

  return {
    type: 'flex',
    altText: `📢 [แจ้งกำหนดการ/เปลี่ยนแปลง] ${mission.mission_title}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#ea580c',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: '#ffedd5', size: 'xxs', weight: 'bold' },
          { type: 'text', text: '📢 แจ้งกำหนดการกิจกรรม / เปลี่ยนแปลง', color: '#ffffff', size: 'md', weight: 'bold', margin: 'xs', wrap: true }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          { type: 'text', text: mission.mission_title, weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
          ...(cleanName ? [{
            type: 'text',
            text: `👤 เรียน: ${cleanName}`,
            size: 'sm',
            color: '#ea580c',
            weight: 'bold',
            margin: 'sm',
            wrap: true
          }] : []),
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '📅 เวลาใหม่:', color: '#ea580c', size: 'xs', flex: 2, weight: 'bold' },
                  { type: 'text', text: timeStr, color: '#0f172a', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '📍 สถานที่:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: mission.location || 'สะพานปลา อสป.', color: '#1e293b', size: 'xs', flex: 5, wrap: true }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👔 การแต่งกาย:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: mission.dress_code || 'ชุดปฏิบัติงาน อสป.', color: '#a855f7', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👥 ผู้ร่วมกิจกรรม:', color: '#64748b', size: 'xs', flex: 2 },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: participantContents
                  }
                ]
              }
            ]
          },
          mission.schedule_details ? {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#fff7ed',
            borderColor: '#ffedd5',
            borderWidth: '1px',
            paddingAll: '10px',
            cornerRadius: '8px',
            margin: 'md',
            contents: [
              { type: 'text', text: '📝 รายละเอียดกำหนดการใหม่:', size: 'xxs', color: '#c2410c', weight: 'bold' },
              { type: 'text', text: mission.schedule_details, size: 'xs', color: '#431407', wrap: true, margin: 'xs' }
            ]
          } : { type: 'spacer', size: 'xs' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#ea580c',
            height: 'sm',
            action: {
              type: 'postback',
              label: '📄 รายละเอียดกำหนดการใหม่',
              data: `SCHED_DETAIL|${mission.id}`,
              displayText: '📋 ขอรับรายละเอียดกำหนดการใหม่'
            }
          },
          {
            type: 'text',
            text: 'ระบบตอบกลับข้อความอัตโนมัติ',
            size: 'xxs',
            color: '#94a3b8',
            align: 'end',
            margin: 'xs'
          }
        ]
      }
    }
  };
}

async function sendScheduleChangeNotification(mission, assignedList) {
  if (!mission || !Array.isArray(assignedList) || assignedList.length === 0) {
    console.log('ℹ️ ไม่มีผู้ได้รับจัดสรรให้ส่งแจ้งเตือนเปลี่ยนแปลงกำหนดการ');
    return false;
  }

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!lineToken) {
    console.error('❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN');
    return false;
  }

  for (const person of assignedList) {
    if (person.line_user_id) {
      const personalCard = createScheduleChangeFlexCardPayload(mission, person, [], [], assignedList);
      try {
        await axios.post(
          'https://api.line.me/v2/bot/message/push',
          {
            to: person.line_user_id,
            messages: [personalCard]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${lineToken}`
            }
          }
        );
        console.log(`✅ ส่งแจ้งเตือนอัปเดตกำหนดการให้ ${person.name} (${person.emp_code}) สำเร็จ`);
      } catch (err) {
        console.error(`❌ ส่งแจ้งเตือนอัปเดตกำหนดการให้ ${person.name} ล้มเหลว:`, err.response?.data || err.message);
      }
    }
  }

  const lineGroupId = process.env.LINE_GROUP_ID;
  if (lineGroupId) {
    const groupCard = createScheduleChangeFlexCardPayload(mission, null, [], [], assignedList);
    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        {
          to: lineGroupId,
          messages: [groupCard]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${lineToken}`
          }
        }
      );
      console.log('✅ ส่งแจ้งเตือนอัปเดตกำหนดการเข้า LINE Group สำเร็จ');
    } catch (err) {
      console.error('❌ ส่งแจ้งเตือนเข้า LINE Group ล้มเหลว:', err.response?.data || err.message);
    }
  }

  return true;
}

function createCancellationFlexCardPayload(mission, cancelReason = '', directors = [], staff = [], assignedList = []) {
  const reasonText = (cancelReason || mission.cancel_reason || 'ผู้ดูแลระบบยกเลิกกิจกรรม').trim();
  const timeStr = `${formatDate24h(mission.start_date)} - ${formatDate24h(mission.end_date)}`;
  const participantContents = buildParticipantsFlexContents(directors, staff, assignedList);

  return {
    type: 'flex',
    altText: `🚫 ประกาศยกเลิกกิจกรรม: ${mission.mission_title}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#dc2626',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: '#fee2e2', size: 'xxs', weight: 'bold' },
          { type: 'text', text: '🚫 ประกาศยกเลิกกิจกรรม/จัดสรรคิว', color: '#ffffff', size: 'md', weight: 'bold', margin: 'xs', wrap: true }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          { type: 'text', text: mission.mission_title || '-', weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
          { type: 'text', text: `รหัสกิจกรรม: ${mission.mission_code || 'ACT-' + mission.id}`, size: 'xs', color: '#64748b', weight: 'bold' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '📍 สถานที่เดิม:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: mission.location || 'สะพานปลา อสป.', color: '#1e293b', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '⏰ กำหนดการเดิม:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: timeStr, color: '#dc2626', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👔 การแต่งกาย:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: mission.dress_code || 'ชุดปฏิบัติงาน อสป.', color: '#a855f7', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👥 ผู้ร่วมกิจกรรม:', color: '#64748b', size: 'xs', flex: 2 },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 5,
                    spacing: 'xs',
                    contents: participantContents
                  }
                ]
              }
            ]
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#fef2f2',
            borderColor: '#fca5a5',
            borderWidth: '1px',
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              { type: 'text', text: '⚠️ เหตุผลในการยกเลิก:', size: 'xs', color: '#991b1b', weight: 'bold' },
              { type: 'text', text: reasonText, size: 'xs', color: '#7f1d1d', wrap: true, margin: 'xs' }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#f0fdf4',
            borderColor: '#bbf7d0',
            borderWidth: '1px',
            cornerRadius: '8px',
            paddingAll: '10px',
            margin: 'sm',
            contents: [
              { type: 'text', text: '✅ สถานะระบบคิว:', size: 'xs', color: '#166534', weight: 'bold' },
              { type: 'text', text: 'ระบบได้ทำการคืนสิทธิ์คิวรอ (WAITING) ให้ท่านในรอบปัจจุบันเรียบร้อยแล้ว', size: 'xxs', color: '#15803d', wrap: true, margin: 'xs' },
              { type: 'text', text: 'รอการจัดสรรคิวในรอบถัดไป', size: 'xxs', color: '#15803d', wrap: true, margin: 'xs' },
              { type: 'text', text: 'ขออภัยในความไม่สะดวก', size: 'xxs', color: '#dc2626', weight: 'bold', wrap: true, margin: 'xs' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: 'ระบบตอบกลับข้อความอัตโนมัติ • FMO Smart Queue System',
            size: 'xxs',
            color: '#94a3b8',
            align: 'end',
            margin: 'xs'
          }
        ]
      }
    }
  };
}

async function sendCancellationNotification(mission, assignedList = [], cancelReason = '') {
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!lineToken) {
    console.warn('⚠️ ไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน .env');
    return false;
  }

  const cancelCard = createCancellationFlexCardPayload(mission, cancelReason, [], [], assignedList);

  for (const person of assignedList) {
    if (person.line_user_id) {
      try {
        await axios.post(
          'https://api.line.me/v2/bot/message/push',
          {
            to: person.line_user_id,
            messages: [cancelCard]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${lineToken}`
            }
          }
        );
        console.log(`✅ ส่งการ์ดแจ้งยกเลิกกิจกรรมทาง LINE ให้ ${person.name} (${person.emp_code}) สำเร็จ`);
      } catch (err) {
        console.error(`❌ ส่งการ์ดแจ้งยกเลิกทาง LINE ให้ ${person.name} ล้มเหลว:`, err.response?.data || err.message);
      }
    }
  }

  const lineGroupId = process.env.LINE_GROUP_ID;
  if (lineGroupId) {
    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        {
          to: lineGroupId,
          messages: [cancelCard]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${lineToken}`
          }
        }
      );
      console.log('✅ ส่งการ์ดแจ้งยกเลิกกิจกรรมเข้า LINE Group สำเร็จ');
    } catch (err) {
      console.error('❌ ส่งการ์ดแจ้งยกเลิกเข้า LINE Group ล้มเหลว:', err.response?.data || err.message);
    }
  }

  return true;
}

module.exports = {
  sendMissionNotification,
  sendUpcomingQueueNotice,
  dispatchPreEventReminders,
  sendScheduleChangeNotification,
  sendCancellationNotification,
  formatDate24h,
  createLineFlexCardPayload,
  createPersonalizedFlexCard,
  createPeerSwapConsentFlexCard,
  createScheduleChangeFlexCardPayload,
  createCancellationFlexCardPayload
};




