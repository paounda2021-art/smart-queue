require('dotenv').config();
const axios = require('axios');
const {
  createPersonalizedFlexCard,
  createScheduleChangeFlexCardPayload,
  createCancellationFlexCardPayload,
  createPeerSwapConsentFlexCard,
  formatDate24h
} = require('./services/notification');

async function testSendAllColorCards() {
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetUserId = 'U3a7529a26c7c9a1a06d4cd374349a33c';

  console.log(`Checking LINE_CHANNEL_ACCESS_TOKEN: ${lineToken ? 'Configured ✅' : 'NOT Configured ❌'}`);
  if (!lineToken) {
    console.error('❌ Error: LINE_CHANNEL_ACCESS_TOKEN is missing in .env');
    process.exit(1);
  }

  // Mock data for testing
  const sampleMission = {
    id: 999,
    mission_title: 'พิธีเปิดงานและจัดแสดงนวัตกรรมสะพานปลา ประจำปี 2569',
    mission_code: 'FMO-AT0926-001',
    location: 'หอประชุมใหญ่ องค์การสะพานปลา',
    dress_code: 'ชุดสูทสากล / ชุดปฏิบัติงาน อสป.',
    start_date: '2026-09-20 09:00:00',
    end_date: '2026-09-20 16:30:00',
    cancel_reason: 'ยกเลิกและเลื่อนกิจกรรมตามคำสั่งผู้บริหาร เนื่องจากมีการปรับเปลี่ยนสถานที่นัดหมายและกำหนดการใหม่'
  };

  const sampleDirectors = [
    {
      id: 1,
      name: 'นายกิตติศักดิ์ พรหมศิริ',
      position: 'ผู้อำนวยการฝ่ายยุทธศาสตร์',
      department: 'ฝ่ายยุทธศาสตร์',
      emp_code: 'DIR-10',
      role_type: 'DIRECTOR',
      is_leader: 1
    }
  ];

  const sampleStaff = [
    {
      id: 2,
      name: 'น.ส.พิมพ์ลดา อัศวเศรษฐชัย',
      department: 'ฝ่ายประชาสัมพันธ์',
      position: 'นักประชาสัมพันธ์',
      emp_code: 'EMP-043',
      role_type: 'STAFF',
      is_leader: 0
    },
    {
      id: 3,
      name: 'นายวาทิต แตงนวลจันทร์',
      department: 'ฝ่ายปฏิบัติการ',
      position: 'เจ้าหน้าที่บันทึกคิว',
      emp_code: 'EMP-102',
      role_type: 'STAFF',
      is_leader: 0
    }
  ];

  const sampleAssignedList = [...sampleDirectors, ...sampleStaff];
  const samplePerson = sampleStaff[0];

  // Build cards of all colors
  // 1. Blue Card (ฟ้า - คำสั่งจัดสรรคิวปกติ)
  const blueCard = createPersonalizedFlexCard(
    sampleMission,
    samplePerson,
    false,
    sampleDirectors,
    sampleStaff,
    sampleAssignedList
  );

  // 2. Orange Card (ส้ม - จัดสรรคิวแทน)
  const orangeCard = createPersonalizedFlexCard(
    sampleMission,
    { ...samplePerson, substitute_for_name: 'นายสมชาย ใจดี' },
    true,
    sampleDirectors,
    sampleStaff,
    sampleAssignedList
  );

  // 3. Yellow Card (เหลือง - เตือนล่วงหน้า 1 วัน)
  const timeStr = `${formatDate24h(sampleMission.start_date)} - ${formatDate24h(sampleMission.end_date)}`;
  const yellowCard = {
    type: 'flex',
    altText: `🔔 เตือนความจำล่วงหน้า (1 วัน): ${sampleMission.mission_title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#eab308',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '🏛️ องค์การสะพานปลา (อสป.) • Smart Queue', color: '#fefce8', size: 'xxs', weight: 'bold' },
          { type: 'text', text: '🔔 เตือนความจำล่วงหน้า (1 วัน)', color: '#ffffff', size: 'md', weight: 'bold', margin: 'xs', wrap: true }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          { type: 'text', text: sampleMission.mission_title, weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
          { type: 'text', text: `👤 เรียน: ${samplePerson.name}`, size: 'sm', color: '#ca8a04', weight: 'bold', wrap: true },
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
                  { type: 'text', text: sampleMission.location, color: '#1e293b', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '⏰ เวลา:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: timeStr, color: '#ca8a04', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '👔 การแต่งกาย:', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: sampleMission.dress_code, color: '#8b5cf6', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
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
                    contents: [
                      { type: 'text', text: '• นายกิตติศักดิ์ พรหมศิริ (ผู้อำนวยการฝ่ายยุทธศาสตร์)', size: 'xs', color: '#0f172a', weight: 'bold', wrap: true },
                      { type: 'text', text: '• น.ส.พิมพ์ลดา อัศวเศรษฐชัย (ฝ่ายประชาสัมพันธ์)', size: 'xs', color: '#334155', wrap: true },
                      { type: 'text', text: '• นายวาทิต แตงนวลจันทร์ (ฝ่ายปฏิบัติการ)', size: 'xs', color: '#334155', wrap: true }
                    ]
                  }
                ]
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#fefce8',
            borderColor: '#fef08a',
            borderWidth: '1px',
            paddingAll: '10px',
            cornerRadius: '8px',
            margin: 'md',
            contents: [
              { type: 'text', text: '⏱️ กรุณามาถึงสถานที่ปฏิบัติงานก่อนเวลาเริ่มอย่างน้อย 30 นาที', size: 'xxs', color: '#854d0e', wrap: true }
            ]
          }
        ]
      }
    }
  };

  // 4. Red Card (แดง - ประกาศยกเลิก)
  const redCard = createCancellationFlexCardPayload(
    sampleMission,
    sampleMission.cancel_reason,
    sampleDirectors,
    sampleStaff,
    sampleAssignedList
  );

  // 5. Purple Card (ม่วง - Peer Swap คำขอสลับคิว)
  const purpleCard = createPeerSwapConsentFlexCard(
    101,
    sampleStaff[0],
    sampleStaff[1],
    'ขอสลับคิวเนื่องจากติดภารกิจเดินทางปฏิบัติหน้าที่ต่างจังหวัด'
  );

  // 6. Deep Orange Card (ส้มแจ้งเปลี่ยนกำหนดการ)
  const deepOrangeCard = createScheduleChangeFlexCardPayload(
    sampleMission,
    samplePerson,
    sampleDirectors,
    sampleStaff,
    sampleAssignedList
  );

  const cardsToSend = [
    { name: '1. Blue Card (ฟ้า - คำสั่งจัดสรรคิว)', card: blueCard },
    { name: '2. Orange Card (ส้ม - จัดสรรคิวแทน)', card: orangeCard },
    { name: '3. Yellow Card (เหลือง - เตือนล่วงหน้า 1 วัน)', card: yellowCard },
    { name: '4. Deep Orange Card (ส้มเข้ม - แจ้งเปลี่ยนกำหนดการ)', card: deepOrangeCard },
    { name: '5. Red Card (แดง - ประกาศยกเลิกกิจกรรม)', card: redCard },
    { name: '6. Purple Card (ม่วง - Peer Swap สลับคิว)', card: purpleCard }
  ];

  console.log(`\n🚀 Start pushing ${cardsToSend.length} color flex cards to LINE User: ${targetUserId}\n`);

  for (const item of cardsToSend) {
    try {
      console.log(`📤 Sending ${item.name}...`);
      const res = await axios.post(
        'https://api.line.me/v2/bot/message/push',
        {
          to: targetUserId,
          messages: [item.card]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${lineToken}`
          }
        }
      );
      console.log(`   ✅ Sent ${item.name} successfully! (Status: ${res.status})`);
      // Wait 1 second between pushes to avoid rate limits and keep order clean
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`   ❌ Failed to send ${item.name}:`, err.response ? err.response.data : err.message);
    }
  }

  console.log('\n🎉 Finished testing all color cards delivery!');
}

testSendAllColorCards();
