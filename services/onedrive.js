/**
 * Services: Microsoft OneDrive / SharePoint Integration via Microsoft Graph API
 * Handles automatic file uploads to OneDrive and generates accessible sharing links.
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
 * Upload file buffer directly to target User Account OneDrive and return accessible sharing link
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

    // 2. Create sharing link (try 'organization' scope first or 'anonymous')
    let shareUrl = itemWebUrl;
    const itemLinkEndpoint = targetUser
      ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(targetUser)}/drive/items/${itemId}/createLink`
      : `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/createLink`;

    const preferredScope = (process.env.MS_LINK_SCOPE || 'organization').trim();
    const scopesToTry = [preferredScope, 'organization', 'anonymous'];
    const tried = new Set();

    for (const scope of scopesToTry) {
      if (tried.has(scope)) continue;
      tried.add(scope);

      try {
        const linkRes = await axios.post(itemLinkEndpoint, {
          type: 'view',
          scope: scope
        }, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (linkRes.data && linkRes.data.link && linkRes.data.link.webUrl) {
          shareUrl = linkRes.data.link.webUrl;
          break;
        }
      } catch (linkErr) {
        console.warn(`OneDrive createLink with scope '${scope}' failed:`, linkErr.response?.data?.error?.message || linkErr.message);
      }
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
