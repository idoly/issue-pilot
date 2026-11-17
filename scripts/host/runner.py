#!/usr/bin/env python3
"""Manage only this Issue Pilot installation; never register a service or kill by port.

Paths and the listener come from the checkout's root configuration. The script never writes to the
application data directory; PID, lock and rotated logs stay in the private host state directory.
"""
import argparse
import fcntl
import json
import os
import pathlib
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request

os.umask(0o077)
home = pathlib.Path.home()
state_home = pathlib.Path(os.environ.get("XDG_STATE_HOME") or home / ".local/state")
if not state_home.is_absolute():
    raise SystemExit("XDG_STATE_HOME must be an absolute path.")
control = state_home / "issue-pilot-host"
control.mkdir(parents=True, exist_ok=True, mode=0o700)
control_info = control.lstat()
if not stat.S_ISDIR(control_info.st_mode) or control_info.st_uid != os.getuid() or (control_info.st_mode & 0o777) != 0o700:
    raise SystemExit(f"Host state directory must be a private 0700 directory owned by this user: {control}")
pidfile = control / "process.json"
logfile = control / "application.log"
operation_lock = control / "operation.lock"
launch_history = control / "launches.json"
launch_window_seconds = 24 * 60 * 60
max_launch_records = 1000  # More than any supported health-probe threshold.
# Rotated logs are application.<UTC time>.log. Keeping several means a failed retry cannot overwrite
# the log of the last run that actually became healthy.
kept_logs = 5

parser = argparse.ArgumentParser(description="Start, stop or inspect the Issue Pilot host process.")
parser.add_argument("action", nargs="?", default="restart", choices=["start", "restart", "stop", "status", "config"])
parser.add_argument("--root", help="application checkout (default: the repository containing this script)")
parser.add_argument("--node", default=os.environ.get("ISSUE_PILOT_NODE", "/usr/local/node/bin/node"),
                    help="Node executable (default: $ISSUE_PILOT_NODE or /usr/local/node/bin/node)")
parser.add_argument("--revision", help="expected git revision; start refuses a different checkout")
parser.add_argument("--lock-fd", type=int, help=argparse.SUPPRESS)
options = parser.parse_args()

root = pathlib.Path(options.root).resolve() if options.root else pathlib.Path(__file__).resolve().parents[2]
node = options.node
command = [node, "--experimental-strip-types", "src/http/production.ts"]
if not (root / "src/http/production.ts").is_file():
    raise SystemExit(f"{root} is not an Issue Pilot checkout; pass --root.")
if os.getuid() != home.stat().st_uid or os.getuid() == 0:
    raise SystemExit("Run as the account that owns the home directory, without sudo.")

if options.action in ("start", "stop", "restart"):
    try:
        if options.lock_fd is None:
            lock = operation_lock.open("a")
            lock_fd = lock.fileno()
        else:
            lock_fd = options.lock_fd
            if not os.path.samestat(os.fstat(lock_fd), operation_lock.stat()):
                raise SystemExit("Release lock descriptor does not match this installation.")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another start/stop operation is still running.")

# The repository root configuration owns the data location, database name, listener and Web build path.
config_script = '''const { applicationConfig: c } = await import("./src/config.ts");
console.log(JSON.stringify({ stateRoot: c.stateRoot, databaseFile: c.databaseFile, host: c.http.host, port: c.http.port, webRoot: c.webRoot }));'''


def base_url(config):
    host = config["healthHost"]
    return f"http://{'[' + host + ']' if ':' in host else host}:{config['port']}"


def load_config():
    if not os.access(node, os.X_OK):
        raise RuntimeError(f"Node binary is missing or not executable: {node}")
    try:
        result = subprocess.run([node, "--experimental-strip-types", "--input-type=module", "-e", config_script],
                                cwd=root, env={"PATH": "/usr/bin:/bin", "HOME": str(home)}, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=60, check=True)
        config = json.loads(result.stdout.strip().splitlines()[-1])
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Cannot read root configuration in {root}: {error.stderr.strip()[-2000:]}") from error
    except (subprocess.TimeoutExpired, IndexError, ValueError) as error:
        raise RuntimeError(f"Cannot read root configuration in {root}: {error}") from error
    fields = {"stateRoot": str, "databaseFile": str, "host": str, "port": int, "webRoot": str}
    if not isinstance(config, dict) or any(type(config.get(key)) is not kind for key, kind in fields.items()):
        raise RuntimeError("Root configuration lacks stateRoot, databaseFile, http host/port or webRoot.")
    if not all(os.path.isabs(config[key]) for key in ["stateRoot", "databaseFile", "webRoot"]):
        raise RuntimeError("Root configuration paths are not absolute.")
    # Health is always probed on this host; a wildcard listener is reached through loopback.
    config["healthHost"] = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(config["host"], config["host"])
    config["baseUrl"] = base_url(config)
    return config


