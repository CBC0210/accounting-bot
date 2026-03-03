# OpenClaw 終端操作手冊

這份手冊提供給可直接執行終端命令的 AI（例如 OpenClaw），用來查詢與修改記賬資料。

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

```bash
sqlite3 ./data/accounting.db "SELECT id,channel_id,user_id,type,amount,category,note,timestamp FROM transactions ORDER BY timestamp DESC LIMIT 50;"
```

查看共同賬本映射：

```bash
sqlite3 ./data/accounting.db "SELECT guild_id,channel_id,updated_at FROM guild_shared_ledgers;"
```

---

## 3) 修改設定（範例）

設定某頻道預算：

```bash
sqlite3 ./data/accounting.db "UPDATE channel_settings SET budget=42000,updated_at=datetime('now') WHERE channel_id='1477641066105540638';"
```

設定共同賬本映射：

```bash
sqlite3 ./data/accounting.db "INSERT INTO guild_shared_ledgers(guild_id,channel_id,updated_at) VALUES('GUILD_ID','1477641095201554655',datetime('now')) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,updated_at=excluded.updated_at;"
```

---

## 4) 新增/刪除交易（範例）

新增一筆支出：

```bash
sqlite3 ./data/accounting.db "INSERT INTO transactions(channel_id,user_id,amount,category,note,type,timestamp) VALUES('1477641066105540638','manual:openclaw',135,'餐飲','晚餐','expense',datetime('now'));"
```

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
