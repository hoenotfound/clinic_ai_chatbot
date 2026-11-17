#!/usr/bin/env node
"use strict";
// Full copy only into an empty database. Never drops, truncates or cleans.
const fs = require("node:fs"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const {
  SOURCE_HOST,
  DESTINATION_HOST,
  connectionIdentity,
} = require("./neutroMigrationHold.cjs");
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
const progress = phase => { if(process.send)process.send({phase}); };
// PostgreSQL jsonb reorders object properties on archive round trips. Object
// order is not data; array order and every value must remain significant.
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const sha = (x) =>
  crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(x) || typeof x === "string" ? x : JSON.stringify(canonical(x)))
    .digest("hex");
function connection(raw, expected, database) {
  const id = connectionIdentity(raw);
  if (id.host !== expected || id.database !== "/neondb")
    throw Error("Connection identity mismatch");
  const u = new URL(raw);
  u.hostname = expected;
  if (database) u.pathname = "/" + database;
  u.searchParams.set("sslmode", "verify-full");
  return u;
}
function targetName(name, env) {
  if (/^neutro_rehearsal_[0-9]{8}$/.test(name)) return name;
  if (
    name === "neondb" &&
    env.NEUTRO_FINAL_COPY_APPROVED === "20261116" &&
    env.NEUTRO_OLD_INSTANCE_RETIRED === "confirmed"
  )
    return name;
  throw Error(
    "Target requires a rehearsal name or explicit final-copy and retirement confirmations",
  );
}
function pgEnv(u, readonly) {
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGDATABASE: u.pathname.slice(1),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    PGCHANNELBINDING: "require",
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "neutro_migration_copy",
    PGOPTIONS: readonly
      ? "-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=5000"
      : "-c statement_timeout=300000 -c lock_timeout=5000",
  };
}
function command(name, args, env, dir) {
  return new Promise((resolve, reject) => {
    const p = cp.spawn(name, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.once("error", () => reject(Error(name + " unavailable")));
    p.once("exit", (code) => {
      if (code) {
        fs.writeFileSync(dir + "/" + name + "-error.log", err, { mode: 0o600 });
        reject(Error(name + " failed; private diagnostic retained"));
      } else resolve(out);
    });
  });
}
const schemaSQL = {
  schemas:
    "SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl::text acl FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY 1",
  tables:
    "SELECT c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.relacl::text acl,c.reloptions FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') ORDER BY 1",
  columns:
    "SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_schema,udt_name,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,collation_name,is_identity,identity_generation,identity_start,identity_increment,identity_maximum,identity_minimum,identity_cycle,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
  constraints:
    "SELECT c.relname table_name,x.conname,x.contype,x.condeferrable,x.condeferred,x.convalidated,pg_get_constraintdef(x.oid) definition FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid WHERE c.relnamespace='public'::regnamespace ORDER BY 1,2",
  indexes:
    "SELECT c.relname table_name,i.relname index_name,pg_get_indexdef(i.oid) definition,x.indisvalid,x.indisready FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid WHERE c.relnamespace='public'::regnamespace ORDER BY 1,2",
  triggers:
    "SELECT c.relname table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY 1,2",
  functions:
    "SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p') ORDER BY 1,2",
  views:
    "SELECT c.relname,pg_get_viewdef(c.oid) definition FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m') ORDER BY 1",
  extensions:
    "SELECT extname,extversion,n.nspname schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1",
  sequences:
    "SELECT schemaname,sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' ORDER BY 1,2",
  sequence_ownership:
    "SELECT s.relname sequence_name,t.relname table_name,a.attname column_name,d.deptype FROM pg_depend d JOIN pg_class s ON s.oid=d.objid AND s.relkind='S' JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') AND s.relnamespace='public'::regnamespace ORDER BY 1",
  policies:
    "SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,2,3",
  defaults:
    "SELECT pg_get_userbyid(defaclrole) owner,CASE WHEN defaclnamespace=0 THEN '' ELSE defaclnamespace::regnamespace::text END schema,defaclobjtype,defaclacl::text acl FROM pg_default_acl ORDER BY 1,2,3",
  database:
    "SELECT pg_get_userbyid(datdba) owner,pg_encoding_to_char(encoding) encoding,datcollate,datctype,datlocprovider,datacl::text acl FROM pg_database WHERE datname=current_database()",
  settings:
    "SELECT CASE WHEN setrole=0 THEN 'all' ELSE pg_get_userbyid(setrole) END role,setconfig FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY 1",
};
function comparable(key, rows) {
  return rows.map((row) => {
    const x = { ...row };
    if (
      key === "tables" &&
      ["pg_stat_statements", "pg_stat_statements_info"].includes(x.relname) &&
      x.owner === "cloud_admin"
    )
      delete x.acl;
    if (
      key === "defaults" &&
      x.owner === "cloud_admin" &&
      x.schema === "public" &&
      x.defaclobjtype === "r"
    )
      delete x.acl;
    if (
      key === "constraints" &&
      x.table_name === "ai_usage_events" &&
      x.conname === "ai_usage_events_response_disposition_check"
    )
      x.definition = x.definition
        .replace(/::character varying|::text\[\]|::text/g, "")
        .replace(/[()\s]/g, "");
    return x;
  });
}
async function connect(u) {
  const { Client } = require("pg");
  const c = new Client({
    connectionString: u.toString(),
    application_name: "neutro_migration_copy",
    connectionTimeoutMillis: 15000,
    query_timeout: 300000,
  });
  await c.connect();
  await c.query("SET TIME ZONE 'UTC'");
  return c;
}
async function manifest(c) {
  const m = { schema: {}, tables: [], largeObjects: [] };
  for (const [key, sql] of Object.entries(schemaSQL))
    m.schema[key] = (await c.query(sql)).rows;
  if (m.schema.schemas.some((s) => s.nspname !== "public"))
    throw Error("Unexpected user schema; extend review before copying");
  const names = (
    await c.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY 1",
    )
  ).rows;
  // One request preserves the same per-table digest while avoiding one
  // Singapore network round trip for each of 115 tables.
  if(names.length)m.tables=(await c.query(names.map(({relname:name},i)=>
    `SELECT $${i+1}::text name,count(*)::text rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) digest FROM ONLY public.${q(name)} t`
  ).join(' UNION ALL ')+' ORDER BY name',names.map(x=>x.relname))).rows;
  m.largeObjects = (
    await c.query(
      "SELECT loid,pageno,md5(data) digest FROM pg_largeobject ORDER BY loid,pageno",
    )
  ).rows;
  return m;
}
function differences(a, b) {
  const diff = [];
  for (const key of Object.keys(a.schema))
    if (
      sha(comparable(key, a.schema[key])) !==
      sha(comparable(key, b.schema[key]))
    )
      diff.push("schema:" + key);
  if (sha(a.tables) !== sha(b.tables)) diff.push("table-data");
  if (sha(a.largeObjects) !== sha(b.largeObjects)) diff.push("large-objects");
  return diff;
}
async function assertNoOtherClients(c) {
  const r = await c.query(
    "SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
  );
  if (r.rows[0].count)
    throw Error("Other source clients still connected; final copy blocked");
}
async function assertSequenceValues(c, sequences) {
  for (const sequence of sequences) {
    if (!/^public\.[a-zA-Z0-9_]+$/.test(sequence.relation))
      throw Error("Unexpected sequence identifier");
    const value = (await c.query("SELECT last_value::text,is_called FROM " + sequence.relation)).rows[0];
    if (!value || value.last_value !== sequence.value || value.is_called !== sequence.called)
      throw Error("Sequence changed after snapshot: " + sequence.relation);
  }
}
async function main() {
  const target = targetName(process.argv[2], process.env),
    final = target === "neondb";
  const src = connection(process.env.DATABASE_URL, SOURCE_HOST),
    dst = connection(process.env.MIGRATION_DEST_URL, DESTINATION_HOST, target);
  const started = Date.now();
  const dir = fs.mkdtempSync("/tmp/neutro-copy-");
  fs.chmodSync(dir, 0o700);
  const s = await connect(src);
  let expected, snapshot;
  try {
    await s.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (final) await assertNoOtherClients(s);
    snapshot = (await s.query("SELECT pg_export_snapshot() snapshot")).rows[0]
      .snapshot;
    await command(
      "pg_dump",
      [
        "--format=custom",
        "--snapshot=" + snapshot,
        "--lock-wait-timeout=5000",
        "--file=" + dir + "/source.dump",
      ],
      pgEnv(src, true),
      dir,
    );
    progress('source_dumped');
    expected = await manifest(s);
    progress('source_manifest_checked');
    await s.query("ROLLBACK");
  } finally {
    await s.end();
  }
  const payload = fs.readFileSync(dir + "/source.dump"),
    checksum = sha(payload);
  const toc = await command(
    "pg_restore",
    ["--list", dir + "/source.dump"],
    process.env,
    dir,
  );
  const omit = toc
    .split("\n")
    .filter((l) => l.includes(" DEFAULT ACL ") && l.endsWith("cloud_admin"));
  if (omit.length !== 2) throw Error("Unexpected managed ACL list");
  fs.writeFileSync(
    dir + "/toc.list",
    toc
      .split("\n")
      .filter((l) => !omit.includes(l))
      .join("\n"),
  );
  fs.writeFileSync(
    dir + "/seq.list",
    toc
      .split("\n")
      .filter((l) => l.includes(" SEQUENCE SET "))
      .join("\n"),
  );
  const sql = await command(
    "pg_restore",
    ["--use-list=" + dir + "/seq.list", "--file=-", dir + "/source.dump"],
    process.env,
    dir,
  );
  const seq = [
    ...sql.matchAll(
      /SELECT pg_catalog\.setval\('([^']+)', (-?\d+), (true|false)\);/g,
    ),
  ].map((m) => ({ relation: m[1], value: m[2], called: m[3] === "true" }));
  if (seq.length !== expected.schema.sequences.length)
    throw Error("Incomplete sequence capture");
  const d = await connect(dst);
  let actual;
  try {
    const n = (
      await d.query(
        "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','S','v','m','f')",
      )
    ).rows[0].n;
    if (n !== 0) throw Error("Target is not empty; nothing removed");
    progress('restore_started');
    await command(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--use-list=" + dir + "/toc.list",
        "--dbname=" + target,
        dir + "/source.dump",
      ],
      pgEnv(dst, false),
      dir,
    );
    progress('restore_finished');
    await d.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    actual = await manifest(d);
    progress('destination_manifest_checked');
    const diff = differences(expected, actual);
    for (const x of seq) {
      if (!/^public\.[a-zA-Z0-9_]+$/.test(x.relation))
        throw Error("Unexpected sequence identifier");
      const st = (
        await d.query("SELECT last_value::text,is_called FROM " + x.relation)
      ).rows[0];
      if (st.last_value !== x.value || st.is_called !== x.called)
        diff.push("sequence:" + x.relation);
    }
    for (const x of expected.schema.sequence_ownership) {
      const st = (
        await d.query(
          "SELECT last_value::text,is_called FROM public." + q(x.sequence_name),
        )
      ).rows[0];
      const def = expected.schema.sequences.find(
        (z) => z.sequencename === x.sequence_name,
      );
      const max = (
        await d.query(
          "SELECT max(" +
            q(x.column_name) +
            ")::text max FROM public." +
            q(x.table_name),
        )
      ).rows[0].max;
      if (
        max !== null &&
        BigInt(def.increment_by) > 0n &&
        BigInt(st.last_value) +
          (st.is_called ? BigInt(def.increment_by) : 0n) <=
          BigInt(max)
      )
        diff.push("unsafe-next-sequence:" + x.sequence_name);
    }
    await d.query("ROLLBACK");
    if (diff.length) throw Error("Verification mismatch: " + diff.join(","));
    progress('destination_sequences_checked');
  } finally {
    await d.end();
  }
  if (final) {
    const check = await connect(src);
    try {
      await check.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertNoOtherClients(check);
      if (differences(expected, await manifest(check)).length)
        throw Error("Source changed during final copy");
      // nextval is not transactional: identical table rows do not prove an
      // unused/reserved sequence value stayed unchanged during the copy.
      await assertSequenceValues(check, seq);
      await check.query("ROLLBACK");
    } finally {
      await check.end();
    }
  }
  const evidence = {
    sourceSnapshot: snapshot,
    createdAt: new Date().toISOString(),
    target,
    verified: true,
    elapsedMs: Date.now() - started,
    bytes: payload.length,
    sha256: checksum,
    tables: expected.tables.length,
    rows: expected.tables.reduce((n, t) => n + Number(t.rows), 0),
    sequences: seq.length,
    platformExceptions: [
      "Neon cloud_admin ACLs",
      "named response-disposition check cast formatting",
    ],
    sourceManifest: expected,
    destinationManifest: actual,
    sequenceValues: seq,
  };
  fs.writeFileSync(dir + "/verification.json", JSON.stringify(evidence), {
    mode: 0o600,
  });
  const backup = await connect(
    connection(
      process.env.MIGRATION_DEST_URL,
      DESTINATION_HOST,
      "neutro_backup_20261116",
    ),
  );
  try {
    await backup.query("BEGIN");
    const id = (final ? "final-" : "rehearsal-") + Date.now();
    await backup.query(
      "INSERT INTO migration_archive.production_dump (id,created_at,sha256,archive,source_manifest,backup_verification,destination_verification) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        evidence.createdAt,
        checksum,
        payload,
        { manifest: expected, sequences: seq },
        {
          passed: true,
          method:
            "existing prior backup retained; this archive verified by target restore",
        },
        evidence,
      ],
    );
    const stored = (
      await backup.query(
        "SELECT archive FROM migration_archive.production_dump WHERE id=$1",
        [id],
      )
    ).rows[0].archive;
    if (sha(stored) !== checksum)
      throw Error("Durable archive checksum mismatch");
    await backup.query("COMMIT");
    evidence.archiveId = id;
    progress('archive_verified');
  } finally {
    await backup.end();
  }
  console.log(
    JSON.stringify({
      ...evidence,
      sourceManifest: undefined,
      destinationManifest: undefined,
      sequenceValues: undefined,
      workdir: dir,
      cutoverPerformed: false,
    }),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(
      "COPY_STOPPED: " +
        String(e.message).replace(/postgres(?:ql)?:\/\/\S+/g, "[REDACTED]"),
    );
    process.exitCode = 1;
  });
module.exports = { targetName, connection, comparable, differences, assertSequenceValues, assertNoOtherClients, manifest };

