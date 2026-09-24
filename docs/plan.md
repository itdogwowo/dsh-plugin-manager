# dsh-plugin-manager 交接與計劃書

> **這份文件的用途**：讓一個**完全沒有上下文**的人（或 agent）在隔天、換 session、
> 甚至換機器之後，讀完這一篇就能接著做事。
>
> 如果你只有五分鐘：讀 §1、§2、§4、§8。
> 如果你要改程式：§3（程式碼地圖）→ §9（測試）→ §10（開工前先驗的假設）。
> 使用者面向的說明在 `README.md`。
>
> 撰寫時間：Windows。**尚未寫任何程式碼**——目前 repo 只有 `LICENSE`、`README.md` 同這一篇。

---

## 1. 一句話

**`dsh-plugin-manager` 是一個 DSH 插件管理器：列出、安裝、移除、啟停、更新 profile 的插件，
而每一次變更都被「驗證 → 快照 → 執行 → 再驗證 → 失敗自動回滾」包住。**

**它為什麼存在**：DSH 的 loader 啟動時**同步** import 每個 bundle 的 entry，
任何一個插件頂層 import 解析失敗，**整個 `dsh web` 就起不來**。
而生態裡現有的七個插件管理器全部是「改完才算」——沒有一個在安裝之前告訴你會發生什麼事。

---

## 2. 現在的狀態

| | |
|---|---|
| 版本 | 尚未發佈 |
| 程式碼 | M1 ＋ M2 ＋ M3 ＋ M4 的**主體已寫**（`src/host`、`src/client`、`test`、`verify.mjs`）；M5（`/pm`）與 M6（boot-ok）未開始 |
| 架構 | 已定案：**做成 DSH 插件**（宿主半 + 瀏覽器半），見 §4 |
| 實測環境 | DSH **`0.1.5-rc.3`**／Node `24.14.1`／Windows。**不是最新版**，升級要重跑 `host-notes` |
| M0 進度 | 🟡 進行中——A1/A2/A3（一半）/A4/A7 已答；餘見 `docs/host-notes.md` 最後一節 |
| 測試 | `npm test` → **219 pass**（新增 5 個檔：`host-tools`／`gitrefs`／`verify`／`pipeline`／`update-routes`，其中的子進程與 junction 都是真的） |
| 下一步 | 在真的 `dsh web` 上驗（需重啟宿主）；補 M5／M6 |

### 2.2 這一輪修掉的兩個 bug（原本會讓功能靜默失效）

| bug | 症狀 | 為什麼測試一開始沒抓到 |
|---|---|---|
| `planUpdate` 檢查 `git.available`，但那欄位來自**另一個問題**的答案 | **每一台機器上**「移動 checkout」的計畫都被拒，錯誤訊息結尾是 `undefined` | 既有測試呼叫 `planUpdate` 時根本沒傳 `git`，所以 `git` 是 `undefined` 而**兩條路都會拒絕**——測出來的紅燈被誤認為正常 |
| `carriesDsh()` 只問有沒有 `dsh` 鍵 | 只要 `dsh web` 的工作目錄是某個插件 checkout，**面板回報零個已安裝插件**，真 profile 從未被讀 | 沒有測試用「非 repo 的 `fs` 基準目錄 ＋ 環境變數指定的 profile」這個組合 |

> 兩個都屬於同一類：**主流程不報錯，功能卻完全不動。**
> 這一輪新增的 `test/update-routes.test.mjs` 就是為了這一類——
> 它用**真的** route handler、**真的**檔案系統、**真的** junction 走完
> 「面板按下去會發生什麼」，而不是只驗單一函式。

### 2.1 這一輪新增了什麼（2026-09 session）

使用者要求：「檢查更新和更新，如果是 git 的話我可以選擇版本和分支」。
三個決定（使用者選的）：**本機優先、按按鈕才連網**；**完整管道**；**分支**要能選。

| 新增 | 檔案 | 支撐的規則／里程碑 |
|---|---|---|
| 宿主假設集中層（R7）＋ spawn 封裝 ＋ 工具探測 | `src/host/host.js` | R7、M4 |
| V1b／V1／V2 三層驗證 | `src/host/verify.js` | M2 |
| 快照與回滾（逐位元組 ＋ 讀回證明） | `src/host/snapshot.js` | M3、R5 |
| 變更管道（唯一入口） | `src/host/pipeline.js` | M4、R5 |
| 本機 ref 列舉（不需 `git`） | `src/host/gitrefs.js` | §4.6 |
| 遠端 ref 查詢（唯一連網的檔案） | `src/host/gitremote.js` | §4.6 |
| 更新 UI（ref 選擇器、計畫、結果） | `src/client/update.js` | M4 |
| 五條新路由（`refs`／`remote-refs`／`plan`／`apply`／`rollback`） | `src/host/routes.js` | M4 |

**同時修掉的兩個假警報**（在同一個檢查器裡，見 `docs/host-notes.md` F34 前後一節）：
`verify.mjs` 的 R4 檢查會被**正規表達式裡的 `{}`** 與 **`===`** 騙到，
兩次都對正確的程式碼報錯。一個會對正確程式碼吠的檢查器，
下一次真的出問題時會被直接忽略——所以它必須修，不能繞。


---

## 3. 程式碼地圖（計劃）

