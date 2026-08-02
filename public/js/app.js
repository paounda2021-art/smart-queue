let currentQueueRole = 'DIRECTOR';
let allPersonnelList = [];
let previewedDirectors = [];
let previewedStaff = [];
let autoFetchDebounceTimer = null;

function cleanFileName(name) {
  if (!name || typeof name !== 'string') return 'ดาวน์โหลดเอกสารกำหนดการ (PDF/Word/รูปภาพ)';
  if (/[\u0080-\u00FF]{2,}/.test(name) || name.includes('à') || name.includes('')) {
    return 'ดาวน์โหลดเอกสารกำหนดการ (PDF/Word/รูปภาพ)';
  }
  return name;
}

// -------------------------------------------------------------
// TOAST NOTIFICATION SYSTEM
// -------------------------------------------------------------

function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = 'fa-circle-check text-emerald';
  if (type === 'warning') icon = 'fa-triangle-exclamation text-amber';
  else if (type === 'danger') icon = 'fa-circle-xmark text-danger';
  else if (type === 'info') icon = 'fa-circle-info text-cyan';

  toast.innerHTML = `
    <i class="fa-solid ${icon}" style="font-size: 1.25rem; flex-shrink: 0;"></i>
    <div style="flex: 1; line-height: 1.35;">${message}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4500);
}


document.addEventListener('DOMContentLoaded', () => {

  initApp();
  initTheme();
  checkUrlActionParams(); // ตรวจสอบ URL query params จาก LINE redirect (เช่น ?action=busy)
});

function initApp() {
  renderUserBadge();
  applyMenuPermissions();
  populate24HourTimeOptions('alloc-start-time', '09:00');
  populate24HourTimeOptions('alloc-end-time', '17:00');
  setDefaultMissionTimes();
  initAttachmentPreviewListeners();

  // 🚀 ดึงข้อมูล ผอ.ฝ่าย สำหรับหน้าจัดสรรคิวทันที (Instant Load < 100ms)
  loadDirectorSelectList();

  // ดึงแท็บเดิมจาก hash หรือ localStorage (ถ้าไม่มี ให้เปิด quick หน้าแรก)
  const hashTab = (window.location.hash || '').replace('#', '').trim();
  const savedTab = hashTab || localStorage.getItem('fmo_active_tab') || 'quick';
  switchTab(savedTab);
}


function applyMenuPermissions(userObj = null) {
  let user = userObj;

  if (!user) {
    const sessionUser = sessionStorage.getItem('fmo_user');
    if (sessionUser) {
      try { user = JSON.parse(sessionUser); } catch(e){}
    }
  }

  if (!user) return;

  const codeUpper = String(user.empCode || user.emp_code || user.username || '').trim().toUpperCase();

  // 👑 บัญชี Super Admin หลัก (ADMIN) ได้รับครบทุกเมนู
  if (codeUpper === 'ADMIN') {
    document.querySelectorAll('.nav-btn[data-menu]').forEach(btn => {
      btn.style.display = 'inline-flex';
    });
    return;
  }

  let perms = [];
  try {
    perms = typeof user.menu_permissions === 'string'
      ? JSON.parse(user.menu_permissions)
      : (user.menu_permissions || []);
  } catch(e){}

  // ถ้ายังคงว่างเปล่า กำหนดสิทธิ์ตั้งต้นเป็น quick และ queue
  if (!perms || perms.length === 0) {
    perms = ['quick', 'queue'];
  }

  // ควบคุมการแสดงผลของปุ่มเมนูกดบน Navbar ให้ตรงกับสิทธิ์ที่กำหนดไว้จริง 100%
  document.querySelectorAll('.nav-btn[data-menu]').forEach(btn => {
    const menuKey = btn.getAttribute('data-menu');
    if (perms.includes(menuKey)) {
      btn.style.display = 'inline-flex';
    } else {
      btn.style.display = 'none';
    }
  });

  // หากสลับไปหน้าเมนูที่ไม่ได้รับอนุญาต ให้เปลี่ยนสลับไปหน้าแรกที่สิทธิ์เข้าถึงได้โดยอัตโนมัติ
  const currentTab = (window.location.hash || '').replace('#', '').trim() || localStorage.getItem('fmo_active_tab') || 'quick';
  if (!perms.includes(currentTab)) {
    const firstAllowed = perms[0] || 'quick';
    if (typeof switchTab === 'function') {
      switchTab(firstAllowed);
    }
  }
}



function renderUserBadge() {
  const sessionUser = sessionStorage.getItem('fmo_user');
  if (!sessionUser) return;

  try {
    const userObj = JSON.parse(sessionUser);
    const nameEl = document.getElementById('user-label-name');
    const posEl = document.getElementById('user-label-pos');
    const roleEl = document.getElementById('user-label-role');

    if (nameEl) nameEl.textContent = userObj.label || userObj.username || 'ผู้ใช้งาน';
    if (posEl) posEl.textContent = userObj.position || (userObj.empCode ? `รหัส ${userObj.empCode}` : 'เจ้าหน้าที่ อสป.');
    if (roleEl) roleEl.textContent = userObj.roleLabel || (userObj.role === 'admin' ? 'แอดมิน (Admin)' : 'เจ้าหน้าที่ (Staff)');

    applyMenuPermissions(userObj);
  } catch (e) {
    console.error('Error rendering user badge:', e);
  }
}

function goHome() {
  switchTab('quick');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


function handleLogout() {
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      title: 'ยืนยันออกจากระบบ?',
      text: 'คุณต้องการออกจากระบบ FMO Smart Queue ใช่หรือไม่',
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#64748b',
      confirmButtonText: '<i class="fa-solid fa-right-from-bracket"></i> ออกจากระบบ',
      cancelButtonText: 'ยกเลิก',
      width: '400px'
    }).then((result) => {
      if (result.isConfirmed) {
        sessionStorage.removeItem('fmo_user');
        sessionStorage.clear();
        window.location.replace('/login');
      }
    });
  } else {
    showConfirmModal({
      title: '🚪 ยืนยันออกจากระบบ?',
      message: 'คุณต้องการออกจากระบบ FMO Smart Queue ใช่หรือไม่',
      icon: 'fa-right-from-bracket text-rose',
      confirmText: 'ออกจากระบบ',
      confirmBtnStyle: 'background: #ef4444; border-color: #ef4444; font-weight: bold;',
      onConfirm: () => {
        sessionStorage.removeItem('fmo_user');
        sessionStorage.clear();
        window.location.replace('/login');
      }
    });
  }
}
window.handleLogout = handleLogout;



// -------------------------------------------------------------
// LINE REDIRECT HANDLER: ?action=busy&mission_id=X&personnel_id=Y
// รองรับการกดปุ่ม "ติดภารกิจ" จาก LINE แล้ว redirect มาเปิดหน้าเว็บสำหรับป้อนตัวแทน
// -------------------------------------------------------------
async function checkUrlActionParams() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  const missionId = params.get('mission_id');
  const personnelId = params.get('personnel_id');

  if (action === 'busy' && missionId && personnelId) {
    window.history.replaceState({}, document.title, window.location.pathname);
    await new Promise(r => setTimeout(r, 600));

    const { value: empCode } = await Swal.fire({
      title: '<span style="font-size: 20px;">🔴 แจ้งติดภารกิจ - ป้อนผู้ปฏิบัติงานแทน</span>',
      html: '<p style="color:#64748b; font-size:14px;">การแจ้งผ่านปุ่มใน LINE<br>กรุณาระบุรหัสพนักงานผู้มาทำหน้าที่แทน</p>',
      input: 'text',
      inputLabel: 'รหัสพนักงานตัวแทน (EMP-XXX)',
      inputPlaceholder: 'เช่น EMP-001',
      showCancelButton: true,
      confirmButtonText: '✅ ยืนยันส่งตัวแทน',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626',
      width: '380px',
      customClass: { popup: 'rounded-popup', input: 'rounded-input' },
      inputValidator: (val) => { if (!val) return 'กรุณาระบุรหัสพนักงานตัวแทน'; }
    });

    if (!empCode) return;

    try {
      const res = await fetch('/api/missions/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mission_id: parseInt(missionId),
          personnel_id: parseInt(personnelId),
          response_status: 'DECLINED_BUSY',
          substitute_emp_code: empCode.trim()
        })
      });
      const result = await res.json();

      if (result.success) {
        showToast(`🎉 ${result.message}`, 'success');
        setTimeout(() => {
          switchTab('reports');
          loadDashboardStats();
          openMissionDetailModal(parseInt(missionId));
        }, 800);
      } else {
        showToast(`❌ ${result.error}`, 'danger');
      }
    } catch (err) {
      console.error('Error processing LINE busy action:', err);
      showToast('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'danger');
    }
  }
}


// -------------------------------------------------------------
// 24-HOUR TIME DROPDOWN POPULATOR
// -------------------------------------------------------------
function populate24HourTimeOptions(selectId, defaultTime = '09:00') {
  const select = document.getElementById(selectId);
  if (!select) return;

  let html = '';
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const timeStr = `${hh}:${mm}`;
      const selected = timeStr === defaultTime ? 'selected' : '';
      html += `<option value="${timeStr}" ${selected}>${timeStr} น.</option>`;
    }
  }
  select.innerHTML = html;
}

// -------------------------------------------------------------
// LIGHT / DARK THEME TOGGLE
// -------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('fmo_theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    updateThemeIcon(true);
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('fmo_theme', isLight ? 'light' : 'dark');
  updateThemeIcon(isLight);
}

function updateThemeIcon(isLight) {
  const icon = document.getElementById('theme-toggle-icon');
  if (!icon) return;
  if (isLight) {
    icon.className = 'fa-solid fa-sun';
    icon.style.color = '#f59e0b';
  } else {
    icon.className = 'fa-solid fa-moon';
    icon.style.color = '#38bdf8';
  }
}

// -------------------------------------------------------------
// TAB NAVIGATION
// -------------------------------------------------------------
function switchTab(tabId) {
  if (!tabId) tabId = 'quick';
  localStorage.setItem('fmo_active_tab', tabId);
  window.history.replaceState(null, '', '#' + tabId);

  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = Array.from(document.querySelectorAll('.nav-btn')).find(btn => btn.getAttribute('onclick')?.includes(tabId));
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('.view-content').forEach(view => view.classList.remove('active'));
  const targetView = document.getElementById(`view-${tabId}`);
  if (targetView) targetView.classList.add('active');

  if (tabId === 'quick') previewCandidates();
  else if (tabId === 'dashboard') loadDashboardStats();
  else if (tabId === 'queue') loadQueueView(currentQueueRole);
  else if (tabId === 'individual') {
    if (allPersonnelList.length === 0) loadPersonnelDropdown();
  } else if (tabId === 'reports') loadAllMissions();
  else if (tabId === 'calendar') loadCalendarEvents();
  else if (tabId === 'user-management') loadUserManagementView();
}

let fullCalendarInstance = null;

async function loadCalendarEvents() {
  const containerEl = document.getElementById('full-calendar-container');
  if (!containerEl) return;

  if (typeof FullCalendar === 'undefined') {
    containerEl.innerHTML = '<p style="text-align:center; padding:2rem; color:var(--text-muted);">กำลังโหลดสคริปต์ปฏิทิน...</p>';
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.10/index.global.min.js';
    script.onload = () => loadCalendarEvents();
    document.head.appendChild(script);
    return;
  }

  try {
    let res = await fetch('/api/missions/calendar-events');
    if (res.status === 404) {
      res = await fetch('api/missions/calendar-events');
    }
    const result = await res.json();


    if (!result.success) {
      showToast(result.error, 'danger');
      return;
    }

    setTimeout(() => {
      if (fullCalendarInstance) {
        fullCalendarInstance.destroy();
      }

      fullCalendarInstance = new FullCalendar.Calendar(containerEl, {
        initialView: 'dayGridMonth',
        height: 'auto',
        displayEventTime: false,
        eventDisplay: 'block',
        headerToolbar: {
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,timeGridWeek,listMonth'
        },

        buttonText: {
          today: 'วันนี้',
          month: 'เดือน',
          week: 'สัปดาห์',
          list: 'รายการ'
        },
        events: result.events || [],
        eventClick: function(info) {
          openMissionDetailModal(info.event.id);
        },
        eventDidMount: function(info) {
          const props = info.event.extendedProps || {};
          const title = info.event.title || 'กิจกรรม';
          const location = props.location || 'สะพานปลา อสป.';
          const dressCode = props.dressCode || 'ชุดปฏิบัติงาน อสป.';
          const status = (props.status === 'SUCCESS' || props.status === 'COMPLETED')
            ? '🟢 SUCCESS (ปฏิบัติเสร็จสิ้น)' 
            : '🟠 SCHEDULED (รอดำเนินการ)';
          const teamInfo = `ผอ.ฝ่าย ${props.directorsCount || 0} ท่าน / พนักงาน ${props.staffCount || 0} ท่าน`;
          info.el.setAttribute('title', `📌 กิจกรรม: ${title}\n📍 สถานที่: ${location}\n👔 การแต่งกาย: ${dressCode}\n👥 ผู้ปฏิบัติงาน: ${teamInfo}\n📊 สถานะ: ${status}`);
        }
      });


      fullCalendarInstance.render();
      setTimeout(() => {
        if (fullCalendarInstance) fullCalendarInstance.updateSize();
      }, 100);
    }, 50);
  } catch (err) {
    console.error('Error loading calendar:', err);
  }
}



// -------------------------------------------------------------
// AUTO-FETCH QUEUE ON INPUT CHANGE
// -------------------------------------------------------------
function autoFetchOnNumberChange() {
  clearTimeout(autoFetchDebounceTimer);
  autoFetchDebounceTimer = setTimeout(() => {
    previewCandidates();
  }, 250);
}

// -------------------------------------------------------------
// DASHBOARD STATS & ACTIVE QUEUE TRACKER
// -------------------------------------------------------------
async function loadDashboardStats() {
  try {
    const res = await fetch('/api/dashboard/stats');
    const result = await res.json();

    if (result.success) {
      const data = result.data;
      document.getElementById('stat-director-round').innerText = `Round ${data.rounds.directorRound}`;
      document.getElementById('stat-staff-round').innerText = `Round ${data.rounds.staffRound}`;
      document.getElementById('stat-participation-rate').innerText = `${data.participationRate.ratePct}%`;
      document.getElementById('stat-hold-count').innerText = `${data.holdsCount} ท่าน`;

      document.getElementById('dash-dir-round-num').innerText = data.rounds.directorRound;
      document.getElementById('dash-staff-round-num').innerText = data.rounds.staffRound;

      renderActiveQueueTracker(data.activeQueueTracker, data.rounds);
      renderRoundProgress('dash-dir-progress', data.directorBreakdown, 8);
      renderRoundProgress('dash-staff-progress', data.staffBreakdown, 94);
      loadRecentMissionsList();
    }
  } catch (err) {
    console.error('Error loading dashboard stats:', err);
  }
}

function renderActiveQueueTracker(tracker, rounds) {
  const nextDir = tracker.nextDirector;
  const nextStaff = tracker.nextStaff;

  const dirNameEl = document.getElementById('tracker-dir-name');
  const dirPosEl = document.getElementById('tracker-dir-pos');
  const dirRoundTag = document.getElementById('tracker-dir-round-tag');

  if (nextDir) {
    const isHold = nextDir.status === 'HOLD';
    dirNameEl.innerHTML = `${escapeHtml(nextDir.name)} ${isHold ? '<span class="badge badge-hold">HOLD Priority</span>' : ''}`;
    dirPosEl.innerText = `${nextDir.position} (${nextDir.department}) | รหัส: ${nextDir.emp_code}`;
    dirRoundTag.innerText = `Round ${nextDir.current_round}`;
  } else {
    dirNameEl.innerText = 'ครบทุกคนในรอบแล้ว';
    dirPosEl.innerText = 'กำลังขึ้นรอบใหม่';
    dirRoundTag.innerText = `Round ${rounds.directorRound}`;
  }

  const staffNameEl = document.getElementById('tracker-staff-name');
  const staffPosEl = document.getElementById('tracker-staff-pos');
  const staffRoundTag = document.getElementById('tracker-staff-round-tag');

  if (nextStaff) {
    const isHold = nextStaff.status === 'HOLD';
    staffNameEl.innerHTML = `ลำดับที่ ${nextStaff.queue_order}: ${escapeHtml(nextStaff.name)} ${isHold ? '<span class="badge badge-hold">HOLD Priority</span>' : ''}`;
    staffPosEl.innerText = `${nextStaff.position} (${nextStaff.department}) | รหัส: ${nextStaff.emp_code}`;
    staffRoundTag.innerText = `Round ${nextStaff.current_round}`;
  } else {
    staffNameEl.innerText = 'ครบทุกคนในรอบแล้ว';
    staffPosEl.innerText = 'กำลังขึ้นรอบใหม่';
    staffRoundTag.innerText = `Round ${rounds.staffRound}`;
  }
}

function renderRoundProgress(containerId, breakdown, total) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let completed = 0, hold = 0, waiting = 0;
  breakdown.forEach(b => {
    if (b.status === 'COMPLETED') completed = b.count;
    else if (b.status === 'HOLD') hold = b.count;
    else if (b.status === 'WAITING') waiting = b.count;
  });

  const compPct = Math.round((completed / total) * 100);

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; font-size:0.8rem; color:var(--text-muted); margin-bottom:4px;">
      <span>เสร็จสิ้นกิจกรรมในรอบนี้: ${completed}/${total} ท่าน (${compPct}%)</span>
      <span>HOLD: ${hold} | WAITING: ${waiting}</span>
    </div>
    <div style="width:100%; height:8px; background:var(--card-border); border-radius:4px; overflow:hidden; display:flex;">
      <div style="width:${(completed/total)*100}%; background:#10b981;" title="COMPLETED"></div>
      <div style="width:${(hold/total)*100}%; background:#f59e0b;" title="HOLD"></div>
      <div style="width:${(waiting/total)*100}%; background:#0284c7;" title="WAITING"></div>
    </div>
  `;
}

