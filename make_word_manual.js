const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  AlignmentType,
  ShadingType
} = require('docx');

const primaryColor = '0284c7';
const darkTextColor = '0f172a';
const mutedTextColor = '475569';
const borderColor = 'cbd5e1';

function createTitle(text) {
  return new Paragraph({
    text: text,
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 240 }
  });
}

function createH1(text) {
  return new Paragraph({
    text: text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 140 }
  });
}

function createH2(text) {
  return new Paragraph({
    text: text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  });
}

function createH3(text) {
  return new Paragraph({
    text: text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 180, after: 80 }
  });
}

function createP(text, bold = false, italic = false, color = darkTextColor) {
  return new Paragraph({
    children: [
      new TextRun({
        text: text,
        bold: bold,
        italic: italic,
        color: color,
        size: 24, // 12pt
        font: 'TH Sarabun PSK'
      })
    ],
    spacing: { after: 120 }
  });
}

function createBullet(text, boldPrefix = '', bold = false) {
  const children = [];
  if (boldPrefix) {
    children.push(new TextRun({ text: boldPrefix + ' ', bold: true, size: 24, font: 'TH Sarabun PSK', color: darkTextColor }));
  }
  children.push(new TextRun({ text: text, bold: bold, size: 24, font: 'TH Sarabun PSK', color: darkTextColor }));

  return new Paragraph({
    children: children,
    bullet: { level: 0 },
    spacing: { after: 80 }
  });
}

function createCallout(title, text, bgColor = 'f0f9ff', borderColor = '0284c7') {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: title + '\n', bold: true, color: borderColor, size: 24, font: 'TH Sarabun PSK' }),
                  new TextRun({ text: text, color: darkTextColor, size: 24, font: 'TH Sarabun PSK' })
                ],
                spacing: { before: 100, after: 100 }
              })
            ],
            shading: { fill: bgColor, type: ShadingType.CLEAR },
            margins: { top: 140, bottom: 140, left: 200, right: 200 },
            borders: {
              left: { style: BorderStyle.SINGLE, size: 24, color: borderColor },
              top: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE },
              bottom: { style: BorderStyle.NONE }
            }
          })
        ]
      })
    ]
  });
}

