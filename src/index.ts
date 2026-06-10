import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import url from 'url';
import nodemailer from 'nodemailer';

// Configure nodemailer transporter using local MTA (exim4 on port 25)
const transporter = nodemailer.createTransport({
  host: 'localhost',
  port: 25,
  secure: false,
  tls: {
    rejectUnauthorized: false
  }
});


import {
  initDb,
  createGroup,
  joinRequest,
  getPendingMembers,
  approveMember,
  addLocation,
  getHistory,
  addMarker,
  getMarkers,
  updateMarker,
  deleteMarker,
  moveMarker,
  checkGroupOwner,
  checkApprovedMember,
  getGroupMembers,
  getMember,
  saveEmailVerification,
  checkEmailVerification,
  updateMemberProfile,
  transferGroupOwnership,
  removeMemberFromGroup,
  deleteGroup,
  deleteMember,
  getGroupBoundary,
  updateGroupBoundary,
  recoverGroupsByEmail
} from './db';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 4000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage configuration for photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());

// Keep track of active WebSocket connections: group_id -> Map(member_id -> WebSocket)
const groupConnections = new Map<string, Map<string, WebSocket>>();

// Keep track of the last time a join request notification was broadcast: member_id -> timestamp (ms)
const lastJoinRequestBroadcast = new Map<string, number>();

// REST API Endpoints