```
dsh-plugin-manager/
├── package.json          # type:module; dsh.bundle.patch; dsh.client.platform:"web"
│                         # 零 dependencies（R1）
├── cordis.patch.yml      # 插入 host 半 + client 半
├── dsh.plugin.json
├── src/
│   ├── host/                        ★ 宿主半（只依賴 webServer，R2）
│   │   ├── index.js                 entry：只註冊服務，不做任何事（R4）
│   │   ├── host.mjs                 ★ R7：所有宿主假設集中在這裡
│   │   ├── profile.mjs              讀 manifest / lock / bundles / 實裝版本
│   │   ├── verify/
│   │   │   ├── compose.mjs          包 --dump-config 子進程
│   │   │   ├── modules.mjs          抽 specifier → 試解析
│   │   │   └── drift.mjs            lock vs node_modules 漂移
│   │   ├── snapshot.mjs             影／列／比對
│   │   ├── pipeline.mjs             ★ 變更管道（唯一的變更入口）
│   │   └── rpc.mjs                  暴露給 client 半
│   └── client/                      ★ 瀏覽器半
│       ├── index.js                 面板：bundles／verify／snapshots／diff／rollback
│       └── commands.js              /pm 斜線指令
├── test/
│   ├── fixtures/                    四個壞情境（§9.1）
│   └── *.test.mjs
├── verify.mjs            # R1–R4 靜態檢查（見 §6.2）
└── docs/
    └── host-notes.md     # ★ M0 實測結果，宿主行為的唯一真相來源
```

**三個設計要點**

1. 宿主半的 `index.js` **只註冊、不執行**（R4）——所有工作都由 client 請求觸發。
2. 所有 profile 變更**必須**經過 `pipeline.mjs`，不許有旁路。
3. 唯一可以碰宿主知識的檔案是 `host/host.mjs`（R7）。

---

## 4. 已定案的事

### 4.1 架構決定：做成插件（不做行程外 CLI）

| 得到 | 說明 |
|---|---|
| 一個 profile 內的正式掛載點 | `dsh.bundle.patch` ＋ `cordis.patch.yml`，與其他插件同一條路 |
| `ctx.commands` 斜線指令 | `/pm verify` 直接在聊天框出結果 |
| slot / 主題 / i18n | 面板與原生 UI 一致 |
| 即時回饋 | 裝完立刻在同一個畫面看到驗證結果 |

⚠️ **~~官方 host 安裝通道~~ 已劃掉（M0 A4 實測）**：本機 DSH `0.1.5-rc.3` **沒有**
`/plugin-installer`、`/plugin-control`（grep 零命中）；官方通道要求 `>=0.1.7-rc.1`。
⇒ **必須自己 spawn `dsh plugin` CLI**，沒有官方通道可以 forward。
（R2「只依賴 `webServer`」因此從限制變成必然——本來就沒有安裝服務可依賴。）
細節見 `docs/host-notes.md` A4。

**代價**：當 `dsh web` 完全起不來時，本插件也載入不了，手上沒有工具。
這是架構事實，不是未完成的功能——**不准在文件或 README 聲稱「自動救援」**。

### 4.2 七條硬規則

| # | 規則 | 為什麼 |
|---|---|---|
| **R1** | 零執行期依賴（宿主半只 import `node:` 與相對檔案） | loader 同步 import；頂層解析失敗 ＝ 整個 `dsh web` 起不來 |
| **R2** | 宿主半只依賴 `webServer` 一個服務 | 啟動時與核心服務打交道，任何一個卡住就開不了機 |
| **R3** | 不碰 `settings` / `agents` / `systemPrompt` / agent 接管 | 已知的「啟動時卡死」來源 |
| **R4** | 不在啟動路徑上做事——面板沒開＝零請求、零寫入 | 出問題時才看得出哪一個動作卡住 |
| **R5** | 任何變更前必先快照；任何生成的 patch 檔必先自我驗證 | patch 檔語意見 §5.5 |
| **R6** | 不寫 `$DSH_HOME/profiles/<n>/cordis.patch.yml` | 那是使用者自己的圖層 |
| **R7** | 所有宿主假設集中在 `src/host/host.mjs` | 那些是讀源碼得出的，不是公開 API |

### 4.3 不做的事（Non-goals）

- ❌ 市集／評分／目錄（`dsh-plugin-hub`、`dsh-plugin-console` 做了）
- ❌ 備份還原 `~/.dsh` 資料（`@xiaoyuyu6420/dsh-backup` 做了）
- ❌ 單一插件包體檢（`dsh-plugin-doctor` 做了）
- ❌ 自己實作 pnpm 語意（一律 forward 官方 `dsh plugin`）
- ❌ 不碰 sessions / credentials / settings.yaml

### 4.4 差異化（唯一賣點）

生態裡七個同類插件，`bin` 全部是 `null`，全部是 web 插件：

`@linxin666/dsh-client-ui-plugin-manager`、`dsh-plugin-manager`、`dsh-plugin-hub`、
`dsh-plugin-console`、`dsh-plugin-center`、`dsh-plugin-check`、`dsh-plugin-guard`。

**它們全部是「改完才算」。** 本插件的差異化只有一句：

> **在安裝之前告訴你會發生什麼事；變更之後再驗一次；不通過就自動回滾。**

