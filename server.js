import express from "express";
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

const statuses = new Set(["新接案", "製作中", "待驗收", "已完成", "暫緩"]);

app.use(express.json({ limit: "1mb" }));
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
    checklist: Array.isArray(row.checklist) ? row.checklist : []
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

app.post("/api/cases", async (req, res, next) => {
  try {
    const body = req.body || {};
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
        (id, name, type, client, owner, start_date, due_date, quote, cost, status, notes, checklist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING *`,
      [
        id,
        String(body.name).trim(),
        body.type,
        String(body.client).trim(),
        body.owner,
        body.start,
        body.due,
        Number(body.quote || 0),
        Number(body.cost || 0),
        body.status || "新接案",
        String(body.notes || "").trim(),
        JSON.stringify(checklist)
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
