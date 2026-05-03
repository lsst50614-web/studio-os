import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8080);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_CONNECTION_STRING,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

const caseTypes = {
  "錄音": ["前製會議", "錄音 Session 1", "錄音 Session 2", "人聲剪輯", "初混確認", "交件"],
  "混音": ["素材確認", "初混版本", "客戶試聽", "修改版本", "最終確認", "交件"],
  "編曲": ["風格確認", "Demo 製作", "客戶試聽", "編曲完稿", "人聲配合", "交件"],
  "母帶": ["素材接收", "聲音分析", "母帶處理", "試聽確認", "最終版本", "交件"],
  "廣告配樂": ["廣告簡報", "風格確認", "初版配樂", "影片對位", "修改", "交件"],
  "電影配樂": ["劇本分析", "音樂風格會議", "主題曲創作", "配樂錄製", "混音", "交件"]
};

const statuses = new Set(["新接案", "製作中", "待驗收", "需修改", "已完成", "暫緩"]);
const recordKinds = new Set(["公司狀態", "零用金"]);
const paymentStatuses = new Set(["未支出", "已支出"]);
const workTypes = new Set(Object.keys(caseTypes));

app.use(express.json({ limit: "6mb" }));
app.use(express.static(__dirname, {
  extensions: ["html"],
  index: "index.html"
}));

