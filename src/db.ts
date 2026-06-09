import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { randomUUID } from 'crypto';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDb() {
  const dbPath = path.join(__dirname, '..', 'database.sqlite');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON');

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE,
      owner_device_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      device_id TEXT,
      nickname TEXT,
      email TEXT,
      status TEXT, -- 'PENDING', 'APPROVED'
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      member_id TEXT,
      latitude REAL,
      longitude REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      speed REAL,
      transport_mode TEXT,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS markers (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      member_id TEXT,
      latitude REAL,
      longitude REAL,
      description TEXT,
      photo_path TEXT,
      icon_type TEXT DEFAULT 'default',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      code TEXT,
      expires_at DATETIME
    );
  `);

  try {
    await db.run('ALTER TABLE members ADD COLUMN email TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run('ALTER TABLE locations ADD COLUMN speed REAL');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run('ALTER TABLE locations ADD COLUMN transport_mode TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run("ALTER TABLE markers ADD COLUMN icon_type TEXT DEFAULT 'default'");
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run('ALTER TABLE groups ADD COLUMN boundary TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  console.log('Database and tables initialized.');
}

export async function createGroup(code: string, ownerDeviceId: string, nickname?: string, email?: string) {
  const normalizedCode = code.toLowerCase().trim();
  
  // Check if group already exists
  const existingGroup = await db.get('SELECT * FROM groups WHERE code = ?', [normalizedCode]);
  if (existingGroup) {
    if (existingGroup.owner_device_id === ownerDeviceId) {
      // Re-fetch the owner member details
      const ownerMember = await db.get(
        'SELECT id FROM members WHERE group_id = ? AND device_id = ?',
        [existingGroup.id, ownerDeviceId]
      );
      return {
        groupId: existingGroup.id,
        memberId: ownerMember ? ownerMember.id : '',
        ownerToken: 'RESTORED'
      };
    } else if (email && email.trim()) {
      // Reclaim group ownership if owner email matches
      const ownerMemberByEmail = await db.get(
        'SELECT * FROM members WHERE group_id = ? AND email = ?',
        [existingGroup.id, email.toLowerCase().trim()]
      );
      if (ownerMemberByEmail && existingGroup.owner_device_id === ownerMemberByEmail.device_id) {
        await db.run(
          'UPDATE groups SET owner_device_id = ? WHERE id = ?',
          [ownerDeviceId, existingGroup.id]
        );
        await db.run(
          'UPDATE members SET device_id = ?, nickname = ? WHERE id = ?',
          [ownerDeviceId, nickname && nickname.trim() ? nickname.trim() : ownerMemberByEmail.nickname, ownerMemberByEmail.id]
        );
        return {
          groupId: existingGroup.id,
          memberId: ownerMemberByEmail.id,
          ownerToken: 'RESTORED'
        };
      }
    }
    throw new Error('Group code already exists');
  }

  const groupId = randomUUID();
  const ownerToken = randomUUID(); // Token to prove ownership of the group
  
  await db.run(
    'INSERT INTO groups (id, code, owner_device_id) VALUES (?, ?, ?)',
    [groupId, normalizedCode, ownerDeviceId]
  );

  // Automatically add the owner as an APPROVED member of the group
  const memberId = randomUUID();
  const creatorNickname = nickname && nickname.trim() ? nickname.trim() : 'Skapare';
  await db.run(
    'INSERT INTO members (id, group_id, device_id, nickname, email, status) VALUES (?, ?, ?, ?, ?, ?)',
    [memberId, groupId, ownerDeviceId, creatorNickname, email ? email.toLowerCase().trim() : null, 'APPROVED']
  );

  return { groupId, memberId, ownerToken };
}

export async function joinRequest(code: string, nickname: string, deviceId: string, email?: string) {
  const group = await db.get('SELECT * FROM groups WHERE code = ?', [code.toLowerCase().trim()]);
  if (!group) {
    throw new Error('Group not found');
  }

  // 1. Check if we already have a member with this email in the group
  if (email && email.trim()) {
    const existingMemberByEmail = await db.get(
      'SELECT * FROM members WHERE group_id = ? AND email = ?',
      [group.id, email.toLowerCase().trim()]
    );

    if (existingMemberByEmail) {
      // Reinstall recovery: update device ID & nickname for existing email
      await db.run(
        'UPDATE members SET device_id = ?, nickname = ? WHERE id = ?',
        [deviceId, nickname, existingMemberByEmail.id]
      );

      // If this member was the group owner, update the group owner device ID as well
      const wasOwner = group.owner_device_id === existingMemberByEmail.device_id;
      if (wasOwner) {
        await db.run(
          'UPDATE groups SET owner_device_id = ? WHERE id = ?',
          [deviceId, group.id]
        );
      }

      return {
        memberId: existingMemberByEmail.id,
        groupId: group.id,
        status: existingMemberByEmail.status,
        isOwner: wasOwner
      };
    }
  }

  // 2. Check if already a member by deviceId
  const existingMember = await db.get(
    'SELECT * FROM members WHERE group_id = ? AND device_id = ?',
    [group.id, deviceId]
  );

  if (existingMember) {
    const isOwner = group.owner_device_id === deviceId;
    return {
      memberId: existingMember.id,
      groupId: group.id,
      status: existingMember.status,
      isOwner: isOwner
    };
  }

  const isOwner = group.owner_device_id === deviceId;
  const memberId = randomUUID();
  const status = isOwner ? 'APPROVED' : 'PENDING';
  
  await db.run(
    'INSERT INTO members (id, group_id, device_id, nickname, email, status) VALUES (?, ?, ?, ?, ?, ?)',
    [memberId, group.id, deviceId, nickname, email ? email.toLowerCase().trim() : null, status]
  );

  return { memberId, groupId: group.id, status, isOwner };
}

export async function checkGroupOwner(groupId: string, ownerDeviceId: string) {
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  return group && group.owner_device_id === ownerDeviceId;
}

export async function checkApprovedMember(groupId: string, deviceId: string) {
  const member = await db.get(
    "SELECT * FROM members WHERE group_id = ? AND device_id = ? AND status = 'APPROVED'",
    [groupId, deviceId]
  );
  return !!member;
}

export async function getPendingMembers(groupId: string) {
  return await db.all(
    "SELECT id, nickname, device_id as deviceId FROM members WHERE group_id = ? AND status = 'PENDING'",
    [groupId]
  );
}

export async function getGroupMembers(groupId: string) {
  return await db.all(
    "SELECT id, nickname, status FROM members WHERE group_id = ? AND status = 'APPROVED'",
    [groupId]
  );
}

export async function getMember(memberId: string) {
  return await db.get('SELECT * FROM members WHERE id = ?', [memberId]);
}

export async function approveMember(memberId: string, approve: boolean) {
  if (approve) {
    await db.run("UPDATE members SET status = 'APPROVED' WHERE id = ?", [memberId]);
    return 'APPROVED';
  } else {
    await db.run('DELETE FROM members WHERE id = ?', [memberId]);
    return 'REJECTED';
  }
}

export async function updateMemberProfile(memberId: string, nickname?: string, email?: string) {
  await db.run(
    'UPDATE members SET nickname = COALESCE(?, nickname), email = COALESCE(?, email) WHERE id = ?',
    [
      nickname !== undefined && nickname !== null ? nickname.trim() : null,
      email !== undefined && email !== null ? email.trim() : null,
      memberId
    ]
  );
}

export async function addLocation(groupId: string, memberId: string, latitude: number, longitude: number, timestamp?: string, speed?: number, transportMode?: string) {
  if (timestamp) {
    await db.run(
      'INSERT INTO locations (group_id, member_id, latitude, longitude, timestamp, speed, transport_mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [groupId, memberId, latitude, longitude, timestamp, speed !== undefined ? speed : null, transportMode || null]
    );
  } else {
    await db.run(
      'INSERT INTO locations (group_id, member_id, latitude, longitude, speed, transport_mode) VALUES (?, ?, ?, ?, ?, ?)',
      [groupId, memberId, latitude, longitude, speed !== undefined ? speed : null, transportMode || null]
    );
  }
}

export async function getHistory(groupId: string, sinceISO?: string) {
  let query = `
    SELECT l.member_id as memberId, m.nickname, l.latitude, l.longitude, l.timestamp, l.speed, l.transport_mode as transportMode
    FROM locations l
    JOIN members m ON l.member_id = m.id
    WHERE l.group_id = ?
  `;
  const params: any[] = [groupId];

  if (sinceISO) {
    query += ' AND l.timestamp >= ?';
    // Convert to ISO/SQLite format
    params.push(sinceISO);
  }

  query += ' ORDER BY l.timestamp ASC';

  const rows = await db.all(query, params);

  // Group paths by memberId
  const memberPaths: { [key: string]: { memberId: string; nickname: string; path: Array<{ lat: number; lng: number; time: string; speed?: number; transportMode?: string }> } } = {};

  for (const row of rows) {
    if (!memberPaths[row.memberId]) {
      memberPaths[row.memberId] = {
        memberId: row.memberId,
        nickname: row.nickname,
        path: []
      };
    }
    memberPaths[row.memberId].path.push({
      lat: row.latitude,
      lng: row.longitude,
      time: row.timestamp,
      speed: row.speed !== null ? row.speed : undefined,
      transportMode: row.transport_mode !== null ? row.transport_mode : undefined
    });
  }

  return Object.values(memberPaths);
}

export async function addMarker(
  groupId: string,
  memberId: string,
  latitude: number,
  longitude: number,
  description: string,
  photoPath: string,
  iconType?: string
) {
  const markerId = randomUUID();
  const icon = iconType || 'default';
  await db.run(
    'INSERT INTO markers (id, group_id, member_id, latitude, longitude, description, photo_path, icon_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [markerId, groupId, memberId, latitude, longitude, description, photoPath, icon]
  );

  return {
    id: markerId,
    latitude,
    longitude,
    description,
    photoPath,
    iconType: icon
  };
}

export async function getMarkers(groupId: string) {
  return await db.all(
    `SELECT mk.id, mk.member_id as memberId, m.nickname, mk.latitude, mk.longitude, mk.description, mk.photo_path as photoPath, mk.icon_type as iconType, mk.created_at as createdAt
     FROM markers mk
     JOIN members m ON mk.member_id = m.id
     WHERE mk.group_id = ?
     ORDER BY mk.created_at DESC`,
    [groupId]
  );
}

export async function updateMarker(markerId: string, description: string, iconType: string) {
  await db.run(
    'UPDATE markers SET description = ?, icon_type = ? WHERE id = ?',
    [description, iconType, markerId]
  );
}

export async function deleteMarker(markerId: string) {
  await db.run('DELETE FROM markers WHERE id = ?', [markerId]);
}

export async function moveMarker(markerId: string, latitude: number, longitude: number) {
  await db.run(
    'UPDATE markers SET latitude = ?, longitude = ? WHERE id = ?',
    [latitude, longitude, markerId]
  );
}

export async function saveEmailVerification(email: string, code: string) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.run(
    'INSERT OR REPLACE INTO email_verifications (email, code, expires_at) VALUES (?, ?, ?)',
    [email.toLowerCase().trim(), code, expiresAt]
  );
}

export async function checkEmailVerification(email: string, code: string) {
  const row = await db.get(
    'SELECT * FROM email_verifications WHERE email = ? AND code = ?',
    [email.toLowerCase().trim(), code]
  );
  if (!row) return false;
  
  const now = new Date().toISOString();
  if (row.expires_at < now) {
    await db.run('DELETE FROM email_verifications WHERE email = ?', [email.toLowerCase().trim()]);
    return false;
  }
  
  await db.run('DELETE FROM email_verifications WHERE email = ?', [email.toLowerCase().trim()]);
  return true;
}

export async function transferGroupOwnership(groupId: string, ownerDeviceId: string, newOwnerMemberId: string) {
  const isOwner = await checkGroupOwner(groupId, ownerDeviceId);
  if (!isOwner) {
    throw new Error('Access denied: only the group owner can transfer ownership');
  }

  const member = await db.get('SELECT device_id FROM members WHERE id = ? AND group_id = ? AND status = \'APPROVED\'', [newOwnerMemberId, groupId]);
  if (!member) {
    throw new Error('New owner is not a member of this group');
  }

  await db.run('UPDATE groups SET owner_device_id = ? WHERE id = ?', [member.device_id, groupId]);
  return member.device_id;
}

export async function removeMemberFromGroup(groupId: string, requesterDeviceId: string, memberIdToRemove: string) {
  const isApproved = await checkApprovedMember(groupId, requesterDeviceId);
  if (!isApproved) {
    throw new Error('Access denied: only approved group members can remove members');
  }

  const member = await db.get('SELECT * FROM members WHERE id = ? AND group_id = ?', [memberIdToRemove, groupId]);
  if (!member) {
    throw new Error('Member not found in this group');
  }

  const group = await db.get('SELECT owner_device_id FROM groups WHERE id = ?', [groupId]);
  if (group && member.device_id === group.owner_device_id) {
    throw new Error('Cannot remove the group owner/creator from the group');
  }

  await db.run('DELETE FROM members WHERE id = ?', [memberIdToRemove]);
}

export async function deleteGroup(groupId: string) {
  await db.run('DELETE FROM groups WHERE id = ?', [groupId]);
}

export async function deleteMember(memberId: string) {
  await db.run('DELETE FROM members WHERE id = ?', [memberId]);
}

export async function getGroupBoundary(groupId: string) {
  const group = await db.get('SELECT boundary FROM groups WHERE id = ?', [groupId]);
  return group ? group.boundary : null;
}

export async function updateGroupBoundary(groupId: string, boundaryJson: string | null) {
  await db.run('UPDATE groups SET boundary = ? WHERE id = ?', [boundaryJson, groupId]);
}

export async function recoverGroupsByEmail(email: string, deviceId: string) {
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Update group ownerships for groups where the owner has this email
  await db.run(
    `UPDATE groups
     SET owner_device_id = ?
     WHERE id IN (
       SELECT g.id
       FROM groups g
       JOIN members m ON g.owner_device_id = m.device_id
       WHERE LOWER(m.email) = ?
     )`,
    [deviceId, normalizedEmail]
  );

  // 2. Update all member device IDs for this email
  await db.run(
    'UPDATE members SET device_id = ? WHERE LOWER(email) = ?',
    [deviceId, normalizedEmail]
  );

  // 3. Retrieve all group sessions for this email
  const query = `
    SELECT 
      g.id as groupId,
      g.code,
      m.id as memberId,
      m.status,
      m.nickname,
      m.email,
      CASE WHEN g.owner_device_id = m.device_id THEN 1 ELSE 0 END as isOwner
    FROM members m
    JOIN groups g ON m.group_id = g.id
    WHERE LOWER(m.email) = ?
  `;
  const rows = await db.all(query, [normalizedEmail]);
  return rows.map(row => ({
    groupId: row.groupId,
    code: row.code,
    memberId: row.memberId,
    status: row.status,
    isOwner: row.isOwner === 1,
    ownerToken: row.isOwner === 1 ? 'RESTORED' : null,
    nickname: row.nickname || '',
    email: row.email || ''
  }));
}

