const http = require('http');

// Configurable Car Booking API endpoint URL (default localhost:8080)
const CAR_BOOKING_API_URL = process.env.CAR_BOOKING_API_URL || 'http://localhost:8080/api/external/auto-booking';
const CAR_BOOKING_WEB_URL = process.env.CAR_BOOKING_WEB_URL || 'http://localhost:8080';

/**
 * Dispatch an automated car booking request to the Car Booking system.
 * @param {Object} mission - Mission object from Smart Queue DB
 * @param {Array} assignedList - Array of assigned personnel objects [{ name, position, role_type, ... }]
 * @returns {Promise<Object>} Result object { success: true/false, booking_id, status, car_booking_url }
 */
async function createAutoCarBooking(mission, assignedList = []) {
  return new Promise((resolve) => {
    try {
      const url = new URL(CAR_BOOKING_API_URL);

      const passengersFormatted = (assignedList || []).map(p => ({
        name: p.name || '',
        position: p.position || p.role_type || ''
      }));

      let reqName = (mission.created_by || '').trim();
      if (!reqName || reqName.toLowerCase().includes('admin') || reqName.includes('ผู้ดูแลระบบ') || reqName.includes('Admin')) {
        reqName = 'น.ส.รณิดา  โชติธนาอุดม';
      }

      const payload = {
        mission_id: mission.id,
        title: mission.mission_title || '',
        destination: mission.location || '',
        startDate: mission.start_date ? String(mission.start_date).split('T')[0] : '',
        endDate: mission.end_date ? String(mission.end_date).split('T')[0] : '',
        passengers: passengersFormatted,
        requesterName: reqName,
        travelType: 'fmo_car',
        purpose: `ปฏิบัติภารกิจ อสป.: ${mission.mission_title || ''}${mission.location ? ' ณ ' + mission.location : ''}`
      };

      const postData = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000 // 5 seconds timeout
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success && data.booking_id) {
              resolve({
                success: true,
                booking_id: data.booking_id,
                status: data.status || 'PENDING',
                car_booking_url: `${CAR_BOOKING_WEB_URL}?bookingId=${data.booking_id}`
              });
            } else {
              console.error('[CarBooking Service] API returned non-success:', data);
              resolve({ success: false, error: data.error || 'API error' });
            }
          } catch (e) {
            console.error('[CarBooking Service] Parse response error:', e);
            resolve({ success: false, error: e.message });
          }
        });
      });

      req.on('error', (err) => {
        console.error('[CarBooking Service] Request error:', err.message);
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        console.error('[CarBooking Service] Request timed out');
        resolve({ success: false, error: 'Timeout' });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error('[CarBooking Service] Execution error:', err);
      resolve({ success: false, error: err.message });
    }
  });
}

module.exports = {
  createAutoCarBooking,
  CAR_BOOKING_WEB_URL
};
