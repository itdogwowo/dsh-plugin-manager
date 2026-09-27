/**
 * Why a plugin's version tools have nothing to read — and the way out.
 *
 * ## The fact this file exists for
 *
 * `dsh plugin …` is a thin pnpm forwarder (the shipped CLI says so in its own
 * header: "init if needed, run `pnpm <args...>` in the profile directory"), and
 * pnpm turns EVERY git-hosted spec into an ARCHIVE:
 *
 *   `github:owner/repo`                → `codeload.github.com/…/tar.gz`
 *   `github:owner/repo#v1.2.3`         → the same tarball, pinned to a commit
 *   `https://github.com/…/main.tar.gz` → the same bytes
 *
 * Measured on pnpm 12.4.1 (`docs/host-notes.md`): the virtual-store directory is
 * named `…@https+++codeload.github.com+owner+repo+tar.gz+<sha>`, and the extracted
 * package contains `index.js`, `LICENSE`, `package.json`, `README.md` — and **no
 * `.git`**. A `#ref` pins the CONTENT; it never brings history.
 *
 * The panel's version tools all read `.git` by design (`gitrefs.js` reads refs
 * from files, no `git` binary needed). So for an archive install they fail
 * together, with messages that were true and useless:
 *
 *   「載入版本」 → no .git/HEAD and no .git file
 *   「查遠端」   → this checkout records no origin remote
 *
 * Neither says *why*, and neither names the one shape that does work. This module
 * answers both from the SPEC alone, without touching the disk: the reason to
 * show, and the two commands that turn the install into a managed checkout.
 *
 * ## What "the way out" is, exactly
 *
 * `link:` is the only spec that points at a real working tree, and it is the
 * whole difference: a `link:` install has `.git`, so `載入版本` can list refs and
 * `更新` can `git merge --ff-only`. Getting there is two steps the USER runs —
 * this plugin does not clone and does not run a package manager (the same rule
 * `install-hints.mjs` states for tool installs):
 *
 *   git clone <repoUrl> <a directory of your choosing>
 *   dsh plugin --profile <name> add 'link:<that directory>'
 *
 * ⚠️ The second command re-installs the dependency under the same name, which is
 * why it is an `add` and not an edit of the profile's `package.json`: every
 * profile change in this package goes through the official CLI (`pipeline.mjs`),
 * and the user's `cordis.patch.yml` is never written by hand (R6, `docs/plan.md`).
 *
 * ## Privacy
 *
 * Command text carries the literal placeholder `<你放 clone 的位置>`, never a real
 * home directory — the plugin does not guess where a user keeps repositories, and
 * a real path does not belong in a public repository (AGENTS.md).
 *
 * R1 applies: this file imports only relative paths.
 */

import { joinPath } from './host.js'
import { parseRemoteUrl } from './gitrefs.js'

/** The literal both commands carry, so the user knows what to replace. */
export const CLONE_PATH_PLACEHOLDER = '<你放 clone 的位置>'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The repository a spec points at, in the terms a `git clone` needs.
 *
 * ⚠️ A GitHub ARCHIVE URL has to be cut down before the URL parser sees it. The
 * parser answers with the LAST path segment as the repository — correct for a
 * remote, which is always `owner/repo(.git)` — so
 * `https://github.com/owner/repo/archive/refs/heads/main.tar.gz` came back as
 * `owner: owner/repo/archive/refs/heads`, `repo: main.tar.gz`, and the clone
 * command built from it would ask for a repository that does not exist. Cut here
 * rather than in the parser, whose other callers only ever hand it a remote.
 *
 * @param {string} spec - the dependency spec from the profile manifest.
 * @returns {{ owner: string|null, repo: string|null, repoUrl: string|null }|null} the repository, or null.
 */
