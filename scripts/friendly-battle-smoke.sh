#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/friendly-battle-smoke.sh host
  scripts/friendly-battle-smoke.sh host local
  scripts/friendly-battle-smoke.sh guest <code>@<host>:<port>
  scripts/friendly-battle-smoke.sh lan-ip
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "${CLAUDE_PLUGIN_ROOT}/bin/run-friendly-battle-turn.sh" ]; then
    printf '%s\n' "${CLAUDE_PLUGIN_ROOT}"
    return 0
  fi

  local script_dir repo_root
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  repo_root="$(CDPATH= cd -- "${script_dir}/.." && pwd)"
  if [ -x "${repo_root}/bin/run-friendly-battle-turn.sh" ]; then
    printf '%s\n' "${repo_root}"
    return 0
  fi

  if [ -x "${HOME}/.claude/plugins/marketplaces/tkm/bin/run-friendly-battle-turn.sh" ]; then
    printf '%s\n' "${HOME}/.claude/plugins/marketplaces/tkm"
    return 0
  fi

  local cache_root candidate
  cache_root="${HOME}/.claude/plugins/cache/tkm/tkm"
  if [ -d "${cache_root}" ]; then
    candidate="$(find "${cache_root}" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort -V | tail -n 1 || true)"
    if [ -n "${candidate}" ] && [ -x "${candidate}/bin/run-friendly-battle-turn.sh" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  fi

  return 1
}

lan_ip() {
  local via_hostname
  via_hostname="$(
    hostname -I 2>/dev/null \
      | awk '{print $1}'
  )"
  if [ -n "${via_hostname}" ]; then
    printf '%s\n' "${via_hostname}"
    return 0
  fi

  node -e '
    const os = require("os");
    let nets;
    try {
      nets = os.networkInterfaces();
    } catch (error) {
      process.stderr.write(`failed to inspect network interfaces: ${error.message}\n`);
      process.exit(1);
    }
    for (const name of Object.keys(nets)) {
      for (const addr of nets[name] || []) {
        if (addr && addr.family === "IPv4" && !addr.internal) {
          process.stdout.write(addr.address);
          process.exit(0);
        }
      }
    }
    process.stderr.write("no non-loopback IPv4 address found\n");
    process.exit(1);
  '
}

detect_generation() {
  local config_root
  config_root="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
  CONFIG_ROOT="${config_root}" node -e '
    const fs = require("fs");
    const path = require("path");
    try {
      const file = path.join(process.env.CONFIG_ROOT, "tokenmon", "global-config.json");
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      process.stdout.write(json.active_generation || "gen1");
    } catch {
      process.stdout.write("gen1");
    }
  '
}

json_field() {
  local json_text="$1"
  local field="$2"
  JSON_INPUT="${json_text}" JSON_FIELD="${field}" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const value = data[process.env.JSON_FIELD];
    if (typeof value === "string" || typeof value === "number") {
      process.stdout.write(String(value));
      process.exit(0);
    }
    process.exit(1);
  '
}

find_session_record() {
  local generation="$1"
  local role="$2"
  local session_code="$3"
  local field="$4"
  local config_root sessions_dir

  config_root="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
  sessions_dir="${config_root}/tokenmon/${generation}/friendly-battle/sessions"
  [ -d "${sessions_dir}" ] || return 1

  SESSIONS_DIR="${sessions_dir}" ROLE="${role}" SESSION_CODE="${session_code}" FIELD="${field}" node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.env.SESSIONS_DIR;
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.role !== process.env.ROLE || data.sessionCode !== process.env.SESSION_CODE) continue;
        const field = process.env.FIELD;
        let value = data[field];
        if (field === "port") value = data.transport && data.transport.port;
        if (field === "sessionId") value = data.sessionId;
        if (value !== undefined && value !== null && value !== "") {
          process.stdout.write(String(value));
          process.exit(0);
        }
      } catch {}
    }
    process.exit(1);
  '
}

run_cli() {
  "${PLUGIN_ROOT}/bin/run-friendly-battle-turn.sh" "$@"
}

drive_one_turn() {
  local session_id="$1"
  local generation="$2"
  local battle_line action_line result_line

  battle_line="$(run_cli --wait-next-event --session "${session_id}" --generation "${generation}" --timeout-ms 60000)"
  printf '%s\n' "${battle_line}"

  action_line="$(run_cli --action move:1 --session "${session_id}" --generation "${generation}")"
  printf '%s\n' "${action_line}"

  result_line="$(run_cli --wait-next-event --session "${session_id}" --generation "${generation}" --timeout-ms 60000)"
  printf '%s\n' "${result_line}"
}