⚠️ 不要把差異化放在「CLI」或者「行程外」——已否決的路線。

### 4.5 `--dump-config --patch` 是空位（M0 實測後新增）

生態裡**最接近本插件的那一個**（`@linxin666/dsh-client-ui-plugin-manager`；
`host-notes.md` 的「借鏡」與「反面教材」兩節有逐條分析）確實做了 `--dump-config`
預檢與失敗回滾，所以**「有預檢」本身不是差異化**。它真正沒做的才是：

| 它沒做 | 為什麼仍然是本插件的空位 |
|---|---|
| **預檢跑在變更之後**；裝前唯一防線是 spec 字元黑名單 | 「在安裝**之前**」這句話仍然成立。照抄它就等於放棄賣點 |
| **全 repo 從不使用 `--patch`** | 所以它沒有能力「先驗證一個候選 patch 檔」。這正是 R5：**寫入磁碟之前**先 `--dump-config --patch <候選檔>` 過一次 |

它的「快照」是**記憶體裡的 before/after 比對**（重啟即失）；
「回滾」是**呼叫官方 `remove` 把新裝的拆掉**（只憑 `code === 0` 判定成功，無 checksum）；
磁碟備份只在它自己改檔時產生，而且**單份、無時間戳、`copyFile` 失敗還靜默吞掉**。

> ⇒ §9.2「回滾後狀態與裝之前**逐位元一致**」這條驗收標準**沒有被任何人做過**。
> ⚠️ 但**不可以再聲稱「沒有人在裝之前驗證」**——正確講法是
> 「沒有人在**寫入之前**驗證候選 patch，也沒有人做得到逐位元回滾」。

### 4.6 git 來源的版本偵測（第二個差異化）

生態現況：更新檢查普遍**只支援 npm registry 源**（參考實作自己承認
「網關更新只適用於 npm registry 源，由 host 解析最新版本」）。

而 git／tarball 來源的插件在本機 profile 裡**確實存在**（`host-notes.md` F5 實測）：
`specifier` 是一個**永遠不變的 URL**，但內容會變。

> ⇒ **「git／tarball 來源也能偵測有沒有新版」是第二個差異化。**
> 實作關鍵（F5）：實裝版本讀 `node_modules/<n>/package.json` 的 `version`；
> **換版訊號讀 `pnpm-lock.yaml` 的 `resolution.integrity`**——
> 同一個 URL spec 底下 `integrity` 一變就是換版。
>
> ⛔ **前置條件**：`github:<owner>/<repo>` 直連來源在 lockfile 的長相**尚未實測**
> （`host-notes.md` 待辦 T5）。**T5 沒做完不准開工這一項。**
>
> 🟡 **這一輪的實際處理**：沒有假裝 T5 做完了。實作的是**兩條不依賴 T5 的路**：
> ① 本地 checkout 的 ref 直接讀 `.git`（`gitrefs.js`，不需要 `git` 執行檔，也不需要 lockfile）；
> ② 可安裝來源（`github:`／`git+https:`／registry／tarball）的更新是**把 ref 寫進 spec
> 再交給官方 CLI**（`pipeline.js` 的 `specWithRef`），所以比對鍵仍然是 spec 本身，
> 不是 `resolution.integrity`。**T5 完成後才應該把 `integrity` 當成換版訊號。**

---

## 5. 已驗證的事實（宿主機制）

以下每一條都是讀 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-app-boot` 的實際程式碼得出。
出處見附錄。

### 5.1 Patch 疊層順序（低 → 高）

```
bundlePatches  →  profile.patches  →  homePatches  →  --patch overlays  →  telemetry
                   (使用者圖層)       ($DSH_HOME/
                                      cordis.patch.yml)
