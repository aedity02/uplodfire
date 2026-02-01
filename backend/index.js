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
app.use(cors());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN)),
});

/* Upload config */
const upload = multer({ dest: "uploads/" });

/* Auth middleware */
async function verifyUser(req, res, next) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

/* Upload route */
app.post("/upload", verifyUser, upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;

    const form = new FormData();
    form.append("chat_id", process.env.CHAT_ID);
    form.append("document", fs.createReadStream(filePath));

    const tgRes = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`,
      {
        method: "POST",
        body: form,
      }
    );

    const tgData = await tgRes.json();
    fs.unlinkSync(filePath);

    if (!tgData.ok) {
      return res.status(500).json({ message: "Telegram upload failed" });
    }

    res.json({
      fileId: tgData.result.document.file_id,
      messageId: tgData.result.message_id,
    });
  } catch (e) {
    res.status(500).json({ message: "Upload error" });
  }
});

/* Start server */
app.listen(process.env.PORT, () => {
  console.log(`Backend running on http://localhost:${process.env.PORT}`);
});