export function specRepository(spec) {
  const value = str(spec)
  if (value === null) return null
  // A fragment names a ref (`#v1.2.3`), which is not part of a clone URL.
  const bare = value.split('#')[0]

  // `github:owner/repo` is pnpm's shorthand, not a URL. It is also the spelling
  // the panel's own install hint recommends, which is how a user arrives here.
  const shorthand = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(bare)
  if (shorthand !== null) {
    return { owner: shorthand[1], repo: shorthand[2], repoUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}` }
  }

  // `git+https://…` is git's own prefix for "this is a git remote"; the parser
  // below only knows URL and scp shapes, so the prefix is removed here.
  let candidate = bare.startsWith('git+') ? bare.slice('git+'.length) : bare

  // An archive URL names a ref after the repository, and none of that is part of
  // where the repository lives.
  const archive = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/(?:archive|tarball|zipball|releases\/download)\/.*$/i.exec(candidate)
  if (archive !== null) candidate = archive[1]

  const parsed = parseRemoteUrl(candidate)
  if (parsed.ok !== true) return null
  return { owner: parsed.owner, repo: parsed.repo, repoUrl: parsed.webUrl ?? candidate }
}

/**
 * The two commands that turn an archive install into a managed checkout.
 *
 * The clone target is a placeholder on purpose: the only honest directory is one
 * the user names, and `link:` needs an absolute path.
 *
 * @param {object} input - `{ repoUrl, profileName }`.
 * @returns {{ clone: string, link: string }} the commands, as text to copy.
 */
export function checkoutCommands(input) {
  const repoUrl = str(input?.repoUrl) ?? '<repo URL>'
  const profileName = str(input?.profileName) ?? '<profile>'
  return {
    clone: `git clone ${repoUrl} ${CLONE_PATH_PLACEHOLDER}`,
    link: `dsh plugin --profile ${profileName} add "link:${CLONE_PATH_PLACEHOLDER}"`,
  }
}

/**
 * What to show for one installed plugin whose version tools cannot work.
 *
 * Pure: the spec and the on-disk directory are inputs, and nothing here reads the
 * disk or spawns anything. The caller (an inventory build) knows both.
 *
 * Every branch answers the same three questions, because a refusal that names no
 * way out is the answer that makes a panel useless (`update.js` says the same
 * thing about its own refusals): what is it, why can it not be read, and what to
 * run instead.
 *
 * @param {object} input - `{ spec, dir, profileName, name }`.
 * @returns {object} plain-JSON recovery record; `applies: false` when git facts
 *   are expected to exist (a checkout that could not be read is a different
 *   report, and this one must not overwrite it).
 */
export function checkoutRecovery(input) {
  const spec = str(input?.spec)
  const value = spec ?? ''
  const out = {
    applies: false,
    sourceKind: 'unknown',
    reason: null,
    repoUrl: null,
    owner: null,
    repo: null,
    dir: str(input?.dir),
    // The spec as recorded, so the panel can show what it is about to replace.
    spec,
    commands: null,
  }

  /**
   * Finish the record: the reason, and the commands when the spec names a repo.
   * @param {string} sourceKind - this branch's answer to "what is it".
   * @param {string} reason - the key the panel turns into a sentence.
   * @param {boolean} withCommands - whether a clone URL was found.
   */
  const finish = (sourceKind, reason, withCommands) => {
    out.applies = true
    out.sourceKind = sourceKind
    out.reason = reason
    if (withCommands && out.repoUrl !== null) {
      const commands = checkoutCommands({ repoUrl: out.repoUrl, profileName: input?.profileName })
      out.commands = { clone: commands.clone, link: commands.link, spec: `link:${CLONE_PATH_PLACEHOLDER}` }
    }
    return out
  }

  /** Record the repository, if the spec names one. @returns {boolean} whether it did. */
  const withRepository = () => {
    const repository = specRepository(spec)
    if (repository === null) return false
    out.owner = repository.owner
    out.repo = repository.repo
    out.repoUrl = repository.repoUrl
    return true
  }

  if (value.startsWith('link:') || value.startsWith('workspace:')) {
    // The shape that CAN be read, and it still could not be. A path problem is
    // the user's to see, so the report names the directory the spec points at
    // instead of blaming pnpm for an archive that was never installed.
    const named = value.startsWith('link:') ? str(value.slice('link:'.length)) : null
    if (named !== null) out.dir = named
    return finish('link', 'linkNoRepo', false)
  }

  if (value.startsWith('github:') || value.startsWith('git+') || value.startsWith('git:')) {
    return finish('git', 'archiveFromSpec', withRepository())
  }

  if (/^https?:\/\//i.test(value)) {
    return finish('tarball', 'archiveFromSpec', withRepository())
  }

  if (value.startsWith('file:')) {
    return finish('file', 'archiveFromLocalFile', false)
  }

  // A registry range, an npm alias, a bare `owner/repo`, or nothing at all. The
  // spec records a NAME, not a URL: the repository exists somewhere, but this
  // plugin cannot read it from here, and guessing an `https://` prefix would
  // produce a clone command that fails in a way the user cannot act on.
  return finish('registry', 'archiveFromRegistry', false)
}

/**
 * The directory an install was resolved into, from its manifest path.
 *
 * `resolvedDir` is `<install dir>/package.json`, which is also how the panel's
 * `parentOf` and the pipeline's `checkoutRootOf` read it.
 * @param {string|null} resolvedDir - the resolved manifest path.
 * @returns {string|null} the directory, or null.
 */
export function installDirOf(resolvedDir) {
  const path = str(resolvedDir)
  if (path === null) return null
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? null : trimmed.slice(0, cut)
}

/**
 * The install directory of a dependency inside a profile, when no manifest path
 * was resolved.
 * @param {string|null} profileDir - the profile directory.
 * @param {string|null} name - the package name.
 * @returns {string|null} the directory, or null.
 */
export function installDirIn(profileDir, name) {
  const base = str(profileDir)
  const packageName = str(name)
  if (base === null || packageName === null) return null
  return joinPath(joinPath(base, 'node_modules'), packageName)
}
