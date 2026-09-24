# dsh-plugin-manager

> DeepSeek Harness（DSH）的插件管理器：**裝之前驗、裝之前影、裝之後再驗、爆咗自動回滾。**

---

## 為什麼需要它

DSH 的失敗模式很尖銳。`dsh web` 啟動時，loader 會**同步**載入每一個 profile bundle 的
entry——**任何一個插件頂層 import 解析失敗，整個 `dsh web` 就起不來**，
而你唯一的手段是手改 `~/.dsh/profiles/<profile>/package.json`。

生態裡已經有七個插件管理器，但它們**全部都是「改完才算」**：

| 插件 | 做什麼 |
|---|---|
| `@linxin666/dsh-client-ui-plugin-manager` | 設定→外掛頁：npm/git 安裝、啟停、衝突 undo |
| `dsh-plugin-manager` | inspect / enable / disable / group runtime plugins |
| `dsh-plugin-hub` | 圖形化 app-store、評分、依賴影響圖、審計日誌 |
| `dsh-plugin-console` | verified catalog + profile manager + Harness updater |
| `dsh-plugin-center` | 設定頁搜尋 npm registry、一鍵裝卸 |
| `dsh-plugin-check` | 檢查已裝插件（壞包／pin 死版本／安裝期執行碼） |
| `dsh-plugin-guard` | 隔離壞掉的使用者插件，讓 web UI 保持運作 |

**它們全部是「改完才算」。**

⚠️ **但有一句話要說準確**：其中 `@linxin666/dsh-client-ui-plugin-manager`
（`dsh-web` 全家桶的一員）**確實**做了 `--dump-config` 預檢與失敗自動回滾。
所以本插件的差異化**不是**「有預檢」，而是它真正沒做的三件事：

| 它沒做 | 本插件 |
|---|---|
| 預檢跑在**變更之後**；裝前的唯一防線是一張 spec 字元黑名單 | **寫入之前**就驗（V1 ＋ V2） |
| **從不使用 `--patch`** | 任何生成的候選 patch 檔，先 `--dump-config --patch <候選>` 自我驗證（R5） |
| 「快照」是記憶體裡的 before/after 比對；「回滾」是 `remove` 掉新裝的（只憑退出碼，無 checksum） | 快照落地成檔案；回滾後狀態**逐位元一致** |

還有一件生態普遍沒做的：**更新檢查只支援 npm registry 源**。
git／tarball 來源的插件（本機 profile 裡就有）拿不到版本比對——
本插件用 `pnpm-lock.yaml` 的 `resolution.integrity` 當換版訊號，把這一塊補上。

本插件做的事情很窄：**在每一次變更之前驗一次、影一次；變更之後再驗一次；不通過就自動回滾。**

---

## 核心機制：變更管道

所有會改動 profile 的動作（安裝／移除／更新）都走同一條管道，**沒有旁路**：

```
① verify          V1b 宣告的 bundle 都在嗎 → V1 離線 compose（--dump-config）
      │           → V2 逐條 entry 試解析模組
      │ pass
② snapshot        profile manifest + lockfile + workspace + patch 層，逐位元組存檔
      │
③ 執行            spawn 官方 `dsh plugin` CLI（唯一寫入器），或 `git` 移動本地 checkout
      │
④ verify          再驗一次
      │
 ├─ pass ────────→ 記錄為 known-good，快照留著
 └─ fail ────────→ ⑤ rollback：還原 ②，然後**逐檔讀回並雜湊**證明還原成功
```

> ⚠️ **V1 與 V2 不能互相取代。** 實測（`docs/host-notes.md` F3）：
> `--dump-config` **不做任何模組解析**——一條指向不存在套件的 row 照樣 exit 0。
> V1 抓得到 compose 期的錯（YAML 壞、bundle 沒裝、bundle 沒有 `dsh.bundle`）；
> V2 才抓得到「指向不存在的套件」。**兩層都必須做。**

> ⚠️ **「略過的層」不等於「通過的層」。** 沒有 `git`、找不到 `dsh` launcher、
> dump 裡一條 row 都沒有——這三種情況下對應的那一層會標成 `skipped`，
> 而整個驗證結果**不會**是 pass。假裝驗過比不驗更危險。

### 更新是怎麼選版本／分支的

| 來源 | 可以選什麼 | 靠什麼 |
|---|---|---|
| 本地 git checkout（`link:`） | 本機的 tag／分支／遠端分支 | 直接讀 `.git/HEAD`、`refs/heads`、`refs/tags`、`packed-refs`——**不需要 `git` 執行檔** |
| 同上，但要看遠端有什麼 | 遠端 tag／分支 | 按「查遠端」才連網；`github.com` 走 REST API（未認證 60 次/小時） |
| `github:` / `git+https:` | tag／分支，寫進 spec 的 `#ref` | 官方 CLI 重新安裝 |
| registry／tarball URL | 沒有版本可選 | 用原本的 spec 重新解析——**離線不可能知道有沒有新版，所以不假裝知道** |