// Send Email Verification Code
app.post('/api/verify/send', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await saveEmailVerification(email, code);
    
    console.log(`\n==================================================`);
    console.log(`[EMAIL VERIFICATION] Sent code ${code} to ${email}`);
    console.log(`==================================================\n`);

    // Send actual email via exim4
    const mailOptions = {
      from: '"no-reply@novabase.se" <no-reply@novabase.se>',
      to: email.trim(),
      subject: 'Verifieringskod för First Beacon!',
      text: `Din 6-siffriga verifieringskod är: ${code}\n\nKoden är giltig i 5 minuter.`,
      html: `
        <div style="font-family: Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #fcfcfc;">
          <h2 style="color: #6200ee; text-align: center;">Verifieringskod för First Beacon!</h2>
          <p style="font-size: 16px; color: #333333;">Hej,</p>
          <p style="font-size: 16px; color: #333333;">Använd följande 6-siffriga kod för att verifiera din e-postadress i appen:</p>
          <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 4px; color: #6200ee; background-color: #f3ebff; padding: 12px 24px; border-radius: 8px; border: 1px solid #dcc3ff;">
              ${code}
            </span>
          </div>
          <p style="font-size: 14px; color: #666666;">Koden är giltig i 5 minuter. Om du inte begärde denna kod kan du bortse från detta e-postmeddelande.</p>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin-top: 30px;" />
          <p style="font-size: 12px; color: #999999; text-align: center;">Med vänliga hälsningar,<br />no-reply@novabase.se</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    
    return res.json({ success: true, message: 'Verification code sent' });
  } catch (error) {
    console.error("E-post fel eller serverfel: ", error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Check Email Verification Code
app.post('/api/verify/check', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required' });
  }

  try {
    const isValid = await checkEmailVerification(email, code);
    if (isValid) {
      return res.json({ success: true, message: 'Verification successful' });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid or expired verification code' });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Create Group
app.post('/api/groups/create', async (req, res) => {
  const { code, nickname, deviceId, email } = req.body;
  if (!code || !deviceId) {
    return res.status(400).json({ error: 'Code and deviceId are required' });
  }

  try {
    const { groupId, memberId, ownerToken } = await createGroup(code, deviceId, nickname, email);
    return res.json({ success: true, groupId, code: code.toLowerCase(), memberId, ownerToken });
  } catch (error: any) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Group code already exists' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Join Request
app.post('/api/groups/join', async (req, res) => {
  const { code, nickname, deviceId, email } = req.body;
  if (!code || !nickname || !deviceId) {
    return res.status(400).json({ error: 'Code, nickname, and deviceId are required' });
  }

  try {
    const result = await joinRequest(code, nickname, deviceId, email);
    if (result.status === 'PENDING') {
      const now = Date.now();
      const lastSent = lastJoinRequestBroadcast.get(result.memberId) || 0;
      if (now - lastSent > 120000) { // 2 minutes cooldown
        lastJoinRequestBroadcast.set(result.memberId, now);
        broadcastToGroup(result.groupId, {
          type: 'join_request',
          groupId: result.groupId,
          memberId: result.memberId,
          nickname: nickname
        });
      }
    }
    return res.json({ success: true, ...result });
  } catch (error: any) {
    if (error.message === 'Group not found') {
      return res.status(404).json({ error: 'Group not found' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Recover Groups by Email (and update their device ID)
app.post('/api/groups/recover', async (req, res) => {
  const { email, deviceId } = req.body;
  if (!email || !deviceId) {
    return res.status(400).json({ error: 'Email and deviceId are required' });
  }

  try {
    const groups = await recoverGroupsByEmail(email, deviceId);
    return res.json({ success: true, groups });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Fetch groups by email
app.get('/api/groups/by-email', async (req, res) => {
  const { email, deviceId } = req.query;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const groups = await recoverGroupsByEmail(email as string, (deviceId as string) || '');
    return res.json({ success: true, groups });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Send Group Invitation Email
app.post('/api/groups/invite', async (req, res) => {
  const { email, groupCode, inviterNickname } = req.body;
  if (!email || !groupCode || !inviterNickname) {
    return res.status(400).json({ error: 'email, groupCode, and inviterNickname are required' });
  }

  try {
    const inviteLink = `https://first.novabase.se/invite?code=${encodeURIComponent(groupCode)}`;
    
    console.log(`\n==================================================`);
    console.log(`[GROUP INVITATION] Sent invitation for ${groupCode} to ${email}`);
    console.log(`==================================================\n`);

    const mailOptions = {
      from: '"no-reply@novabase.se" <no-reply@novabase.se>',
      to: email.trim(),
      subject: `Inbjudan till gruppen ${groupCode.toUpperCase()} i First Beacon!`,
      text: `Hej!\n\n${inviterNickname} har bjudit in dig till sin grupp ${groupCode.toUpperCase()} i appen First Beacon!.\n\nKlicka på följande länk på din telefon för att ladda ner appen och gå med i gruppen direkt:\n${inviteLink}\n\nMed vänliga hälsningar,\nno-reply@novabase.se`,
      html: `
        <div style="font-family: Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #fcfcfc;">
          <h2 style="color: #6200ee; text-align: center;">Inbjudan till First Beacon!</h2>
          <p style="font-size: 16px; color: #333333;">Hej,</p>
          <p style="font-size: 16px; color: #333333;"><strong>${inviterNickname}</strong> har bjudit in dig till sin grupp <strong>${groupCode.toUpperCase()}</strong> i appen First Beacon!.</p>
          <p style="font-size: 16px; color: #333333;">Klicka på knappen nedan på din mobiltelefon för att komma till inbjudan, ladda ner appen och ansluta direkt:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteLink}" style="font-size: 18px; font-weight: bold; color: #ffffff; background-color: #6200ee; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(98, 0, 238, 0.2);">
              Visa inbjudan & Gå med
            </a>
          </div>
          <p style="font-size: 14px; color: #666666;">Om du inte kan klicka på knappen, kopiera och klistra in denna länk i din webbläsare:<br/><a href="${inviteLink}" style="color: #6200ee;">${inviteLink}</a></p>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin-top: 30px;" />
          <p style="font-size: 12px; color: #999999; text-align: center;">Med vänliga hälsningar,<br />no-reply@novabase.se</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    return res.json({ success: true, message: 'Invitation email sent successfully' });
  } catch (error) {
    console.error("E-post inbjudan fel: ", error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Group Invite Landing Page
app.get('/invite', (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send('Group code is required');
  }

  const cleanCode = code.trim().toUpperCase();

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inbjudan till First Beacon!</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      color: #1a1a1a;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 24px;
      padding: 40px 30px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
      width: 100%;
      max-width: 440px;
      text-align: center;
      box-sizing: border-box;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.5);
    }
    h1 {
      font-size: 28px;
      font-weight: 800;
      color: #6200ee;
      margin-top: 0;
      margin-bottom: 10px;
      letter-spacing: -0.5px;
    }
    p {
      color: #666;
      font-size: 16px;
      line-height: 1.5;
      margin-bottom: 25px;
    }
    .code-display {
      font-size: 32px;
      font-weight: 800;
      color: #6200ee;
      background: #f3ebff;
      border: 2px dashed #6200ee;
      border-radius: 12px;
      padding: 12px;
      margin: 20px 0;
      letter-spacing: 2px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 16px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      box-sizing: border-box;
      transition: all 0.2s ease;
      cursor: pointer;
      border: none;
      outline: none;
    }
    .btn-primary {
      background: #6200ee;
      color: #fff;
      box-shadow: 0 8px 16px rgba(98, 0, 238, 0.3);
      margin-bottom: 15px;
    }
    .btn-primary:hover {
      background: #5000c9;
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(98, 0, 238, 0.4);
    }
    .btn-secondary {
      background: #f1f3f5;
      color: #495057;
      border: 1px solid #dee2e6;
    }
    .btn-secondary:hover {
      background: #e9ecef;
      transform: translateY(-1px);
    }
    .alert {
      display: none;
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 15px;
      font-size: 14px;
      font-weight: 600;
    }
    .footer-text {
      font-size: 12px;
      color: #999;
      margin-top: 25px;
    }
  </style>
  <script>
    function copyAndDownload() {
      const inviteData = "locationsharing:" + "${cleanCode}";
      navigator.clipboard.writeText(inviteData).then(function() {
        var alertBox = document.getElementById("alert");
        alertBox.style.display = "block";
        setTimeout(function() {
          alertBox.style.display = "none";
        }, 4000);
      }).catch(function(err) {
        console.error("Clipboard copy failed: ", err);
      });

      setTimeout(function() {
        window.location.href = "/download/app";
      }, 500);
    }
  </script>
</head>
<body>
  <div class="card">
    <h1>Välkommen till First Beacon!</h1>
    <p>Du har blivit inbjuden att gå med i gruppen:</p>
    
    <div class="code-display">${cleanCode}</div>
    
    <div id="alert" class="alert">
      Gruppkoden har kopierats till urklipp! Den kommer att fyllas i automatiskt när du öppnar appen.
    </div>

    <button onclick="copyAndDownload()" class="btn btn-primary">
      1. Ladda ner appen
    </button>
    
    <a href="locationsharing://join?code=${cleanCode}" class="btn btn-secondary">
      2. Öppna appen & Gå med
    </a>

    <p class="footer-text">
      Tips: Ladda ner appen först. När den är installerad, klicka på "Öppna appen & Gå med" eller öppna appen så fylls koden i automatiskt.
    </p>
  </div>
</body>
</html>
  `);
});

