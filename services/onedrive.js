/**
 * Services: Microsoft OneDrive / SharePoint Integration via Microsoft Graph API
 * Handles automatic file uploads to OneDrive and generates protected sharing links.
 * 
 * Graceful Fallback:
 * If MS_TENANT_ID, MS_CLIENT_ID, or MS_CLIENT_SECRET are not set in .env,
 * the system will safely skip OneDrive and use local/external URL storage without errors.
 */

const axios = require('axios');
const path = require('path');

function isOneDriveConfigured() {
  const tenantId = (process.env.MS_TENANT_ID || '').trim();
  const clientId = (process.env.MS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.MS_CLIENT_SECRET || '').trim();

  return Boolean(
    tenantId && 
    clientId && 
    clientSecret && 
    tenantId !== 'your-microsoft-tenant-id-here' &&
    clientId !== 'your-microsoft-client-id-here' &&
    clientSecret !== 'your-microsoft-client-secret-here'
  );
}

/**
 * Obtain Microsoft OAuth 2.0 Access Token using Client Credentials Flow
 */
async function getAccessToken() {
  const tenantId = process.env.MS_TENANT_ID.trim();
  const clientId = process.env.MS_CLIENT_ID.trim();
  const clientSecret = process.env.MS_CLIENT_SECRET.trim();

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');

  const res = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return res.data.access_token;
}

/**
 * Upload file buffer directly to OneDrive and return sharing link
 */
async function uploadToOneDrive(fileBuffer, originalFileName, customSubfolder = '') {
  if (!isOneDriveConfigured()) {
    return { isConfigured: false };
  }

  try {
    const accessToken = await getAccessToken();
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER || 'FMO_SmartQueue_Docs').trim();
    const folderPath = customSubfolder ? `${baseFolder}/${customSubfolder}` : baseFolder;
    
    // Sanitize file name for OneDrive
    const sanitizedFileName = originalFileName.replace(/[\/\\?%*:|"<>]/g, '_');
    const encodedPath = encodeURIComponent(`${folderPath}/${sanitizedFileName}`);
    
    const driveEndpoint = (process.env.MS_USER_EMAIL || '').trim()
      ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MS_USER_EMAIL.trim())}/drive/root:/${encodedPath}:/content`
      : `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/content`;

    // 1. Upload file content to OneDrive
    const uploadRes = await axios.put(driveEndpoint, fileBuffer, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      }
    });

    const itemId = uploadRes.data.id;
    const itemWebUrl = uploadRes.data.webUrl;

    // 2. Create sharing link (isolated/view permission)
    let shareUrl = itemWebUrl;
    try {
      const linkEndpoint = `https://graph.microsoft.com/v1.0/me/items/${itemId}/createLink`;
      const linkRes = await axios.post(linkEndpoint, {
        type: 'view',
        scope: process.env.MS_LINK_SCOPE || 'anonymous' // 'organization' or 'anonymous'
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (linkRes.data && linkRes.data.link && linkRes.data.link.webUrl) {
        shareUrl = linkRes.data.link.webUrl;
      }
    } catch (linkErr) {
      console.warn('OneDrive createLink warning (using webUrl fallback):', linkErr.message);
    }

    return {
      isConfigured: true,
      success: true,
      file_url: shareUrl,
      file_name: originalFileName,
      storage: 'ONEDRIVE'
    };
  } catch (err) {
    console.error('OneDrive Upload Error:', err.response?.data || err.message);
    return {
      isConfigured: true,
      success: false,
      error: err.response?.data?.error?.message || err.message
    };
  }
}

module.exports = {
  isOneDriveConfigured,
  uploadToOneDrive
};