async function loadRecentMissionsList() {
  try {
    const res = await fetch('/api/missions');
    const result = await res.json();

    const container = document.getElementById('dash-recent-missions');
    if (!result.success || result.missions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted); padding:1rem;">ยังไม่มีรายการกิจกรรมในระบบ</p>';
      return;
    }

    const recent = result.missions.slice(0, 5);
    let html = `
      <table class="custom-table">
        <thead>
          <tr>
            <th>ชื่อกิจกรรม</th>
            <th>สถานที่</th>
            <th>วันที่เริ่มต้น (เวลา 24 ชม.)</th>
            <th>สถานะ</th>
          </tr>
        </thead>
        <tbody>
    `;

    recent.forEach(m => {
      const statusBadge = (m.status === 'SUCCESS' || m.status === 'COMPLETED')
        ? '<span class="badge badge-completed"><i class="fa-solid fa-circle-check"></i> SUCCESS</span>' 
        : '<span class="badge badge-waiting"><i class="fa-solid fa-clock"></i> SCHEDULED</span>';


      html += `
        <tr style="cursor: pointer;" onclick="openMissionDetailModal(${m.id})" title="คลิกเพื่อดูรายละเอียดและเปลี่ยนตัว">
          <td><strong style="color:var(--text-heading);">${escapeHtml(m.mission_title)}</strong></td>
          <td>${escapeHtml(m.location || '-')}</td>
          <td>${formatDate(m.start_date)}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    console.error('Error loading recent activities:', err);
  }
}

// -------------------------------------------------------------
// DUAL QUEUE VISUALIZER
// -------------------------------------------------------------
async function loadQueueView(roleType) {
  currentQueueRole = roleType;

  const btnDir = document.getElementById('tab-btn-director');
  const btnStaff = document.getElementById('tab-btn-staff');

  if (roleType === 'DIRECTOR') {
    if (btnDir) btnDir.className = 'queue-segment-btn btn-primary active';
    if (btnStaff) btnStaff.className = 'queue-segment-btn btn-secondary';
  } else {
    if (btnDir) btnDir.className = 'queue-segment-btn btn-secondary';
    if (btnStaff) btnStaff.className = 'queue-segment-btn btn-primary active';
  }

  const tbody = document.getElementById('queue-table-body');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">กำลังโหลดข้อมูลคิว...</td></tr>';

  // --- ฟังก์ชันช่วยนับเฉพาะคนที่ "รอคิวจริง" ---
  const countWaiting = (membersList) => {
    return membersList.filter(m => m.status === 'WAITING' || m.status === 'HOLD').length;
  };

  // --- แอบดึงข้อมูลของอีกแท็บมาเพื่อนับจำนวนคิวที่เหลือ / จำนวนทั้งหมด ---
  const otherRole = roleType === 'DIRECTOR' ? 'STAFF' : 'DIRECTOR';
  fetch(`/api/queue/${otherRole}`)
    .then(res => res.json())
    .then(otherResult => {
       const otherMembers = otherResult.data || otherResult.members || [];
       const otherWaitingCount = countWaiting(otherMembers);
       const otherTotal = otherMembers.length;
       
       if (otherRole === 'STAFF') {
          document.getElementById('tab-btn-staff-text').innerText = `พนักงาน (${otherWaitingCount}/${otherTotal})`;
       } else {
          document.getElementById('tab-btn-director-text').innerText = `ผอ.ฝ่าย (${otherWaitingCount}/${otherTotal})`;
       }
    })

    .catch(err => console.log('Background fetch error:', err));

  try {
    const res = await fetch(`/api/queue/${roleType}`);
    const result = await res.json();

    if (!result.success) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger);">${result.error}</td></tr>`;
      return;
    }

    let members = result.data || result.members || [];
    const waitingCount = countWaiting(members);
    const totalCount = members.length;

    // ตรึงลำดับผู้บริหารระดับสูง: DIR-10 ลำดับที่ 1 และ DIR-09 ลำดับที่ 2 เสมอ
    if (roleType === 'DIRECTOR') {
      const dir10 = members.find(m => String(m.emp_code || '').trim().toUpperCase() === 'DIR-10');
      const dir09 = members.find(m => String(m.emp_code || '').trim().toUpperCase() === 'DIR-09');
      const others = members.filter(m => {
        const code = String(m.emp_code || '').trim().toUpperCase();
        return code !== 'DIR-10' && code !== 'DIR-09';
      });

      members = [];
      if (dir10) members.push(dir10);
      if (dir09) members.push(dir09);
      members.push(...others);
    }

    // อัปเดตข้อความบนปุ่มของแท็บปัจจุบัน (แสดงยอดที่เหลือ / จำนวนทั้งหมด)

    if (roleType === 'DIRECTOR') {
       document.getElementById('tab-btn-director-text').innerText = `ผอ.ฝ่าย (${waitingCount}/${totalCount})`;
    } else {
       document.getElementById('tab-btn-staff-text').innerText = `พนักงาน (${waitingCount}/${totalCount})`;
    }


    if (members.length === 0) {
       tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">ไม่พบข้อมูลบุคลากรในระบบ</td></tr>';
       return;
    }

    let html = '';
    let regularIndex = 1;
    members.forEach((m) => {
      const code = String(m.emp_code || '').trim().toUpperCase();
      const isDir10 = code === 'DIR-10';
      const isDir09 = code === 'DIR-09';
      const isExecutiveReserve = isDir10 || isDir09 || (m.status === 'RESERVE_EXEC');

      let orderCell = '';
      let statusBadge = '';
      let actions = '';

      if (isExecutiveReserve) {
        const roleDesc = isDir10 ? 'ผออ.' : (isDir09 ? 'รผอ.บร.' : 'ผู้บริหาร');
        const execLabel = `👑 ${roleDesc}`;

        orderCell = `<span class="badge" style="background:rgba(168,85,247,0.12); color:#a855f7; border:1px solid rgba(168,85,247,0.3); font-weight:700;">${execLabel}</span>`;

        statusBadge = `<span class="badge" style="background:#a855f7; color:#ffffff; font-weight:700;"><i class="fa-solid fa-crown"></i> ${roleDesc}</span>`;

        actions = `<span class="badge" style="background:rgba(168,85,247,0.12); color:#a855f7; border:1px solid rgba(168,85,247,0.3); padding:4px 10px; font-size:0.78rem;"><i class="fa-solid fa-user-shield"></i> ผู้บริหาร</span>`;
      }
 else {
        const queueNum = regularIndex++;
        orderCell = `<strong style="color:var(--primary);">#${queueNum}</strong>`;



        if (m.status === 'HOLD') {
          statusBadge = `<span class="badge badge-hold"><i class="fa-solid fa-pause"></i> HOLD (ค้างสิทธิ์)</span><br><small style="color:var(--warning);">${escapeHtml(m.hold_reason || '')}</small>`;
          actions = `<button class="btn btn-primary btn-sm" onclick="unholdPerson(${m.personnel_id}, this)"><i class="fa-solid fa-play"></i> คืนสิทธิ์ปกติ</button>`;
        } else if (m.status === 'COMPLETED') {
          statusBadge = '<span class="badge badge-completed"><i class="fa-solid fa-check"></i> COMPLETED</span>';
          actions = `<span style="color:var(--text-muted); font-size:0.8rem;">ปฏิบัติกิจกรรมในรอบนี้แล้ว</span>`;
        } else {
          statusBadge = '<span class="badge badge-waiting"><i class="fa-solid fa-clock"></i> WAITING (รอคิว)</span>';
          actions = `<button class="btn btn-warning btn-sm" onclick="openSkipModal(${m.personnel_id}, '${escapeHtml(m.name)}')"><i class="fa-solid fa-pause"></i> ข้ามคิว (Hold)</button>`;
        }
      }

      html += `
        <tr ${isExecutiveReserve ? 'style="background:rgba(168,85,247,0.03);"' : ''}>
          <td>${orderCell}</td>
          <td><code>${m.emp_code}</code></td>
          <td><strong style="color:var(--text-heading);">${escapeHtml(m.name)}</strong></td>
          <td>${escapeHtml(m.position)}<br><small style="color:var(--text-muted);">${escapeHtml(m.department)}</small></td>
          <td>${statusBadge}</td>
          <td><strong style="color:var(--success);">${m.total_missions_joined}</strong> ครั้ง</td>
          <td>${m.last_assigned_at ? formatDate(m.last_assigned_at) : '<span style="color:var(--text-muted);">-</span>'}</td>
          <td class="no-print">${actions}</td>
        </tr>
      `;
    });




    tbody.innerHTML = html;
  } catch (err) {
    console.error('Error loading queue:', err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--danger);">เกิดข้อผิดพลาดในการดึงข้อมูล</td></tr>';
  }
}

// -------------------------------------------------------------
// SKIP & HOLD ACTIONS
// -------------------------------------------------------------
function openSkipModal(personnelId, name) {
  document.getElementById('modal-skip-person-id').value = personnelId;
  document.getElementById('modal-skip-person-name').innerText = name;
  document.getElementById('modal-skip-reason').value = '';
  openModal('modal-skip');
}

async function confirmSkipHold() {
  const pId = document.getElementById('modal-skip-person-id').value;
  const reason = document.getElementById('modal-skip-reason').value.trim();

  if (!reason) {
    showToast('กรุณาระบุเหตุผลการข้ามคิว', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/queue/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personnel_id: pId, reason })
    });
    const result = await res.json();

    if (result.success) {
      closeModal('modal-skip');
      loadQueueView(currentQueueRole);
      loadDashboardStats();
      previewCandidates();
      showToast('บันทึกการข้ามคิว (Hold) เรียบร้อยแล้ว', 'warning');
    } else {
      showToast(`Error: ${result.error}`, 'danger');
    }
  } catch (err) {
    console.error('Skip error:', err);
  }
}

async function unholdPerson(personnelId, btnElem) {
  try {
    const pId = Number.parseInt(personnelId, 10);

    // ⚡ Instant Optimistic UI Update: ค้นหา row แล้วเปลี่ยนเฉพาะเซลล์สถานะและเซลล์ปุ่มทันที
    let targetRow = null;
    if (btnElem && btnElem.closest) {
      targetRow = btnElem.closest('tr');
    }

    if (targetRow) {
      // เซลล์สถานะคืนค่า WAITING ทันที
      const statusCell = targetRow.querySelector('.badge-hold')?.closest('td');
      // เซลล์ปุ่ม action (คลาส no-print)
      const actionCell = targetRow.querySelector('td.no-print');

      if (statusCell) {
        statusCell.innerHTML = '<span class="badge badge-waiting"><i class="fa-solid fa-clock"></i> WAITING (รอคิว)</span>';
      }
      if (actionCell) {
        actionCell.innerHTML = `<button class="btn btn-warning btn-sm" onclick="openSkipModal(${pId}, '')"><i class="fa-solid fa-pause"></i> ข้ามคิว (Hold)</button>`;
      }
    }

    const res = await fetch('/api/queue/unhold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personnel_id: pId })
    });
    const result = await res.json();

    if (result.success) {
      showToast('🎉 คืนสิทธิ์ให้บุคลากรกลับสู่สถานะรอคิวปกติเรียบร้อยแล้ว', 'success');
      // โหลดตารางใหม่ 1 ครั้งในพื้นหลัง (ไม่กะพริบ)
      setTimeout(async () => {
        if (typeof loadQueueView === 'function') {
          await loadQueueView(currentQueueRole || 'DIRECTOR');
        }
        if (typeof loadDashboardStats === 'function') loadDashboardStats();
        if (typeof previewCandidates === 'function') previewCandidates();
      }, 500);
    } else {
      showToast(`Error: ${result.error}`, 'danger');
      // กรณีผิดพลาดให้โหลดใหม่ทันทีเพื่อย้อน UI
      if (typeof loadQueueView === 'function') loadQueueView(currentQueueRole);
    }
  } catch (err) {
    console.error('Unhold error:', err);
    showToast('เกิดข้อผิดพลาดในการคืนสิทธิ์', 'danger');
    if (typeof loadQueueView === 'function') loadQueueView(currentQueueRole);
  }
}
window.unholdPerson = unholdPerson;

// -------------------------------------------------------------
// EMERGENCY SUBSTITUTION (การเปลี่ยนตัวกะทันหัน)
// -------------------------------------------------------------
function toggleSubModeUI() {
  const mode = document.querySelector('input[name="sub_mode"]:checked')?.value || 'AUTO';
  const manualGroup = document.getElementById('sub-manual-group');
  if (manualGroup) {
    manualGroup.style.display = (mode === 'MANUAL') ? 'block' : 'none';
  }
}

