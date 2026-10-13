import shutil, os
p = "/opt/open-inspect/selfhost-sandbox/server.mjs"
bak = p + ".orig-20261013"
if not os.path.exists(bak):
    shutil.copy2(p, bak)
s = open(bak).read()  # always patch from the original
a = 'const CP_LOOPBACK = process.env.CONTROL_PLANE_LOOPBACK ?? "http://127.0.0.1:8787";'
assert a in s
s = s.replace(a, a + '''
// factory hardening (all opt-in; unset = the original behaviour):
//   SANDBOX_NETWORK      docker network for sandboxes instead of the host's
//   SANDBOX_CP_URL       control-plane URL as a sandbox reaches it there
//   SANDBOX_RUNTIME      container runtime, e.g. runsc (gVisor)
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || "host";
const SANDBOX_CP_URL = process.env.SANDBOX_CP_URL || CP_LOOPBACK;
const SANDBOX_RUNTIME = process.env.SANDBOX_RUNTIME || "";''', 1)
a = '  env.CONTROL_PLANE_URL = CP_LOOPBACK;'
assert s.count(a) == 1
s = s.replace(a, '  env.CONTROL_PLANE_URL = SANDBOX_CP_URL;')
a = '''    "--network", "host",
    "--cpus", "6", "--memory", "8g", "--pids-limit", "2048",
    "-w", "/workspace",
  ];'''
assert a in s
s = s.replace(a, '''    "--network", SANDBOX_NETWORK,
    "--cpus", "6", "--memory", "8g", "--pids-limit", "2048",
    "-w", "/workspace",
  ];
  if (SANDBOX_NETWORK !== "host") {
    // off the host network: no privilege escalation, no raw sockets/devices
    args.push("--security-opt", "no-new-privileges:true",
      "--cap-drop", "NET_RAW", "--cap-drop", "MKNOD", "--cap-drop", "SYS_CHROOT",
      "--cap-drop", "AUDIT_WRITE", "--cap-drop", "SETFCAP");
  }
  if (SANDBOX_RUNTIME) args.push("--runtime", SANDBOX_RUNTIME);''')
a = 'log("listening", { port: PORT, address, image: IMAGE, cp: CP_LOOPBACK })'
assert a in s
s = s.replace(a, 'log("listening", { port: PORT, address, image: IMAGE, cp: CP_LOOPBACK, sandbox_network: SANDBOX_NETWORK, sandbox_cp: SANDBOX_CP_URL, runtime: SANDBOX_RUNTIME || "runc" })')
open(p, "w").write(s)
print("patched")
