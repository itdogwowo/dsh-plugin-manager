/**
 * The detection parameter schema — one declaration, two consumers.
 *
 * `test/params.test.mjs` enforces that the host's `buildDetect()` implements
 * exactly these keys. The entry that made this file necessary is `position`:
 * it was added to the host report and to the panel's rendering, but never to
 * this table, so nothing failed and the parameter was invisible in the docs.
 * A hand-kept parameter list is a list that rots.
 *
 * ## What this file is NOT allowed to become
 *
 * Every parameter here is **read-only**. Detection reads the profile manifest,
 * the lockfile, `.git` metadata and the installed tree; it never writes, never
 * installs, never fetches. That is a product decision, not a limitation to be
 * lifted later without asking: an update check that can itself change the
 * install is a check nobody can run safely.
 */

/** The five source kinds the detector understands. */
export const SOURCE_KINDS = ['registry', 'git', 'file', 'link', 'tarball-url']

/** The three verdicts a comparison can reach. */
export const VERDICTS = ['current', 'moved', 'unknown']

/**
 * Verdict definitions, so the panel and the docs cannot disagree about meaning.
 *
 * `unknown` is load-bearing. Every source kind without a remote baseline lands
 * here, and that is the honest answer: for a `link:` install with no
 * remote-tracking ref, "no update available" and "cannot tell" are different
 * claims, and only one of them is true.
 */
export const VERDICT_MEANING = {
  current: 'the source still matches the recorded baseline',
  moved: 'the source no longer matches the recorded baseline',
  unknown: 'there is no baseline to compare against, so no claim is made',
}

/**
 * Source parameters: where a plugin came from, and what its version even means.
 *
 * `ref` is the comparison key. For a git checkout it is the branch whose commit
 * is compared; for a registry dependency it is the declared range; for a
 * `link:`/`file:` install it is null, because the identity is the local path.
 */
export const SOURCE_PARAMS = [
  {
    key: 'name',
    label: '插件名稱',
    source: 'profile manifest dependencies',
    meaning: 'the dependency key, which is also what the boot graph reports as an entry id',
  },
  {
    key: 'spec',
    label: '來源 spec',
    source: 'profile manifest dependencies',
    meaning: 'the exact string the user installed with — the only record of where it came from',
  },
  {
    key: 'sourceType',
    label: '來源類型',
    source: 'classified from spec',
    meaning: 'which of the five kinds this is; decides which comparison is even possible',
  },
  {
    key: 'ref',
    label: '比較鍵',
    source: 'branch for git, range or branch/tag for registry, null for link/file',
    meaning: 'what "the same version" is measured against',
  },
  {
    key: 'specifier',
    label: 'specifier',
    source: 'pnpm-lock.yaml importers',
    meaning: 'the spec as the lockfile recorded it, which may differ from the manifest',
  },
  {
    key: 'lockVersion',
    label: '鎖定版本',
    source: 'pnpm-lock.yaml importers',
    meaning: 'the resolved version at last install — the baseline for a registry comparison',
  },
  {
    key: 'installedVersion',
    label: '已安裝版本',
    source: 'node_modules/<name>/package.json',
    meaning: 'what is actually on disk now; a lockfile entry can disagree with it',
  },
  {
    key: 'enabled',
    label: '是否啟用',
    source: "the user's cordis.patch.yml, then the shipped bundle patch",
    meaning:
      'resolved by layer precedence, last write winning per row; false only when the winning layer states disabled: true',
  },
  {
    key: 'enabledState',
    label: '啟用狀態',
    source: 'derived from enabled plus the boot graph',
    meaning:
      'running / disabled / not-loaded / computed. Not-loaded is a FAULT (enabled yet absent from the graph); computed means the flag is an expression, not a choice',
  },
  {
    key: 'disabledBy',
    label: '被誰停用',
    source: 'the winning patch layer',
    meaning: 'which layer decided this, so the user is not told they disabled something a bundle disabled',
  },
  {
    key: 'enabledReason',
    label: '啟用判斷理由',
    source: 'the resolver',
    meaning: 'plain-language reason, including the raw !!js expression when the flag is computed rather than stated',
  },
  {
    key: 'resolvedDir',
    label: '解析目錄',
    source: 'fs.resolve on the installed manifest',
    meaning: 'where the package really is, after any junction is followed',
  },
  {
    key: 'pathIsLink',
    label: '是連結',
    source: 'directory comparison',
    meaning: 'whether the install points away from the profile, which is what link: means in practice',
  },
  {
    key: 'commit',
    label: '目前 commit',
    source: '.git/HEAD + .git/refs/heads/<branch>',
    meaning: 'read from files, never from the git binary — git is not on PATH on the reference machine',
  },
  {
    key: 'branch',
    label: '分支',
    source: '.git/HEAD',
    meaning: 'the branch whose tip is the working-tree baseline',
  },
  {
    key: 'remote',
    label: 'remote',
    source: '.git/config [remote "origin"] url',
    meaning: 'where the upstream lives; shown because a checkout with no remote can never be compared',
  },
  {
    key: 'trackingRef',
    label: '追蹤 ref',
    source: '.git/refs/remotes/origin/<branch> and .git/FETCH_HEAD',
    meaning: 'the upstream tip as of the last fetch — NOT as of now; see strategyParams.reachability',
  },
  {
    key: 'tarball',
    label: 'tarball',
    source: 'spec for file: and https: installs',
    meaning: 'the archive itself, for installs whose source is a single file',
  },
  {
    key: 'fileHash',
    label: '目錄指紋',
    source: 'FNV-1a over the sorted (relative path, size, mtime) list',
    meaning: 'a stable content signal that needs no crypto import and no git binary',
  },
  {
    key: 'fileCount',
    label: '檔案數',
    source: 'the same walk',
    meaning: 'a hash is only meaningful next to the size of the thing it summarises',
  },
]