def git_revision():
    try:
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=30, check=True,
                                env={"PATH": "/usr/bin:/bin", "HOME": str(home)})
        return result.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def expected_revision():
    head = git_revision()
    if options.revision is None:
        return head
    if head is None:
        raise RuntimeError("Cannot verify the checkout revision; git is unavailable.")
    if head != options.revision:
        raise RuntimeError(f"Checkout revision {head} does not match the expected {options.revision}.")
    return head


def proc(pid):
    try:
        raw = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        if raw[0] == "Z":
            return None
        return raw[19]
    except FileNotFoundError:
        return None


def read_record():
    if not pidfile.exists():
        return None
    saved = json.loads(pidfile.read_text())
    pid = saved["pid"]
    if not isinstance(pid, int) or pid <= 1:
        raise RuntimeError("Invalid PID record; inspect it before proceeding.")
    return saved


def current(saved=None):
    saved = read_record() if saved is None else saved
    if saved is None:
        return None
    pid = saved["pid"]
    if proc(pid) != saved["startTime"]:
        return None
    try:
        actual = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
        directory = pathlib.Path(f"/proc/{pid}/cwd").resolve(strict=True)
    except FileNotFoundError:
        if proc(pid) != saved["startTime"]:
            return None
        raise
    if actual != [a.encode() for a in command] or directory != root:
        raise RuntimeError("PID record does not match this application; refusing to signal.")
    return saved


def write_record(saved):
    temporary = pidfile.with_suffix(".tmp")
    temporary.write_text(json.dumps(saved) + "\n")
    temporary.replace(pidfile)


def healthy(config):
    try:
        with urllib.request.urlopen(base_url(config) + "/health", timeout=2) as response:
            return json.load(response) == {"ok": True}
    except (OSError, ValueError):
        return False


def group_busy(group):
    # Startup may still have Git children if Node exits before installing signal handlers.
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
            if fields[0] != "Z" and int(fields[2]) == group:
                return True
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return False