async function initDb() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_CONNECTION_STRING) {
    throw new Error("DATABASE_URL or POSTGRES_CONNECTION_STRING is required");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_cases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      client TEXT NOT NULL,
      owner TEXT NOT NULL,
      start_date DATE NOT NULL,
      due_date DATE NOT NULL,
      quote INTEGER NOT NULL DEFAULT 0,
      cost INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '新接案',
      notes TEXT NOT NULL DEFAULT '',
      checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE studio_cases
      ADD COLUMN IF NOT EXISTS drive_folder_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS source_material_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS delivery_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS delivery_notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS review_notes TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_company_records (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT '已支出',
      occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE studio_company_records
      ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT '已支出';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      work_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_boss BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_expense_claims (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES studio_users(id) ON DELETE SET NULL,
      employee_name TEXT NOT NULL,
      item_name TEXT NOT NULL,
      purchased_at DATE NOT NULL,
      receipt_image TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE studio_users
      ADD COLUMN IF NOT EXISTS work_types JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM studio_users");
  if (rows[0].count === 0) {
    const password = hashPassword("boss123");
    await pool.query(
      `INSERT INTO studio_users (email, display_name, role, password_hash, password_salt, is_boss)
       VALUES ($1, $2, $3, $4, $5, true)`,
      ["boss", "老闆", "老闆", password.hash, password.salt]
    );
  }
}

function toCase(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    client: row.client,
    owner: row.owner,
    start: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : row.start_date,
    due: row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date,
    quote: Number(row.quote || 0),
    cost: Number(row.cost || 0),
    status: row.status,
    notes: row.notes || "",
    checklist: Array.isArray(row.checklist) ? row.checklist : [],
    driveFolderUrl: row.drive_folder_url || "",
    sourceMaterialUrl: row.source_material_url || "",
    deliveryUrl: row.delivery_url || "",
    deliveryNotes: row.delivery_notes || "",
    reviewNotes: row.review_notes || "",
    deliveredAt: row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at
  };
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch (_error) {
    return "";
  }
}

function cleanEmail(value) {
  return cleanText(value).toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function toCompanyRecord(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    amount: Number(row.amount || 0),
    paymentStatus: row.kind === "零用金" ? (row.payment_status || "已支出") : "不適用",
    date: row.occurred_on instanceof Date ? row.occurred_on.toISOString().slice(0, 10) : row.occurred_on,
    notes: row.notes || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function toUser(row) {
  return {
    id: row.id,
    email: row.email,
    label: row.display_name,
    role: row.role,
    employee: row.is_boss ? "" : row.display_name,
    icon: row.is_boss ? "👑" : "👤",
    isBoss: Boolean(row.is_boss),
    workTypes: Array.isArray(row.work_types) ? row.work_types : []
  };
}

function toExpenseClaim(row) {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    itemName: row.item_name,
    purchaseDate: row.purchased_at instanceof Date ? row.purchased_at.toISOString().slice(0, 10) : row.purchased_at,
    receiptImage: row.receipt_image || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function nextCaseId() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `STU-${yy}${mm}-`;
  const { rows } = await pool.query(
    "SELECT id FROM studio_cases WHERE id LIKE $1 ORDER BY id DESC LIMIT 1",
    [`${prefix}%`]
  );
  const next = rows[0] ? Number(rows[0].id.slice(-3)) + 1 : 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.get("/api/cases", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM studio_cases ORDER BY created_at DESC");
    res.json(rows.map(toCase));
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email || !password) {
      res.status(400).json({ error: "請輸入帳號與密碼" });
      return;
    }

    const { rows } = await pool.query("SELECT * FROM studio_users WHERE lower(email) = $1", [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      res.status(401).json({ error: "帳號或密碼不正確，請再試一次。" });
      return;
    }
    res.json(toUser(user));
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", async (_req, res, next) => {
  try {
    const requesterId = Number(_req.query.requesterId);
    const requester = await pool.query("SELECT is_boss FROM studio_users WHERE id = $1", [requesterId]);
    if (!requester.rows[0]?.is_boss) {
      res.status(403).json({ error: "只有老闆可以讀取員工帳號" });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM studio_users ORDER BY is_boss DESC, display_name");
    res.json(rows.map(toUser));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", async (req, res, next) => {
  try {
    const body = req.body || {};
    const requester = await pool.query("SELECT is_boss FROM studio_users WHERE id = $1", [Number(body.requesterId)]);
    if (!requester.rows[0]?.is_boss) {
      res.status(403).json({ error: "只有老闆可以新增員工帳號" });
      return;
    }

    const email = cleanEmail(body.email);
    const displayName = cleanText(body.displayName);
    const password = String(body.password || "");
    if (!email || !displayName || !password) {
      res.status(400).json({ error: "缺少必要欄位" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "密碼至少需要 6 碼" });
      return;
    }

    const hashed = hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO studio_users (email, display_name, role, password_hash, password_salt, is_boss)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING *`,
      [email, displayName, "員工", hashed.hash, hashed.salt]
    );
    res.status(201).json(toUser(rows[0]));
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: "這個 email 已經建立過帳號" });
      return;
    }
    next(error);
  }
});

app.patch("/api/users/:id/work-types", async (req, res, next) => {
  try {
    const body = req.body || {};
    const requesterId = Number(body.requesterId);
    const targetId = Number(req.params.id);
    const selected = Array.isArray(body.workTypes) ? body.workTypes.filter(item => workTypes.has(item)) : [];
    if (!targetId || !requesterId) {
      res.status(400).json({ error: "缺少使用者資訊" });
      return;
    }

    const requester = await pool.query("SELECT * FROM studio_users WHERE id = $1", [requesterId]);
    if (!requester.rows[0] || (!requester.rows[0].is_boss && requesterId !== targetId)) {
      res.status(403).json({ error: "沒有權限更新工作項目" });
      return;
    }

    const { rows } = await pool.query(
      `UPDATE studio_users
       SET work_types = $1::jsonb,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify([...new Set(selected)]), targetId]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "找不到使用者" });
      return;
    }
    res.json(toUser(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/:id/password", async (req, res, next) => {
  try {
    const body = req.body || {};
    const requesterId = Number(body.requesterId);
    const targetId = Number(req.params.id);
    const password = String(body.password || "");
    if (!targetId || !requesterId) {
      res.status(400).json({ error: "缺少使用者資訊" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "密碼至少需要 6 碼" });
      return;
    }

    const requester = await pool.query("SELECT * FROM studio_users WHERE id = $1", [requesterId]);
    if (!requester.rows[0] || (!requester.rows[0].is_boss && requesterId !== targetId)) {
      res.status(403).json({ error: "沒有權限更新這個密碼" });
      return;
    }

    const hashed = hashPassword(password);
    const { rows } = await pool.query(
      `UPDATE studio_users
       SET password_hash = $1,
           password_salt = $2,
           updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [hashed.hash, hashed.salt, targetId]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "找不到使用者" });
      return;
    }
    res.json(toUser(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.get("/api/company-records", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM studio_company_records ORDER BY occurred_on DESC, created_at DESC");
    res.json(rows.map(toCompanyRecord));
  } catch (error) {
    next(error);
  }
});

app.get("/api/expense-claims", async (req, res, next) => {
  try {
    const requesterId = Number(req.query.requesterId);
    const requester = await pool.query("SELECT * FROM studio_users WHERE id = $1", [requesterId]);
    if (!requester.rows[0]) {
      res.status(403).json({ error: "沒有權限讀取報帳" });
      return;
    }

    const query = requester.rows[0].is_boss
      ? ["SELECT * FROM studio_expense_claims ORDER BY purchased_at DESC, created_at DESC", []]
      : ["SELECT * FROM studio_expense_claims WHERE user_id = $1 ORDER BY purchased_at DESC, created_at DESC", [requesterId]];
    const { rows } = await pool.query(query[0], query[1]);
    res.json(rows.map(toExpenseClaim));
  } catch (error) {
    next(error);
  }
});

app.post("/api/expense-claims", async (req, res, next) => {
  try {
    const body = req.body || {};
    const requesterId = Number(body.requesterId);
    const requester = await pool.query("SELECT * FROM studio_users WHERE id = $1", [requesterId]);
    if (!requester.rows[0]) {
      res.status(403).json({ error: "沒有權限新增報帳" });
      return;
    }

    const itemName = cleanText(body.itemName);
    const purchaseDate = cleanText(body.purchaseDate);
    const receiptImage = cleanText(body.receiptImage);
    if (!itemName || !purchaseDate || !receiptImage) {
      res.status(400).json({ error: "請填寫物品名稱、購買時間，並上傳發票照片" });
      return;
    }
    if (!receiptImage.startsWith("data:image/") || receiptImage.length > 5_000_000) {
      res.status(400).json({ error: "發票照片格式不正確或檔案太大" });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO studio_expense_claims (user_id, employee_name, item_name, purchased_at, receipt_image)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [requesterId, requester.rows[0].display_name, itemName, purchaseDate, receiptImage]
    );
    res.status(201).json(toExpenseClaim(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/company-records", async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.role !== "owner") {
      res.status(403).json({ error: "只有老闆可以新增行政紀錄" });
      return;
    }
    if (!recordKinds.has(body.kind)) {
      res.status(400).json({ error: "紀錄類型不正確" });
      return;
    }
    if (!cleanText(body.title) || !body.date) {
      res.status(400).json({ error: "缺少必要欄位" });
      return;
    }

    const amount = body.kind === "零用金" ? Math.max(0, Number(body.amount || 0)) : 0;
    const paymentStatus = body.kind === "零用金" && paymentStatuses.has(body.paymentStatus) ? body.paymentStatus : "不適用";
    const { rows } = await pool.query(
      `INSERT INTO studio_company_records (kind, title, amount, payment_status, occurred_on, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [body.kind, cleanText(body.title), amount, paymentStatus, body.date, cleanText(body.notes)]
    );
    res.status(201).json(toCompanyRecord(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/company-records/:id", async (req, res, next) => {
  try {
    if (req.body?.role !== "owner") {
      res.status(403).json({ error: "只有老闆可以刪除行政紀錄" });
      return;
    }
    await pool.query("DELETE FROM studio_company_records WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/cases", async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.role !== "owner") {
      res.status(403).json({ error: "只有老闆可以建立案件" });
      return;
    }
    if (!body.name || !body.type || !body.client || !body.owner || !body.start || !body.due) {
      res.status(400).json({ error: "缺少必要欄位" });
      return;
    }
    if (!caseTypes[body.type]) {
      res.status(400).json({ error: "案件種類不正確" });
      return;
    }
    if (!statuses.has(body.status || "新接案")) {
      res.status(400).json({ error: "案件狀態不正確" });
      return;
    }

    const id = await nextCaseId();
    const checklist = caseTypes[body.type].map(() => false);
    const { rows } = await pool.query(
      `INSERT INTO studio_cases
        (id, name, type, client, owner, start_date, due_date, quote, cost, status, notes, checklist, drive_folder_url, source_material_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
       RETURNING *`,
      [
        id,
        cleanText(body.name),
        body.type,
        cleanText(body.client),
        body.owner,
        body.start,
        body.due,
        Number(body.quote || 0),
        Number(body.cost || 0),
        body.status || "新接案",
        cleanText(body.notes),
        JSON.stringify(checklist),
        cleanUrl(body.driveFolderUrl),
        cleanUrl(body.sourceMaterialUrl)
      ]
    );
    res.status(201).json(toCase(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/cases/:id/status", async (req, res, next) => {
  try {
    if (!statuses.has(req.body?.status)) {
      res.status(400).json({ error: "案件狀態不正確" });
      return;
    }
    if (req.body.status === "需修改" && req.body.role !== "owner") {
      res.status(403).json({ error: "只有老闆可以標記需修改" });
      return;
    }
    const { rows } = await pool.query(
      "UPDATE studio_cases SET status = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [req.body.status, req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "找不到案件" });
      return;
    }
    res.json(toCase(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/cases/:id/review", async (req, res, next) => {
  try {
    if (req.body?.role !== "owner") {
      res.status(403).json({ error: "只有老闆可以更新驗收建議" });
      return;
    }

    const reviewNotes = cleanText(req.body?.reviewNotes);
    const { rows } = await pool.query(
      `UPDATE studio_cases
       SET status = '需修改',
           review_notes = $1,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [reviewNotes, req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "找不到案件" });
      return;
    }
    res.json(toCase(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/cases/:id/checklist", async (req, res, next) => {
  try {
    const index = Number(req.body?.index);
    const checked = Boolean(req.body?.checked);
    const found = await pool.query("SELECT * FROM studio_cases WHERE id = $1", [req.params.id]);
    if (!found.rows[0]) {
      res.status(404).json({ error: "找不到案件" });
      return;
    }

    const item = toCase(found.rows[0]);
    if (!Number.isInteger(index) || index < 0 || index >= item.checklist.length) {
      res.status(400).json({ error: "Checklist 項目不正確" });
      return;
    }
    item.checklist[index] = checked;
    const status = item.checklist.every(Boolean) ? "已完成" : item.status;
    const { rows } = await pool.query(
      "UPDATE studio_cases SET checklist = $1::jsonb, status = $2, updated_at = now() WHERE id = $3 RETURNING *",
      [JSON.stringify(item.checklist), status, req.params.id]
    );
    res.json(toCase(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/cases/:id/delivery", async (req, res, next) => {
  try {
    const found = await pool.query("SELECT * FROM studio_cases WHERE id = $1", [req.params.id]);
    if (!found.rows[0]) {
      res.status(404).json({ error: "找不到案件" });
      return;
    }

    const current = toCase(found.rows[0]);
    const driveFolderUrl = cleanUrl(req.body?.driveFolderUrl);
    const sourceMaterialUrl = cleanUrl(req.body?.sourceMaterialUrl);
    const deliveryUrl = cleanUrl(req.body?.deliveryUrl);
    const deliveryNotes = cleanText(req.body?.deliveryNotes);
    const deliveredAt = deliveryUrl ? (current.deliveredAt || new Date().toISOString()) : null;
    const status = deliveryUrl && !["已完成", "暫緩"].includes(current.status) ? "待驗收" : current.status;

    const { rows } = await pool.query(
      `UPDATE studio_cases
       SET drive_folder_url = $1,
           source_material_url = $2,
           delivery_url = $3,
           delivery_notes = $4,
           delivered_at = $5,
           status = $6,
           updated_at = now()
       WHERE id = $7
       RETURNING *`,
      [driveFolderUrl, sourceMaterialUrl, deliveryUrl, deliveryNotes, deliveredAt, status, req.params.id]
    );
    res.json(toCase(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/cases/:id", async (req, res, next) => {
  try {
    await pool.query("DELETE FROM studio_cases WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "伺服器發生錯誤" });
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Studio OS listening on ${port}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
