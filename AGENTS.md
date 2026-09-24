# 給 AI 的專案指示（dsh-plugin-manager）

這個 repo 是**公開**的。動任何檔案之前先讀完這一頁，以及 `docs/plan.md`。

## 個資紅線

> 完整版（三道防線與事故處理步驟）：**載入 `privacy-guard` 技能**。

1. **不寫**真實使用者名稱或本機絕對路徑 → 用 `C:\Users\<你的帳號>\`、`/Users/<user>/`、`~/.dsh/`、`link:<你 clone 的位置>`
2. **不寫**公司名／內部專案名／客戶名 → 用「專案A」。⚠️ **側邊欄的「工作區名稱」就是內部專案名**
3. **不 commit 截圖** → 側邊欄會連路徑一起入鏡。⚠️ GitHub 網頁拖檔上傳**不看 `.gitignore`**
4. **改完跑 `npm test`**（`verify.mjs` 有個資掃描與 R1–R4 靜態檢查會擋）
5. **講「上次洩漏了什麼」只講形狀，不講內容**
6. 已 commit 的洩漏，**`force push` 沒有用** → 刪 repo 重建

## 這個 repo 的硬規則（R1–R7，見 `docs/plan.md` §4.2）

1. **零執行期依賴**：宿主半只准 import `node:` 與自己的相對檔案。
   宿主半載入失敗 ＝ **整個 `dsh web` 起不來**。`verify.mjs` 強制檢查。
2. 宿主半**只依賴 `webServer` 一個服務**。不碰 `settings` / `agents` / `systemPrompt`。
3. **不在啟動路徑上做事**——面板沒開 ＝ 零請求、零寫入。
4. **所有 profile 變更必須經過 `src/host/pipeline.mjs`**，不准有旁路。
5. **任何變更前必先快照；任何生成的 patch 檔必先自我驗證**（`--dump-config --patch` 過一次）。
6. **不寫使用者的 `cordis.patch.yml`**。
7. **所有宿主假設集中在 `src/host/host.mjs`**——檔名、疊層順序、錯誤字串都是讀源碼得出的，不是公開 API。

## 不准講的話

- **不准聲稱「自動救援」或「宿主起不來也能用」。** 本插件是一個插件，宿主死了它也死了。
  README 與程式碼註解都要說清楚（`docs/plan.md` §4.1）。
- 不准把差異化寫成「CLI」或「行程外」——那是已否決的路線。

## 開發迴圈

- 改 `src/host/*` → **一定要重啟 `dsh web`** 才生效
- 改 `src/client/*` → 可在真瀏覽器直接驗
- `npm run verify`（R1–R4 靜態檢查）→ `npm test`

## 省錢：工具輸出要節制

**每次對話都付這個成本，而且它比上面所有規則加起來還貴。**

- **不要整份 dump。** 用 `Select-String`／`Select-Object -Last N`／`-First N` 只取需要的部分。
- **先過濾再讀檔**：`grep` 找位置 → `read` 只讀那一段，不要整檔讀進來。
- **大的 API／網頁回應先挑欄位**，貼全文會一次吃掉幾十 KB。
- 不確定要不要的輸出，就先不要；需要時再查一次比一次灌進來便宜。

## 文件

- `README.md` — 使用者面向（含**限制**一節，不准刪）
- `docs/plan.md` — 交接與計劃書（**接手的人先讀這一份**）
- `docs/host-notes.md` — 宿主行為的實測記錄（M0 的產出；尚未建立）