run_host() {
  local mode="${1:-}"
  local listen_host advertised_host session_code generation
  local init_output init_stdout init_stderr init_pid init_rc session_id port

  generation="$(detect_generation)"
  session_code="$(node -e 'process.stdout.write(require("crypto").randomBytes(3).toString("hex"))')"
  if [ "${mode}" = "local" ]; then
    listen_host="127.0.0.1"
    advertised_host="127.0.0.1"
  else
    listen_host="0.0.0.0"
    advertised_host="$(lan_ip)"
  fi

  init_stdout="$(mktemp)"
  init_stderr="$(mktemp)"
  run_cli \
    --init-host \
    --session-code "${session_code}" \
    --generation "${generation}" \
    --listen-host "${listen_host}" \
    --port 0 \
    --timeout-ms 300000 \
    --player-name Host \
    >"${init_stdout}" \
    2>"${init_stderr}" &
  init_pid=$!

  port=""
  while kill -0 "${init_pid}" 2>/dev/null; do
    port="$(awk '/^PORT: / { print $2; exit }' "${init_stderr}")"
    if [ -z "${port}" ]; then
      port="$(find_session_record "${generation}" host "${session_code}" port || true)"
    fi
    if [ -n "${port}" ]; then
      break
    fi
    sleep 0.1
  done

  # --init-host exits as soon as the detached daemon is ready, so the process
  # can die BEFORE the PORT line is flushed into init_stderr. Wait for the
  # child to fully exit so the stderr file is complete, then re-parse once
  # more before giving up.
  wait "${init_pid}" 2>/dev/null || true
  if [ -z "${port}" ]; then
    port="$(awk '/^PORT: / { print $2; exit }' "${init_stderr}")"
  fi
  if [ -z "${port}" ]; then
    port="$(find_session_record "${generation}" host "${session_code}" port || true)"
  fi

  if [ -z "${port}" ]; then
    cat "${init_stderr}" >&2
    rm -f "${init_stdout}" "${init_stderr}"
    die "failed to parse host port"
  fi

  printf 'MODE: %s\n' "${mode:-lan}"
  printf 'SESSION_CODE: %s\n' "${session_code}"
  printf 'HOST: %s\n' "${advertised_host}"
  printf 'PORT: %s\n' "${port}"
  printf 'JOIN: %s@%s:%s\n' "${session_code}" "${advertised_host}" "${port}"

  if ! wait "${init_pid}"; then
    init_rc=$?
    cat "${init_stderr}" >&2
    rm -f "${init_stdout}" "${init_stderr}"
    exit "${init_rc}"
  fi

  init_output="$(cat "${init_stdout}")"
  session_id="$(json_field "${init_output}" sessionId || true)"
  if [ -z "${session_id}" ]; then
    session_id="$(find_session_record "${generation}" host "${session_code}" sessionId || true)"
  fi
  [ -n "${session_id}" ] || die "failed to parse host sessionId"
  printf '%s\n' "${init_output}"
  rm -f "${init_stdout}" "${init_stderr}"

  drive_one_turn "${session_id}" "${generation}"
}

run_guest() {
  local target="${1:-}"
  local session_code host port generation init_output session_id

  [ -n "${target}" ] || die "guest requires <code>@<host>:<port>"
  case "${target}" in
    *@*:*)
      session_code="${target%%@*}"
      host="${target#*@}"
      port="${host##*:}"
      host="${host%:*}"
      ;;
    *)
      die "guest target must be <code>@<host>:<port>"
      ;;
  esac

  [ -n "${session_code}" ] || die "missing session code"
  [ -n "${host}" ] || die "missing host"
  [ -n "${port}" ] || die "missing port"

  generation="$(detect_generation)"
  init_output="$(
    run_cli \
      --init-join \
      --session-code "${session_code}" \
      --host "${host}" \
      --port "${port}" \
      --generation "${generation}" \
      --timeout-ms 30000 \
      --player-name Guest
  )"
  session_id="$(json_field "${init_output}" sessionId)" || die "failed to parse guest sessionId"

  printf 'JOIN: %s\n' "${target}"
  printf '%s\n' "${init_output}"

  drive_one_turn "${session_id}" "${generation}"
}

PLUGIN_ROOT="$(resolve_plugin_root)" || die "tkm plugin root not found"

subcommand="${1:-}"
case "${subcommand}" in
  host)
    shift
    if [ "$#" -gt 1 ]; then
      usage >&2
      exit 1
    fi
    run_host "${1:-}"
    ;;
  guest)
    shift
    if [ "$#" -ne 1 ]; then
      usage >&2
      exit 1
    fi
    run_guest "$1"
    ;;
  lan-ip)
    shift
    [ "$#" -eq 0 ] || {
      usage >&2
      exit 1
    }
    lan_ip
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
