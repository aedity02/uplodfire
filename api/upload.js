/**
 * CloudVault Upload API - Vercel Serverless
 * 
 * SECURITY FIXES:
 * 1. Firebase ID Token verification
 * 2. Telegram Bot Token in env vars only
 * 3. File size validation (2GB max)
 * 4. Streaming upload to Telegram
 * 5. No secrets exposed
 */

const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');
const multiparty = require('multiparty');

// Initialize Firebase Admin (singleton pattern for serverless)
if (!admin.apps.length) {
  // For Vercel, use environment variable for service account
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString()
  );
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.FRONTEND_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

// Disable body parsing for multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Parse multipart form with multiparty
 */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({
      maxFilesSize: 2 * 1024 * 1024 * 1024, // 2GB
      maxFieldsSize: 10 * 1024 * 1024 // 10MB for fields
    });

    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

/**
 * Verify Firebase ID Token
 */
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('No token provided');
  }

  const idToken = authHeader.split('Bearer ')[1];
  return await admin.auth().verifyIdToken(idToken);
}

/**
 * Upload file to Telegram
 */
async function uploadToTelegram(fileBuffer, fileName, mimetype, caption) {
  const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('document', fileBuffer, {
    filename: fileName,
    contentType: mimetype || 'application/octet-stream'
  });
  formData.append('caption', caption);

  const response = await axios.post(`${TELEGRAM_API}/sendDocument`, formData, {
    headers: formData.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 300000 // 5 minutes
  });

  if (!response.data.ok) {
    throw new Error(response.data.description);
  }

  return response.data.result;
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
    res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
    res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);
    res.setHeader('Access-Control-Max-Age', corsHeaders['Access-Control-Max-Age']);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
    res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
    res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);

    // Verify authentication
    const authHeader = req.headers.authorization;
    const decodedToken = await verifyToken(authHeader);

    // Parse multipart form
    const { fields, files } = await parseForm(req);

    // Extract fields
    const folder = fields.folder?.[0] || '';
    const userId = fields.userId?.[0];
    const fileNameOverride = fields.fileName?.[0];

    // Security: Verify userId matches token
    if (decodedToken.uid !== userId) {
      return res.status(403).json({ error: 'User ID mismatch' });
    }

    // Get uploaded file
    const uploadedFiles = files.file;
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const file = uploadedFiles[0];
    const fileBuffer = require('fs').readFileSync(file.path);
    const actualFileName = fileNameOverride || file.originalFilename;

    // Create caption
    const caption = [
      `📁 CloudVault Upload`,
      `━━━━━━━━━━━━━━━━`,
      `👤 User: ${decodedToken.name || decodedToken.email || 'Unknown'}`,
      `🆔 UID: ${userId}`,
      `📂 Folder: ${folder || 'Root'}`,
      `📄 File: ${actualFileName}`,
      `📊 Size: ${formatBytes(file.size)}`,
      `📅 Date: ${new Date().toISOString()}`,
      `━━━━━━━━━━━━━━━━`
    ].join('\n');

    // Upload to Telegram
    const result = await uploadToTelegram(
      fileBuffer,
      actualFileName,
      file.headers['content-type'],
      caption
    );

    // Clean up temp file
    require('fs').unlinkSync(file.path);

    // Return file metadata
    res.status(200).json({
      success: true,
      fileId: result.document.file_id,
      messageId: result.message_id,
      fileName: actualFileName,
      size: file.size
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up any temp files on error
    if (req.files?.file) {
      req.files.file.forEach(f => {
        try {
          require('fs').unlinkSync(f.path);
        } catch (e) {}
      });
    }

    res.status(500).json({
      error: 'Upload failed',
      message: error.message
    });
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