```
同一 row id 後者勝。

### 5.2 三個離線入口（插件也可以用子進程呼叫）

| 入口 | 用途 |
|---|---|
| `dsh --profile <n> --dump-config` | 離線 compose 全樹，**不 boot、不評估 `!!js`** |
| `dsh --profile <n> --dump-default-config` | 跳過使用者圖層（壞 patch 檔的隔離診斷） |
| `dsh --profile <n> --patch <file>` | 額外 overlay，可重複，永遠最後疊 |

⛔ **`--dump-config` 不做任何模組解析**（`host-notes.md` F3 實測）：
在 overlay 裡插入一條 `name` 指向不存在套件的 row，**exit 仍是 0**，那行原樣出現在輸出裡。
⇒ 「裝之前會不會爆」必須是**兩層**，且**不能互相取代**：

| 層 | 做什麼 | 抓得到 | 抓不到 |
|---|---|---|---|
| **V1** compose | 跑 `--dump-config`，只看退出碼 | YAML 壞、overlay 讀不到、bundle 未裝、bundle 無 `dsh.bundle` | **指向不存在套件的 row**、`!!js` 的真值、import 期失敗 |
| **V2** 模組解析 | 從 dump 抽每條 row 的 `name:`，逐一試解析 | row 引用了 `node_modules` 裡不存在的套件、lock 與實裝漂移 | 套件在但 export 壞、`apply()` 期失敗 |

⚠️ dump 的 `disabled:` 是**未求值的 `!!js` 原始表達式**，不是布林值——
**「這行有沒有啟用」不能靠 V1 判斷**。

> **官方唯讀補充通道**：`@deepseek-ai/dsh-host-plugin-inventory`（本機 `0.1.5-rc.3`
> 已具備）提供服務 **`pluginInventory`**，`list()` 直接回傳 loader 每個非 group entry 的
> `{entryId, moduleName, enabled, fiberPhase}`——免子進程、已求值。
> 但它只反映**當前進程已載入的樹**，看不到「磁碟上有什麼還沒載入」。
> **與 V1/V2 互補，不可取代。** 是否在本 profile 真的被掛上＝待辦 T4。

### 5.3 開機失敗的簽名（M0 後擴充為四階）

| 階段 | 簽名 | V1 離線看得到？ |
|---|---|---|
| Compose | `profile bundle "X" declares no dsh.bundle in its package.json` | ✅ |
| Compose | `cannot resolve profile bundle "X" from the dsh installation or <dir>` | ✅ |
| Compose | `failed to read overlay <file>`／`failed to parse overlay <file>` | ✅（實測） |
| Compose | `failed to parse config <file>` | ✅ |
| 樹 settle 後 | `plugin(s) failed to load: <names>; Cordis startup failed...` | ❌ |
| 進程級 | `dsh: fatal load failure: <stack>` → **`exit(1)`** | ❌ |
| Loader | `patch: name mismatch for <target> (expected <a>, got <b>), skipping` | ❌ **只 warn** |
| Loader | `duplicate loader entry id: <id>` → TypeError | ❌ **致命** |

⚠️ **只准用前綴或結構比對，不准完整字串比對**——宿主用樣板字串組訊息
（例如 webserver 的是 `` `duplicate ${kind} route "${path}"` ``，不是固定的
`duplicate prefix route`）。這是 R7 存在的理由。
完整清單與實測輸出見 `docs/host-notes.md`。

### 5.4 `dsh plugin` 真正做什麼

pnpm forwarder + reconcile：在 profile 目錄跑 `pnpm <args>`，然後掃描已裝依賴，
**有 `dsh.bundle` 宣告的自動加入 `dsh.profile.bundles`，消失的自動移除**。
→ 不要自己寫 `bundles`，只讀結果。

### 5.5 Patch 檔錯誤語意（決定 R5）

- **非法欄位／值 → throw**（會讓 boot 更糟）
- **target row 不存在 → 只是 per-entry warning**（所以一次 disable 一批可疑 row 是安全的）

### 5.6 斜線指令（`@deepseek-ai/dsh-commands`）

```js
ctx.commands.register({
  name: 'pm',                                   // 必須匹配 COMMAND_NAME 正則
  description: '插件管理器：檢查／快照／回滾',    // 必填非空 → 選單顯示這句
  input: { hint: '<verify|snapshot|rollback|rescue> [參數]' },
  handler: async (input) => ({ kind: 'success', text: '…' }),
})
```
規則：`description` 必填非空；handler 必須回 `{kind:'success'|'error'}`，
error 的 `text` 不可以空白。普通 context ＝ 全域；agent context ＝ 只在該 agent 可見。

---

## 6. 環境與操作手冊

### 6.1 開發迴圈

```sh
# 裝進 profile（開發時用 link:）
dsh plugin --profile web add link:<你 clone 的位置>/dsh-plugin-manager

# 改 src/host/*  → 一定要重啟 dsh web
# 改 src/client/* → 可在真瀏覽器直接驗