// App Download Link
app.get('/download/app', (req, res) => {
  const apkPath = '/var/www/first-backend/first-app-debug.apk';
  if (!fs.existsSync(apkPath)) {
    return res.status(404).send('APK-filen kunde inte hittas på servern. Vänligen kontakta administratören.');
  }
  res.setHeader('Content-Disposition', 'attachment; filename="first-app-debug.apk"');
  res.sendFile(apkPath);
});

// Fetch pending members (Any approved group member)
app.get('/api/groups/pending', async (req, res) => {
  const { groupId, ownerDeviceId } = req.query; // ownerDeviceId represents requester's deviceId
  if (!groupId || !ownerDeviceId) {
    return res.status(400).json({ error: 'groupId and ownerDeviceId are required' });
  }

  try {
    const isApproved = await checkApprovedMember(groupId as string, ownerDeviceId as string);
    if (!isApproved) {
      return res.status(403).json({ error: 'Access denied: not an approved group member' });
    }

    const pendingMembers = await getPendingMembers(groupId as string);
    return res.json({ success: true, pendingMembers });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Fetch approved members (Any approved group member)
app.get('/api/groups/members', async (req, res) => {
  const { groupId, deviceId } = req.query;
  if (!groupId || !deviceId) {
    return res.status(400).json({ error: 'groupId and deviceId are required' });
  }

  try {
    const isApproved = await checkApprovedMember(groupId as string, deviceId as string);
    if (!isApproved) {
      return res.status(403).json({ error: 'Access denied: not an approved group member' });
    }

    const members = await getGroupMembers(groupId as string);
    return res.json({ success: true, members });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Approve Member (Any approved group member)
app.post('/api/groups/approve', async (req, res) => {
  const { groupId, ownerDeviceId, memberId, approve } = req.body; // ownerDeviceId represents requester's deviceId
  if (!groupId || !ownerDeviceId || !memberId || approve === undefined) {
    return res.status(400).json({ error: 'groupId, ownerDeviceId, memberId, and approve are required' });
  }

  try {
    const isApproved = await checkApprovedMember(groupId, ownerDeviceId);
    if (!isApproved) {
      return res.status(403).json({ error: 'Access denied: not an approved group member' });
    }

    const status = await approveMember(memberId, approve);
    
    // If approved or rejected, notify the member if they are connected or listening
    // We can also send a WS message to all current approved members that someone joined
    if (status === 'APPROVED') {
      broadcastToGroup(groupId, {
        type: 'member_approved',
        memberId
      });
    }

    return res.json({ success: true, status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Group Boundary
app.get('/api/groups/boundary', async (req, res) => {
  const { groupId, memberId } = req.query;
  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    const member = await getMember(memberId as string);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const boundary = await getGroupBoundary(groupId as string);
    return res.json({ success: true, boundary: boundary ? JSON.parse(boundary) : null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update Group Boundary
app.post('/api/groups/boundary', async (req, res) => {
  const { groupId, memberId, boundary } = req.body; // boundary should be an array of coordinates or null
  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const boundaryJson = boundary ? JSON.stringify(boundary) : null;
    await updateGroupBoundary(groupId, boundaryJson);

    // Broadcast to other group members
    broadcastToGroup(groupId, {
      type: 'boundary_updated',
      boundary: boundary
    }, memberId);

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get group history
app.get('/api/groups/history', async (req, res) => {
  const { groupId, memberId, since } = req.query;
  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    // Check if requester is approved in group
    const member = await getMember(memberId as string);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const history = await getHistory(groupId as string, since ? (since as string) : undefined);
    return res.json({ success: true, history });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Add marker on the map (with optional description and photo)
app.post('/api/groups/markers', upload.single('photo'), async (req, res) => {
  const { groupId, memberId, latitude, longitude, description, iconType } = req.body;
  if (!groupId || !memberId || !latitude || !longitude) {
    return res.status(400).json({ error: 'groupId, memberId, latitude, and longitude are required' });
  }

  try {
    // Check if requester is approved in group
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const latVal = parseFloat(latitude);
    const lngVal = parseFloat(longitude);
    const photoPath = req.file ? `/api/groups/photo/${req.file.filename}` : '';

    const marker = await addMarker(groupId, memberId, latVal, lngVal, description || '', photoPath, iconType || 'default');

    // Notify group members of the new marker
    broadcastToGroup(groupId, {
      type: 'new_marker',
      marker: {
        ...marker,
        memberId,
        nickname: member.nickname,
        createdAt: new Date().toISOString()
      }
    });

    return res.json({ success: true, marker });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update/Edit marker description/icon
app.post('/api/groups/markers/update', async (req, res) => {
  const { groupId, memberId, markerId, description, iconType } = req.body;
  if (!groupId || !memberId || !markerId) {
    return res.status(400).json({ error: 'groupId, memberId, and markerId are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    await updateMarker(markerId, description || '', iconType || 'default');

    broadcastToGroup(groupId, {
      type: 'marker_updated',
      markerId,
      description: description || '',
      iconType: iconType || 'default'
    });

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete marker
app.post('/api/groups/markers/delete', async (req, res) => {
  const { groupId, memberId, markerId } = req.body;
  if (!groupId || !memberId || !markerId) {
    return res.status(400).json({ error: 'groupId, memberId, and markerId are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    await deleteMarker(markerId);

    broadcastToGroup(groupId, {
      type: 'marker_deleted',
      markerId
    });

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Move marker
app.post('/api/groups/markers/move', async (req, res) => {
  const { groupId, memberId, markerId, latitude, longitude } = req.body;
  if (!groupId || !memberId || !markerId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'groupId, memberId, markerId, latitude, and longitude are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const latVal = parseFloat(latitude);
    const lngVal = parseFloat(longitude);

    await moveMarker(markerId, latVal, lngVal);

    broadcastToGroup(groupId, {
      type: 'marker_moved',
      markerId,
      latitude: latVal,
      longitude: lngVal
    });

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get all markers in group
app.get('/api/groups/markers', async (req, res) => {
  const { groupId, memberId } = req.query;
  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    const member = await getMember(memberId as string);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const markers = await getMarkers(groupId as string);
    return res.json({ success: true, markers });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Secure endpoint to serve group photos
app.get('/api/groups/photo/:filename', async (req, res) => {
  const { filename } = req.params;
  const { groupId, memberId } = req.query;

  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    const member = await getMember(memberId as string);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    const filePath = path.join(uploadsDir, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    return res.sendFile(filePath);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update member profile (nickname, email)
app.post('/api/groups/update-profile', async (req, res) => {
  const { groupId, memberId, nickname, email } = req.body;
  if (!groupId || !memberId) {
    return res.status(400).json({ error: 'groupId and memberId are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    // Update nickname and email in database
    await updateMemberProfile(memberId, nickname, email);

    // Broadcast the nickname update to group members
    if (nickname) {
      broadcastToGroup(groupId, {
        type: 'member_profile_updated',
        memberId,
        nickname: nickname.trim()
      }, memberId);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Transfer group ownership
app.post('/api/groups/transfer-ownership', async (req, res) => {
  const { groupId, ownerDeviceId, newOwnerMemberId } = req.body;
  if (!groupId || !ownerDeviceId || !newOwnerMemberId) {
    return res.status(400).json({ error: 'groupId, ownerDeviceId, and newOwnerMemberId are required' });
  }

  try {
    const newOwnerDeviceId = await transferGroupOwnership(groupId, ownerDeviceId, newOwnerMemberId);
    
    // Broadcast ownership transfer to the group
    broadcastToGroup(groupId, {
      type: 'ownership_transferred',
      newOwnerDeviceId,
      newOwnerMemberId
    });

    return res.json({ success: true, message: 'Group ownership transferred successfully' });
  } catch (error: any) {
    console.error(error);
    return res.status(400).json({ error: error.message || 'Failed to transfer ownership' });
  }
});

// Remove member from group (Owner only)
app.post('/api/groups/members/remove', async (req, res) => {
  const { groupId, ownerDeviceId, memberIdToRemove } = req.body;
  if (!groupId || !ownerDeviceId || !memberIdToRemove) {
    return res.status(400).json({ error: 'groupId, ownerDeviceId, and memberIdToRemove are required' });
  }

  try {
    await removeMemberFromGroup(groupId, ownerDeviceId, memberIdToRemove);

    // Broadcast member removal to the group
    broadcastToGroup(groupId, {
      type: 'member_removed',
      memberId: memberIdToRemove
    });

    return res.json({ success: true, message: 'Member removed from group successfully' });
  } catch (error: any) {
    console.error(error);
    return res.status(400).json({ error: error.message || 'Failed to remove member' });
  }
});

// Delete self (Leave group with email verification)
app.post('/api/groups/members/delete-self', async (req, res) => {
  const { groupId, memberId, email, code } = req.body;
  if (!groupId || !memberId || !email || !code) {
    return res.status(400).json({ error: 'groupId, memberId, email, and code are required' });
  }

  try {
    // 1. Verify the code
    const isCodeValid = await checkEmailVerification(email, code);
    if (!isCodeValid) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // 2. Fetch the member record
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    // 3. Verify that the email matches the member's email
    if (!member.email || member.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ error: 'Email does not match this member\'s profile email' });
    }

    // 4. Check if the user is the owner
    const isOwner = await checkGroupOwner(groupId, member.device_id);
    if (isOwner) {
      // Check if they are the only member in the group
      const allMembers = await getGroupMembers(groupId);
      if (allMembers.length > 1) {
        return res.status(400).json({ error: 'As the group owner, you must transfer ownership to another member before leaving the group.' });
      } else {
        // Owner is the only member, delete the entire group
        await deleteGroup(groupId);
        return res.json({ success: true, message: 'Group and your membership have been deleted successfully.' });
      }
    }

    // 5. Delete the member
    await deleteMember(memberId);

    // Broadcast member removal/leaving to the group
    broadcastToGroup(groupId, {
      type: 'member_removed',
      memberId
    });

    return res.json({ success: true, message: 'You have left the group and your membership was deleted.' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Post location update (useful for background tracking when WS is not connected)
app.post('/api/groups/location', async (req, res) => {
  const { groupId, memberId, latitude, longitude, heading, timestamp, speed, transportMode } = req.body;
  if (!groupId || !memberId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'groupId, memberId, latitude, and longitude are required' });
  }

  try {
    const member = await getMember(memberId);
    if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Access denied: not an approved member of this group' });
    }

    // Save to SQLite
    await addLocation(groupId, memberId, latitude, longitude, timestamp, speed, transportMode);

    // Broadcast to other online members in the group
    broadcastToGroup(groupId, {
      type: 'location_update',
      memberId,
      nickname: member.nickname,
      latitude,
      longitude,
      heading: heading !== undefined ? heading : 0.0,
      timestamp,
      speed,
      transportMode
    }, memberId);

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Helper function to broadcast message to all approved group connections
function broadcastToGroup(groupId: string, message: any, excludeMemberId?: string) {
  const connections = groupConnections.get(groupId);
  if (!connections) return;

  const payload = JSON.stringify(message);
  connections.forEach((ws, memberId) => {
    if (memberId !== excludeMemberId && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

// WebSocket connection routing & authentication
server.on('upgrade', (request, socket, head) => {
  const parsedUrl = url.parse(request.url || '', true);
  const { pathname, query } = parsedUrl;

  if (pathname === '/ws' || pathname === '/ws/') {
    const groupId = query.groupId as string;
    const memberId = query.memberId as string;

    if (!groupId || !memberId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate member status asynchronously
    getMember(memberId).then(member => {
      if (!member || member.group_id !== groupId || member.status !== 'APPROVED') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, member);
      });
    }).catch(err => {
      console.error(err);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// WebSocket Handler
wss.on('connection', (ws: WebSocket, req: any, member: any) => {
  const { group_id: groupId, id: memberId, nickname } = member;

  console.log(`User ${nickname} (${memberId}) connected to WS in group ${groupId}`);

  // Register connection
  if (!groupConnections.has(groupId)) {
    groupConnections.set(groupId, new Map());
  }
  groupConnections.get(groupId)!.set(memberId, ws);

  // Send message to other members that this user is online
  broadcastToGroup(groupId, {
    type: 'member_online',
    memberId,
    nickname
  }, memberId);

  ws.on('message', async (messageData) => {
    try {
      const data = JSON.parse(messageData.toString());
      
      if (data.type === 'location_update') {
        const { latitude, longitude, heading, timestamp, speed, transportMode } = data;
        if (latitude === undefined || longitude === undefined) return;

        // Save to SQLite locations table
        await addLocation(groupId, memberId, latitude, longitude, timestamp, speed, transportMode);

        // Broadcast to other members in the group
        broadcastToGroup(groupId, {
          type: 'location_update',
          memberId,
          nickname,
          latitude,
          longitude,
          heading, // optional compass heading
          timestamp,
          speed,
          transportMode
        }, memberId);
      }
    } catch (err) {
      console.error('Failed parsing WS message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`User ${nickname} (${memberId}) disconnected`);
    const connections = groupConnections.get(groupId);
    if (connections) {
      connections.delete(memberId);
      if (connections.size === 0) {
        groupConnections.delete(groupId);
      }
    }

    broadcastToGroup(groupId, {
      type: 'member_offline',
      memberId,
      nickname
    });
  });

  ws.on('error', (err) => {
    console.error(`WS error for ${nickname}:`, err);
  });
});

// Initialize DB and start HTTP/WS Server
async function startServer() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