async function openSubstituteModal(missionId, origPersonId, origPersonName) {
  document.getElementById('sub-mission-id').value = missionId;
  document.getElementById('sub-orig-person-id').value = origPersonId;
  document.getElementById('sub-orig-person-name').innerText = origPersonName;
  document.getElementById('sub-reason').value = '';
  document.getElementById('sub-auto-preview').innerText = 'กำลังโหลด...';

  const autoRadio = document.querySelector('input[name="sub_mode"][value="AUTO"]');
  if (autoRadio) autoRadio.checked = true;
  toggleSubModeUI();

  const select = document.getElementById('sub-manual-select');
  if (select) select.innerHTML = '<option value="">-- กำลังโหลดรายชื่อพนักงาน --</option>';

  openModal('modal-substitute');

  try {
    const res = await fetch(`/api/missions/substitute-candidates?mission_id=${missionId}&original_personnel_id=${origPersonId}`);
    const data = await res.json();

    if (data.success) {
      const roleLabel = data.role_group_label ? ` [${data.role_group_label}]` : '';
      document.getElementById('sub-orig-person-name').innerText = `${origPersonName}${roleLabel}`;

      if (data.auto_candidate) {
        const qOrderStr = data.auto_candidate.queue_order ? ` (คิวรออยู่ #${data.auto_candidate.queue_order})` : '';
        document.getElementById('sub-auto-preview').innerText = `${data.auto_candidate.name} (${data.auto_candidate.emp_code})${qOrderStr}`;
      } else {
        document.getElementById('sub-auto-preview').innerText = 'ไม่พบบุคลากรสำรองที่รออยู่ในกลุ่มนี้';
      }

      if (select) {
        if (Array.isArray(data.available_candidates) && data.available_candidates.length > 0) {
          select.innerHTML = '<option value="">-- เลือกพนักงานผู้ปฏิบัติงานแทนในกลุ่มเดียวกัน --</option>' +
            data.available_candidates.map(c => {
              const statusTag = (c.queue_status === 'COMPLETED')
                ? ' [สถานะ: COMPLETED ปฏิบัติงานแล้ว]'
                : ` [สถานะ: WAITING คิวรออยู่ #${c.queue_order || '-'}]`;
              return `<option value="${c.id}">${escapeHtml(c.name)} (${c.emp_code}) - ${escapeHtml(c.position || '-')}${statusTag}</option>`;
            }).join('');
        } else {
          select.innerHTML = '<option value="">-- ไม่พบบุคลากรอื่นในกลุ่มเดียวกัน --</option>';
        }
      }
    }
  } catch (err) {
    console.error('Error loading substitute candidates:', err);
    document.getElementById('sub-auto-preview').innerText = 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
  }
}

async function confirmSubstitution() {
  const missionId = document.getElementById('sub-mission-id').value;
  const origPersonId = document.getElementById('sub-orig-person-id').value;
  const mode = document.querySelector('input[name="sub_mode"]:checked')?.value || 'AUTO';
  const substitutePersonnelId = document.getElementById('sub-manual-select')?.value;
  const reason = document.getElementById('sub-reason').value.trim();

  if (!reason) {
    showToast('กรุณาระบุเหตุผลการขอเปลี่ยนตัว', 'warning');
    return;
  }

  if (mode === 'MANUAL' && !substitutePersonnelId) {
    showToast('กรุณาเลือกพนักงานผู้ปฏิบัติงานแทน', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/missions/substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mission_id: missionId,
        original_personnel_id: origPersonId,
        mode: mode,
        substitute_personnel_id: mode === 'MANUAL' ? substitutePersonnelId : null,
        reason: reason
      })
    });
    const result = await res.json();

    if (result.success) {
      showToast(`🎉 ${result.message}`, 'success');
      closeModal('modal-substitute');
      closeModal('modal-mission-detail');
      if (typeof refreshAllSystemData === 'function') {
        refreshAllSystemData();
      } else {
        loadAllMissions();
        loadDashboardStats();
        previewCandidates();
      }
    } else {
      showToast(`Error: ${result.error}`, 'danger');
    }
  } catch (err) {
    console.error('Substitution error:', err);
    showToast('เกิดข้อผิดพลาดในการเปลี่ยนตัว', 'danger');
  }
}

window.toggleSubModeUI = toggleSubModeUI;
window.openSubstituteModal = openSubstituteModal;
window.confirmSubstitution = confirmSubstitution;

async function loadDirectorSelectList() {
  const container = document.getElementById('director-select-list');

  if (!container) {
    console.error('❌ ไม่พบ element: director-select-list');
    return;
  }

  try {
    const res = await fetch('/api/queue/DIRECTOR');

    if (!res.ok) {
      throw new Error(`เซิร์ฟเวอร์ตอบกลับด้วยสถานะ ${res.status}`);
    }

    const result = await res.json();
    const list = Array.isArray(result.members) ? result.members : (Array.isArray(result.data) ? result.data : []);

    if (!result.success || !Array.isArray(list)) {
      throw new Error(result.error || result.message || 'ไม่สามารถโหลดรายชื่อ ผอ.ฝ่ายได้');
    }

    allDirectorsList = list;

    // 1. หาหัวหน้าตามคิวจริง (DIR-01 ถึง DIR-08) คนแรกที่มีสถานะ WAITING
    const fixedDirector = allDirectorsList
      .filter(person => {
        const empCode = String(person.emp_code || '').trim().toUpperCase();
        const queueStatus = String(person.status || person.queue_status || 'WAITING').trim().toUpperCase();
        return /^DIR-0[1-8]$/.test(empCode) && queueStatus === 'WAITING';
      })
      .sort((a, b) => (a.queue_order || 99) - (b.queue_order || 99))[0] || null;

    // 2. ผอ.ฝ่ายสำรอง / ผู้บริหารระดับสูง (DIR-10 และ DIR-09) - Deduplicated
    const reserveOrder = { 'DIR-10': 1, 'DIR-09': 2 };

    const reserveDirectorsMap = new Map();
    allDirectorsList.forEach(person => {
      const empCode = String(person.emp_code || '').trim().toUpperCase();
      if (['DIR-10', 'DIR-09'].includes(empCode)) {
        if (!reserveDirectorsMap.has(empCode)) {
          reserveDirectorsMap.set(empCode, person);
        }
      }
    });

    const reserveDirectors = Array.from(reserveDirectorsMap.values()).sort((a, b) => {
      const codeA = String(a.emp_code || '').trim().toUpperCase();
      const codeB = String(b.emp_code || '').trim().toUpperCase();
      return (reserveOrder[codeA] || 99) - (reserveOrder[codeB] || 99);
    });


    // 3. ลำดับรายการด้านซ้าย: DIR-10 → DIR-09 → หัวหน้าตามคิวปัจจุบัน
    const displayedDirectors = [
      ...reserveDirectors,
      ...(fixedDirector ? [fixedDirector] : [])
    ];



    console.log(
      '✅ หัวหน้าตามคิวปัจจุบัน:',
      fixedDirector
        ? {
            emp_code:
              fixedDirector.emp_code,
            status:
              fixedDirector.queue_status ||
              fixedDirector.status
          }
        : 'ไม่พบ DIRECTOR สถานะ WAITING'
    );

    console.log(
      '➕ ผอ.ฝ่ายสำรอง:',
      reserveDirectors.map(
        person => person.emp_code
      )
    );

    // ---------------------------------------------------------
    // 4. กรณีไม่พบข้อมูล
    // ---------------------------------------------------------
    if (displayedDirectors.length === 0) {
      container.innerHTML = `
        <p
          style="
            color: var(--text-muted);
            font-size: 0.82rem;
            margin: 0;
          "
        >
          ไม่พบรายชื่อ ผอ.ฝ่าย
        </p>
      `;

      previewedDirectors = [];

      renderCandidatesList(
        'preview-directors-list',
        previewedDirectors
      );

      const badge = document.getElementById(
        'selected-directors-badge'
      );

      if (badge) {
        badge.textContent = 'เลือกแล้ว 0 ท่าน';
      }

      return;
    }

    // ID ของหัวหน้าตามคิวในรอบปัจจุบัน
    const fixedPersonnelId = String(
      fixedDirector?.personnel_id ||
      fixedDirector?.id ||
      ''
    );

    // ---------------------------------------------------------
    // 5. สร้างรายการ Checkbox
    // ---------------------------------------------------------
    container.innerHTML =
      displayedDirectors
        .map(person => {
          const personnelId = String(
            person.personnel_id ||
            person.id ||
            ''
          );

          const empCode = String(
            person.emp_code || ''
          )
            .trim()
            .toUpperCase();

          // ห้ามฟิกด้วย empCode === DIR-01
          // เพราะรอบต่อไปอาจเป็น DIR-02, DIR-03 เป็นต้น
          const isFixed =
            Boolean(fixedPersonnelId) &&
            personnelId === fixedPersonnelId;

          const description = isFixed
            ? 'ผอ.ฝ่ายรันคิวอัตโนมัติ'
            : 'ผู้บริหารระดับสูง';

          return `
            <label
              class="${
                isFixed
                  ? 'director-auto-selected'
                  : 'director-reserve-option'
              }"
              style="
                display: flex;
                align-items: center;
                gap: 12px;
                background: ${
                  isFixed
                    ? '#e5e7eb'
                    : 'var(--input-bg)'
                };
                padding: 12px 14px;
                border-radius: 10px;
                border: 1px solid var(--card-border);
                cursor: ${
                  isFixed
                    ? 'default'
                    : 'pointer'
                };
                transition: all 0.2s;
              "
            >
              <input
                type="checkbox"
                class="director-checkbox"
                name="assigned_director_ids"
                value="${personnelId}"
                data-emp-code="${empCode}"
                data-fixed="${
                  isFixed ? '1' : '0'
                }"
                ${isFixed ? 'checked' : ''}
                onchange="onDirectorSelectionChange(this)"
                style="
                  accent-color: var(--primary);
                  width: 18px;
                  height: 18px;
                "
              >

              <div
                style="
                  flex: 1;
                  min-width: 0;
                "
              >
                <div
                  style="
                    font-size: 0.88rem;
                    font-weight: 700;
                    color: var(--text-heading);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                  "
                >
                  ${escapeHtml(person.name || '-')}
                </div>

                <div
                  style="
                    font-size: 0.76rem;
                    color: var(--text-muted);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                  "
                >
                  ${escapeHtml(person.position || '-')}
                </div>
              </div>

              <div
                style="
                  display: flex;
                  flex-direction: column;
                  align-items: flex-end;
                  gap: 2px;
                "
              >
                <strong
                  style="
                    font-size: 0.78rem;
                    color: var(--text-muted);
                  "
                >
                  ${escapeHtml(empCode)}
                </strong>

                <small
                  style="
                    font-size: 0.68rem;
                    color: ${
                      isFixed
                        ? '#64748b'
                        : '#d97706'
                    };
                    white-space: nowrap;
                  "
                >
                  ${description}
                </small>
              </div>
            </label>
          `;
        })
        .join('');

    // อัปเดตจำนวนที่เลือกและการ์ดด้านขวา
    onDirectorSelectionChange();
  } catch (err) {
    console.error('Error loading director select list:', err);
    container.innerHTML = `<p style="color: #dc2626; font-size: 0.82rem; margin: 0;">ไม่สามารถโหลดรายชื่อ ผอ.ฝ่ายได้</p>`;
  }
}


function onDirectorSelectionChange(changedCheckbox = null) {

  // DIR-01 เป็นหัวหน้าฟิก ห้ามยกเลิก
  if (
    changedCheckbox &&
    changedCheckbox.dataset.fixed === '1'
  ) {
    changedCheckbox.checked = true;
  }

  // อ่าน ID ของ Checkbox ที่เลือก โดยใช้ String ป้องกันชนิดข้อมูลไม่ตรงกัน
  const selectedIds = Array.from(
    document.querySelectorAll(
      '#director-select-list .director-checkbox:checked'
    )
  )
    .map(checkbox => String(checkbox.value))
    .filter(Boolean);

  // อัปเดตป้ายจำนวนที่เลือก
  const badge = document.getElementById(
    'selected-directors-badge'
  );

  if (badge) {
    badge.textContent =
      `เลือกแล้ว ${selectedIds.length} ท่าน`;
  }

  // ดึงรายชื่อที่เลือกจริง (Deduplicate)
  const selectedMap = new Map();
  (allDirectorsList || []).forEach(person => {
    const personnelId = String(person.personnel_id || person.id || '');
    const empCode = String(person.emp_code || '').trim().toUpperCase();
    const key = empCode || personnelId;

    if (selectedIds.includes(personnelId) && !selectedMap.has(key)) {
      selectedMap.set(key, person);
    }
  });

  previewedDirectors = Array.from(selectedMap.values());


  // 👑 เรียงการ์ดฝั่งขวาตามลำดับชั้นผู้บริหาร (Hierarchy Priority):
  // 1. ผู้บริหารระดับสูง (DIR-10 ผออ. -> DIR-09 รผอ.บร.) แสดงผลเป็นลำดับแรกสุดเสมอ
  // 2. ผอ.ฝ่ายที่วนคิวตามระบบอัตโนมัติประจำรอบ (DIR-01 ถึง DIR-08) แสดงผลลำดับถัดมา
  const directorOrder = {
    'DIR-10': 1, // 👑 ผออ. (ผู้บริหารระดับสูง) แสดงเป็นลำดับแรกสุดเสมอ
    'DIR-09': 2, // 👑 รผอ.บร. (ผู้บริหารระดับสูง) แสดงเป็นลำดับสอง
    'DIR-01': 3,
    'DIR-02': 4,
    'DIR-03': 5,
    'DIR-04': 6,
    'DIR-05': 7,
    'DIR-06': 8,
    'DIR-07': 9,
    'DIR-08': 10
  };

  previewedDirectors.sort((a, b) => {
    const codeA = String(a.emp_code || '').trim().toUpperCase();
    const codeB = String(b.emp_code || '').trim().toUpperCase();

    const orderA = directorOrder[codeA] || 99;
    const orderB = directorOrder[codeB] || 99;

    return orderA - orderB;
  });


  // แสดงหัวหน้าทีมด้านขวาตาม Checkbox ที่เลือกจริง
  renderCandidatesList(
    'preview-directors-list',
    previewedDirectors
  );

  console.log(
    '👔 หัวหน้าทีมที่เลือกจริง:',
    previewedDirectors.map(person => ({
      id: person.personnel_id || person.id,
      emp_code: person.emp_code
    }))
  );
}

// -------------------------------------------------------------
// 1-PAGE QUICK ALLOCATION FORM
// -------------------------------------------------------------
function setDefaultMissionTimes() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const y = tomorrow.getFullYear();
  const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const d = String(tomorrow.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const startDateEl = document.getElementById('alloc-start-date');
  const endDateEl = document.getElementById('alloc-end-date');

  if (startDateEl) startDateEl.value = dateStr;
  if (endDateEl) endDateEl.value = dateStr;
}

// -------------------------------------------------------------
// PREVIEW STAFF CANDIDATES
//
// หน้าที่:
// - ดึงพนักงานตามคิวสุ่ม
// - แสดงพนักงานด้านขวา
//
// ไม่จัดการ ผอ.ฝ่าย
// ผอ.ฝ่ายให้ loadDirectorSelectList() และ
// onDirectorSelectionChange() ดูแลเพียงระบบเดียว
// -------------------------------------------------------------
async function previewCandidates() {
  const reqStaffInput =
    document.getElementById('alloc-req-staff')?.value;

  const parsedStaff =
    Number.parseInt(reqStaffInput, 10);

  const reqStaff =
    Number.isInteger(parsedStaff) && parsedStaff > 0
      ? parsedStaff
      : 5;

  try {
    const res = await fetch(
      '/api/missions/preview-candidates',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // ผอ.ฝ่ายไม่ได้จัดการในฟังก์ชันนี้
          required_directors: 0,
          required_staff: reqStaff
        })
      }
    );

    if (!res.ok) {
      throw new Error(
        `เซิร์ฟเวอร์ตอบกลับด้วยสถานะ ${res.status}`
      );
    }

    const result = await res.json();

    if (!result.success) {
      throw new Error(
        result.message ||
        'ไม่สามารถโหลดรายชื่อพนักงานตามคิวได้'
      );
    }

    // ---------------------------------------------------------
    // รับเฉพาะพนักงานจาก API
    // ---------------------------------------------------------
    previewedStaff =
      Array.isArray(result.data?.staff)
        ? result.data.staff
        : [];

    // ---------------------------------------------------------
    // แสดงพนักงานด้านขวา
    // ---------------------------------------------------------
    renderCandidatesList(
      'preview-staff-list',
      previewedStaff
    );

    console.log(
      '🎲 พนักงานตามคิวสุ่ม:',
      previewedStaff.map(
        person => person.emp_code
      )
    );
  } catch (err) {
    console.error(
      'Error previewing staff candidates:',
      err
    );

    showToast(
      `ไม่สามารถโหลดคิวพนักงานได้: ${err.message}`,
      'danger'
    );
  }
}