npm run verify     # 靜態檢查 R1–R4
npm test           # 全部測試
```

### 6.2 `verify.mjs` 要檢查什麼

- 宿主半的 import 清單只有 `node:` 前綴與相對路徑（R1）
- 宿主半沒有 import 任何 `@deepseek-ai/*` 服務（除了 `webServer` 型別）（R2）
- 沒有任何 top-level side effect（top-level 只准宣告）（R4）
- `client` 半沒有在模組頂層建立全域變數

### 6.3 快照格式

```
$DSH_HOME/.dsh-pm/
  boot-ok.txt                       # 每次成功啟動更新
  profiles/<name>/
    latest-good.txt                 # 純文字指標（Windows 沒有 symlink 權限）
    log.jsonl                       # append-only 事件流
    snapshots/<ISO8601>-<label>/
      manifest.json                 # id/createdAt/label/action/dshVersion/nodeVersion
      package.json
      pnpm-lock.yaml
      pnpm-workspace.yaml
      cordis.patch.yml              # 不存在就記 null
      bundles.json                  # name/spec/version/sourceType/resolvedDir/patchPath/patchSha256
      dump.txt                      # --dump-config 輸出（供 diff）
      verify.json
```

> **不夠記 manifest**：同一個 spec 可以解析到不同版本。
> 要認得出「是不是同一個狀態」就要 hash 與 resolvedDir。

⚠️ **M0 實測補充（`host-notes.md` F5）——tarball／git 來源的讀法不同**：

| 要讀什麼 | 從哪裡讀 |
|---|---|
| 實裝版本 | `node_modules/<n>/package.json` 的 `version`。**不要讀 lockfile 的 importer 段**——URL 來源下那裡記的是 URL，不是版本 |
| 換版訊號 | `pnpm-lock.yaml` packages 段的 `resolution.integrity`。同一個 URL spec 底下 `integrity` 一變就是換版 |
| 來源種類 | spec 的字面形狀（版本範圍／`link:`／`file:`／URL／`github:`） |

> 這三條同時是 §4.6（git 版本偵測）的實作基礎。
> 另外：`copyFile` 失敗**不准靜默**，備份**不准單份無時間戳**——
> 那是參考實作已經犯過的錯（見 §4.5）。

### 6.4 變更管道（唯一的變更入口）

```
① verify（V1 離線 compose ＋ V2 模組解析）
      │ pass
② snapshot（自動，label ＝ 動作名）
      │
③ 執行（spawn `dsh plugin --profile <n> add|remove <spec>`）
      │
④ verify（再驗一次）
      │
 ├─ pass → 記錄 known-good
 └─ fail → ⑤ rollback（自動還原 ②）+ 出報告
```

⚠️ **③ 不是「forward 官方 host 通道」**——A4 實測顯示本機沒有那個通道（見 §4.1）。
唯一寫入器是 **`dsh plugin` CLI**。

⚠️ **Windows 上不可以直接 spawn PATH 裡的 `dsh`**（`host-notes.md` A3）：
它是 `.ps1`，`Start-Process` 會失敗。必須解析到
`<checkout>/dsh/lib/bin.js` 再用 `process.execPath` 執行，或走 `cmd.exe /d /s /c` 封套。

⚠️ **兩條從參考實作學到的紀律**（`host-notes.md` 借鏡清單）：
1. **不信退出碼**——CLI 回 0 之後要再確認 profile `package.json` 的
   `dependencies` key 集合真的變了，沒變就當失敗。
2. **串行化的尾巴一定要復原**——任務自己 reject 保留給呼叫端，
   但佇列尾巴必須永遠前進，一次失敗不可以卡住後面所有工作。

`--no-verify` 逃生門要留，但必須留痕，不可以靜默。

---

## 7. 進度

| 項目 | 狀態 |
|---|---|
| 架構決定 | ✅ 已定案（插件版） |
| 宿主機制研究 | ✅ 完成（§5） |
| 競品調查 | ✅ 完成（§4.4）；M0 後修正為 §4.5 |
| M0 spike | 🟡 **進行中**——A1/A2/A3（一半）/A4/A7 已答；T4 已完成；T1/T2/T3/T5–T8 待驗 |
| M1 骨架 | 🟡 **程式碼已寫，唯讀面板已在真實瀏覽器註冊成功**（見下） |
| M2 verify | 🟢 **三層已寫且有測試**；尚未在真 profile 上跑過零誤報驗收 |
| M3 快照／回滾 | 🟢 **已寫且有測試**（真檔案 I/O、真子進程）；`--dry-run` 檢視未做 |
| M4 變更管道 | 🟢 **已寫且有測試**（含自動回滾的逐位元組驗證）；未在真的 `dsh web` 上按過 |
| M5 斜線指令 | ⬜ 未開始 |
| M6 boot-ok | ⬜ 未開始 |


### 7.1 M1 的實際進度

| 交付項目 | 狀態 |
|---|---|
| `package.json` / `cordis.patch.yml` / `src/host` / `src/client` | ✅ 已寫 |
| `verify.mjs`（R1–R4 ＋ 個資掃描） | ✅ 全綠 |
| 單元測試 | ✅ 23 個通過（`npm test`） |
| 面板在真實部署**註冊進 `settings.plugins.tab`** | ✅ 已驗（活的 slot 樹顯示 `id=plugin-manager-spike order=15 active=true`） |
| 裝得進 profile（`dsh plugin add link:`） | ⬜ **未做**——目前只在動態外掛上驗過 |
| `dsh web` 起得來 | ⬜ 未做（同上） |
| 面板**未打開**時零請求零寫入（T8） | ⬜ 未驗 |

> ⚠️ **原型與真插件的差距**：上述「已驗」那一列是在**動態 Cordis 外掛**上做的，
> 不是 `dsh.bundle` 路線。兩者的 client 半寫法不同（見 `host-notes.md` F11），
> **所以在跑到「裝得進 profile」之前，M1 不算完成。**

---

### 7.2 安裝欄位與 spec 守門（2026-09 session）

使用者要求：「我怎樣安裝新的插件？我還想設計一個類似 docker compose / requirements 的安裝列表」。
設計與三個決策記在 **`docs/install-manifest.md`**（清單語意只加不刪、檔案放
`$DSH_HOME/.dsh-pm/plugin-manifest.yml`、第一步先做面板安裝欄位）。這一輪做完的是**第一步**。

**規劃時查到的四個缺口**（都是實測）：

| 缺口 | 位置 | 後果 |
|---|---|---|
| `apply` 早支援 `verb: 'add'` | `routes.js` | 管道對安裝早就能用，只是**沒有介面呼叫它** |
| 面板沒有任何安裝 UI | `client/panel.js` | 只能走 CLI，等於放棄管道 |
| `plan` 只支援 update | `routes.js`（走 `classifyUpdate`，找不到已裝插件就回錯） | 「先給計畫再給按鈕」對安裝不成立 |
| `add` 對 spec **完全沒有驗證** | `src/host` 全樹 grep 不到任何檢查 | 這是**唯一沒有守門的變更路徑**：使用者給什麼字串就 spawn 什麼 |

| 新增 | 檔案 | 支撐 |
|---|---|---|
| `checkPackageSpec`：spec 守門（拒絕 `-` 開頭、控制字元、shell 特殊字元、非 ASCII、>1024） | `src/host/pipeline.js` | 補上缺口 4 |
| `nameFromSpec`：只在能確定時推出套件名，否則回 `null` | 同上 | 不猜「這是新的」 |
| `planInstall` / `planRemoval`：與 `planUpdate` 同形狀的計畫 | 同上 | 補上缺口 3 |
| `plan` 路由接受 `verb=add\|remove`，且守門跑在**讀 profile 之前** | `src/host/routes.js` | 同上 |
| `apply` 的 `add` 路徑套用同一個守門（**兩個執行點，一次驗證**） | 同上 | 缺口 4：`apply` 可以單獨被呼叫，只在 `plan` 驗不算規則 |
| 安裝欄位：輸入 → 檢查計畫 → 才給安裝鈕 | `src/client/panel.js`、`copy.js`、`styles.js`、`face.js` | 缺口 2 |
| `test/install-plan.test.mjs`（22）＋ `panel-render` 的安裝欄位（7） | `test/` | 新增 29 個測試 |

**這一輪修掉的一個順序 bug**：守門一開始寫在 `resolveChangeContext` **之後**，
所以一個壞 spec 會先拿到「讀不到 profile」——兩件無關的事被混成一個答案。
現在守門在所有 profile 讀取之前，`test/install-plan.test.mjs` 用「這個 stub 沒有 profile」
把順序釘住。

**尚未驗的**：面板要**重啟 `dsh web`** 才會有這顆欄位（宿主半改了）。見 §8.2。

---

## 8. 里程碑

| M | 內容 | 估時 | 完成定義 |
|---|---|---|---|
| **M0** | Spike：答 §10 全部假設 | 半日 | 八條都有實測答案 ＋ T1–T8 完成，寫入 `docs/host-notes.md` |
| **M1** | 骨架 + `verify.mjs` + 唯讀面板（bundles 清單） | 2 日 | 裝得進 profile、`dsh web` 起得來、面板列得出 bundle、`verify.mjs` 全綠 |
| **M2** | `verify`（V1 compose ＋ V2 模組解析 ＋ 漂移） | 2 日 | 在真 profile **零誤報**；§9.1 六個 fixture 判得準 |
| **M3** | 快照 + 回滾 + diff | 2 日 | 影得到、列得到、`--dry-run` 與實際一致 |
| **M4** | ★ 變更管道：install / remove / update + 裝前驗 + 自動回滾 | 3 日 | 故意裝壞套件 → 自動回滾 → 狀態逐位元一致 |
| **M5** | 斜線指令 `/pm` | 1 日 | `/pm verify` 出得到結果 |
| **M6** | `boot-ok` 記錄 + 面板提示 | 半日 | 上次啟動失敗時面板提示得出來 |
| **S1** | 安裝欄位 ＋ `add` 的計畫預覽 ＋ spec 守門 | ✅ **已寫且有測試**（29 個） | 面板打一個 spec → 看到會跑什麼 → 走完整管道。**未在真的 `dsh web` 上按過** |
| **S2** | 安裝清單：解析 ＋ 差異比對 ＋ 產生指令（**不碰 profile**） | ⬜ | 見 `docs/install-manifest.md` §5 |
| **S3** | 逐顆同步 ＋ 孤兒清單 ＋ 同步後報告 | ⬜ | 每顆變更都有**自己**的快照 |

**M1 + M2 完成就有「裝之前告訴你會不會爆」這個核心價值。M4 完成就有自動回滾。**

### 8.1 M4 的驗收現況（照實）

| 驗收項 | 狀態 | 證據 |
|---|---|---|
| `pipeline.mjs` 是所有變更的唯一路徑 | 🟢 | `apply` 路由只有三條出口，全部經過 `runPipeline`；`test/pipeline.test.mjs` |
| 故意裝壞 → 自動回滾 → 狀態逐位元一致 | 🟢 **以真子進程驗過** | 假 launcher 真的把 `package.json` 寫壞 → 驗證失敗 → 回滾 → 檔案與變更前**逐位元組相同** |
| 中斷恢復（kill 之後偵測未完成管道） | 🔴 **未做** | `log.jsonl` 的 started/finished 協定還沒寫；目前只有快照本身留下 |
| 更新時選版本／分支 | 🟢 | 本機 ref 列舉有測試（含 packed-refs、annotated tag、detached HEAD） |
| 遠端 ref 查詢 | 🟡 | 解析與失敗語意有測試；**真實 API 呼叫未在宿主內跑過** |
| 在真的 `dsh web` 上按過 | 🔴 **未驗** | 需要重啟宿主，見 §8.2 |

### 8.2 為什麼「在真的宿主上驗」還沒做完

新增的路由、`inject` 的改變、以及 `apply()` 裡新增的工具探測，
**全部要重啟 `dsh web` 才會生效**（F21：宿主半是啟動時 import 的）。
而重啟會把正在跑的那個 session 一起帶走。

所以這一項**要用戶同意才做**，不是可以自己決定的事。
已經先確認過的：`dsh-base` 的 `cordis.patch.yml` 有註冊
`@deepseek-ai/dsh-subprocess-local`（`:199`），所以 `ctx.get('subprocess')` 在真實部署裡拿得到東西。


---

## 9. 測試計劃

### 9.1 固定情境（每個用獨立 `$DSH_HOME` 指向臨時目錄）

⚠️ **M0 後重排**：期望值要按「V1 抓得到 / 只有 V2 抓得到」分類，
不可以再寫成籠統的「指出正確 bundle」——那會讓 M2 的驗收標準訂錯。

| Fixture | 造法 | 期望 | 靠哪一層 |
|---|---|---|---|
| `ok` | 正常 profile | pass，**零誤報** | V1＋V2 |
| `bundle-not-installed` | `dsh.profile.bundles` 有一條但 `node_modules` 沒有 | 指出是哪一條 bundle 沒裝 | **V1**（`:831`） |
| `not-a-bundle` | 依賴一個沒有 `dsh.bundle` 的包 | 指出正確的 row | **V1**（`:852`） |
| `broken-patch` | 塞一個語法壞的 overlay | 指出是哪個檔、第幾行 | **V1**（`failed to parse overlay ... YAMLException`） |
| `missing-module` | 依賴存在但 `node_modules` 刪掉 | 指出正確 bundle | ⚠️ **只有 V2**（V1 可能因 `.dsh-module-fallback` 而 pass；T3 未定） |
| `insert-nonexistent` | 某 bundle 的 patch 有一條 `insert.name` 指向沒裝的套件 | 指出那條 insert 行 | ⚠️ **只有 V2**（V1 對它完全沉默，F3 實測） |

> `bundle-not-installed` 與 `insert-nonexistent` 是 M0 之後**新增**的兩個 fixture。
> 前者來自 A1 的實測更正，後者來自 F3——**沒有它，「裝之前驗證」有一半是空的**。

### 9.2 管道測試（最重要的一組）

| 情境 | 期望 |
|---|---|
| 裝一個正常套件 | 驗→影→裝→再驗 全 pass，快照留下 |
| 裝一個**會讓 compose 爆**的套件 | 偵測到失敗 → 自動回滾 → 狀態與裝之前**逐位元一致** |
| 回滾過程中斷（kill） | 下次執行時偵測到未完成管道並修復（`log.jsonl` 有 started 沒 finished） |

### 9.3 插件自身的安全測試（R1–R4）

| 情境 | 期望 |
|---|---|
| 宿主半 import 了 `@deepseek-ai/*` 服務 | `verify.mjs` 要 fail |
| 宿主半有 top-level side effect | `verify.mjs` 要 fail |
| profile 有一個**壞掉的無關插件** | 本插件仍然載入得到、面板開得到（不可以因為鄰居壞就跟著死） |
| 面板未打開 | **零請求、零檔案寫入**（用 fetch 監聽釘死：`apply()` 零請求 → 掛載零請求） |

### 9.4 驗收

1. 在真 profile 裝本插件 → `dsh web` 起得來、面板開得到
2. 面板按「Verify」→ 零誤報
3. **餵一個候選 patch 檔（內含指向不存在套件的 insert 行）→ V2 必須抓到**
   （V1 會放它過，這正是 §5.2 兩層分工的驗收）
4. 故意裝一個壞套件 → 自動回滾 → 狀態與裝前**逐位元一致**
5. 手動餵壞的候選 patch → R5 擋得住（V1 於**寫入之前**就 throw）

---

## 10. 開工前必須先答的假設（M0）

每一條附可執行驗證。**全部在 throwaway profile 做，不碰真身。**
實測結果與完整輸出在 `docs/host-notes.md`；下表只放結論。

| # | 假設 | 結論 | 附註 |
|---|---|---|---|
| **A1** ⛔ | `--dump-config` 在 bundle 缺檔／壞檔時會 throw | ✅ **成立（附更正）** | throw 的條件是「bundle 未裝」（`:831`）或「bundle 無 `dsh.bundle`」（`:852`），**不是**模組解析失敗 |
| **A2** | `--dump-config` 輸出含每個 entry 的模組 specifier | ✅ **成立** | `name:` 欄位。**但** `disabled:` 是未求值的 `!!js` |
| **A3** ⛔ | 插件可以在宿主內 spawn `dsh` 子進程 | 🟡 **一半成立** | 一般進程可（122 ms、拿得到 exit code/stdout）。**宿主半內**未測（T2）。另有前置問題：Windows 的 `dsh` 是 `.ps1`，必須走 `bin.js` |
| **A4** ⛔ | 官方 host 通道可以由插件觸發安裝 | ❌ **不成立** | `0.1.5-rc.3` 沒有 `/plugin-installer`、`/plugin-control`。⇒ 必須 spawn CLI，見 §4.1 |
| **A5** | 裝完之後**不重啟**也拿得到新 bundle 的 patch | ⬜ 未測 | T6。間接證據傾向成立（都是普通磁碟檔、宿主無快取） |
| **A6** | 「壞鄰居」會不會讓本插件也載入不了 | ⬜ 未測 | T7。宿主是**樹 settle 後才統一審計**（`:1438`），但進程級仍可能 `exit(1)` |
| **A7** | 語法錯誤的 `--patch` 檔會讓 boot throw | ✅ **成立** | `exit 1` ＋ `failed to parse overlay ... YAMLException`。⇒ **R5 必須保留** |
| **A8** | 面板未打開時真的零請求 | ⬜ 未測 | T8，M1 驗收 |

**A1 / A3 / A4 是阻塞性的。** A4 已經有答案（否），架構照 §4.1 調整；
A3 的關鍵一半（宿主半內）仍未驗，**在 T2 完成前不要開始 M2**。

### 10.1 M0 剩下的待辦

完整版在 `docs/host-notes.md` 最後一節。摘要：

| # | 待驗 | 阻塞 |
|---|---|---|
| **T1** | `--dump-config` 在假 profile 上的完整行為 | M1 的包裝層 |
| **T2** | **宿主半內** spawn 是否安全 | ⛔ M2 |
| **T3** | `node_modules` 刪掉後落不落到 `.dsh-module-fallback` | `missing-module` fixture 的期望 |
| **T4** | `pluginInventory` 在本 profile 是否真的提供 | 面板資料來源 |
| **T5** | **git 直連來源在 lockfile 的長相** | ⭐ §4.6 差異化 |
| **T6** | 裝後不重啟能否讀到新 patch（A5） | 「裝後即驗」 |
| **T7** | 壞鄰居隔離（A6） | §9.3 測試設計 |
| **T8** | 面板未開＝零請求零寫入（A8） | R4，M1 驗收 |

---

## 11. 交付檢查清單

**M0**
- [x] A1 / A2 / A3（一半）/ A4 / A7 有實測答案
- [ ] A3（宿主半內）/ A5 / A6 / A8 有實測答案
- [ ] T1–T8 完成
- [x] `docs/host-notes.md` 寫好，每條附實際命令與輸出

**M1**
- [ ] 插件裝得進 profile、`dsh web` 起得來
- [ ] `npm run verify` 全綠（R1–R4）
- [ ] 面板列得出全部 bundle
- [ ] 面板**未打開**時零請求、零檔案寫入（T8）

**M2**
- [ ] `verify` 在真 profile 零誤報
- [ ] §9.1 **六個** fixture 判得準
- [ ] `insert-nonexistent` 這個 fixture 由 V2 抓到（V1 對它沉默）

**M3**
- [ ] 快照生成完整目錄
- [ ] `rollback --dry-run` 與實際一致

**M4**
- [ ] `pipeline.mjs` 是所有變更的唯一路徑（code review 確認沒有旁路）
- [ ] 故意裝壞 → 自動回滾 → 狀態逐位元一致
- [ ] 中斷恢復測試 pass

**S1（安裝欄位）**
- [x] spec 守門有測試：接受清單與拒絕清單都釘住
- [x] 守門在**兩個**執行點（`plan` 與 `apply`），且跑在讀 profile 之前
- [x] `planInstall` 三種狀態（新裝／同 spec／不同 spec）與「看不出名字」都有測試
- [x] 面板渲染：沒有計畫就沒有指令、沒有安裝鈕；拒絕要渲染理由
- [x] NOT PROBED 與 NOT AVAILABLE 渲染成不同東西
- [ ] **在真的 `dsh web` 上按過**（需重啟宿主，見 §8.2）

**發佈前**
- [ ] `package.json` 零 `dependencies`
- [ ] README 講清楚**限制**——不准聲稱「自動救援」
- [ ] README 有與七個同類插件的對照表

---

## 附錄：宿主出處一覽

| 主題 | 檔案:行 |
|---|---|
| Patch 疊層順序 | `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:222-257` |
| dump-config 語意 | `@deepseek-ai/dsh/lib/dump-config-lFgMwK8i.js:6-50` |
| `--patch` / `--dump-config` 定義 | `@deepseek-ai/dsh/lib/bin.js:85,101` |
| `plugin` 子命令的 `--profile` | `@deepseek-ai/dsh/lib/bin.js:106` |
| patch 檔錯誤語意 | `@deepseek-ai/dsh-app-boot/lib/index.js:1179-1190` |
| bundle 解析 + 錯誤 | `@deepseek-ai/dsh-app-boot/lib/index.js:843-871`（`:831` 解析不到、`:852` 無 `dsh.bundle`） |
| overlay 讀取／解析失敗 | `@deepseek-ai/dsh-app-boot/lib/index.js:1165,1197,1247` |
| dump 的層標記 | `@deepseek-ai/dsh-app-boot/lib/index.js:1290,1301` |
| 樹 settle 後審計 | `@deepseek-ai/dsh-app-boot/lib/index.js:1434-1440` |
| fail-loud 進程退出 | `@deepseek-ai/dsh-app-boot/lib/index.js:1401-1426` |
| user layer 檔名與「不存在＝空」 | `@deepseek-ai/dsh-app-boot/lib/index.js:861-862` |
| `dsh plugin` ＝ pnpm forwarder | `@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:7-90` |
| 斜線指令註冊 | `@deepseek-ai/dsh-commands/lib/index.js:142-173,257-259` |
| 模組解析雙 anchor | `@deepseek-ai/dsh-app-boot/lib/index.js:301-316` |
| **`pluginInventory` 服務** | `@deepseek-ai/dsh-host-plugin-inventory/lib/index.js:91-131` |
| **重複 entry id ＝ 致命** | `@deepseek-ai/cordis-plugin-loader/lib/index.js:91` |
| **patch 行 `name` 不符 ＝ 只 warn** | `@deepseek-ai/cordis-plugin-include/lib/index.js:96-99` |
