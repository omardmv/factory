// Read-only database access for a project's working agent (projects.json "readDb").
// Pure: the caller injects the secret reader. The real protection is the database role the
// box owner creates (SELECT only, ideally on a replica); the session is also opened read-only as
// a second layer. Off unless a project configures it; reviewers and the QA tester never get it.
//   "shop": { ..., "readDb": { "host": "db.internal", "port": 5432, "name": "shop", "user": "agent_ro", "passwordFile": "shop-readdb-password", "sslmode": "require" } }
export const ENV_KEYS = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGOPTIONS', 'FACTORY_READ_DB'];
const KNOWN = new Set(['host', 'port', 'name', 'user', 'passwordFile', 'sslmode']);
const SSLMODES = ['require', 'verify-ca', 'verify-full'];
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // a name inside the secrets folder, never a path
// roles whose name says they can write: refused, so a wrong role is caught before an agent gets it
const WRITE_ROLE = /(^|[_.-])(admin|owner|root|superuser|postgres|write|writer|rw|master)([_.-]|$)/i;

// -> { ok: true, cfg } | { ok: false, error } | null (not configured)
export function readDbConfig(project) {
  const c = project && typeof project === 'object' ? project.readDb : undefined;
  if (c === undefined || c === null || c === false) return null;
  if (typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'readDb must be an object' };
  for (const k of Object.keys(c)) if (!KNOWN.has(k)) return { ok: false, error: `readDb.${k} is not allowed (read-only access has no such setting)` };
  const port = c.port === undefined ? 5432 : Number(c.port);
  if (!HOST.test(String(c.host ?? ''))) return { ok: false, error: 'readDb.host is required (a hostname)' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'readDb.port must be 1-65535' };
  if (!IDENT.test(String(c.name ?? ''))) return { ok: false, error: 'readDb.name is required' };
  if (!IDENT.test(String(c.user ?? ''))) return { ok: false, error: 'readDb.user is required' };
  if (WRITE_ROLE.test(c.user)) return { ok: false, error: `readDb.user "${c.user}" looks like a role that can write; use a SELECT-only role` };
  if (!FILE.test(String(c.passwordFile ?? ''))) return { ok: false, error: 'readDb.passwordFile must be a file name in the secrets folder' };
  const sslmode = c.sslmode ?? 'require';
  if (!SSLMODES.includes(sslmode)) return { ok: false, error: `readDb.sslmode must be one of ${SSLMODES.join(', ')}` };
  return { ok: true, cfg: { host: c.host, port, name: c.name, user: c.user, passwordFile: c.passwordFile, sslmode } };
}

// the container env for a working agent; {} when off or invalid (fails closed). readSecret(name) -> string
export function readDbEnv(project, readSecret) {
  const r = readDbConfig(project);
  if (!r?.ok) return {};
  let password;
  try { password = readSecret(r.cfg.passwordFile); } catch { return {}; }
  if (!password) return {};
  return {
    PGHOST: r.cfg.host, PGPORT: String(r.cfg.port), PGDATABASE: r.cfg.name, PGUSER: r.cfg.user, PGPASSWORD: password,
    PGSSLMODE: r.cfg.sslmode, PGOPTIONS: '-c default_transaction_read_only=on', FACTORY_READ_DB: '1',
  };
}

// the line added to the working agent's rules; '' when off
export const readDbRules = (env) => env?.FACTORY_READ_DB
  ? `\nREAD-ONLY DATABASE: the project's database is reachable with psql (PGHOST, PGDATABASE, PGUSER and PGPASSWORD are set, so plain \`psql\` works). The role can only read: use it to look at real data and schemas, never to change anything. Never print the password or put it in a file, commit, PR or message. Do not point tests or migrations at it.`
  : '';

// mask the password wherever it shows up in text the factory stores or posts
export const redact = (text, env) => {
  const p = env?.PGPASSWORD;
  return p && p.length >= 4 ? String(text ?? '').split(p).join('[redacted]') : String(text ?? '');
};