function renderCandidatesList(containerId, list) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (list.length === 0) {
    const emptyMsg = containerId === 'preview-directors-list' ? 'ยังไม่ได้เลือกหัวหน้าทีม' : 'ไม่พบคู่คิวที่ตรงเงื่อนไข';
    container.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">${emptyMsg}</p>`;
    return;
  }

  let html = '<ul style="list-style:none; display:flex; flex-direction:column; gap:8px; padding:0; margin:0; width:100%;">';

  list.forEach((item, idx) => {
    const isHold = item.queue_status === 'HOLD';
    const queueNum = item.queue_order ? item.queue_order : (idx + 1);
    const badge = isHold 
      ? '<span class="badge badge-hold"><i class="fa-solid fa-pause"></i> HOLD</span>' 
      : `<span class="badge badge-waiting">คิว #${queueNum}</span>`;


    html += `
      <li style="background:var(--table-row-hover); padding:0.65rem 0.85rem; border-radius:10px; border:1px solid var(--card-border); width:100%; max-width:100%;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%;">
          <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1; overflow:hidden;">
            <strong style="color:var(--text-heading); font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.name)}</strong>
            <small style="color:var(--text-muted); font-size:0.78rem; flex-shrink:0;">(${item.emp_code})</small>
          </div>
          <div style="flex-shrink:0;">${badge}</div>
        </div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:3px; line-height:1.3; word-break:break-word;">
          <i class="fa-solid fa-briefcase" style="font-size:0.7rem; color:var(--accent);"></i> ${escapeHtml(item.position)} — <span style="color:var(--accent); font-weight:500;">${escapeHtml(item.department)}</span>
        </div>
      </li>
    `;
  });

  html += '</ul>';
  container.innerHTML = html;
}

function refreshAllSystemData() {
  loadDirectorSelectList();
  previewCandidates();
  loadDashboardStats();
  loadAllMissions();
  loadQueueView(currentQueueRole || 'DIRECTOR');
  loadPersonnelDropdown();
}

async function handleCreateMission(event) {
  event.preventDefault();

  const title = document.getElementById('alloc-title').value.trim();
  const location = document.getElementById('alloc-location').value.trim();
  const dressCode = document.getElementById('alloc-dress-code').value.trim();
  
  const startDate = document.getElementById('alloc-start-date').value;
  const startTime = document.getElementById('alloc-start-time').value;
  const endDate = document.getElementById('alloc-end-date').value;
  const endTime = document.getElementById('alloc-end-time').value;

  const desc = document.getElementById('alloc-desc').value.trim();

  if (!startDate || !endDate) {
    showToast('กรุณาเลือกวันที่เริ่มต้นและสิ้นสุด', 'warning');
    return;
  }

  const startFull = `${startDate} ${startTime}:00`;
  const endFull = `${endDate} ${endTime}:00`;

  const dirIds = previewedDirectors.map(d => d.personnel_id);
  const staffIds = previewedStaff.map(s => s.personnel_id);

  if (dirIds.length === 0 && staffIds.length === 0) {
    showToast('กรุณาเลือกหรือระบุจำนวนผู้ปฏิบัติงานก่อนยืนยัน', 'warning');
    return;
  }

  // 💡 ตรวจสอบไฟล์อัปโหลด หรือ ลิงก์แชร์เอกสาร (ถ้ามี)
  let attachmentUrl = '';
  let attachmentName = '';
  const fileInput = document.getElementById('alloc-attachment-file');
  const urlInput = document.getElementById('alloc-attachment-url')?.value.trim();

  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    const formData = new FormData();
    formData.append('attachment', fileInput.files[0]);
    showToast('กำลังอัปโหลดไฟล์แนบกำหนดการ...', 'info');
    try {
      const upRes = await fetch('/api/upload-attachment', {
        method: 'POST',
        body: formData
      });
      const upResult = await upRes.json();
      if (upResult.success) {
        attachmentUrl = upResult.file_url;
        attachmentName = upResult.file_name;
      }
    } catch (e) {
      console.error('File upload error:', e);
    }
  } else if (urlInput) {
    attachmentUrl = urlInput;
    attachmentName = 'เอกสารแนบกำหนดการ (ลิงก์แชร์ภายนอก)';
  }

    let currentUserName = 'ผู้ดูแลระบบ';
    const sessionUser = sessionStorage.getItem('fmo_user');
    if (sessionUser) {
      try {
        const u = JSON.parse(sessionUser);
        currentUserName = u.name || u.label || u.username || 'ผู้ดูแลระบบ';
      } catch(e){}
    }

    const res = await fetch('/api/missions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mission_title: title,
        location,
        dress_code: dressCode,
        start_date: startFull,
        end_date: endFull,
        schedule_details: desc,
        description: desc,
        assigned_director_ids: dirIds,
        assigned_staff_ids: staffIds,
        attachment_file: attachmentUrl,
        attachment_name: attachmentName,
        created_by: currentUserName
      })
    });
    const result = await res.json();

    if (result.success) {
      // 1. โชว์ Toast แจ้งเตือน
      showToast(`🎉 ${result.message}<br>⏰ เวลาปฏิบัติงาน: ${startTime} น. - ${endTime} น.`, 'success');
      
      // 2. เคลียร์ฟอร์ม
      document.getElementById('form-quick-mission').reset();
      const allocPrev = document.getElementById('alloc-attachment-preview');
      if (allocPrev) { allocPrev.style.display = 'none'; allocPrev.innerHTML = ''; }
      setDefaultMissionTimes();
      
      // 3. รีเฟรชข้อมูลทุกระบบทุกหน้าจอให้อัปเดตเป็นปัจจุบันเรียลไทม์ (ไม่ต้องกด F5)
      refreshAllSystemData();

      // 4. หน่วงเวลา 1.5 วินาที ให้ผู้ใช้อ่าน Toast ทัน แล้วค่อยสลับไปหน้ารายงาน
      setTimeout(() => {
        switchTab('reports');
      }, 1500); 
    } else {
      showToast(`Error: ${result.error}`, 'danger');
    }

  } catch (err) {
    console.error('Error creating activity:', err);
  }
}

function initAttachmentPreviewListeners() {
  const allocFile = document.getElementById('alloc-attachment-file');
  const allocUrl = document.getElementById('alloc-attachment-url');
  const allocPreview = document.getElementById('alloc-attachment-preview');

  function updateAllocPreview() {
    if (!allocPreview) return;
    if (allocFile && allocFile.files && allocFile.files.length > 0) {
      const f = allocFile.files[0];
      const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
      allocPreview.style.display = 'block';
      allocPreview.innerHTML = `<i class="fa-solid fa-file-pdf" style="color:#0284c7;"></i> <strong>ไฟล์ที่เลือกแนบจากเครื่อง:</strong> ${escapeHtml(f.name)} (${sizeMB} MB)`;
    } else if (allocUrl && allocUrl.value.trim()) {
      let url = allocUrl.value.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      allocPreview.style.display = 'block';
      allocPreview.innerHTML = `<i class="fa-solid fa-link" style="color:#0284c7;"></i> <strong>ลิงก์แชร์เอกสารแนบที่เลือก:</strong> <a href="${url}" target="_blank" style="text-decoration:underline; color:#0369a1; font-weight:bold;">${escapeHtml(url)}</a>`;
    } else {
      allocPreview.style.display = 'none';
      allocPreview.innerHTML = '';
    }
  }

  if (allocFile) allocFile.addEventListener('change', updateAllocPreview);
  if (allocUrl) {
    allocUrl.addEventListener('input', updateAllocPreview);
    allocUrl.addEventListener('change', updateAllocPreview);
  }

  const editFile = document.getElementById('edit-schedule-file');
  const editUrl = document.getElementById('edit-schedule-url');
  const editPreview = document.getElementById('edit-schedule-current-file');

  function updateEditPreview() {
    if (!editPreview) return;
    if (editFile && editFile.files && editFile.files.length > 0) {
      const f = editFile.files[0];
      const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
      editPreview.style.display = 'block';
      editPreview.innerHTML = `<i class="fa-solid fa-file-arrow-up" style="color:#ea580c;"></i> <strong>ไฟล์ใหม่ที่เลือกแนบ:</strong> ${escapeHtml(f.name)} (${sizeMB} MB)`;
    } else if (editUrl && editUrl.value.trim()) {
      let url = editUrl.value.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      editPreview.style.display = 'block';
      editPreview.innerHTML = `<i class="fa-solid fa-link" style="color:#ea580c;"></i> <strong>ลิงก์แชร์เอกสารแนบที่เลือก:</strong> <a href="${url}" target="_blank" style="text-decoration:underline; color:#c2410c; font-weight:bold;">${escapeHtml(url)}</a>`;
    }
  }

  if (editFile) editFile.addEventListener('change', updateEditPreview);
  if (editUrl) {
    editUrl.addEventListener('input', updateEditPreview);
    editUrl.addEventListener('change', updateEditPreview);
  }
}

// -------------------------------------------------------------
// INDIVIDUAL HISTORY VIEW (หน้าประวัติย้อนหลังรายบุคคล)
// -------------------------------------------------------------
async function loadPersonnelDropdown() {
  try {
    const res = await fetch('/api/personnel');
    const result = await res.json();

    if (result.success) {
      allPersonnelList = result.data;
      renderPersonnelSelectOptions(allPersonnelList);
    }
  } catch (err) {
    console.error('Error loading personnel:', err);
  }
}

function renderPersonnelSelectOptions(list) {
  const select = document.getElementById('indiv-select-person');
  if (!select) return;

  let html = '<option value="">-- กรุณาเลือกบุคลากร (ผอ. 8 ท่าน / พนักงาน 94 ท่าน) --</option>';

  const directors = list.filter(p => p.role_type === 'DIRECTOR');
  const staff = list.filter(p => p.role_type === 'STAFF');

  if (directors.length > 0) {
    html += '<optgroup label="ผอ.ฝ่าย (8 ท่าน)">';
    directors.forEach(d => {
      html += `<option value="${d.id}">[${d.emp_code}] ${escapeHtml(d.name)} - ${escapeHtml(d.position)}</option>`;
    });
    html += '</optgroup>';
  }

  if (staff.length > 0) {
    html += '<optgroup label="พนักงาน (94 ท่าน)">';
    staff.forEach((s) => {
      html += `<option value="${s.id}">[${s.emp_code}] ${escapeHtml(s.name)} - ${escapeHtml(s.department)} (ลำดับที่ ${s.queue_order})</option>`;
    });
    html += '</optgroup>';
  }

  select.innerHTML = html;
}

function filterPersonDropdown(keyword) {
  const select = document.getElementById('indiv-select-person');
  if (!keyword.trim()) {
    renderPersonnelSelectOptions(allPersonnelList);
    return;
  }

  const kw = keyword.toLowerCase().trim();
  const filtered = allPersonnelList.filter(p => 
    (p.name && p.name.toLowerCase().includes(kw)) || 
    (p.emp_code && p.emp_code.toLowerCase().includes(kw)) || 
    (p.position && p.position.toLowerCase().includes(kw))
  );

  renderPersonnelSelectOptions(filtered);

  if (filtered.length > 0 && select && select.options.length > 1) {
    select.selectedIndex = 1;
  }
}

function loadSelectedPerson() {
  const select = document.getElementById('indiv-select-person');
  const searchInput = document.getElementById('indiv-search-input');
  const keyword = searchInput ? searchInput.value.trim() : '';

  let personId = select ? select.value : '';

  if (!personId && keyword) {
    const kw = keyword.toLowerCase();
    const match = allPersonnelList.find(p => 
      (p.name && p.name.toLowerCase().includes(kw)) || 
      (p.emp_code && p.emp_code.toLowerCase().includes(kw)) || 
      (p.position && p.position.toLowerCase().includes(kw))
    );

    if (match) {
      personId = match.id;
      if (select) select.value = match.id;
    } else {
      showToast(`ไม่พบบุคลากรที่ตรงกับคำว่า "${keyword}"`, 'warning');
      return;
    }
  }

  if (personId) {
    loadIndividualHistory(personId);
  } else {
    showToast('กรุณาพิมพ์ชื่อ หรือเลือกรหัสบุคลากรเพื่อแสดงประวัติ', 'warning');
  }
}


