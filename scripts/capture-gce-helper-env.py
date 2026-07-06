import os
import pwd


def find_helper_pid():
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            cmdline = open(f"/proc/{name}/cmdline", "rb").read()
        except OSError:
            continue
        command = cmdline.replace(b"\0", b" ").decode("utf-8", "ignore")
        if "node app.js" in command:
            return name
    raise SystemExit("node app.js process not found")


pid = find_helper_pid()
data = open(f"/proc/{pid}/environ", "rb").read().replace(b"\0", b"\n")
target = "/tmp/ivucx-helper-current.env"
open(target, "wb").write(data)

uid = int(os.environ.get("SUDO_UID") or os.getuid())
gid = int(os.environ.get("SUDO_GID") or pwd.getpwuid(uid).pw_gid)
os.chown(target, uid, gid)
os.chmod(target, 0o600)
print("captured")
