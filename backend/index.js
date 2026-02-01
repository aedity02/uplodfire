import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

dotenv.config();

const app = express();

// Enable CORS for all origins (restrict in production)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type']
}));

// Handle preflight
app.options('*', cors());

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN)),
    });
}

// Multer config - store in uploads folder
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

/* Auth middleware */
async function verifyUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        console.log('Auth header:', authHeader ? 'Present' : 'Missing');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: "No token provided or invalid format" });
        }

        const token = authHeader.replace("Bearer ", "").trim();
        console.log('Verifying token...');
        
        const decoded = await admin.auth().verifyIdToken(token);
        console.log('Token verified for user:', decoded.uid);
        
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Auth error:', error.message);
        res.status(401).json({ message: "Invalid token", error: error.message });
    }
}

/* Upload route */
app.post("/upload", verifyUser, upload.single("file"), async (req, res) => {
    console.log('Upload request received');
    console.log('File:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'No file');
    console.log('Body:', req.body);
    
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file provided" });
        }

        // Verify userId matches token
        const bodyUserId = req.body?.userId;
        if (bodyUserId && bodyUserId !== req.user.uid) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ message: "User ID mismatch" });
        }

        const filePath = req.file.path;
        const fileName = req.body?.fileName || req.file.originalname;

        // Create form data for Telegram
        const form = new FormData();
        form.append("chat_id", process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID);
        form.append("document", fs.createReadStream(filePath), {
            filename: fileName,
            contentType: req.file.mimetype || 'application/octet-stream'
        });
        
        // Optional caption
        const caption = `📁 CloudVault Upload\n👤 User: ${req.user.email || req.user.uid}\n📄 File: ${fileName}`;
        form.append("caption", caption);

        const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        console.log('Sending to Telegram...');
        
        const tgRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendDocument`,
            {
                method: "POST",
                body: form,
                headers: form.getHeaders(),
                timeout: 120000 // 2 minute timeout
            }
        );

        // Clean up temp file immediately
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            console.error('Failed to clean up temp file:', e);
        }

        const tgData = await tgRes.json();
        console.log('Telegram response:', tgData.ok ? 'Success' : 'Failed');

        if (!tgData.ok) {
            console.error('Telegram error:', tgData.description);
            return res.status(500).json({ 
                message: "Telegram upload failed", 
                error: tgData.description 
            });
        }

        res.json({
            success: true,
            fileId: tgData.result.document.file_id,
            messageId: tgData.result.message_id,
            fileName: fileName,
            size: req.file.size
        });
        
    } catch (e) {
        console.error('Upload error:', e);
        // Clean up on error
        if (req.file?.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (e) {}
        }
        res.status(500).json({ 
            message: "Upload error", 
            error: e.message 
        });
    }
});

/* Health check */
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
    console.log('Environment check:', {
        firebase: process.env.FIREBASE_ADMIN ? 'Set' : 'Missing',
        telegram: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing',
        chatId: process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID ? 'Set' : 'Missing'
    });
});