async function loadIndividualHistory(personId) {
  if (!personId) return;

  try {
    const res = await fetch(`/api/history/individual/${personId}`);
    const result = await res.json();

    if (!result.success) {
      showToast(result.error, 'danger');
      return;
    }

    const { person, queueStatus, summary, historyByRound, activeRound } = result;

    document.getElementById('indiv-profile-card').style.display = 'block';

    const queueOrderLabel = person.role_type === 'DIRECTOR' 
      ? `ผอ.ฝ่ายลำดับที่ ${queueStatus ? queueStatus.queue_order : '-'}`
      : `พนักงานลำดับที่ ${queueStatus ? queueStatus.queue_order : '-'}`;

    document.getElementById('indiv-header-info').innerText = 
      `ข้อมูล: ${person.name} (${person.department}) | รหัสคิว: ${queueOrderLabel} (${person.emp_code})`;

    let statusText = `สถานะปัจจุบัน: อยู่ระหว่างรอรับกิจกรรมใน Round ${activeRound}`;
    if (queueStatus && queueStatus.status === 'HOLD') {
      statusText = `สถานะปัจจุบัน: ติดกิจกรรมซ้อน (Hold_In_Round) ใน Round ${queueStatus.current_round} — จะได้รับสิทธิ์ดึงคิวแรกสุดในกิจกรรมถัดไป`;
    } else if (queueStatus && queueStatus.status === 'COMPLETED') {
      statusText = `สถานะปัจจุบัน: ปฏิบัติกิจกรรมครบเรียบร้อยแล้วใน Round ${queueStatus.current_round} (เตรียมพร้อมสู่ Round ${queueStatus.current_round + 1})`;
    }
    document.getElementById('indiv-header-status').innerText = statusText;

    document.getElementById('indiv-header-summary').innerText = 
      `สรุปประวัติรวม: เข้าร่วมแล้ว ${summary.totalJoined} กิจกรรม | รวม ${summary.totalHours} ชั่วโมง | ${summary.attendanceNote}`;

    const container = document.getElementById('indiv-rounds-container');
    let html = '';

    const rounds = Object.keys(historyByRound).sort((a, b) => Number(a) - Number(b));

    if (rounds.length === 0) {
      html += `
        <div style="background:var(--input-bg); padding:1rem; border-radius:10px; margin-bottom:1rem; border:1px solid var(--card-border);">
          <h5 style="color:var(--primary); font-size:1rem; margin-bottom:6px;">Round 1</h5>
          <p style="color:var(--text-muted); font-size:0.9rem;">(รอการจัดสรรอัตโนมัติ)</p>
        </div>
      `;
    } else {
      rounds.forEach(r => {
        const roundMissions = historyByRound[r];
        html += `
          <div style="background:var(--input-bg); padding:1.25rem; border-radius:12px; margin-bottom:1.25rem; border:1px solid var(--card-border);">
            <h5 style="color:var(--primary); font-size:1.05rem; font-weight:700; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-rotate"></i> Round ${r}
            </h5>
            <div class="table-responsive">
              <table class="custom-table">
                <thead>
                  <tr>
                    <th>ชื่อกิจกรรม</th>
                    <th>วันที่ปฏิบัติกิจกรรม (เวลา 24 ชม.)</th>
                    <th>ระยะเวลา</th>
                    <th>การแต่งกาย</th>
                    <th>หัวหน้าคณะ (ผู้บริหาร/ผอ.ฝ่าย) / บริบทร่วม</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
        `;

        roundMissions.forEach(m => {
          let leaderContext = '-';
          if (person.role_type === 'STAFF') {
            leaderContext = m.director_leader_name 
              ? `ร่วมกับ ${m.director_leader_position || m.director_leader_name}` 
              : 'ร่วมกับ ผอ.ฝ่ายประจำกิจกรรม';
          } else {
            leaderContext = `ทำหน้าที่หัวหน้าคณะปฏิบัติการ (${m.location || 'อสป.'})`;
          }


          if (m.notes) {
            leaderContext += ` <br><small style="color:var(--warning);">${escapeHtml(m.notes)}</small>`;
          }

          const statusBadge = m.assignment_status === 'JOINED' 
            ? '<span class="badge badge-completed">เข้าร่วมเรียบร้อย</span>'
            : `<span class="badge badge-hold">เปลี่ยนตัว/ขอลา</span>`;

          html += `
            <tr>
              <td><strong style="color:var(--text-heading);">${escapeHtml(m.mission_title)}</strong></td>
              <td>${formatDate(m.start_date)}</td>
              <td>${m.duration_hours || 8} ชั่วโมง</td>
              <td>${escapeHtml(m.dress_code || 'ชุดปฏิบัติงาน อสป.')}</td>
              <td>${leaderContext}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        });

        html += `</tbody></table></div></div>`;
      });

      const nextPendingRound = Number(rounds[rounds.length - 1]) + 1;
      html += `
        <div style="background:var(--input-bg); padding:1rem 1.25rem; border-radius:12px; border:1px dashed var(--card-border); opacity:0.85;">
          <h5 style="color:var(--text-muted); font-size:0.95rem; margin-bottom:4px;">Round ${nextPendingRound}:</h5>
          <p style="color:var(--text-muted); font-size:0.88rem; font-style:italic;">(รอการจัดสรรอัตโนมัติ)</p>
        </div>
      `;
    }

    container.innerHTML = html;

  } catch (err) {
    console.error('Error loading individual history:', err);
  }
}

// -------------------------------------------------------------
// REPORTS & ALL MISSIONS / ACTIVITIES VIEW
// -------------------------------------------------------------
function isNewMission(createdAtStr) {
  if (!createdAtStr) return false;
  const createdTime = new Date(createdAtStr).getTime();
  if (isNaN(createdTime)) return false;
  const now = new Date().getTime();
  const diffHours = (now - createdTime) / (1000 * 60 * 60);
  return diffHours <= 48;
}

let allMissionsCache = [];

async function loadAllMissions() {
  const tbody = document.getElementById('all-missions-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">กำลังโหลดรายการกิจกรรม...</td></tr>';


  try {
    const res = await fetch('/api/missions');
    const result = await res.json();

    if (!result.success || result.missions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">ยังไม่มีรายการกิจกรรมในระบบ</td></tr>';
      return;
    }

    allMissionsCache = result.missions;
    resetMissionDateFilter();
  } catch (err) {
    console.error('Error loading all missions:', err);
  }
}

function renderMissionsTable(list) {
  const tbody = document.getElementById('all-missions-table-body');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:1.5rem; color:var(--text-muted);">ไม่พบรายการกิจกรรมตามเงื่อนไขที่เลือก</td></tr>';
    return;
  }

  let html = '';
  list.forEach(m => {
    const statusBadge = (m.status === 'SUCCESS' || m.status === 'COMPLETED')
      ? '<span class="badge badge-completed"><i class="fa-solid fa-circle-check"></i> SUCCESS</span>' 
      : '<span class="badge badge-waiting"><i class="fa-solid fa-clock"></i> SCHEDULED</span>';

    const isScheduled = m.status !== 'SUCCESS' && m.status !== 'COMPLETED';
    const isRecent = isNewMission(m.created_at || m.start_date);
    const newBadge = (isScheduled && isRecent) ? ' <span class="badge-new-pulse"><i class="fa-solid fa-bell fa-beat"></i> NEW</span>' : '';


    const creatorName = m.created_by || 'ผู้ดูแลระบบ';
    const createdAtFormatted = formatDate24h(m.created_at || m.start_date);

    html += `
      <tr style="cursor: pointer;" onclick="openMissionDetailModal(${m.id})" title="คลิกเพื่อดูรายละเอียดและเปลี่ยนตัว">
        <td><code>${m.mission_code || 'ACT-' + m.id}</code></td>
        <td>
          <strong style="color:var(--text-heading); font-size: 0.95rem;">${escapeHtml(m.mission_title)}</strong>${newBadge}
          <div style="font-size: 0.78rem; color: #64748b; margin-top: 3px; font-weight: 500;">
            <i class="fa-solid fa-user-pen" style="color:#0284c7;"></i> ${escapeHtml(creatorName)} | 
            <i class="fa-solid fa-clock" style="color:#0284c7;"></i> ${createdAtFormatted}
          </div>
        </td>
        <td>${escapeHtml(m.location || '-')}</td>
        <td>${escapeHtml(m.dress_code || 'ชุดปฏิบัติงาน อสป.')}</td>
        <td>${formatDate(m.start_date)}</td>
        <td><span class="badge badge-director">${m.directors_count} ท่าน</span></td>
        <td><span class="badge badge-staff">${m.staff_count} ท่าน</span></td>
        <td>${statusBadge}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn btn-secondary btn-sm" onclick="openMissionDetailModal(${m.id})">
            <i class="fa-solid fa-eye"></i> รายชื่อ & เปลี่ยนตัว
          </button>
        </td>
      </tr>
    `;

  });

  tbody.innerHTML = html;
}


function filterMissionsByDate() {
  const startInput = document.getElementById('report-start-date')?.value;
  const endInput = document.getElementById('report-end-date')?.value;
  const summaryEl = document.getElementById('report-filter-summary');

  if (!startInput && !endInput) {
    showToast('กรุณาเลือกวันที่เริ่มต้น หรือ วันที่สิ้นสุด', 'warning');
    return;
  }

  const filtered = allMissionsCache.filter(m => {
    if (!m.start_date) return false;
    const mDateStr = m.start_date.split(' ')[0];
    if (startInput && mDateStr < startInput) return false;
    if (endInput && mDateStr > endInput) return false;
    return true;
  });

  if (summaryEl) {
    summaryEl.textContent = `พบ ${filtered.length} จาก ${allMissionsCache.length} รายการ`;
  }

  renderMissionsTable(filtered);
}

function resetMissionDateFilter() {
  const startEl = document.getElementById('report-start-date');
  const endEl = document.getElementById('report-end-date');
  const summaryEl = document.getElementById('report-filter-summary');

  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  if (summaryEl) summaryEl.textContent = `กิจกรรมทั้งหมด (${allMissionsCache.length} รายการ)`;

  renderMissionsTable(allMissionsCache);
}

async function openMissionDetailModal(missionId) {
  try {
    const res = await fetch(`/api/missions/${missionId}`);
    const result = await res.json();

    if (!result.success) {
      showToast(result.error, 'danger');
      return;
    }

    const { mission, assigned = [] } = result;
    currentActiveMissionData = mission;

    const creatorName = mission.created_by || 'ผู้ดูแลระบบ';
    const createdAtFormatted = formatDate24h(mission.created_at || mission.start_date);

    document.getElementById('md-title').innerHTML = `
      <div style="font-size: 1.35rem; font-weight: 700; color: var(--text-heading);">${escapeHtml(mission.mission_title)}</div>
      <div style="font-size: 0.85rem; color: #475569; margin-top: 6px; font-weight: 500; background: #f8fafc; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <span><i class="fa-solid fa-user-pen" style="color: #0284c7;"></i> <strong>ผู้สร้างกิจกรรม:</strong> ${escapeHtml(creatorName)}</span>
        <span style="color: #cbd5e1;">|</span>
        <span><i class="fa-solid fa-clock" style="color: #0284c7;"></i> <strong>สร้างเมื่อ:</strong> ${createdAtFormatted}</span>
      </div>
    `;

    document.getElementById('md-location-time').innerText =
      `สถานที่: ${mission.location || '-'} | ` +
      `ช่วงเวลา: ${formatDate(mission.start_date)} - ` +
      `${formatDate(mission.end_date)}`;

    document.getElementById('md-dress-code').innerHTML =
      `การแต่งกาย: ${escapeHtml(mission.dress_code || 'ชุดปฏิบัติงาน อสป.')}` +
      (mission.attachment_file ? `<div style="margin-top:8px;"><a href="${mission.attachment_file}" target="_blank" class="btn btn-outline-primary btn-sm" style="font-weight:bold; padding:6px 14px; display:inline-flex; align-items:center; gap:6px; background:#f0f9ff; color:#0369a1; border:1px solid #0284c7;"><i class="fa-solid fa-file-arrow-down" style="font-size:1.1rem; color:#0284c7;"></i> 📄 ${escapeHtml(cleanFileName(mission.attachment_name))}</a></div>` : '') +
      `<div style="margin-top:10px;"><button type="button" class="btn btn-warning btn-sm" onclick="openEditScheduleModal(${mission.id})" style="font-weight:bold; background:#ea580c; border:none; color:#fff; padding:6px 12px;"><i class="fa-solid fa-calendar-pen"></i> ✏️ อัปเดตเปลี่ยนแปลงกำหนดการ & แจ้ง LINE อัตโนมัติ</button></div>`;

    const tbody =
      document.getElementById('md-assigned-body');




    if (!tbody) return;

    if (assigned.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6">ไม่มีข้อมูลผู้ได้รับจัดสรร</td></tr>';
    } else {
      let html = '';

      assigned.forEach(a => {
        const assignmentStatus = String(
          a.assignment_status || ''
        )
          .trim()
          .toUpperCase();

        const ackStatus = String(
          a.ack_status || ''
        )
          .trim()
          .toUpperCase();

        const roleBadge =
          Number(a.is_leader) === 1
            ? '<span class="badge badge-director">หัวหน้าคณะ</span>'
            : '<span class="badge badge-staff">สมาชิก</span>';


        // ---------------------------------------------------
        // สถานะที่แสดงในตาราง
        //
        // คนเดิม:
        // SUBSTITUTED / DECLINED_BUSY = ติดภารกิจ
        //
        // คนแทน:
        // JOINED + ACKNOWLEDGED = รับทราบแล้ว
        // ---------------------------------------------------
        let ackStatusBadge = '';

        if (
          assignmentStatus === 'DECLINED_NO_SUBSTITUTE'
        ) {
          ackStatusBadge = `
            <span class="badge badge-hold" style="background:#ef4444; color:white;">
              <i class="fa-solid fa-user-slash"></i>
              ขอลา (ไม่มีคนแทน)
            </span>
          `;
        } else if (
          assignmentStatus === 'SUBSTITUTED' ||
          ackStatus === 'DECLINED_BUSY'
        ) {
          ackStatusBadge = `
            <span class="badge badge-hold">
              <i class="fa-solid fa-circle-xmark"></i>
              ติดภารกิจ
            </span>
          `;
        } else if (ackStatus === 'ACKNOWLEDGED') {
          ackStatusBadge = `
            <span class="badge badge-completed">
              <i class="fa-solid fa-circle-check"></i>
              รับทราบแล้ว
            </span>
          `;
        } else {
          ackStatusBadge = `
            <span class="badge badge-waiting">
              <i class="fa-solid fa-clock"></i>
              รอการตอบรับ
            </span>
          `;
        }


        // ---------------------------------------------------
        // หมายเหตุ
        // ---------------------------------------------------
        let notesText = '-';

if (
  a.assignment_status === 'JOINED' &&
  a.substituted_for_personnel_id
) {
  notesText = `
    <small style="color:var(--warning);">
      ปฏิบัติงานแทน
      ${escapeHtml(
        a.substitute_for_name ||
        a.original_name ||
        ''
      )}
    </small>
  `;
}
else if (a.notes) {
  let cleanedNote = String(a.notes).trim();

  // ปฏิบัติงานแทน นาย ก (นาย ก)
  // ให้เหลือ ปฏิบัติงานแทน นาย ก
  cleanedNote = cleanedNote.replace(
    /^ปฏิบัติงานแทน\s+(.+?)\s*\(\s*\1\s*\)\s*$/i,
    'ปฏิบัติงานแทน $1'
  );

  notesText = `
    <small style="color:var(--warning);">
      ${escapeHtml(cleanedNote)}
    </small>
  `;
}

        if (
          assignmentStatus === 'SUBSTITUTED' ||
          ackStatus === 'DECLINED_BUSY'
        ) {
          notesText = `
            <span class="badge badge-hold">
              ส่งตัวแทนแล้ว
            </span>
            <br>
            ${notesText}
          `;
        } else if (
          assignmentStatus === 'JOINED' &&
          a.substituted_for_personnel_id
        ) {
          notesText = `
            <span
              class="badge badge-completed"
              style="margin-bottom:4px;"
            >
              ผู้ปฏิบัติงานแทน
            </span>
            <br>
            ${notesText}
          `;
        }

        // ---------------------------------------------------
        // ปุ่มดำเนินการ (เปลี่ยนตัวฉุกเฉิน / ตอบรับ)
        // แสดงปุ่มเปลี่ยนตัวจนกว่าจะเลยวันเวลาสิ้นสุดกิจกรรม (end_date)
        // ---------------------------------------------------
        let actionBtn = '-';
        const missionEndDate = mission.end_date ? new Date(String(mission.end_date).replace(' ', 'T')) : null;
        const isMissionEnded = missionEndDate && !isNaN(missionEndDate.getTime()) ? (new Date() > missionEndDate) : false;

        if (assignmentStatus === 'JOINED') {
          const safeName = String(a.name || '').replace(/'/g, "\\'");
          actionBtn = `
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              ${ackStatus !== 'ACKNOWLEDGED' ? `
                <button class="btn btn-primary btn-sm" onclick="respondToMission(${mission.id}, ${a.personnel_id}, 'ACKNOWLEDGED')">
                  <i class="fa-solid fa-check"></i> รับทราบ
                </button>
              ` : ''}
              ${!isMissionEnded ? `
                <button class="btn btn-warning btn-sm" onclick="openSubstituteModal(${mission.id}, ${a.personnel_id}, '${safeName}')">
                  <i class="fa-solid fa-rotate"></i> เปลี่ยนตัว
                </button>
              ` : ''}
            </div>
          `;
        }

        html += `
          <tr>
            <td>${roleBadge}</td>

            <td>
              <code>${escapeHtml(a.emp_code || '-')}</code>
            </td>

            <td>
              <strong style="color:var(--text-heading);">
                ${escapeHtml(a.name || '-')}
              </strong>
            </td>

            <td>
              ${escapeHtml(a.position || '-')}
              (${escapeHtml(a.department || '-')})
            </td>

            <td>
              ${ackStatusBadge}
              <br>
              ${notesText}
            </td>

            <td class="no-print">
              ${actionBtn}
            </td>
          </tr>
        `;
      });

      tbody.innerHTML = html;
    }

    openModal('modal-mission-detail');
  } catch (err) {
    console.error(
      'Error loading activity details:',
      err
    );

    showToast(
      'ไม่สามารถโหลดรายละเอียดกิจกรรมได้',
      'danger'
    );
  }
}

async function respondToMission(missionId, personnelId, status) {
  let substituteEmpCode = '';

  // 1. ถ้ากดปุ่ม "ติดภารกิจ" ให้ใช้ SweetAlert2 มีตัวเลือก มีคนแทน / ไม่มีคนแทน
  if (status === 'DECLINED_BUSY') { 
    const { value: option } = await Swal.fire({
      title: '<span style="font-size: 20px;">🔴 แจ้งติดภารกิจ / ขอลา</span>',
      html: `
        <p style="color:#64748b; font-size:14px; margin-bottom:15px;">กรุณาเลือกรูปแบบการติดภารกิจ</p>
        <div style="display:flex; flex-direction:column; gap:10px; text-align:left;">
          <label style="display:flex; align-items:center; gap:8px; padding:12px; border:1px solid #cbd5e1; border-radius:8px; cursor:pointer; background:#f8fafc;">
            <input type="radio" name="declined_type" value="NO_SUB" checked style="width:18px; height:18px;">
            <div>
              <strong style="color:#0f172a;">🟡 ไม่มีผู้ปฏิบัติงานแทน (ขอลา)</strong>
              <div style="font-size:12px; color:#64748b; margin-top:2px;">ถือว่าใช้สิทธิ์ในรอบนี้แล้ว ระบบจะเลื่อนคิวถัดไปให้อัตโนมัติ</div>
            </div>
          </label>
          <label style="display:flex; align-items:center; gap:8px; padding:12px; border:1px solid #cbd5e1; border-radius:8px; cursor:pointer; background:#f8fafc;">
            <input type="radio" name="declined_type" value="HAS_SUB" style="width:18px; height:18px;">
            <div>
              <strong style="color:#0f172a;">🟢 มีผู้ปฏิบัติงานแทน</strong>
              <div style="font-size:12px; color:#64748b; margin-top:2px;">ระบุรหัสพนักงานตัวแทนที่ตกลงปฏิบัติงานแทน</div>
            </div>
          </label>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'ถัดไป',
      cancelButtonText: 'ยกเลิก',
      width: '420px',
      customClass: { popup: 'rounded-popup' },
      preConfirm: () => {
        const selected = document.querySelector('input[name="declined_type"]:checked');
        return selected ? selected.value : 'NO_SUB';
      }
    });

    if (!option) return;

    if (option === 'NO_SUB') {
      const { value: reason } = await Swal.fire({
        title: 'ระบุเหตุผลการขอลา',
        input: 'textarea',
        inputPlaceholder: 'เช่น ติดภารกิจด่วนองค์กร, ลาป่วย, ลาพักผ่อน...',
        showCancelButton: true,
        confirmButtonText: 'ยืนยันขอลา',
        cancelButtonText: 'ยกเลิก',
        width: '400px',
        customClass: { popup: 'rounded-popup', input: 'rounded-input' }
      });

      if (reason === undefined) return;

      try {
        const res = await fetch('/api/missions/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mission_id: missionId,
            personnel_id: personnelId,
            response_status: 'DECLINED_NO_SUBSTITUTE',
            decline_reason: (reason || '').trim() || 'ติดภารกิจ/ขอลา (ไม่มีคนแทน)'
          })
        });
        const result = await res.json();

        if (result.success) {
          showToast(`🎉 ${result.message}`, 'success');
          openMissionDetailModal(missionId);
          loadDashboardStats();
          loadAllMissions();
          previewCandidates();
        } else {
          showToast(`Error: ${result.error}`, 'danger');
        }
      } catch (err) {
        console.error('Error declining mission:', err);
      }
      return;
    } else if (option === 'HAS_SUB') {
      const { value: empCode } = await Swal.fire({
        title: '<span style="font-size: 20px;">ระบุตัวแทนปฏิบัติหน้าที่</span>',
        input: 'text',
        inputLabel: 'กรุณากรอกรหัสพนักงาน (EMP-XXX หรือ DIR-XX)',
        inputPlaceholder: 'เช่น EMP-001',
        showCancelButton: true,
        confirmButtonText: 'บันทึกข้อมูล',
        cancelButtonText: 'ยกเลิก',
        width: '420px',
        customClass: { popup: 'rounded-popup', input: 'rounded-input' },

        inputValidator: (value) => {
          if (!value) return 'กรุณาระบุรหัสพนักงานตัวแทน!';
        }
      });

      if (!empCode) return;
      substituteEmpCode = empCode.trim();
    }
  }

  // 2. ส่งข้อมูลไปที่หลังบ้านสำหรับกรณีมีตัวแทน หรือ ACKNOWLEDGED
  try {
    const res = await fetch('/api/missions/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mission_id: missionId,
        personnel_id: personnelId,
        response_status: status, 
        substitute_emp_code: substituteEmpCode
      })
    });
    const result = await res.json();

    if (result.success) {
      showToast(`🎉 ${result.message}`, 'success');
      openMissionDetailModal(missionId);
      loadDashboardStats();
      loadAllMissions();
      previewCandidates();
    } else {
      showToast(`Error: ${result.error}`, 'danger');
    }
  } catch (err) {
    console.error('Error responding to mission:', err);
  }
}