const doc = new Document({
  styles: {
    paragraphStyles: [
      {
        id: 'Normal',
        name: 'Normal',
        run: { font: 'TH Sarabun PSK', size: 24, color: darkTextColor }
      }
    ]
  },
  sections: [
    {
      properties: {},
      children: [
        createTitle('📘 คู่มือการใช้งานระบบจัดสรรคิวอัตโนมัติ\n(FMO SMART QUEUE SYSTEM)'),
        createP('คู่มือฉบับเต็ม สำหรับพนักงานผู้ปฏิบัติงาน (User) และผู้ดูแลระบบ (Admin)', true, true, primaryColor),
        createP('จัดทำโดย: ทีมพัฒนาระบบ FMO Smart Queue System | อัปเดตล่าสุด: สิงหาคม 2026', false, true, mutedTextColor),

        createH1('1. ภาพรวมระบบ (System Overview)'),
        createP('ระบบ FMO SMART QUEUE SYSTEM เป็นระบบบริหารจัดการคิวการเข้าปฏิบัติงานสำหรับบุคลากรองค์การสะพานปลา (อสป.) ทำงานร่วมกันระหว่างระบบเว็บบริหารจัดการ (Web Admin Dashboard) และระบบตอบกลับอัตโนมัติผ่าน LINE Official Account (Auto Reply) เพื่อแจ้งเตือน จัดสรรคิว รับทราบภารกิจ เปลี่ยนตัวฉุกเฉิน และสลับคิวได้อย่างสะดวกรวดเร็วและเป็นธรรม'),

        createH1('ส่วนที่ 1: คู่มือสำหรับพนักงานและผู้ปฏิบัติงาน (User Manual)'),

        createH2('1.1 การผูกบัญชี LINE Official Account'),
        createP('พนักงานทุกท่านต้องผูกบัญชี LINE กับระบบก่อน จึงจะได้รับ Notification และกดตอบรับการปฏิบัติงานได้'),
        createBullet('เพิ่มเพื่อน LINE Official Account ของ FMO SMART QUEUE SYSTEM'),
        createBullet('กดปุ่มยินยอมข้อตกลง PDPA บน LINE (การ์ดสีเขียวสด)'),
        createBullet('ระบบจะบันทึก LINE User ID ของท่านเข้ากับรหัสพนักงานในฐานข้อมูลโดยอัตโนมัติ'),

        createH2('1.2 การ์ดคำสั่งจัดสรรคิวกิจกรรม (การ์ดสีฟ้า)'),
        createP('เมื่อท่านได้รับการจัดสรรเข้าปฏิบัติงานในกิจกรรมใหม่ ระบบจะส่งการ์ดสีฟ้าทาง LINE Push Notification:'),
        createBullet('ชื่อกิจกรรม, เรียน [ชื่อท่าน], หัวหน้าคณะ (ผอ.ฝ่าย), สถานที่, วัน-เวลา (24 ชม.), การแต่งกาย และข้อปฏิบัติตน', 'ข้อมูลบนการ์ด:'),
        createBullet('กดตอบรับการปฏิบัติงาน ระบบจะส่งข้อความตอบกลับยืนยันรายละเอียดภารกิจ วัน เวลา สถานที่ และลิงก์ดาวน์โหลดเอกสาร (ถ้ามี) (หากกดซ้ำ ระบบจะแจ้งเตือน: ℹ️ ท่านได้กดรับทราบกิจกรรมนี้แล้วค่ะ)', '🟢 กดรับทราบ:'),
        createBullet('กดเมื่อท่านไม่สามารถปฏิบัติงานได้ ระบบจะส่งการ์ดตัวเลือกให้ท่านระบุรหัสพนักงานตัวแทน (เช่น EMP-025) หรือกดปุ่ม 🟡 ไม่มีคนแทน (ให้ระบบเลื่อนคิว) เพื่อให้ระบบดึงคิวถัดไปให้อัตโนมัติ', '🔴 ติดภารกิจ:'),

        createH2('1.3 การ์ดแจ้งจัดสรรคิวแทนด่วน (การ์ดสีส้ม-แดง)'),
        createP('เมื่อท่านได้รับการจัดสรรให้เข้าปฏิบัติงานแทนเพื่อนร่วมงานกะทันหัน หรือ Admin กดเปลี่ยนตัวฉุกเฉิน ระบบจะส่งการ์ดด่วนสีส้ม-แดงทาง LINE ทันที:'),
        createBullet('แสดงป้าย 🚨 แจ้งเตือนจัดสรรคิวแทน และระบุ 👤 ปฏิบัติงานแทน : [ชื่อพนักงานเดิม]', 'ข้อมูลบนการ์ด:'),
        createBullet('กดรับทราบการเข้าปฏิบัติงานแทน ระบบจะบันทึกสถานะและส่งรายละเอียดภารกิจให้ทันที', '🟢 กดรับทราบ:'),

        createH2('1.4 การ์ดแจ้งเปลี่ยนแปลงกำหนดการ (การ์ดสีส้ม)'),
        createP('เมื่อผู้ดูแลระบบมีการแก้ไขวัน เวลา สถานที่ หรือรายละเอียดกิจกรรม ระบบจะส่งการ์ดสีส้มแจ้งเตือน:'),
        createBullet('ระบุ 👤 เรียน: [ชื่อท่าน], เวลาใหม่, สถานที่ใหม่, การแต่งกายใหม่ และรายละเอียดการเปลี่ยนแปลง', 'ข้อมูลบนการ์ด:'),
        createBullet('เมื่อกดปุ่มนี้ ระบบจะส่งข้อความสรุปรายละเอียดกิจกรรมฉบับอัปเดตล่าสุดทั้งหมด รวมทั้งลิงก์ดาวน์โหลดเอกสารใหม่ให้ท่านทาง LINE ทันที', '📄 รายละเอียดกำหนดการใหม่:'),

        createH2('1.5 การสลับคิวปฏิบัติงานกับเพื่อนร่วมงาน (Peer Swap)'),
        createP('หากพนักงานต้องการขอสลับลำดับคิวกับเพื่อนร่วมงาน สามารถดำเนินการผ่าน LINE Chat ได้ดังนี้:'),
        createBullet('สลับ [รหัสพนักงานเพื่อน] (ตัวอย่าง: สลับ EMP-025)', 'ขั้นตอนที่ 1:'),
        createBullet('ระบบจะส่งการ์ดคำขอสลับคิว (การ์ดสีม่วง) ไปยังเพื่อนร่วมงานคนนั้นทันที', 'ขั้นตอนที่ 2:'),
        createBullet('เพื่อนร่วมงานกดปุ่ม 🟢 ยินยอมสลับคิว หรือ 🔴 ปฏิเสธ', 'ขั้นตอนที่ 3:'),
        createBullet('เมื่อได้รับการยินยอม ระบบจะสลับลำดับคิวของทั้งสองคนในระบบให้อัตโนมัติพร้อมแจ้งเตือนยืนยัน', 'ขั้นตอนที่ 4:'),

        createH2('1.6 การ์ดแจ้งเตือนความจำล่วงหน้า (การ์ดสีเหลืองนวล)'),
        createP('ก่อนถึงวันปฏิบัติงานกิจกรรม ระบบจะส่งการ์ดสีเหลืองนวล (Upcoming Mission Reminder) แจ้งเตือนพนักงานล่วงหน้าเพื่อให้เตรียมความพร้อมเข้าปฏิบัติงานตรงตามเวลา'),

        createH1('ส่วนที่ 2: คู่มือสำหรับผู้ดูแลระบบ (Admin Manual)'),

        createH2('2.1 การเข้าสู่ระบบบริหารจัดการ (Web Dashboard)'),
        createBullet('เปิดเว็บเบราว์เซอร์ เข้าไปที่ URL ของระบบ (เช่น https://smart-queue.fishmarket.co.th)'),
        createBullet('กรอก รหัสพนักงาน (EMP Code) และ รหัสผ่าน (Password) ของผู้ดูแลระบบ'),
        createBullet('เข้าสู่หน้าหลัก Dashboard แสดงสถิติกิจกรรม คิวปัจจุบัน และรายงานผล'),

        createH2('2.2 การสร้างกิจกรรมและจัดสรรคิวใหม่ (Create Mission)'),
        createBullet('ไปที่เมนู "สร้างกิจกรรมใหม่"'),
        createBullet('กรอกข้อมูลกิจกรรม: ชื่อกิจกรรม, สถานที่, การแต่งกาย, วัน-เวลา เริ่มต้น/สิ้นสุด และแนบไฟล์กำหนดการ (ถ้ามี)'),
        createBullet('ระบุจำนวนผู้ปฏิบัติงานที่ต้องการ: จำนวน ผอ.ฝ่าย / หัวหน้าคณะ (Director Queue) และ จำนวน พนักงานปฏิบัติงาน (Staff Queue)'),
        createBullet('กดปุ่ม "สร้างกิจกรรมและจัดสรรคิว" ระบบจะดึงพนักงานคิวปัจจุบันตามลำดับเข้ากิจกรรมให้อัตโนมัติ และส่ง LINE Flex Card สีฟ้าไปยังพนักงานทุกคนทันที'),

        createH2('2.3 การจัดการฉุกเฉิน / เปลี่ยนตัวพนักงานกะทันหัน (Emergency Handling)'),
        createP('ใช้เมื่อมีเหตุฉุกเฉินกะทันหันกับพนักงานที่ได้รับการจัดสรรแล้ว (แม้จะกดรับทราบแล้วก็ตาม):'),
        createBullet('ไปที่เมนู "รายงานกิจกรรม" หรือหน้าแรก แดชบอร์ด'),
        createBullet('คลิกที่แถวกิจกรรมนั้นๆ (หรือกดปุ่ม 👥 รายชื่อ & เปลี่ยนตัว) เพื่อเปิดหน้าต่าง "รายละเอียดกิจกรรม"'),
        createBullet('ที่แถบรายชื่อพนักงาน กดปุ่ม 🔄 เปลี่ยนตัว ข้างชื่อพนักงานที่ต้องการเปลี่ยนตัว'),
        createBullet('เลือกรูปแบบการเปลี่ยนตัว: 🔄 ดึงคิวต่อไปอัตโนมัติ (Auto) หรือ 👤 ระบุพนักงานโดยตรง (Manual)'),
        createBullet('กรอกเหตุผลการเปลี่ยนตัว แล้วกด "ยืนยันการเปลี่ยนตัว"'),
        createBullet('ระบบจะปรับสถานะคนเดิมเป็น HOLD และจัดสรรคนใหม่พร้อมส่ง LINE Flex Card ด่วนสีส้ม-แดง ไปยังพนักงานคนใหม่ทันที'),

        createH2('2.4 การอัปเดตและเปลี่ยนแปลงกำหนดการกิจกรรม (Update Schedule)'),
        createBullet('ในหน้าต่าง รายละเอียดกิจกรรม กดปุ่ม ✏️ แก้ไขกำหนดการ'),
        createBullet('ปรับเปลี่ยน วัน เวลา สถานที่ หรือกรอกช่อง "รายละเอียดการเปลี่ยนแปลงกำหนดการใหม่"'),
        createBullet('กดยืนยันบันทึกข้อมูล ระบบจะส่ง LINE Flex Card สีส้ม (แจ้งเปลี่ยนแปลงกำหนดการ) ไปยังพนักงานทุกคนที่ได้รับการจัดสรรในกิจกรรมนั้น โดยระบุชื่อพนักงานเฉพาะบุคคลให้อัตโนมัติ'),

        createH2('2.5 หน้ารายงานกิจกรรม (Reports & Activity Monitoring)'),
        createBullet('สามารถ คลิกที่แถวกิจกรรมในตารางได้โดยตรง เพื่อเปิดหน้าต่างรายละเอียดกิจกรรม (เหมือนกับการกดปุ่ม 👥 รายชื่อ & เปลี่ยนตัว)'),
        createBullet('กรองดูตามช่วงวันที่ เริ่มต้น - สิ้นสุด หรือค้นหาตามชื่อกิจกรรม/รหัสกิจกรรมได้'),
        createBullet('ป้ายสถานะ: NEW (กิจกรรมใหม่ 48 ชม.), SCHEDULED (รอดำเนินการ/รอรับทราบ), SUCCESS (รับทราบและปฏิบัติงานครบถ้วนแล้ว)'),

        createH2('2.6 การจัดการบุคลากรและลำดับคิว (Personnel & Queue Management)'),
        createBullet('เมนู "จัดการคิว": ตรวจสอบลำดับคิวของ ผอ.ฝ่าย และ พนักงาน แบบ Real-time'),
        createBullet('ปรับสถานะคิว (HOLD / WAITING): ปรับสถานะพนักงานกรณีลาพักผ่อน หรือพักการจ่ายคิวชั่วคราวได้'),
        createBullet('การส่งออกรายงาน: กดปุ่ม Export CSV เพื่อดาวน์โหลดรายงานสรุปกิจกรรมและประวัติการเข้าปฏิบัติงาน'),

        createH1('4. สรุปประเภท LINE Flex Cards 6 สี'),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [createP('สีของการ์ด', true)], shading: { fill: 'f1f5f9' } }),
                new TableCell({ children: [createP('ชื่อประเภทการ์ด', true)], shading: { fill: 'f1f5f9' } }),
                new TableCell({ children: [createP('วัตถุประสงค์ / การใช้งาน', true)], shading: { fill: 'f1f5f9' } }),
                new TableCell({ children: [createP('Action ปุ่มกด', true)], shading: { fill: 'f1f5f9' } })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🟢 สีเขียวสด')] }),
                new TableCell({ children: [createP('การ์ดลงทะเบียน PDPA')] }),
                new TableCell({ children: [createP('แจ้งข้อตกลงและยินยอมผูกบัญชี LINE')] }),
                new TableCell({ children: [createP('🟢 ยินยอมผูกบัญชี')] })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🔵 สีฟ้า')] }),
                new TableCell({ children: [createP('การ์ดแจ้งคำสั่งจัดสรรกิจกรรม')] }),
                new TableCell({ children: [createP('แจ้งคำสั่งจัดสรรปฏิบัติงานใหม่')] }),
                new TableCell({ children: [createP('🟢 กดรับทราบ / 🔴 ติดภารกิจ')] })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🚨 สีส้ม-แดง')] }),
                new TableCell({ children: [createP('การ์ดแจ้งจัดสรรคิวแทนด่วน')] }),
                new TableCell({ children: [createP('แจ้งเข้าปฏิบัติงานแทนเพื่อนด่วน')] }),
                new TableCell({ children: [createP('🟢 กดรับทราบ')] })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🟧 สีส้ม')] }),
                new TableCell({ children: [createP('การ์ดแจ้งเปลี่ยนแปลงกำหนดการ')] }),
                new TableCell({ children: [createP('แจ้งอัปเดตวัน เวลา สถานที่ หรือกำหนดการใหม่')] }),
                new TableCell({ children: [createP('📄 รายละเอียดกำหนดการใหม่')] })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🟣 สีม่วง')] }),
                new TableCell({ children: [createP('การ์ดคำขอสลับคิว (Peer Swap)')] }),
                new TableCell({ children: [createP('ส่งคำขอสลับคิวไปยังเพื่อนร่วมงาน')] }),
                new TableCell({ children: [createP('🟢 ยินยอมสลับคิว / 🔴 ปฏิเสธ')] })
              ]
            }),
            new TableRow({
              children: [
                new TableCell({ children: [createP('🟡 สีเหลืองนวล')] }),
                new TableCell({ children: [createP('การ์ดเตือนความจำล่วงหน้า')] }),
                new TableCell({ children: [createP('แจ้งเตือนล่วงหน้าก่อนถึงวันปฏิบัติงานจริง')] }),
                new TableCell({ children: [createP('-')] })
              ]
            })
          ]
        })
      ]
    }
  ]
});

const outPath1 = path.join('C:\\apps', 'fmo_smart_queue_manual.docx');
const outPath2 = path.join('C:\\apps\\smart-queue', 'public', 'fmo_smart_queue_manual.docx');

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outPath1, buffer);
  fs.writeFileSync(outPath2, buffer);
  console.log(`✅ Word Manual generated successfully: ${outPath1} and ${outPath2}`);
}).catch(err => {
  console.error('Error generating docx:', err);
});