**三個刻意的設計**：

1. **本機優先**：開面板只讀 `.git`，零網路。遠端是另一顆按鈕，它自己說明了會連網。
2. **先給計畫再給按鈕**：選了 ref 之後會先問宿主「這會跑什麼指令」，把指令顯示出來；
   沒有可執行的計畫，更新鈕就是停用的。「按了沒反應」不是能到達的狀態。
3. **只探測真正需要的那個工具**：`plan` 會先判斷這個來源要移動本地 checkout（需要 `git`）
   還是交給官方 CLI（需要 `dsh`），**只探測那一個**。
   所以 registry 插件的計畫不會去 spawn 一次 `git --version`，反之亦然。
   回傳裡 `tools.git: null` 的意思是「沒探測」，跟「不可用」是兩件事。

> ⚠️ **移動本地 checkout 需要 `git`**：這台機器上沒有（`Get-Command git` 失敗）。
> 所以那個按鈕會**明說**缺什麼，並給出替代做法（把來源改成 `github:<owner>/<repo>#<ref>`）。

---

## 功能與限制

| 能力 | 支援 | 說明 |
|---|---|---|
| 裝**之前**驗證 | ✅ | V1b 宣告的 bundle ＋ V1 子進程 `dsh --profile <n> --dump-config` ＋ V2 模組解析 |
| 裝**之前**自動快照 | ✅ | 純檔案 I/O；快照存不下就**不開始**變更 |
| 用官方 CLI 當唯一寫入器 | ✅ | 不自己實作 pnpm 語意 |
| 裝**之後**即時再驗 + 自動回滾 | ✅ | 回滾後逐檔雜湊比對，證明狀態一致 |
| 更新：選版本／選分支（git 來源） | ✅ | 本機 ref 直接讀 `.git`；遠端要按按鈕才連網 |
| 更新：registry／tarball 來源 | 🟡 | 只能用原本的 spec 重新解析；**新版本要查 registry 才知道，本插件不假裝知道** |
| 面板（bundle 清單／verify／快照 diff／一鍵回滾） | 🟡 | 清單、檢查、更新、啟停都有；快照 diff 檢視還沒有 |
| 驗證 import 期失敗（`ERR_MODULE_NOT_FOUND` 等） | ❌ | 只有真正啟動一次才會出現 |
| 宿主**完全起不來**時救援 | ❌ | **見下方「限制」** |

### 限制（請務必讀）

**本插件是一個插件。** 當 `dsh web` 完全起不來的時候，它自己也載入不了——
那個時刻它幫不上忙。這是架構上的事實，不是還沒做完的功能。

所以：

- 本插件**不會**聲稱「自動救援」。
- 它能大幅降低「裝完起不來」的機率（因為裝之前就驗過了），但**不能**保證。
- 真的完全起不來時，逃生方式是官方指令：
  ```sh
  dsh plugin --profile web remove <套件名>
  ```
  或在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 移除該項。
- 插件會記錄每次啟動是否成功；下次啟動時如果發現上次失敗，面板會提示
  「上次啟動失敗，最後一次變更是 X，要回滾嗎？」——但這只在**宿主仍然起得來**的前提下有用。
- **靜態驗證有天花板**：V1 只組合 patch 層、**不 import 條目**；V2 只做模組解析。
  真正的 `apply()` 期失敗，以及「套件在但 export 壞掉」的情況，
  仍然要到下次啟動才暴露。
- **「逐位元一致」的範圍是 profile 的狀態檔**（`package.json`、`pnpm-lock.yaml`、
  `pnpm-workspace.yaml`、`cordis.patch.yml`），**不是整個 `node_modules`**。
  安裝樹由 lockfile 決定，回滾後由官方 CLI 對帳；回滾當下動不了的殘留會被**列出來**，
  不會被靜默忽略。
- **移動本地 git checkout 需要 `git` 執行檔**，而參考機器上沒有。
  這個功能會明說缺什麼，不會假裝成功。
- **遠端 ref 查詢只實作了 github.com**。其他 host 會回「這個 host 沒有實作」——
  那不是「沒有新版」。
- **DSH 版本相依**：實測基準是 `0.1.5-rc.3`。宿主升級後
  `docs/host-notes.md` 裡標 `[測]` 的項目全部要重跑。

---

## 安裝

```sh
# 從 GitHub 安裝
dsh plugin --profile web add github:itdogwowo/dsh-plugin-manager

# 或從 npm（套件名見 npm 頁面）
dsh plugin --profile web add <npm 套件名>
```

