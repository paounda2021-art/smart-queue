require('dotenv').config();
const axios = require('axios');

async function sendSampleCancelCard() {
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetUserId = 'U3a7529a26c7c9a1a06d4cd374349a33c';

  console.log(`Checking LINE_CHANNEL_ACCESS_TOKEN: ${lineToken ? 'Configured' : 'NOT Configured'}`);

  const flexCardObj = {
    type: 'flex',
    altText: '🚫 ประกาศยกเลิกกิจกรรม/จัดสรรคิว: พิธีเปิดงานและจัดแสดงนวัตกรรมสะพานปลา ประจำปี 2569',
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
          { type: 'text', text: 'พิธีเปิดงานและจัดแสดงนวัตกรรมสะพานปลา ประจำปี 2569', weight: 'bold', size: 'md', color: '#0f172a', wrap: true },
          { type: 'text', text: 'รหัสกิจกรรม: FMO-AT0826-001', size: 'xs', color: '#64748b', weight: 'bold' },
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
                  { type: 'text', text: '📍 สถานที่เดิม:', color: '#64748b', size: 'xs', flex: 3 },
                  { type: 'text', text: 'กระทรวงเกษตรและสหกรณ์', color: '#1e293b', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
                ]
              },
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '⏰ กำหนดการเดิม:', color: '#64748b', size: 'xs', flex: 3 },
                  { type: 'text', text: '25/08/2026 09:00 น. - 17:00 น.', color: '#dc2626', size: 'xs', flex: 5, wrap: true, weight: 'bold' }
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
              { type: 'text', text: 'ยกเลิกและเลื่อนกิจกรรมตามคำสั่งผู้บริหาร เนื่องจากมีการปรับเปลี่ยนสถานที่นัดหมายและกำหนดการใหม่', size: 'xs', color: '#7f1d1d', wrap: true, margin: 'xs' }
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

  if (!lineToken) {
    console.error('❌ Error: LINE_CHANNEL_ACCESS_TOKEN is missing in .env file!');
    process.exit(1);
  }

  try {
    console.log(`🚀 Sending updated LINE Push Flex Card to user: ${targetUserId}...`);
    const res = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: targetUserId,
        messages: [flexCardObj]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lineToken}`
        }
      }
    );

    console.log('✅ LINE Push Message Sent Successfully!', res.status, res.data);
  } catch (err) {
    console.error('❌ Failed to send LINE message:', err.response ? err.response.data : err.message);
  }
}

sendSampleCancelCard();