/**
 * Strategy parameters: when a comparison is allowed, and what it must not do.
 *
 * `reachability` is the one that decides how much the detector may claim. With
 * `local`, a git verdict can only ever be "the working tree moved since the last
 * fetch" — it cannot see a newer upstream commit, and saying otherwise would be
 * a lie the user has no way to check.
 */
export const STRATEGY_PARAMS = [
  {
    key: 'reachability',
    label: '可及範圍',
    default: 'local',
    options: ['local', 'network'],
    meaning:
      'local reads only this machine and can never report "a newer version exists"; network would query the registry and run git ls-remote, and is not implemented',
  },
  {
    key: 'includeKinds',
    label: '納入比較的來源',
    default: SOURCE_KINDS,
    options: SOURCE_KINDS,
    meaning: 'narrowing this is how a slow check gets fast, since every file-kind probe walks a directory tree',
  },
  {
    key: 'hashFileTrees',
    label: '計算目錄指紋',
    default: true,
    options: [true, false],
    meaning: 'the expensive half; turning it off keeps commit, version and path evidence only',
  },
  {
    key: 'maxFiles',
    label: '指紋檔案上限',
    default: 2000,
    options: 'number',
    meaning: 'the walk stops here and the hash is reported as truncated rather than silently partial',
  },
  {
    key: 'writesAnything',
    label: '是否會寫入',
    default: false,
    options: [false],
    meaning: 'permanently false in this version: detection is a read, so it is always safe to run',
  },
]

/** Every parameter key, both sets, for the drift test. */
export const ALL_PARAM_KEYS = {
  source: SOURCE_PARAMS.map((entry) => entry.key),
  strategy: STRATEGY_PARAMS.map((entry) => entry.key),
}

/** The strategy defaults as a plain object. */
export const STRATEGY_DEFAULTS = Object.fromEntries(STRATEGY_PARAMS.map((entry) => [entry.key, entry.default]))