裝完**重啟 `dsh web`**，再到「設定 → 外掛」開啟。

---

## 使用

**面板**（設定 → 外掛 → 插件管理器）

- **非原裝插件** — 來自 profile manifest 的 `dependencies`：名稱、**實際安裝版本**、
  來源種類（registry／link／tarball URL／git／npm: 別名）、宣告的 spec、
  已載入狀態、以及**換版訊號**。本插件自己也在清單裡，並被標記出來
- **全部 web entry**（收合）— boot graph 的完整清單、內容雜湊、立即／按需、注入的服務
- **重新讀取** — 面板不輪詢；`apply()` 階段零請求、零寫入（R4）

### 「非原裝」是怎麼判定的

分界不是一份會腐爛的名字清單，而是 **profile manifest 的 `dependencies`**：

| 位置 | 意思 |
|---|---|
| `dsh.profile.bundles` | 會載入的圖層——**原裝與非原裝都在這裡** |
| `dependencies` | 使用者裝了什麼——**只有非原裝在這裡** |

原裝 bundle 只出現在 `bundles`，永遠不會是 dependency。

### 為什麼「已安裝」與「已載入」要分開顯示

兩者回答不同問題，而價值就在**接不起來的時候**：一個插件可以「裝了但沒載入」
（import 壞掉、row 被停用），那正是插件管理器存在的理由。

### 換版訊號

不同來源要用不同方式判斷有沒有新版：

| 來源 | 訊號 | 為什麼 |
|---|---|---|
| registry | `integrity` | 版本號會變 |
| **tarball URL** | `integrity` | ⚠️ spec 長成 `…/releases/latest/…`，**永遠不變**，但內容會變 |
| `link:` | `resolvedDir` | 指向本地 checkout，版本由那個目錄決定 |
| git | `integrity` | tag 可以被移動 |

> 這也是 `docs/plan.md` §4.6 的實作基礎：**生態普遍的更新檢查只支援 npm registry**，
> 而 tarball／git 來源的插件在本機 profile 裡就存在。

### 更新一顆插件

在插件的詳細資料（卡片折疊區）最下面按「檢查更新」：

1. 讀**本機** `.git`，列出這顆 checkout 有的 tag、分支、遠端分支（零網路）
2. 選一個目標版本／分支 → 面板先問宿主「這會跑什麼」，把指令顯示出來
3. 要更遠端的東西就按「查遠端」（**這一顆按鈕才會連網**，而且它自己說了）
4. 按「更新」→ 走完整管道：驗 → 快照 → 執行 → 再驗 → 失敗自動回滾

**斜線指令**：`/pm` 目前**還沒有實作**（計劃中的 M5）。面板是唯一入口。
下面列的是計劃中的樣子，不是現在能用的東西：

```
/pm             狀態摘要
/pm verify      跑一次驗證
/pm snapshots   列出快照
/pm rollback    回滾（先 dry-run）
```

---

## 硬規則（為什麼這個插件的程式碼長這樣）

這些規則來自實際的血淚：一個 DSH 插件如果在啟動路徑上做太多事，
會讓**整個 `dsh web` 起不來**。本插件自己就是用來處理這個問題的，所以更不能犯。

| # | 規則 | 為什麼 |
|---|---|---|
| **R1** | **零執行期依賴**——宿主半只 import `node:` 與相對檔案 | loader 同步 import；任何頂層 import 解析失敗 ＝ 整個 `dsh web` 起不來 |
| **R2** | **宿主半只依賴 `webServer` 一個服務** | 啟動時與核心服務打交道，任何一個卡住就開不了機。⚠️ `subprocess`／`fs` 是**選用讀取**：沒有它們，按鈕會說明缺什麼，插件仍然載入 |
| **R3** | **不碰 `settings` / `agents` / `systemPrompt` / agent 接管** | 這幾樣是已知的「啟動時卡死」來源 |
| **R4** | **不在啟動路徑上做事**——面板沒開＝零請求、零寫入 | 出問題時才看得出是哪一個動作卡住。⚠️ 工具探測（`dsh`／`git` 在哪）跑在 `apply()` 裡，不在 import 路徑上 |
| **R5** | **任何變更前必先快照；任何生成的 patch 檔必先自我驗證** | patch 檔語意：非法欄位必 throw，target 不存在只是 warning。⚠️ `--patch` 自我驗證已實作且有測試，但**目前的變更路徑不產生 patch 檔**，所以它還沒有在產品路徑上被用到 |
| **R6** | **不寫使用者的 `cordis.patch.yml`** | 那是使用者自己的圖層（唯一例外是使用者明確授權的啟停，見 `patch-writer.js`） |
| **R7** | **所有宿主假設集中在 `src/host/host.js`** | 檔名、疊層次序、錯誤簽名都是讀源碼得出的，不是公開 API |

