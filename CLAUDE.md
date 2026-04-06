# Accounting Bot — LLM 快速導覽

> **重要：修改任何功能、結構或行為後，請同步更新本檔案（CLAUDE.md）及 `docs/prompt.md`。**

---

## 專案概述

Discord 記帳機器人（章魚哥），搭配 Web Dashboard。
- 自然語言 LLM 記帳 + 查詢
- 多頻道隔離帳本，支援共同帳本
- 後端：Node.js + discord.js + sql.js（Bot）/ better-sqlite3（Web）
- LLM：MiniMax（Anthropic 相容 API）

完整功能規格見 [`docs/prompt.md`](docs/prompt.md)。

---

## 檔案結構

```
accounting-bot/
├── src/
│   ├── index.js                    # 入口：Discord client 初始化、事件綁定、各 scheduler 啟動
│   ├── register-commands.js        # 一次性：向 Discord 註冊 slash commands
│   ├── web.js                      # Web Dashboard Express server（port 3000）
│   │
│   ├── handlers/
│   │   ├── message.js              # 處理所有 Discord 訊息（LLM 路由 → 記帳/查詢/對話）
│   │   ├── slash.js                # 處理 slash commands 和 component interactions（按鈕）
│   │   └── channel.js              # 頻道初始化引導訊息
│   │
│   ├── llm/
│   │   ├── generator.js            # LLM API 呼叫層（MiniMax Anthropic / Standard fallback）
│   │   └── parser.js               # LLM 解析：記帳 / 查詢意圖 / 分析
│   │
│   ├── db/
│   │   ├── database.js             # sql.js 初始化、Schema migration、讀寫、mtime reload
│   │   └── queries.js              # 所有 DB 查詢函數（頻道設定、交易、統計）
│   │
│   ├── services/
│   │   ├── recurring.js            # 週期收支排程（每分鐘 tick）
│   │   ├── reminder.js             # 每日提醒排程（每分鐘 tick）
│   │   ├── channel-balance-sync.js # 頻道名稱餘額同步排程
│   │   ├── monthly-settlement.js   # 每月 1 號 00:00 月結
│   │   ├── data-change-notifier.js # DB 變更通知（Web → Bot 即時感知）
│   │   ├── db-backup.js            # SQLite 備份管理
│   │   ├── undo-step.js            # 撤銷最後一步操作
│   │   └── voice-transcription.js  # 語音轉文字（OpenAI Whisper）
│   │
│   └── utils/
│       ├── category-rules.js       # 分類別名正規化、規則解析
│       └── embed.js                # Discord Embed 產生工具函數
│
├── public/                         # Web Dashboard 前端（HTML/CSS/JS + Chart.js）
├── data/                           # accounting.db（SQLite，Bot 和 Web 共用）
├── docs/
│   ├── prompt.md                   # 詳細功能規格與進度（給 LLM 看的規格書）
│   └── openclaw-terminal-manual.md # OpenClaw 終端機使用說明
├── scripts/                        # 維護腳本
├── .env                            # 環境變數（含 API keys，不進 git）
└── CLAUDE.md                       # 本檔案
```

---

## 核心資料流

### 記帳流程（Discord 訊息）
```
Discord 訊息
  → handlers/message.js（佇列處理）
  → llm/generator.js（decideActionWithLLM：判斷意圖）
  → 記帳：llm/parser.js（parseWithLLM）→ db/queries.js（insertTransaction）
  → 輸出三段：預算 Embed → 記帳 Embed → LLM 回饋文字
```

### 查詢流程
```
Discord 訊息（查詢意圖）
  → llm/generator.js（generateDataAnalysisResponse）
  → db/queries.js（多種統計查詢）
  → Discord 回覆
```

### Web ↔ Bot 資料同步
- 共用同一個 `data/accounting.db`
- Bot 使用 `sql.js`（記憶體 DB），每次查詢前檢查檔案 mtime，有變更就 reload
- Web 使用 `better-sqlite3`（直接讀寫）
- `data-change-notifier.js` 觸發 Bot 主動感知 Web 的修改

---

## 關鍵設定

| 項目 | 說明 |
|------|------|
| DB 路徑 | `DB_PATH`（.env），預設 `./data/accounting.db` |
| Bot port | 無（Discord 長連線） |
| Web port | `PORT`（.env），預設 3000 |
| LLM | MiniMax，`MINIMAX_API_STYLE=anthropic` |
| 頻道隔離 | 所有資料以 `channel_id` 為 key，頻道間完全隔離 |
| 共同帳本 | 每個 Guild 唯一，存在 `guild_settings` table |

---

## 部署

```bash
# systemd user services（已設定 enabled）
systemctl --user status accounting-bot-bot.service   # Discord Bot
systemctl --user status accounting-bot-web.service   # Web Dashboard

# 重啟
systemctl --user restart accounting-bot-bot.service
systemctl --user restart accounting-bot-web.service

# 查 log
journalctl --user -u accounting-bot-bot.service -f
```

---

## 注意事項

- **修改後必須更新本檔案**，若有功能新增/移除/重構，對應更新「檔案結構」和「核心資料流」
- **同步更新 `docs/prompt.md`**，確保功能進度表反映實際狀態
- DB schema 變更要確認 `database.js` 裡的 migration 邏輯有對應處理
- LLM 回應失敗時的 fallback 是 log-only（不自動記帳），避免誤判
- `sql.js` 是記憶體 DB，**不要在 Bot 服務中使用 `better-sqlite3`**，兩者混用會衝突
