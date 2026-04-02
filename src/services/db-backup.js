const fs = require('fs');
const path = require('path');

const TICK_INTERVAL_MS = 60 * 1000;
const backupRunState = {
  lastRunDateKey: '',
};

function getDatabasePath() {
  return path.resolve(process.cwd(), process.env.DB_PATH || './data/accounting.db');
}

function getBackupDir() {
  return path.resolve(process.cwd(), process.env.BACKUP_DIR || './data/backups');
}

function getDailyBackupTime() {
  const raw = String(process.env.BACKUP_DAILY_TIME || '03:30').trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : '03:30';
}

function getBackupKeepDays() {
  const raw = Number(process.env.BACKUP_KEEP_DAYS || 30);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.floor(raw);
}

function ensureBackupDir() {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatFileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function parseBackupFilenameToIso(name) {
  const match = String(name || '').match(/^accounting-(\d{8})-(\d{6})(?:-[a-z0-9_-]+)?\.db$/i);
  if (!match) return null;
  const d = match[1];
  const t = match[2];
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const hh = Number(t.slice(0, 2));
  const mm = Number(t.slice(2, 4));
  const ss = Number(t.slice(4, 6));
  const local = new Date(y, m - 1, day, hh, mm, ss, 0);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

function toBackupMeta(filePath, stats = null) {
  const resolvedPath = path.resolve(filePath);
  const name = path.basename(resolvedPath);
  const stat = stats || fs.statSync(resolvedPath);
  return {
    filename: name,
    path: resolvedPath,
    sizeBytes: Number(stat.size || 0),
    createdAt: parseBackupFilenameToIso(name) || new Date(Number(stat.mtimeMs || Date.now())).toISOString(),
    updatedAt: new Date(Number(stat.mtimeMs || Date.now())).toISOString(),
  };
}

function listBackups(options = {}) {
  const limitRaw = Number(options.limit || 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 30;
  const dir = ensureBackupDir();
  const files = fs.readdirSync(dir)
    .filter((name) => /^accounting-\d{8}-\d{6}(?:-[a-z0-9_-]+)?\.db$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      return { name, filePath, stat };
    })
    .sort((a, b) => Number(b.stat.mtimeMs || 0) - Number(a.stat.mtimeMs || 0))
    .slice(0, limit);
  return files.map((row) => toBackupMeta(row.filePath, row.stat));
}

function assertBackupFilename(filename) {
  const name = String(filename || '').trim();
  if (!/^accounting-\d{8}-\d{6}(?:-[a-z0-9_-]+)?\.db$/i.test(name)) {
    throw new Error('備份檔名格式不正確');
  }
  return name;
}

function createBackup(options = {}) {
  const reasonRaw = String(options.reason || 'manual').trim().toLowerCase();
  const reason = /^[a-z0-9_-]{1,24}$/.test(reasonRaw) ? reasonRaw : 'manual';
  const now = options.now instanceof Date ? options.now : new Date();
  const sourceDbPath = getDatabasePath();
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`找不到資料庫檔案：${sourceDbPath}`);
  }
  const backupDir = ensureBackupDir();
  const stamp = formatFileStamp(now);
  const backupName = `accounting-${stamp}-${reason}.db`;
  const targetPath = path.join(backupDir, backupName);
  fs.copyFileSync(sourceDbPath, targetPath);
  const meta = toBackupMeta(targetPath);
  cleanupOldBackups();
  return meta;
}

function cleanupOldBackups() {
  const keepDays = getBackupKeepDays();
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  listBackups({ limit: 500 }).forEach((row) => {
    const updatedMs = new Date(row.updatedAt).getTime();
    if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) {
      try {
        fs.unlinkSync(row.path);
      } catch (_) {
        // best effort
      }
    }
  });
}

function restoreBackupByFilename(filename, options = {}) {
  const backupName = assertBackupFilename(filename);
  const backupDir = ensureBackupDir();
  const backupPath = path.join(backupDir, backupName);
  if (!fs.existsSync(backupPath)) {
    throw new Error('找不到指定備份檔');
  }
  const dbPath = getDatabasePath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const createSafetyBackup = options.createSafetyBackup !== false;
  let safetyBackup = null;
  if (createSafetyBackup && fs.existsSync(dbPath)) {
    safetyBackup = createBackup({ reason: 'pre_restore' });
  }

  const tempPath = `${dbPath}.restore.tmp`;
  fs.copyFileSync(backupPath, tempPath);
  fs.renameSync(tempPath, dbPath);

  return {
    restored: toBackupMeta(backupPath),
    safetyBackup,
    databasePath: dbPath,
  };
}

function shouldRunNow(now = new Date()) {
  const [hh, mm] = getDailyBackupTime().split(':').map((n) => Number(n));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  return now.getHours() === hh && now.getMinutes() === mm;
}

function tickDatabaseBackupJobs() {
  const now = new Date();
  if (!shouldRunNow(now)) return;
  const dateKey = formatDateKey(now);
  if (backupRunState.lastRunDateKey === dateKey) return;
  createBackup({ reason: 'daily' });
  backupRunState.lastRunDateKey = dateKey;
}

function startDatabaseBackupScheduler() {
  tickDatabaseBackupJobs();
  return setInterval(() => {
    try {
      tickDatabaseBackupJobs();
    } catch (error) {
      console.error('[backup] scheduler error:', error?.message || error);
    }
  }, TICK_INTERVAL_MS);
}

function getBackupConfig() {
  return {
    databasePath: getDatabasePath(),
    backupDir: getBackupDir(),
    dailyTime: getDailyBackupTime(),
    keepDays: getBackupKeepDays(),
  };
}

module.exports = {
  createBackup,
  listBackups,
  restoreBackupByFilename,
  startDatabaseBackupScheduler,
  getBackupConfig,
};