`npm run verify` 會強制檢查 R1–R4。

---

## 開發

```sh
npm run build:client    # 把 src/client/*.js 折成單一 client.js（必要步驟，見下）
npm run verify          # 靜態檢查：R1–R4 ＋ 個資掃描
npm test                # 產物新鮮度 + verify + 單元測試
npm run test:isolated   # 同上但子進程隔離（沙盒擋 spawn 時會 EPERM）
```

> ⚠️ **測試裡的子進程是真的。** `test/helpers/real-subprocess.mjs` 用
> `node:child_process` 起**真的**子進程來測「收輸出、拿退出碼、逾時真的砍掉」，
> 因為這一層如果用假的，「我們跑過指令才判斷結果」這句話就沒有被驗到。
> 它在受限沙盒裡把子進程的 stdio 接到**檔案**而不是管道——管線在沙盒裡會 `EPERM`
> （具名管道被擋），這是實測出來的邊界，不是猜的。

**為什麼有建置步驟**：宿主只拿 `exports["./client"]` 指向的**已存在檔案**，
而且 bundle 內的**相對 `require` 解不掉**——模組系統只認平台種子字、
已載入的模組、與已註冊的套件三條路（`dsh-client-modules` 的 `makeRequire`）。
所以每個套件的 browser 半都必須是自帶所有內部模組的單一檔案。

```
src/
├── params.js             偵測參數的單一宣告（測試釘住它與實際輸出一致）
├── endpoints.json        端點契約；宿主半的字面值有測試釘住不許漂移
├── host/
│   ├── index.js          entry：只註冊路由；工具探測在 apply() 裡（R4）
│   ├── host.js           ★ R7：所有宿主假設——dsh launcher 定位、spawn 封裝、
│   │                        git 探測、單檔刪除（fs 服務沒有 delete）
│   ├── mount-once.js     同一套件只掛一次（重複註冊會讓 dsh web 起不來）
│   ├── profile.js        讀 manifest／lock／實裝版本與 resolvedDir
│   ├── overview.js       把活的 Service 投影成純 JSON
│   ├── enabled.js        從 patch 疊層解析「這行有沒有啟用」
│   ├── patch-writer.js   唯一會寫使用者 cordis.patch.yml 的檔案（已授權的例外）
│   ├── detect.js         讀檔案得出 git 狀態、lockfile、目錄指紋
│   ├── detect-report.js  唯讀的「檢查來源」報告
│   ├── gitrefs.js        讀 .git 的 refs（版本／分支選擇器的資料）
│   ├── gitremote.js      唯一連網的檔案：問遠端有哪些 tag／分支
│   ├── verify.js         V1b ＋ V1 compose ＋ V2 模組解析
│   ├── snapshot.js       快照與回滾（逐位元組，並讀回證明）
│   ├── pipeline.js       ★ 唯一的變更入口：驗→影→做→再驗→回滾
│   └── routes.js         九條 HTTP 路由（其中四條會改變東西或連網）
└── client/
    ├── bundle.json       要折進 bundle 的模組清單（建置腳本與測試共用）
    ├── client.js         ← 產生物，不要手改
    ├── panel.js          面板元件（React.createElement，沒有 JSX）
    ├── update.js         更新控制項：ref 選擇器、計畫、結果
    ├── face.js           HTTP 介面（fetch，不是 host.call）
    ├── styles.js         樣式字串 ＋ 主題 token 探測
    └── copy.js           zh / en 文案
```

- `build-client.mjs` — 折 bundle 的腳本；`--check` 只驗新鮮度、不寫檔
- `docs/plan.md` — 交接與計劃書（**接手的人先讀這一份**）
- `docs/host-notes.md` — 宿主行為的實測記錄（標 `[測]` 的是真的跑過的）

> ⚠️ **`npm run build:client` 只更新磁碟，不會通知執行中的宿主。**
> 而兩半的行為**不一樣**（`docs/host-notes.md` F38，實測更正了 F21）：
>
> | 改哪裡 | 要重啟 `dsh web` 嗎 | 重新整理頁面夠嗎 |
> |---|---|---|
> | `src/client/*` ＋ `npm run build:client` | ❌ 不用 | ✅ 夠——bundle 每次請求都重新從磁碟讀 |
> | `src/host/*` | ✅ **一定要** | ❌ 不夠——端點根本不存在 |
>
> 症狀是「**端點有資料、畫面沒資料**」或者反過來。
> **不確定的時候就重啟**：graph 宣告的 `rev` 是啟動時算的，它會騙你。

---

## 授權

MIT
