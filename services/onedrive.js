/**
 * Services: Microsoft OneDrive / SharePoint Integration via Microsoft Graph API
 * Handles automatic file uploads to OneDrive and generates accessible pre-signed download links.
 */

const axios = require('axios');

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
 * Upload file buffer directly to target User Account OneDrive
 */
async function uploadToOneDrive(fileBuffer, originalFileName, customSubfolder = '') {
  if (!isOneDriveConfigured()) {
    return { isConfigured: false };
  }

  try {
    const accessToken = await getAccessToken();
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER || 'FMO_SmartQueue_Docs').trim();
    const folderPath = customSubfolder ? `${baseFolder}/${customSubfolder}` : baseFolder;
    
    // Support either MS_USER_ACCOUNT or MS_USER_EMAIL
    const targetUser = (process.env.MS_USER_ACCOUNT || process.env.MS_USER_EMAIL || '').trim();
    
    // Sanitize file name for OneDrive
    const sanitizedFileName = originalFileName.replace(/[\/\\?%*:|"<>]/g, '_');
    const encodedPath = encodeURIComponent(`${folderPath}/${sanitizedFileName}`);
    
    const driveEndpoint = targetUser
      ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(targetUser)}/drive/root:/${encodedPath}:/content`
      : `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/content`;

    // 1. Upload file content to target User Account OneDrive
    const uploadRes = await axios.put(driveEndpoint, fileBuffer, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      }
    });

    const itemId = uploadRes.data.id;
    const itemWebUrl = uploadRes.data.webUrl;

    // 2. Build Smart Queue Proxy Download URL so LINE users can open files seamlessly without Microsoft login prompt
    const proxyDownloadUrl = `/api/download-onedrive-file/${itemId}?name=${encodeURIComponent(originalFileName)}`;

    return {
      isConfigured: true,
      success: true,
      file_url: proxyDownloadUrl,
      item_id: itemId,
      web_url: itemWebUrl,
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

/**
 * Get direct pre-signed download URL (@microsoft.graph.downloadUrl) for an item
 */
async function getOneDriveDownloadUrl(itemId) {
  if (!isOneDriveConfigured()) {
    throw new Error('OneDrive configuration is missing.');
  }

  const accessToken = await getAccessToken();
  const targetUser = (process.env.MS_USER_ACCOUNT || process.env.MS_USER_EMAIL || '').trim();

  const itemEndpoint = targetUser
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(targetUser)}/drive/items/${itemId}`
    : `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`;

  const itemRes = await axios.get(itemEndpoint, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  const downloadUrl = itemRes.data['@microsoft.graph.downloadUrl'] || itemRes.data.webUrl;
  return downloadUrl;
}

/**
 * Download file stream directly from OneDrive using App Credentials Token
 */
async function getOneDriveFileStream(itemId) {
  if (!isOneDriveConfigured()) {
    throw new Error('OneDrive configuration is missing.');
  }

  const accessToken = await getAccessToken();
  const targetUser = (process.env.MS_USER_ACCOUNT || process.env.MS_USER_EMAIL || '').trim();

  const contentEndpoint = targetUser
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(targetUser)}/drive/items/${itemId}/content`
    : `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/content`;

  const streamRes = await axios.get(contentEndpoint, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    responseType: 'stream'
  });

  return streamRes;
}

module.exports = {
  isOneDriveConfigured,
  uploadToOneDrive,
  getOneDriveDownloadUrl,
  getOneDriveFileStream
};