function switchNotifSubTab(tabName) {
  const ackSec = document.getElementById('notif-subtab-ack');
  const sysSec = document.getElementById('notif-subtab-system');
  const btnAck = document.getElementById('btn-notif-tab-ack');
  const btnSys = document.getElementById('btn-notif-tab-system');

  if (tabName === 'ack') {
    if (ackSec) ackSec.style.display = 'block';
    if (sysSec) sysSec.style.display = 'none';
    if (btnAck) btnAck.className = 'btn btn-sm btn-primary';
    if (btnSys) btnSys.className = 'btn btn-sm btn-secondary';
  } else {
    if (ackSec) ackSec.style.display = 'none';
    if (sysSec) sysSec.style.display = 'block';
    if (btnAck) btnAck.className = 'btn btn-sm btn-secondary';
    if (btnSys) btnSys.className = 'btn btn-sm btn-primary';
  }
}

async function openNotificationLogsModal() {
  openModal('modal-notif-logs');
  switchNotifSubTab('ack');

  const ackBody = document.getElementById('notif-ack-body');
  const sysBody = document.getElementById('notif-logs-body');

  if (ackBody) ackBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-muted);">กำลังโหลดประวัติการรับทราบ...</td></tr>';
  if (sysBody) sysBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:1.5rem; color:var(--text-muted);">กำลังโหลดประวัติระบบ...</td></tr>';

  try {
    const res = await fetch('/api/notifications/logs');
    const result = await res.json();
    if (!result.success) return;

    // 1. Render Acknowledgement Status
    if (ackBody) {
      if (!result.acknowledgements || result.acknowledgements.length === 0) {
        ackBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-muted);">ยังไม่มีประวัติการรับทราบ</td></tr>';
      } else {
        let ackHtml = '';
        result.acknowledgements.forEach(a => {
          const lineUser = String(a.line_user_id || '').trim().toLowerCase();
          const isLineChannel = lineUser !== '' && lineUser !== 'email' && lineUser !== 'null';

          let channelBadge = '';
          if (a.ack_status === 'ACKNOWLEDGED') {
            if (isLineChannel) {
              channelBadge = '<span class="badge" style="background:#06c755; color:#ffffff; font-weight:700;"><i class="fa-brands fa-line"></i> รับทราบจาก LINE</span>';
            } else {
              channelBadge = '<span class="badge badge-completed"><i class="fa-solid fa-envelope"></i> รับทราบจาก อีเมล</span>';
            }
          } else if (a.ack_status === 'DECLINED_BUSY' || a.assignment_status === 'DECLINED_NO_SUBSTITUTE') {
            channelBadge = '<span class="badge badge-hold"><i class="fa-solid fa-user-minus"></i> ติดภารกิจ/ขอลา</span>';
          } else {
            channelBadge = isLineChannel 
              ? '<span class="badge badge-waiting"><i class="fa-brands fa-line"></i> รอรับทราบ (LINE)</span>'
              : '<span class="badge badge-waiting"><i class="fa-solid fa-envelope"></i> รอรับทราบ (Email)</span>';
          }

          ackHtml += `
            <tr>
              <td><strong>${escapeHtml(a.person_name)}</strong> <small style="color:var(--text-muted);">(${escapeHtml(a.emp_code)})</small></td>
              <td><strong style="color:var(--text-heading);">${escapeHtml(a.mission_title)}</strong></td>
              <td>${channelBadge}</td>
              <td>${a.ack_at ? formatDate(a.ack_at) : '<span style="color:var(--text-muted);">-</span>'}</td>
            </tr>
          `;
        });
        ackBody.innerHTML = ackHtml;
      }
    }

    // 2. Render System Logs
    if (sysBody) {
      if (!result.logs || result.logs.length === 0) {
        sysBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:1.5rem; color:var(--text-muted);">ยังไม่มีประวัติการส่งระบบ</td></tr>';
      } else {
        let sysHtml = '';
        result.logs.forEach(l => {
          const isLine = l.channel === 'LINE_GROUP' || l.channel === 'LINE';
          const channelBadge = isLine 
            ? '<span class="badge" style="background:#06c755; color:#ffffff; font-weight:700;"><i class="fa-brands fa-line"></i> LINE Push</span>'
            : '<span class="badge badge-waiting"><i class="fa-solid fa-envelope"></i> Email</span>';

          let contentPreview = escapeHtml(l.content_body || '-');
          if (isLine && l.content_body && l.content_body.startsWith('{')) {
            contentPreview = renderLineFlexCardHtml(l.content_body);
          } else {
            contentPreview = `<small style="color:var(--text-muted); font-size:0.78rem;">${contentPreview.slice(0, 120)}...</small>`;
          }

          sysHtml += `
            <tr>
              <td>${channelBadge}</td>
              <td><strong>${escapeHtml(l.recipient || '-')}</strong></td>
              <td><strong>${escapeHtml(l.subject_title || '-')}</strong></td>
              <td>${contentPreview}</td>
              <td>${formatDate(l.sent_at)}</td>
            </tr>
          `;
        });
        sysBody.innerHTML = sysHtml;
      }
    }
  } catch (err) {
    console.error('Error loading notification logs modal:', err);
  }
}


function renderLineFlexCardHtml(jsonStr) {
  try {
    const card = JSON.parse(jsonStr);
    const bubble = card.contents || {};
    const header = bubble.header || {};
    const headerTitle = header.contents && header.contents[1] ? header.contents[1].text : 'LINE Notification';
    const headerBg = header.backgroundColor || '#0284c7';

    return `
      <div style="background:#ffffff; color:#0f172a; border-radius:12px; overflow:hidden; border:1px solid #cbd5e1; max-width:320px; box-shadow:0 6px 18px rgba(0,0,0,0.15); font-family:sans-serif; text-align:left;">
        <div style="background:${headerBg}; padding:10px 14px; color:#ffffff;">
          <div style="font-size:0.6rem; font-weight:700; color:#e0f2fe; letter-spacing:1px;">FMO SMART QUEUE SYSTEM</div>
          <div style="font-size:0.9rem; font-weight:700; margin-top:2px;">${escapeHtml(headerTitle)}</div>
        </div>
        <div style="padding:12px 14px; font-size:0.8rem; line-height:1.4;">
          <div style="font-weight:700; font-size:0.88rem; margin-bottom:6px; color:#0f172a;">${escapeHtml(card.altText || '')}</div>
          <div style="background:#fef3c7; color:#b45309; padding:6px 8px; border-radius:6px; font-size:0.72rem; font-weight:600; margin-top:8px;">
            ⏱️ กรุณาเดินทางมาถึงก่อนเวลาเริ่ม 30 นาที
          </div>
        </div>
        <div style="padding:8px 12px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; gap:6px;">
          <button style="flex:1; background:#10b981; color:#fff; border:none; padding:6px; border-radius:6px; font-weight:bold; font-size:0.75rem;">🟢 กดรับทราบ</button>
          <button style="flex:1; background:#ef4444; color:#fff; border:none; padding:6px; border-radius:6px; font-weight:bold; font-size:0.75rem;">🔴 ติดภารกิจ(ส่งคนแทน)</button>
        </div>
      </div>
    `;
  } catch (e) {
    return `<pre style="font-size:0.72rem; max-height:120px; overflow:auto;">${escapeHtml(jsonStr)}</pre>`;
  }
}

