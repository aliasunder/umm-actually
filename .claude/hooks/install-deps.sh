#!/usr/bin/env bash
# Ensures the current checkout's dependencies are installed. Registered on
# SessionStart and on PostToolUse for EnterWorktree, because fresh cloud clones
# and fresh git worktrees start without node_modules.
set -euo pipefail

# Logs go to stderr because SessionStart hook stdout enters the model's context.
log() { echo "[install-deps] $*" >&2; }

# A hook's non-interactive shell never sources .bashrc, so nvm must be loaded
# here; without it, npm can resolve to a system Node (cloud images ship
# Node 22 at /opt/node22). Sourcing nvm.sh activates the default alias.
# Cloud setup scripts run with HOME=/root, hence the second candidate.
for dir in "${HOME}/.nvm" /root/.nvm; do
  if [[ -s "${dir}/nvm.sh" ]]; then
    export NVM_DIR="${dir}"
    # shellcheck disable=SC1091
    . "${dir}/nvm.sh"
    break
  fi
done

# The payload cwd follows the session into a worktree; CLAUDE_PROJECT_DIR
# stays at the original project root, so it is only the fallback.
payload_cwd="$(node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).cwd??""))' 2>/dev/null || true)"
checkout="$(git -C "${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}" rev-parse --show-toplevel 2>/dev/null)" || {
  log "no git checkout resolved from '${payload_cwd:-<empty>}' — skipping"
  exit 0
}

# The marker, stamp, and lock all live in .claude/. A worktree entered from a
# commit that predates this hook has no .claude/, and every mkdir lock attempt
# would fail there as if another session held the lock.
mkdir -p "${checkout}/.claude"

# The marker survives an interrupted npm ci (a hook-timeout kill included), so
# a partial node_modules is retried instead of trusted. It lives outside
# node_modules because npm ci deletes that directory before installing.
marker="${checkout}/.claude/.install-deps-incomplete"

# The stamp records which package-lock.json the hook's own last install used,
# so a stamped checkout reinstalls after a pull changes the lockfile. An
# unstamped checkout (node_modules installed by the developer, not the hook)
# is trusted as-is — the hook must never wipe an install it does not own.
stamp="${checkout}/.claude/.install-deps-lockhash"
lockfile_hash="$(git -C "${checkout}" hash-object package-lock.json 2>/dev/null || true)"

if [[ -d "${checkout}/node_modules" && ! -f "${marker}" ]]; then
  stamped="$(cat "${stamp}" 2>/dev/null || true)"
  if [[ -z "${stamped}" || "${stamped}" == "${lockfile_hash}" ]]; then
    log "node_modules present in ${checkout} — nothing to do"
    exit 0
  fi
  log "package-lock.json changed since the hook's last install in ${checkout} — reinstalling"
fi

# mkdir is the portable atomic lock (flock is Linux-only). The lock records its
# owner's pid.
# - A live owner means a concurrent install is running, so this session waits
#   for it rather than race npm ci.
# - A dead owner (hook killed mid-install) is taken over immediately, so the
#   marker's retry is never blocked behind an orphaned lock.
lock="${checkout}/.claude/.install-deps.lock"
if mkdir "${lock}" 2>/dev/null; then
  echo "$$" > "${lock}/pid"