def stop():
    saved = read_record()
    if saved:
        running = current(saved)
        if running and "stopRequestedAt" in saved:
            # An earlier stop timed out after signalling this same process. The application ignores repeated
            # SIGTERM anyway; not resending keeps the original shutdown start visible.
            print(f"Stop already requested at {saved['stopRequestedAt']}; waiting without resending SIGTERM.", flush=True)
        elif running:
            # pidfd prevents a PID reused between the identity check and the signal receiving SIGTERM.
            try:
                fd = os.pidfd_open(saved["pid"])
            except ProcessLookupError:
                fd = None
            if fd is not None:
                try:
                    if proc(saved["pid"]) == saved["startTime"]:
                        signal.pidfd_send_signal(fd, signal.SIGTERM)
                        write_record({**saved, "stopRequestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                finally:
                    os.close(fd)
        deadline = time.monotonic() + 1800
        while proc(saved["pid"]) == saved["startTime"] or group_busy(saved["pid"]):
            if time.monotonic() >= deadline:
                raise RuntimeError("Graceful stop exceeded 1800s; process retained. Inspect tasks and logs; no SIGKILL sent.")
            time.sleep(1)
    pidfile.unlink(missing_ok=True)
    print("Stopped (no data removed).", flush=True)


def validate_installation(config):
    # Everything that does not need the port is checked before a restart stops the running service.
    data, database = pathlib.Path(config["stateRoot"]), pathlib.Path(config["databaseFile"])
    if not data.is_dir() or data.is_symlink() or not database.is_file() or database.is_symlink():
        raise RuntimeError(f"Expected migrated data directory or database is missing ({database}); refusing to create empty state.")
    if (root / ".issue-pilot").exists() or (root / ".issue-pilot").is_symlink():
        raise RuntimeError("Unexpected legacy state directory; inspect it before starting.")
    if not (pathlib.Path(config["webRoot"]) / "index.html").is_file() or not (root / "node_modules").is_dir():
        raise RuntimeError("Production dependencies or built Web assets are missing.")


def rotate_log():
    if logfile.exists():
        logfile.replace(control / time.strftime("application.%Y%m%dT%H%M%SZ.log", time.gmtime()))
    # Also bounds the single application.previous.log left by earlier runner versions.
    rotated = sorted(control.glob("application.*.log"), key=lambda path: path.stat().st_mtime)
    for old in rotated[:-kept_logs]:
        old.unlink(missing_ok=True)


def recent_launches(now):
    try:
        events = json.loads(launch_history.read_text())
    except FileNotFoundError:
        return []
    if not isinstance(events, list) or len(events) > max_launch_records or any(type(stamp) is not int for stamp in events):
        raise RuntimeError("Invalid host launch history; inspect it before proceeding.")
    return [stamp for stamp in events if now - launch_window_seconds < stamp <= now]


def record_launch():
    now = int(time.time())
    events = [*recent_launches(now), now][-max_launch_records:]
    temporary = launch_history.with_suffix(".tmp")
    temporary.write_text(json.dumps(events) + "\n")
    temporary.replace(launch_history)


try:
    if options.action == "config":
        print(json.dumps({**load_config(), "operationLock": str(operation_lock), "launches24h": len(recent_launches(int(time.time())))}, sort_keys=True))
    elif options.action == "status":
        saved = current()
        report = {"running": saved is not None, "pid": saved["pid"] if saved else None,
                  "stopping": bool(saved and "stopRequestedAt" in saved), "log": str(logfile),
                  "revision": saved.get("revision") if saved else None}
        try:
            config = load_config()
            report.update(healthy=healthy(config), baseUrl=base_url(config), data=config["stateRoot"])
        except RuntimeError as error:
            report.update(healthy=None, configError=str(error))
        print(json.dumps(report))
    elif options.action == "stop":
        stop()
    else:
        if options.action == "start" and current():
            if options.revision is not None:
                raise RuntimeError("Already running; cannot verify a new launch at the requested revision.")
            print("Already running. Use status or restart.", flush=True)
            sys.exit(0)
        config = load_config()
        revision = expected_revision()
        validate_installation(config)
        if options.action == "restart":
            stop()
        elif (saved := read_record()) and group_busy(saved["pid"]):
            raise RuntimeError("A previous process group is still active; drain it with stop before starting.")
        # Never adopt or stop a process merely because it serves the port. The old process holds it until stopped.
        with socket.socket(socket.AF_INET6 if ":" in config["host"] else socket.AF_INET) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((config["host"], config["port"]))
        env = {**os.environ, "HOME": str(home), "NODE_ENV": "production",
               "JAVA_HOME": "/usr/local/java", "MAVEN_HOME": "/usr/local/maven",
               "PATH": f"/usr/local/node/bin:/usr/local/java/bin:/usr/local/maven/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin"}
        # The API logs this value at startup so a crash can be tied to the exact checkout.
        if revision is not None:
            env["ISSUE_PILOT_REVISION"] = revision
        rotate_log()
        record_launch()
        with logfile.open("ab", buffering=0) as log:
            child = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        start_time = proc(child.pid)
        if start_time is None:
            raise RuntimeError(f"Application exited immediately; inspect {logfile}")
        saved = {"pid": child.pid, "startTime": start_time, "revision": revision}
        write_record(saved)
        print(f"Started PID {child.pid} at {revision or 'unknown revision'}; waiting up to 600s for health. Log: {logfile}", flush=True)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            if child.poll() is not None:
                if not group_busy(child.pid):
                    pidfile.unlink(missing_ok=True)
                raise RuntimeError(f"Application exited with status {child.returncode}; inspect {logfile}")
            if healthy(config) and current() == saved:
                print(f"Healthy: {base_url(config)}", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"Health timeout; process retained for inspection. Check {logfile} before retrying.")
except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