// -------------------------------------------------------------
// EXPORT SUMMARY DATA
// -------------------------------------------------------------
async function exportSummaryData() {
  try {
    const res = await fetch('/api/reports/export');
    const result = await res.json();

    if (!result.success) {
      showToast(`Export Error: ${result.error || 'ไม่สามารถดึงข้อมูลได้'}`, 'danger');
      return;
    }

    // 💡 1. เพิ่มการรับค่า swapHistory ที่ส่งมาจากหลังบ้าน
    const { missions = [], personnel = [], swapHistory = [] } = result;

    // UTF-8 BOM for Thai language in Microsoft Excel
    let csvContent = '\uFEFF';

    // SECTION 1: MISSIONS SUMMARY
    csvContent += '=== รายงานสรุปกิจกรรมทั้งหมด (FMO SMART QUEUE) ===\n';
    csvContent += '"รหัสกิจกรรม","ชื่อกิจกรรม","สถานที่","การแต่งกาย","วันที่เริ่ม (เวลา 24 ชม.)","ผอ.ฝ่าย (ท่าน)","พนักงาน (ท่าน)","สถานะ"\n';

    missions.forEach(m => {
      const title = `"${(m.mission_title || '').replace(/"/g, '""')}"`;
      const location = `"${(m.location || '-').replace(/"/g, '""')}"`;
      const dress = `"${(m.dress_code || 'ชุดปฏิบัติงาน อสป.').replace(/"/g, '""')}"`;
      const startDate = `"${formatDate(m.start_date)}"`;
      const dirCount = `"${m.directors_count || 0}"`;
      const staffCount = `"${m.staff_count || 0}"`;
      const status = `"${m.status || 'SCHEDULED'}"`;

      csvContent += `"ACT-${m.id}",${title},${location},${dress},${startDate},${dirCount},${staffCount},${status}\n`;
    });

    // SECTION 2: PERSONNEL QUEUE REPORT
    csvContent += '\n=== รายงานสรุปประวัติบุคลากรและการวนคิว (PERSONNEL QUEUE REPORT) ===\n';
    // 💡 2. เพิ่มคอลัมน์ "ส่งตัวแทน/ติดภารกิจ (ครั้ง)"
    csvContent += '"รหัสพนักงาน","ชื่อ-นามสกุล","ตำแหน่ง","หน่วยงาน/ฝ่าย","บทบาท","ลำดับคิว","สถานะในคิว","เข้าร่วมกิจกรรมสะสม (ครั้ง)","ส่งตัวแทน/ติดภารกิจ (ครั้ง)","เข้าร่วมล่าสุด"\n';

    personnel.forEach(p => {
      const code = `"${(p.emp_code || '').replace(/"/g, '""')}"`;
      const name = `"${(p.name || '').replace(/"/g, '""')}"`;
      const pos = `"${(p.position || '').replace(/"/g, '""')}"`;
      const dept = `"${(p.department || '').replace(/"/g, '""')}"`;
      const role = `"${p.role_type === 'DIRECTOR' ? 'ผอ.ฝ่าย' : 'พนักงาน'}"`;
      const qOrder = `"${p.queue_order || '-'}"`;
      const qStatus = `"${p.queue_status || 'WAITING'}"`;
      const totalJoined = `"${p.total_missions_joined || 0}"`;
      const totalSubstituted = `"${p.total_substituted || 0}"`; // 💡 ดึงค่านับจำนวนครั้งที่ส่งตัวแทน
      const lastAssigned = `"${p.last_assigned_at ? formatDate(p.last_assigned_at) : '-'}"`;

      csvContent += `${code},${name},${pos},${dept},${role},${qOrder},${qStatus},${totalJoined},${totalSubstituted},${lastAssigned}\n`;
    });

    // 💡 3. SECTION 3: SWAP HISTORY (เพิ่มส่วนใหม่สำหรับประวัติการสลับคิวโดยเฉพาะ)
    csvContent += '\n=== รายงานประวัติการส่งตัวแทนและสลับคิว (SWAP & SUBSTITUTE HISTORY) ===\n';
    csvContent += '"ชื่อกิจกรรม","รหัสพนักงาน (เดิม)","ชื่อ-นามสกุล (ผู้ติดภารกิจ)","สถานะ","หมายเหตุ/ชื่อตัวแทน","วันที่ทำรายการ"\n';

    swapHistory.forEach(s => {
      const mTitle = `"${(s.mission_title || '').replace(/"/g, '""')}"`;
      const pCode = `"${(s.emp_code || '').replace(/"/g, '""')}"`;
      const pName = `"${(s.original_person || '').replace(/"/g, '""')}"`;
      const aStatus = `"${(s.assignment_status || '').replace(/"/g, '""')}"`;
      
      // ดึงหมายเหตุจากฐานข้อมูล (ช่อง decline_reason หรือ notes)
      const noteStr = s.substitute_note || s.additional_notes || '-';
      const pNote = `"${noteStr.replace(/"/g, '""')}"`;
      const actionDate = `"${s.action_date ? formatDate(s.action_date) : '-'}"`;

      csvContent += `${mTitle},${pCode},${pName},${aStatus},${pNote},${actionDate}\n`;
    });

    // สร้างไฟล์และดาวน์โหลด
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `FMO_Smart_Queue_Report_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);

    showToast('📊 ส่งออกข้อมูลสรุปเป็นไฟล์ CSV (พร้อมประวัติการส่งตัวแทน) เรียบร้อยแล้ว!', 'success');
  } catch (err) {
    console.error('Export CSV error:', err);
    showToast('เกิดข้อผิดพลาดในการส่งออกไฟล์ CSV', 'danger');
  }
}
let activeModalStack = [];

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  if (!activeModalStack.includes(modalId)) {
    activeModalStack.push(modalId);
  }

  modal.classList.add('active');
  // Dynamic Z-Index ป้องกัน Modal ทับซ้อน
  modal.style.zIndex = 1000 + (activeModalStack.length * 20);
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    modal.style.zIndex = '';
  }
  activeModalStack = activeModalStack.filter(id => id !== modalId);
}

// ปิด Modal บนสุดเมื่อกด ESC บนคีย์บอร์ด
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeModalStack.length > 0) {
    const topModalId = activeModalStack[activeModalStack.length - 1];
    closeModal(topModalId);
  }
});

function showConfirmModal({
  title = 'ยืนยันการทำรายการ',
  message = 'คุณต้องการดำเนินการต่อหรือไม่?',
  icon = 'fa-circle-question text-cyan',
  confirmText = 'ยืนยัน',
  cancelText = 'ยกเลิก',
  confirmBtnStyle = 'background: #0ea5e9; border-color: #0ea5e9;',
  onConfirm = null
}) {
  const iconElem = document.getElementById('custom-confirm-icon');
  const titleElem = document.getElementById('custom-confirm-title');
  const msgElem = document.getElementById('custom-confirm-message');
  let okBtn = document.getElementById('custom-confirm-ok-btn');
  let cancelBtn = document.getElementById('custom-confirm-cancel-btn');

  if (iconElem) iconElem.innerHTML = `<i class="fa-solid ${icon}"></i>`;
  if (titleElem) titleElem.textContent = title;
  if (msgElem) msgElem.textContent = message;

  if (okBtn) {
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    okBtn = newOkBtn;
    okBtn.textContent = confirmText;
    okBtn.setAttribute('style', `min-width: 120px; padding: 0.65rem 1.25rem; font-weight: 600; ${confirmBtnStyle}`);
    okBtn.addEventListener('click', () => {
      closeModal('modal-custom-confirm');
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    });
  }

  if (cancelBtn) {
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    cancelBtn = newCancelBtn;
    cancelBtn.textContent = cancelText;
    cancelBtn.addEventListener('click', () => {
      closeModal('modal-custom-confirm');
    });
  }

  openModal('modal-custom-confirm');
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
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

// -------------------------------------------------------------
// IMPORT REAL PERSONNEL DATA (CSV)
// -------------------------------------------------------------
function openImportCsvModal() {
  document.getElementById('csv-file-input').value = '';
  document.getElementById('csv-text-input').value = '';
  openModal('modal-import-csv');
}

function downloadCsvTemplate() {
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', '/FMO_Real_Personnel_Dataset.csv');
  downloadAnchor.setAttribute('download', `FMO_Real_Personnel_Dataset_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}



function filterUserList() {
  const search = document.getElementById('user-search-input')?.value.toLowerCase().trim() || '';
  const role = document.getElementById('user-role-filter')?.value || 'ALL';
  const dept = document.getElementById('user-dept-filter')?.value || 'ALL';
  const line = document.getElementById('user-line-filter')?.value || 'ALL';

  let filtered = allUsersData.filter(u => {
    const matchSearch = !search ||
      (u.name && u.name.toLowerCase().includes(search)) ||
      (u.emp_code && u.emp_code.toLowerCase().includes(search)) ||
      (u.position && u.position.toLowerCase().includes(search)) ||
      (u.department && u.department.toLowerCase().includes(search));

    const matchRole = role === 'ALL' || u.role_type === role;

    const matchDept = dept === 'ALL' || (u.department && u.department.trim() === dept);

    const isLineConnected = Boolean(u.line_user_id && u.line_user_id.trim() !== '' && u.line_user_id.toLowerCase() !== 'email');
    const matchLine = line === 'ALL' || 
      (line === 'CONNECTED' && isLineConnected) || 
      (line === 'DISCONNECTED' && !isLineConnected);

    return matchSearch && matchRole && matchDept && matchLine;
  });

  renderUserTable(filtered);
}

function resetUserFilters() {
  const sInput = document.getElementById('user-search-input');
  if (sInput) sInput.value = '';
  const rFilter = document.getElementById('user-role-filter');
  if (rFilter) rFilter.value = 'ALL';
  const dFilter = document.getElementById('user-dept-filter');
  if (dFilter) dFilter.value = 'ALL';
  const lFilter = document.getElementById('user-line-filter');
  if (lFilter) lFilter.value = 'ALL';
  filterUserList();
}

function populateDepartmentFilterOptions() {
  const deptSelect = document.getElementById('user-dept-filter');
  if (!deptSelect) return;

  const currentVal = deptSelect.value;
  const depts = new Set();
  allUsersData.forEach(u => {
    if (u.department && u.department.trim()) {
      depts.add(u.department.trim());
    }
  });

  const sortedDepts = Array.from(depts).sort();
  let html = '<option value="ALL">ทุกสังกัด / ฝ่าย</option>';
  sortedDepts.forEach(d => {
    html += `<option value="${d}">${d}</option>`;
  });
  deptSelect.innerHTML = html;
  if (sortedDepts.includes(currentVal)) {
    deptSelect.value = currentVal;
  }
}

function updateUserLineStats() {
  const totalCount = allUsersData.length;
  const connectedCount = allUsersData.filter(u => u.line_user_id && u.line_user_id.trim() !== '' && u.line_user_id.toLowerCase() !== 'email').length;
  const disconnectedCount = totalCount - connectedCount;
  const percentage = totalCount > 0 ? Math.round((connectedCount / totalCount) * 100) : 0;

  const cElem = document.getElementById('line-connected-count');
  const tElem = document.getElementById('line-total-count');
  const pElem = document.getElementById('line-percentage');

  if (cElem) cElem.textContent = connectedCount;
  if (tElem) tElem.textContent = totalCount;
  if (pElem) pElem.textContent = `${percentage}%`;

  const lFilter = document.getElementById('user-line-filter');
  if (lFilter) {
    const currentLineVal = lFilter.value;
    lFilter.innerHTML = `
      <option value="ALL">สถานะ LINE ทั้งหมด (${totalCount} คน)</option>
      <option value="CONNECTED">🟢 ผูกบัญชี LINE แล้ว (${connectedCount} / ${totalCount} คน)</option>
      <option value="DISCONNECTED">⚪ ยังไม่ได้ผูก LINE (${disconnectedCount} คน)</option>
    `;
    lFilter.value = currentLineVal || 'ALL';
  }
}

function toggleSelectAllMenuPermissions(isChecked) {
  const checkboxes = document.querySelectorAll('.menu-perm-cb');
  checkboxes.forEach(cb => {
    if (!cb.disabled) {
      cb.checked = isChecked;
    }
  });
}

function updateSelectAllState() {
  const checkboxes = Array.from(document.querySelectorAll('.menu-perm-cb'));
  const selectAllCb = document.getElementById('menu-perm-select-all');
  if (!selectAllCb) return;

  const enabledCbs = checkboxes.filter(cb => !cb.disabled);
  if (enabledCbs.length === 0) return;

  const allChecked = enabledCbs.every(cb => cb.checked);
  selectAllCb.checked = allChecked;
}

function togglePermissionChecklist(roleType) {
  const checkboxes = document.querySelectorAll('.menu-perm-cb');
  const selectAllCb = document.getElementById('menu-perm-select-all');

  // 💡 ปลดล็อกช่องสิทธิ์เมนูทั้งหมด ไม่ล็อกสีเทา (disabled) เพื่อให้แอดมินแก้ไขสิทธิ์ได้อิสระสำหรับทุกบทบาท
  checkboxes.forEach(cb => {
    cb.disabled = false;
  });

  if (selectAllCb) {
    selectAllCb.disabled = false;
  }

  updateSelectAllState();
}




function openUserModal(userId = null) {
  document.getElementById('user-form-id').value = userId || '';
  document.getElementById('user-modal-title').innerHTML = userId
    ? `<i class="fa-solid fa-user-pen text-purple"></i> แก้ไขข้อมูลผู้ใช้งาน & สิทธิ์`
    : `<i class="fa-solid fa-user-plus text-purple"></i> เพิ่มผู้ใช้งานใหม่`;

  if (userId) {
    const user = allUsersData.find(u => Number(u.id) === Number(userId));
    if (user) {
      document.getElementById('user-form-emp-code').value = user.emp_code || '';
      document.getElementById('user-form-name').value = user.name || '';
      document.getElementById('user-form-role').value = user.role_type || 'STAFF';
      document.getElementById('user-form-position').value = user.position || '';
      document.getElementById('user-form-department').value = user.department || '';
      document.getElementById('user-form-phone').value = user.phone || '';
      document.getElementById('user-form-email').value = user.email || '';
      document.getElementById('user-form-password').value = '';

      let perms = [];
      try { perms = typeof user.menu_permissions === 'string' ? JSON.parse(user.menu_permissions) : (user.menu_permissions || []); } catch(e){}
      document.querySelectorAll('.menu-perm-cb').forEach(cb => {
        cb.checked = perms.includes(cb.value);
      });
      togglePermissionChecklist(user.role_type);
    }
  } else {
    document.getElementById('user-form-emp-code').value = '';
    document.getElementById('user-form-name').value = '';
    document.getElementById('user-form-role').value = 'STAFF';
    document.getElementById('user-form-position').value = '';
    document.getElementById('user-form-department').value = '';
    document.getElementById('user-form-phone').value = '';
    document.getElementById('user-form-email').value = '';
    document.getElementById('user-form-password').value = '';
    togglePermissionChecklist('STAFF');
  }

  openModal('modal-user-form');
}

async function saveUser() {
  const id = document.getElementById('user-form-id').value;
  const emp_code = document.getElementById('user-form-emp-code').value.trim();
  const name = document.getElementById('user-form-name').value.trim();
  const role_type = document.getElementById('user-form-role').value;
  const position = document.getElementById('user-form-position').value.trim();
  const department = document.getElementById('user-form-department').value.trim();
  const phone = document.getElementById('user-form-phone').value.trim();
  const email = document.getElementById('user-form-email').value.trim();
  const password = document.getElementById('user-form-password').value.trim();

  const selectedPerms = Array.from(document.querySelectorAll('.menu-perm-cb:checked')).map(cb => cb.value);

  if (!emp_code || !name) {
    Swal.fire('ข้อผิดพลาด', 'กรุณากรอกรหัสพนักงาน/Username และชื่อ-นามสกุลให้ครบถ้วน', 'warning');
    return;
  }

  const payload = { emp_code, name, role_type, position, department, phone, email, password, menu_permissions: selectedPerms };

  try {
    const url = id ? `/api/users/${id}` : '/api/users';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      closeModal('modal-user-form');
      Swal.fire('สำเร็จ', data.message, 'success');
      loadUserManagementView();
    } else {
      Swal.fire('ข้อผิดพลาด', data.error, 'error');
    }
  } catch (err) {
    console.error('Error saving user:', err);
    Swal.fire('ข้อผิดพลาด', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อบันทึกข้อมูลผู้ใช้งานได้', 'error');
  }
}


async function sendPreEventReminders() {
  showConfirmModal({
    title: '🔔 ส่งเตือนความจำล่วงหน้า',
    message: 'คุณต้องการส่งข้อความแจ้งเตือนเตือนความจำล่วงหน้า (24 ชั่วโมงก่อนเริ่มงาน) ผ่านทาง LINE ไปยังผู้ปฏิบัติงานหรือไม่?',
    icon: 'fa-bell text-amber',
    confirmText: 'ส่งแจ้งเตือน',
    confirmBtnStyle: 'background: #f59e0b; border-color: #f59e0b; font-weight: bold;',
    onConfirm: async () => {
      showToast('กำลังส่งแจ้งเตือนเตือนความจำล่วงหน้าทาง LINE...', 'info');

      try {
        const res = await fetch('/api/notifications/pre-event-reminders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const result = await res.json();

        if (result.success) {
          showToast(result.message || 'ส่งเตือนความจำล่วงหน้าเรียบร้อยแล้ว', 'success');
        } else {
          showToast(result.error || 'เกิดข้อผิดพลาดในการส่งเตือนความจำ', 'danger');
        }
      } catch (err) {
        console.error('Error sending pre-event reminders:', err);
        showToast('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', 'danger');
      }
    }
  });
}

// -------------------------------------------------------------
// PEER SWAP REQUEST & APPROVAL SYSTEM (ข้อ 5)
// -------------------------------------------------------------
let peerSwapMembersCache = [];

async function openPeerSwapModal(forcedRole) {
  const roleToLoad = forcedRole || currentQueueRole || 'DIRECTOR';
  const roleSelect = document.getElementById('swap-role-type');
  if (roleSelect) roleSelect.value = roleToLoad;

  await changePeerSwapRole(roleToLoad);
  openModal('modal-peer-swap');
}

async function changePeerSwapRole(roleType) {
  const select1 = document.getElementById('swap-person-1');
  const select2 = document.getElementById('swap-person-2');
  const reasonInput = document.getElementById('swap-reason');

  if (reasonInput) reasonInput.value = '';
  if (select1) select1.innerHTML = '<option value="">-- กำลังโหลดรายชื่อ... --</option>';
  if (select2) select2.innerHTML = '<option value="">-- กรุณาเลือกคนแรกก่อน --</option>';

  try {
    const res = await fetch(`/api/queue/${roleType}`);
    const result = await res.json();

    if (!result.success) {
      showToast(result.error, 'danger');
      return;
    }

    const rawMembers = result.data || result.members || [];
    peerSwapMembersCache = rawMembers.filter(m => {
      const code = String(m.emp_code || '').trim().toUpperCase();
      return code !== 'DIR-10' && code !== 'DIR-09';
    });

    let optionsHtml = '<option value="">-- เลือกผู้ขอสลับคิว (คนแรก) --</option>';

    peerSwapMembersCache.forEach(m => {
      optionsHtml += `<option value="${m.personnel_id}">[${m.emp_code}] ${m.name} (คิวที่ #${m.queue_order})</option>`;
    });

    if (select1) select1.innerHTML = optionsHtml;
  } catch (err) {
    console.error('Error loading peer swap members:', err);
    showToast('เกิดข้อผิดพลาดในการโหลดรายชื่อคิว', 'danger');
  }
}


function filterPeerSwapTargets() {
  const select1 = document.getElementById('swap-person-1');
  const select2 = document.getElementById('swap-person-2');
  if (!select1 || !select2) return;

  const selectedId = select1.value;
  if (!selectedId) {
    select2.innerHTML = '<option value="">-- กรุณาเลือกคนแรกก่อน --</option>';
    return;
  }

  let optionsHtml = '<option value="">-- เลือกผู้รับสลับคิว (คนที่สอง) --</option>';
  peerSwapMembersCache.forEach(m => {
    if (String(m.personnel_id) !== String(selectedId)) {
      optionsHtml += `<option value="${m.personnel_id}">[${m.emp_code}] ${m.name} (คิวที่ #${m.queue_order})</option>`;
    }
  });


  select2.innerHTML = optionsHtml;
}

async function executePeerSwap() {
  const requesterId = document.getElementById('swap-person-1')?.value;
  const targetId = document.getElementById('swap-person-2')?.value;
  const reason = document.getElementById('swap-reason')?.value?.trim();

  if (!requesterId || !targetId) {
    showToast('กรุณาเลือกผู้ขอสลับคิวและผู้รับสลับคิวให้ครบถ้วน', 'warning');
    return;
  }

  showToast('กำลังประมวลผลสลับลำดับคิวและส่งแจ้งเตือน...', 'info');

  try {
    const res = await fetch('/api/queue/peer-swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester_id: requesterId,
        target_id: targetId,
        reason: reason
      })
    });

    const result = await res.json();

    if (result.success) {
      closeModal('modal-peer-swap');
      showToast(result.message || 'สลับลำดับคิวสำเร็จเรียบร้อยแล้ว', 'success');
      const selectedRole = document.getElementById('swap-role-type')?.value || currentQueueRole;
      loadQueueView(selectedRole);
    } else {
      showToast(result.error || 'เกิดข้อผิดพลาดในการสลับคิว', 'danger');
    }
  } catch (err) {
    console.error('Error executing peer swap:', err);
    showToast('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', 'danger');
  }
}

