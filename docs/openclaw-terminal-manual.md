# OpenClaw 終端操作手冊

這份手冊提供給可直接執行終端命令的 AI（例如 OpenClaw），用來查詢與修改記帳資料。

---

## 0) 查帳原則（非常重要）

本專案是「**頻道帳本（channel ledger）**」模型：

- 帳本主鍵是 `channel_id`
- `user_id` 只代表「這筆記錄是誰送出的訊息」，不是帳本歸屬
- **查帳、統計、分析一律以 `channel_id` 為條件，不要用 `user_id` 當查帳條件**

錯誤示例（不要用）：

```sql
-- 這會變成查「某個人記過哪些帳」，不是查該頻道帳本
SELECT * FROM transactions WHERE user_id='...';
```

正確示例（請用）：

```sql
-- 查指定頻道帳本
SELECT * FROM transactions WHERE channel_id='1477641066105540638';
```

---

## 0.5) Discord 風格 OpenClaw CLI（推薦）

為了讓 OpenClaw 操作更貼近 Discord，本專案提供：

`scripts/openclaw-ledger-cli.js`

快速查看幫助：

```bash
node scripts/openclaw-ledger-cli.js help
```

常用映射（Discord 語意 → OpenClaw CLI）：

```bash
# 「列出所有帳本」
node scripts/openclaw-ledger-cli.js ledgers

# 「這個月交通費呢」
node scripts/openclaw-ledger-cli.js query --channel 1477641066105540638 --preset this_month --metric expense --category 交通費

# 「幫我查今天早餐吃多少」
node scripts/openclaw-ledger-cli.js query --channel 1477641066105540638 --preset today --meal breakfast --metric expense --category 餐飲

# 「查這個月明細」
node scripts/openclaw-ledger-cli.js entries --channel 1477641066105540638 --preset this_month --limit 100

# 「記一筆：學餐 70」
node scripts/openclaw-ledger-cli.js add --channel 1477641066105540638 --amount 70 --type expense --category 餐飲 --note 學餐

# 「改 id 76 金額 90」
node scripts/openclaw-ledger-cli.js update --channel 1477641066105540638 --id 76 --amount 90

# 「刪 id 76」
node scripts/openclaw-ledger-cli.js delete --channel 1477641066105540638 --id 76
```

說明：
- 所有操作都以 `--channel`（`channel_id`）為主鍵，符合 Discord 的「頻道帳本」模型。
- `--category 交通費` 會自動對應到已配置 tag（例如 `交通`）。
- `--meal breakfast|lunch|dinner|late_night` 會套用該頻道餐期設定。

---

## 1) 環境與資料庫路徑

預設資料庫：

`./data/accounting.db`

若有自訂：

`DB_PATH=/your/path/accounting.db`

建議先在專案根目錄執行：

```bash
cd /home/clawb/workspace/accounting-bot
```

---

## 2) 快速查詢（sqlite3）

```bash
sqlite3 ./data/accounting.db ".tables"
```

```bash
sqlite3 ./data/accounting.db "SELECT channel_id,name,type,user_title,setup_state,setup_completed_at FROM channel_settings ORDER BY updated_at DESC LIMIT 20;"
```

推薦（查「實際帳本顯示名」而非原始 name 快照）：

```bash
sqlite3 ./data/accounting.db "SELECT s.channel_id, CASE WHEN s.type='shared' THEN '共同帳本' WHEN TRIM(COALESCE(s.user_title,''))<>'' THEN TRIM(s.user_title)||'的帳本' ELSE COALESCE(s.name,'未命名帳本') END AS ledger_name, s.type FROM channel_settings s ORDER BY s.updated_at DESC;"
```

若你也要同時看「目前餘額」（頻道帳本維度）：

```bash
sqlite3 ./data/accounting.db "SELECT s.channel_id, CASE WHEN s.type='shared' THEN '共同帳本' WHEN TRIM(COALESCE(s.user_title,''))<>'' THEN TRIM(s.user_title)||'的帳本' ELSE COALESCE(s.name,'未命名帳本') END AS ledger_name, s.type, COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END),0) AS balance FROM channel_settings s LEFT JOIN transactions t ON t.channel_id=s.channel_id GROUP BY s.channel_id,s.type,s.user_title,s.name ORDER BY s.updated_at DESC;"
```

```bash
sqlite3 ./data/accounting.db "SELECT id,channel_id,type,amount,category,note,timestamp,user_id AS recorder FROM transactions ORDER BY timestamp DESC LIMIT 50;"
```

依「頻道帳本」查最近 50 筆（推薦）：

```bash
sqlite3 ./data/accounting.db "SELECT id,channel_id,type,amount,category,note,timestamp,user_id AS recorder FROM transactions WHERE channel_id='1477641066105540638' ORDER BY timestamp DESC LIMIT 50;"
```

查「某頻道本月」支出統計：

```bash
sqlite3 ./data/accounting.db "SELECT category,COALESCE(SUM(amount),0) AS total FROM transactions WHERE channel_id='1477641066105540638' AND type='expense' AND timestamp >= '2026-03-01T00:00:00.000Z' AND timestamp < '2026-04-01T00:00:00.000Z' GROUP BY category ORDER BY total DESC;"
```

查看共同帳本映射：

```bash
sqlite3 ./data/accounting.db "SELECT guild_id,channel_id,updated_at FROM guild_shared_ledgers;"
```

---

## 3) 修改設定（範例）

設定某頻道預算：

```bash
sqlite3 ./data/accounting.db "UPDATE channel_settings SET budget=42000,updated_at=datetime('now') WHERE channel_id='1477641066105540638';"
```

設定共同帳本映射：

```bash
sqlite3 ./data/accounting.db "INSERT INTO guild_shared_ledgers(guild_id,channel_id,updated_at) VALUES('GUILD_ID','1477641095201554655',datetime('now')) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,updated_at=excluded.updated_at;"
```

---

## 4) 新增/刪除交易（範例）

新增一筆支出：

```bash
sqlite3 ./data/accounting.db "INSERT INTO transactions(channel_id,user_id,amount,category,note,type,timestamp) VALUES('1477641066105540638','manual:openclaw',135,'餐飲','晚餐','expense',datetime('now'));"
```

說明：`user_id='manual:openclaw'` 只是「操作者標記」，不影響帳本歸屬；帳本仍由 `channel_id` 決定。

刪除交易 id=123：

```bash
sqlite3 ./data/accounting.db "DELETE FROM transactions WHERE id=123;"
```

---

## 5) 安全操作建議

修改前先備份：

```bash
cp ./data/accounting.db ./data/accounting.db.bak.$(date +%Y%m%d-%H%M%S)
```

批次修改建議使用 transaction：

```bash
sqlite3 ./data/accounting.db "BEGIN; /* SQL... */ COMMIT;"
```

---

## 6) 服務重啟（資料修改後）

重啟 bot：

```bash
pkill -f "node src/index.js"; node src/index.js
```

重啟 web：

```bash
pkill -f "node src/web.js"; node src/web.js
```