else
  owner="$(cat "${lock}/pid" 2>/dev/null || true)"

  # A live session writes its pid right after its mkdir. An empty pid file
  # means that write is still in flight, or its writer died between the two
  # steps. Without this re-read, two sessions starting together would treat
  # the in-flight lock as abandoned and both run npm ci.
  if [[ -z "${owner}" ]]; then
    sleep 1
    owner="$(cat "${lock}/pid" 2>/dev/null || true)"
  fi

  if [[ -n "${owner}" ]] && kill -0 "${owner}" 2>/dev/null; then
    # Waiting for the live install lets this session start with dependencies
    # instead of racing a tree npm ci is actively rewriting. The 480s bound
    # sits well inside the 600s hook timeout in settings.json.
    log "another session (pid ${owner}) is installing in ${checkout} — waiting for it"
    waited=0
    while kill -0 "${owner}" 2>/dev/null && ((waited < 480)); do
      sleep 5
      waited=$((waited + 5))
    done
    if [[ -d "${checkout}/node_modules" && ! -f "${marker}" ]]; then
      log "concurrent install finished in ${checkout} — nothing to do"
      exit 0
    fi
    if ((waited >= 480)); then
      log "concurrent install still running after ${waited}s in ${checkout} — skipping"
      exit 0
    fi
    log "concurrent installer (pid ${owner}) died without finishing in ${checkout}"
  fi

  # The claim token makes the takeover exclusive, because rm-then-mkdir alone
  # is not atomic. Without it, a second taker's rm could delete the first
  # taker's fresh lock and both would install. The claim records its taker's
  # pid so a killed takeover is reclaimed immediately. The age check covers
  # only a pidless claim, whose taker died between mkdir and the pid write.
  claim="${lock}.claim"
  claim_is_stale() {
    local claim_owner
    claim_owner="$(cat "${claim}/pid" 2>/dev/null || true)"
    if [[ -n "${claim_owner}" ]]; then
      ! kill -0 "${claim_owner}" 2>/dev/null
    else
      [[ -n "$(find "${claim}" -maxdepth 0 -mmin +1 2>/dev/null)" ]]
    fi
  }

  # The second mkdir attempt covers a stale claim this session just cleared —
  # mkdir stays the atomic arbiter both times, so two clearers still produce
  # exactly one taker.
  if ! mkdir "${claim}" 2>/dev/null; then
    if claim_is_stale; then
      log "clearing a stale takeover claim in ${checkout}"
      rm -rf "${claim}"
    fi
    if ! mkdir "${claim}" 2>/dev/null; then
      log "another session is taking over the stale lock in ${checkout} — skipping"
      exit 0
    fi
  fi
  echo "$$" > "${claim}/pid"

  # Holding the claim excludes every other taker, so the lock's owner is
  # re-read only now. A session that finished its own takeover after this one
  # first read the lock has released its claim and installs under a live pid.
  # Removing that lock would start a second npm ci in the same node_modules.
  owner="$(cat "${lock}/pid" 2>/dev/null || true)"
  if [[ -n "${owner}" ]] && kill -0 "${owner}" 2>/dev/null; then
    rm -rf "${claim}"
    log "another session (pid ${owner}) took over the install in ${checkout} — skipping"
    exit 0
  fi

  log "install lock owner (pid ${owner:-unknown}) is gone — taking over"
  rm -rf "${lock}"
  if ! mkdir "${lock}" 2>/dev/null; then
    rm -rf "${claim}"
    log "lost the lock to a newly arrived session — skipping"
    exit 0
  fi
  echo "$$" > "${lock}/pid"
  rm -rf "${claim}"
fi

owned_pid="$$"
cleanup() {
  # A hook killed while its npm ci keeps running leaves the lock in place. The
  # lock's pid targets the live npm process, and the takeover logic above
  # cleans up once npm exits.
  if [[ -n "${install_pid:-}" ]] && kill -0 "${install_pid}" 2>/dev/null; then
    return
  fi

  # After this hook's npm exits, a takeover may have replaced the lock.
  # Removing that lock would unlock a third session against the second's live
  # install, so only a lock this hook still owns is released.
  if [[ "$(cat "${lock}/pid" 2>/dev/null)" == "${owned_pid}" ]]; then
    rm -rf "${lock}"
  fi
}
trap cleanup EXIT

# A hook killed by timeout can leave the marker even though its orphaned npm ci
# finished the install. A tree that passes npm ls is complete, so this clears
# the marker and stamps the tree instead of rebuilding it. The check runs only
# while holding the lock, because an orphaned npm ci that is still writing
# holds the lock, and its half-written tree can pass npm ls.
if [[ -d "${checkout}/node_modules" && -f "${marker}" ]]; then
  if npm --prefix "${checkout}" ls --depth=0 >/dev/null 2>&1; then
    rm -f "${marker}"

    # The orphaned install was still the hook's own, so it is stamped like the
    # normal success path. Leaving it unstamped would disable the
    # lockfile-change guard for this checkout forever.
    if [[ -n "${lockfile_hash}" ]]; then
      printf '%s\n' "${lockfile_hash}" > "${stamp}"
    fi
    log "marker left by an interrupted hook but the dependency tree in ${checkout} is complete — clearing"
    exit 0
  fi
fi

cd "${checkout}"
touch "${marker}"

# Honor the checkout's .nvmrc when that Node is already installed; otherwise
# stay on the default alias — a hook must never download a Node version.
command -v nvm >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
log "installing dependencies in ${checkout} (node $(node --version 2>/dev/null || echo unknown))"

# npm's stdout goes to stderr too, because SessionStart hook stdout enters the
# model's context.
npm ci >&2 &
install_pid=$!

# The lock's liveness target becomes the npm process itself. If the hook shell
# is killed but its npm ci survives, the lock stays respected until the process
# actually mutating node_modules is gone.
echo "${install_pid}" > "${lock}/pid"
owned_pid="${install_pid}"

if wait "${install_pid}"; then
  rm -f "${marker}"
  if [[ -n "${lockfile_hash}" ]]; then
    printf '%s\n' "${lockfile_hash}" > "${stamp}"
  fi
  log "install complete"
else
  log "npm ci failed — the session continues without dependencies; the marker forces a retry next session"
fi
exit 0
