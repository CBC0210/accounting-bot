# Accounting Bot

Discord 記帳機器人 + Web Dashboard。

## 功能
- 頻道獨立記帳（個人賬本 / 共同賬本）
- 預算追蹤與月預算使用率
- LLM 自然語言記帳與查詢
- 每日提醒、週期收支排程
- 每月自動月結（每月 1 號 00:00）
- Dashboard 交易編輯/刪除、分類與設定管理

## 環境需求
- Node.js 18+（建議 LTS）
- Discord Bot Token 與 App 設定
- MiniMax API Key

## 安裝
```bash
npm install
```

## 環境變數
請先建立 `.env`（可參考 `.env.example`）：

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
MINIMAX_API_KEY=
MINIMAX_API_STYLE=anthropic
MINIMAX_BASE_URL=https://api.minimax.io
MINIMAX_MODEL=MiniMax-Text-01
DASHBOARD_BASE_URL=http://localhost:3000
PORT=3000
```

## 本機開發啟動
Bot:
```bash
node src/index.js
```

Web:
```bash
node src/web.js
```

## 註冊 Slash Commands
```bash
node src/register-commands.js
```

## 以 systemd --user 方式常駐（推薦）
目前專案已配置兩個 user service：
- `accounting-bot-bot.service`
- `accounting-bot-web.service`

### 常用指令
查看狀態：
```bash
systemctl --user status accounting-bot-bot.service accounting-bot-web.service
```

啟動 / 重啟：
```bash
systemctl --user restart accounting-bot-bot.service accounting-bot-web.service
```

開機自啟：
```bash
systemctl --user enable accounting-bot-bot.service accounting-bot-web.service
```

查看即時日誌：
```bash
journalctl --user -u accounting-bot-bot.service -f
journalctl --user -u accounting-bot-web.service -f
```

## 服務檔位置
- `/home/clawb/.config/systemd/user/accounting-bot-bot.service`
- `/home/clawb/.config/systemd/user/accounting-bot-web.service`

## 常見問題
- Web service 不斷重啟：通常是 `3000` port 被手動啟動的 `node src/web.js` 佔用，先停止手動進程再重啟 service。
- Bot 沒上線：先檢查 `accounting-bot-bot.service` 是否 `active`，再看 `journalctl` 日誌。