// -------------------------------------------------------------
// 15. USER & ROLE MANAGEMENT FUNCTIONS (ข้อ 6)
// -------------------------------------------------------------

let allUsersData = [];

async function loadUserManagementView() {
  const tbody = document.getElementById('user-management-table-body');
  if (!tbody) return;

  const clearSearch = () => {
    const sInput = document.getElementById('user-search-input');
    if (sInput) sInput.value = '';
    const rFilter = document.getElementById('user-role-filter');
    if (rFilter) rFilter.value = 'ALL';
  };

  clearSearch();
  [50, 150, 300, 600].forEach(delay => {
    setTimeout(clearSearch, delay);
  });

  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;"><i class="fa-solid fa-spinner fa-spin text-purple"></i> กำลังโหลดข้อมูลผู้ใช้งาน...</td></tr>';



  try {
    const res = await fetch('/api/users');
    const data = await res.json();

    if (data.success) {
      allUsersData = data.users || [];
      populateDepartmentFilterOptions();
      updateUserLineStats();
      filterUserList();
    } else {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger);">เกิดข้อผิดพลาด: ${data.error}</td></tr>`;
    }
  } catch (err) {
    console.error('Error loading users:', err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--danger);">ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อโหลดข้อมูลผู้ใช้งานได้</td></tr>';
  }
}


function renderUserTable(users) {
  const tbody = document.getElementById('user-management-table-body');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">ไม่พบข้อมูลผู้ใช้งานตามเงื่อนไขที่ค้นหา</td></tr>';
    return;
  }

  // เรียงลำดับรายการ:
  // 1. DIR-10 (ผออ.)
  // 2. DIR-09 (รผอ.บร.)
  // 3. DIR-01 ถึง DIR-08
  // 4. ADMIN / OPERATOR อื่นๆ
  // 5. พนักงาน (STAFF)
  const sortedUsers = [...users].sort((a, b) => {
    const codeA = String(a.emp_code || '').trim().toUpperCase();
    const codeB = String(b.emp_code || '').trim().toUpperCase();

    if (codeA === 'DIR-10') return -1;
    if (codeB === 'DIR-10') return 1;
    if (codeA === 'DIR-09') return -1;
    if (codeB === 'DIR-09') return 1;

    const isDirA = codeA.startsWith('DIR-');
    const isDirB = codeB.startsWith('DIR-');
    if (isDirA && !isDirB) return -1;
    if (!isDirA && isDirB) return 1;

    if (isDirA && isDirB) {
      const numA = parseInt(codeA.replace(/\D/g, ''), 10) || 99;
      const numB = parseInt(codeB.replace(/\D/g, ''), 10) || 99;
      return numA - numB;
    }

    const numA = parseInt(codeA.replace(/\D/g, ''), 10) || 9999;
    const numB = parseInt(codeB.replace(/\D/g, ''), 10) || 9999;
    return numA - numB;
  });

  let html = '';
  sortedUsers.forEach(u => {
    const code = String(u.emp_code || '').trim().toUpperCase();
    const isDir10 = code === 'DIR-10';
    const isDir09 = code === 'DIR-09';
    const isExec = isDir10 || isDir09;

    let roleBadge = `<span class="badge" style="background:#10b981; color:#fff;"><i class="fa-solid fa-user"></i> พนักงาน</span>`;
    if (isDir10) {
      roleBadge = `<span class="badge" style="background:#a855f7; color:#fff; font-weight:700;"><i class="fa-solid fa-crown"></i> 👑 ผออ.</span>`;
    } else if (isDir09) {
      roleBadge = `<span class="badge" style="background:#8b5cf6; color:#fff; font-weight:700;"><i class="fa-solid fa-crown"></i> 👑 รผอ.บร.</span>`;
    } else if (u.role_type === 'ADMIN') {
      roleBadge = `<span class="badge" style="background:#6366f1; color:#fff; font-weight:600;"><i class="fa-solid fa-user-shield"></i> แอดมิน</span>`;
    } else if (u.role_type === 'OPERATOR') {
      roleBadge = `<span class="badge" style="background:#0284c7; color:#fff; font-weight:600;"><i class="fa-solid fa-user-gear"></i> โอเปอเรเตอร์</span>`;
    } else if (u.role_type === 'DIRECTOR') {
      roleBadge = `<span class="badge" style="background:#0284c7; color:#fff; font-weight:600;"><i class="fa-solid fa-user-tie"></i> ผอ.ฝ่าย</span>`;
    }

    let queueBadge = '';
    if (isExec) {
      queueBadge = `<span class="badge" style="background:rgba(168,85,247,0.12); color:#a855f7; border:1px solid rgba(168,85,247,0.3); font-weight:600;">👑 ไม่วนคิว</span>`;
    } else if (u.queue_order) {
      queueBadge = `<span class="badge" style="background:var(--bg-card); border:1px solid var(--card-border); color:var(--text-heading); font-weight:600;">คิว #${u.queue_order}</span>`;
    } else {
      queueBadge = `<span class="badge" style="background:var(--bg-card); border:1px solid var(--card-border); color:var(--text-muted);">-</span>`;
    }

    const hasLine = u.line_user_id && u.line_user_id.toLowerCase() !== 'email';
    const lineBadge = hasLine
      ? `<span class="badge" style="background:#16a34a; color:#fff;"><i class="fa-brands fa-line"></i> ผูกแล้ว</span>`
      : `<span class="badge" style="background:#94a3b8; color:#fff;">ยังไม่ผูก</span>`;

    const unbindBtn = hasLine
      ? `<button class="btn btn-sm btn-secondary" onclick="unbindUserLine(${u.id}, '${u.name}')" title="ยกเลิกผูก LINE"><i class="fa-solid fa-link-slash text-rose"></i></button>`
      : '';

    html += `
      <tr ${isExec ? 'style="background:rgba(168,85,247,0.03);"' : ''}>
        <td><code>${u.emp_code || '-'}</code></td>
        <td><strong style="color:var(--text-heading);">${u.name || '-'}</strong></td>
        <td>${roleBadge}</td>
        <td>${u.position || '-'}</td>
        <td>${u.department || 'อสป.'}</td>
        <td>${queueBadge}</td>
        <td>${lineBadge}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-secondary" onclick="openUserModal(${u.id})" title="แก้ไข"><i class="fa-solid fa-pen-to-square text-sky"></i></button>
          ${unbindBtn}
          <button class="btn btn-sm btn-secondary" onclick="deleteUser(${u.id}, '${u.name}', '${u.emp_code}')" title="ลบ"><i class="fa-solid fa-trash text-rose"></i></button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}






async function deleteUser(id, name, empCode) {
  const result = await Swal.fire({
    title: 'ยืนยันการลบผู้ใช้งาน?',
    text: `คุณต้องการลบ คุณ${name} (${empCode}) ออกจากระบบใช่หรือไม่? ข้อมูลประวัติการจัดสรรทั้งหมดจะถูกลบไปด้วย`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'ลบผู้ใช้งาน',
    cancelButtonText: 'ยกเลิก'
  });

  if (!result.isConfirmed) return;

  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.success) {
      Swal.fire('สำเร็จ', data.message, 'success');
      loadUserManagementView();
    } else {
      Swal.fire('ข้อผิดพลาด', data.error, 'error');
    }
  } catch (err) {
    console.error('Error deleting user:', err);
    Swal.fire('ข้อผิดพลาด', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อลบข้อมูลผู้ใช้งานได้', 'error');
  }
}

async function unbindUserLine(id, name) {
  const result = await Swal.fire({
    title: 'ยกเลิกการผูกบัญชี LINE OA?',
    text: `คุณต้องการยกเลิกการผูก LINE ของ คุณ${name} ใช่หรือไม่? พนักงานจะต้องผูกบัญชีใหม่ใน LINE`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#d97706',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'ยกเลิกการผูก LINE',
    cancelButtonText: 'ยกเลิก'
  });

  if (!result.isConfirmed) return;

  try {
    const res = await fetch(`/api/users/${id}/unbind-line`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      Swal.fire('สำเร็จ', data.message, 'success');
      loadUserManagementView();
    } else {
      Swal.fire('ข้อผิดพลาด', data.error, 'error');
    }
  } catch (err) {
    console.error('Error unbinding LINE:', err);
    Swal.fire('ข้อผิดพลาด', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อยกเลิกผูก LINE ได้', 'error');
  }
}

let currentActiveMissionData = null;

async function openEditScheduleModal(missionId) {
  closeModal('modal-mission-detail');

  let m = currentActiveMissionData;
  if (!m || Number(m.id) !== Number(missionId)) {
    try {
      const res = await fetch(`/api/missions/${missionId}`);
      const data = await res.json();
      if (data.success && data.mission) {
        m = data.mission;
      }
    } catch (e) {}
  }

  if (!m) {
    showToast('ไม่สามารถดึงข้อมูลกิจกรรมได้', 'danger');
    return;
  }

  const elId = document.getElementById('edit-schedule-mission-id');
  const elTitle = document.getElementById('edit-schedule-title');
  const elLoc = document.getElementById('edit-schedule-location');
  const elDress = document.getElementById('edit-schedule-dress');
  const elDetails = document.getElementById('edit-schedule-details');
  const elStart = document.getElementById('edit-schedule-start');
  const elEnd = document.getElementById('edit-schedule-end');

  if (elId) elId.value = m.id;
  if (elTitle) elTitle.value = m.mission_title || '';
  if (elLoc) elLoc.value = m.location || '';
  if (elDress) elDress.value = m.dress_code || '';
  if (elDetails) elDetails.value = m.schedule_details || m.description || '';

  if (elStart && m.start_date) {
    try {
      const d1 = new Date(m.start_date);
      if (!isNaN(d1.getTime())) {
        const tzOffset = d1.getTimezoneOffset() * 60000;
        elStart.value = (new Date(d1.getTime() - tzOffset)).toISOString().slice(0, 16);
      } else if (typeof m.start_date === 'string') {
        elStart.value = m.start_date.slice(0, 16);
      }
    } catch (e) {}
  }

  if (elEnd && m.end_date) {
    try {
      const d2 = new Date(m.end_date);
      if (!isNaN(d2.getTime())) {
        const tzOffset = d2.getTimezoneOffset() * 60000;
        elEnd.value = (new Date(d2.getTime() - tzOffset)).toISOString().slice(0, 16);
      } else if (typeof m.end_date === 'string') {
        elEnd.value = m.end_date.slice(0, 16);
      }
    } catch (e) {}
  }

  const curFileDiv = document.getElementById('edit-schedule-current-file');
  const urlEl = document.getElementById('edit-schedule-url');
  if (urlEl) urlEl.value = '';

  if (curFileDiv) {
    if (m.attachment_file) {
      if (m.attachment_file.startsWith('http')) {
        if (urlEl) urlEl.value = m.attachment_file;
        curFileDiv.innerHTML = `<i class="fa-solid fa-link"></i> ลิงก์แชร์ปัจจุบัน: <a href="${m.attachment_file}" target="_blank" style="text-decoration:underline; color:#0284c7;">${escapeHtml(m.attachment_file)}</a>`;
      } else {
        curFileDiv.innerHTML = `<i class="fa-solid fa-paperclip"></i> ไฟล์แนบปัจจุบัน: <a href="${m.attachment_file}" target="_blank" style="text-decoration:underline;">${escapeHtml(m.attachment_name || 'ดาวน์โหลดเอกสาร')}</a>`;
      }
    } else {
      curFileDiv.innerHTML = '';
    }
  }

  openModal('modal-edit-schedule');
}

async function saveScheduleChanges(e) {
  e.preventDefault();
  const missionId = document.getElementById('edit-schedule-mission-id').value;
  const title = document.getElementById('edit-schedule-title').value.trim();
  const startDate = document.getElementById('edit-schedule-start').value;
  const endDate = document.getElementById('edit-schedule-end').value;
  const location = document.getElementById('edit-schedule-location').value.trim();
  const dressCode = document.getElementById('edit-schedule-dress').value.trim();
  const scheduleDetails = document.getElementById('edit-schedule-details').value.trim();
  const notifyLine = document.getElementById('edit-schedule-notify-cb').checked;

  let attachmentUrl = null;
  let attachmentName = null;

  const fileInput = document.getElementById('edit-schedule-file');
  const urlInput = document.getElementById('edit-schedule-url')?.value.trim();

  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    const formData = new FormData();
    formData.append('attachment', fileInput.files[0]);
    showToast('กำลังอัปโหลดไฟล์แนบกำหนดการใหม่...', 'info');
    try {
      const upRes = await fetch('/api/upload-attachment', {
        method: 'POST',
        body: formData
      });
      const upResult = await upRes.json();
      if (upResult.success) {
        attachmentUrl = upResult.file_url;
        attachmentName = upResult.file_name;
      }
    } catch (err) {
      console.error('Upload new file error:', err);
    }
  } else if (urlInput) {
    attachmentUrl = urlInput;
    attachmentName = 'เอกสารแนบกำหนดการ (ลิงก์แชร์ภายนอก)';
  }

  showToast('กำลังบันทึกและส่งแจ้งเตือนเปลี่ยนแปลงกำหนดการทาง LINE...', 'info');

  try {
    const payload = {
      mission_title: title,
      start_date: startDate.replace('T', ' ') + ':00',
      end_date: endDate.replace('T', ' ') + ':00',
      location,
      dress_code: dressCode,
      schedule_details: scheduleDetails,
      notify_line: notifyLine
    };
    if (attachmentUrl) {
      payload.attachment_file = attachmentUrl;
      payload.attachment_name = attachmentName;
    }

    const res = await fetch(`/api/missions/${missionId}/update-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (result.success) {
      closeModal('modal-edit-schedule');
      closeModal('modal-mission-detail');
      showToast(`🎉 ${result.message}`, 'success');
      refreshAllSystemData();
    } else {
      showToast(`Error: ${result.error}`, 'danger');
    }
  } catch (err) {
    console.error('Error updating schedule:', err);
    showToast('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่ออัปเดตกำหนดการได้', 'danger');
  }
}

window.openEditScheduleModal = openEditScheduleModal;
window.saveScheduleChanges = saveScheduleChanges;




