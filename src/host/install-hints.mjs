/**
 * What to tell a user who does not have a tool the update needs.
 *
 * ## Why this is a host-side fact and not panel copy
 *
 * The panel speaks 中文 and English; the install instruction does not translate.
 * `winget install --id Git.Git` is the same string in every locale, and a
 * translated COMMAND is a command that no longer works. So the host answers with
 * the command, a URL, and the platform it read them from, and the panel supplies
 * only the sentences around them.
 *
 * ## What this deliberately does not do
 *
 * Nothing here installs anything. The plugin is a plugin: it must not run a
 * package manager on the user's machine behind one click, and it cannot — the
 * `dsh web` host has no consent flow for that. The reminder is a reminder, the
 * button opens the page the platform's own instructions live on, and the command
 * is offered as text the user can copy and read before running it.
 *
 * ## Platforms
 *
 * `process.platform` is the primary key; Linux is then refined by the distro id
 * from os-release, because "install git" on Debian and on Arch are different
 * commands and a generic one would be wrong on both. A platform this file has
 * never heard of still gets the official download URL rather than nothing.
 *
 * R1 applies: only `node:` imports, no dependencies.
 */

/** The official page whose install instructions this module defers to. */
const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads'

/** Per-platform installer pages. The OS-specific page is the better landing. */
const GIT_PLATFORM_URLS = {
  win32: 'https://git-scm.com/download/win',
  darwin: 'https://git-scm.com/download/mac',
  linux: 'https://git-scm.com/download/linux',
}

/** Tools this module knows how to name. */
const TOOL_LABELS = {
  git: 'git',
  dsh: 'dsh',
}

/**
 * The distro's own package manager, from the `ID` and `ID_LIKE` fields of
 * os-release.
 *
 * `ID_LIKE` is what makes this work on the derivatives: Linux Mint reports
 * `ID=linuxmint`, and only `ID_LIKE=ubuntu debian` says that `apt-get` is the
 * answer. Reading only `ID` would fall through to the source-build page for
 * every distro that is not on a short list.
 *
 * @param {string|null} osRelease - the text of `/etc/os-release`, or null.
 * @returns {{ command: string, id: string }|null} the command and the id it came from.
 */
export function linuxInstallCommand(osRelease) {
  if (typeof osRelease !== 'string' || osRelease.length === 0) return null

  const fields = new Map()
  for (const line of osRelease.split('\n')) {
    const match = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    // Values are shell-quoted in the real file (`ID="ubuntu"`), and a value can
    // contain `#`, so the quotes are stripped rather than the line split on it.
    fields.set(match[1], match[2].trim().replace(/^"(.*)"$/, '$1').trim())
  }

  const id = (fields.get('ID') ?? '').toLowerCase()
  const like = (fields.get('ID_LIKE') ?? '').toLowerCase()
  const keys = [id, ...like.split(/\s+/)].filter((value) => value.length > 0)

  // Order matters: the first family that matches wins, so a distro that is
  // `ID=pop` with `ID_LIKE="ubuntu debian"` gets apt.
  const families = [
    { ids: ['debian', 'ubuntu', 'raspbian', 'linuxmint', 'pop'], command: 'sudo apt-get update && sudo apt-get install -y git' },
    { ids: ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'], command: 'sudo dnf install -y git' },
    { ids: ['opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'sles'], command: 'sudo zypper install -y git' },
    { ids: ['arch', 'manjaro', 'endeavouros'], command: 'sudo pacman -S --noconfirm git' },
    { ids: ['alpine'], command: 'sudo apk add git' },
    { ids: ['void'], command: 'sudo xbps-install -y git' },
  ]

  for (const family of families) {
    for (const key of keys) {
      if (family.ids.includes(key)) return { command: family.command, id: key }
    }
  }
  return null
}

/**
 * The reminder for one missing tool, or null when there is nothing to suggest.
 *
 * @param {string} tool - `'git'` today; anything else returns null rather than a guess.
 * @param {object} [options] - `platform` (defaults to `process.platform`) and
 *   `osRelease` (the text of `/etc/os-release`, read by the caller so this stays
 *   a pure function the tests can pin).
 * @returns {{ tool: string, platform: string, distro: string|null, command: string|null, url: string, note: string|null }|null} the hint.
 */
export function toolInstallHint(tool, options = {}) {
  const name = TOOL_LABELS[tool]
  if (name === undefined) return null

  const platform = typeof options.platform === 'string' && options.platform.length > 0 ? options.platform : null
  if (platform === null) return null

  const url = GIT_PLATFORM_URLS[platform] ?? GIT_DOWNLOAD_URL

  if (platform === 'win32') {
    return {
      tool: name,
      platform,
      distro: null,
      command: 'winget install --id Git.Git -e --source winget',
      url,
      note: 'winget ships with Windows 10 1809 and later; the download page has the installer for anything older',
    }
  }

  if (platform === 'darwin') {
    return {
      tool: name,
      platform,
      distro: null,
      command: 'xcode-select --install',
      url,
      note: 'this opens Apple’s own installer for the command line tools, which include git; Homebrew users can run brew install git instead',
    }
  }

  if (platform === 'linux') {
    const found = linuxInstallCommand(options.osRelease ?? null)
    return {
      tool: name,
      platform,
      distro: found === null ? null : found.id,
      // NO command rather than a wrong one: an unreadable os-release on an
      // unknown distribution means the honest answer is the platform's own page.
      command: found === null ? null : found.command,
      url,
      note:
        found === null
          ? 'this distribution could not be identified from /etc/os-release, so the page below lists the command for each one'
          : `read from /etc/os-release: this is a ${found.id} system`,
    }
  }

  // A platform this file has never seen: the official page, and no invented
  // command for an OS nobody here has tested.
  return { tool: name, platform, distro: null, command: null, url: GIT_DOWNLOAD_URL, note: null }
}
