"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {loadMigrations}=require("../src/db/migrationRunner");

const filename=path.join(__dirname,"../src/db/migrations/132_contacts_whatsapp_number_cross_sender.sql");
const migration=fs.readFileSync(filename,"utf8");

test("cross-sender contact lookup index is additive, versioned, and sender-safe",()=>{
  const plans=loadMigrations();
  const migration132=plans.find(x=>x.version===132);
  assert.ok(migration132,"forward-only migration 132 must be discoverable");
  assert.equal(migration132.filename,path.basename(filename));
  assert.match(migration,/CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_number_cross_sender/);
  assert.match(migration,/ON contacts \(whatsapp_number, id\)/);
  assert.match(migration,/INCLUDE \(whatsapp_sender_id\)/);
  assert.match(migration,/WHERE channel = 'whatsapp'/);
  assert.doesNotMatch(migration,/\b(?:DELETE FROM|TRUNCATE|UPDATE contacts|ALTER TABLE contacts|DROP INDEX|DROP TABLE|CREATE INDEX CONCURRENTLY)\b/i);
});

test("new index preserves cross-sender lookup results and is used on isolated CI PostgreSQL",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const {Client}=require("pg");
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema="bench_contact_number_"+process.pid+"_"+Date.now();
  await db.connect();
  let created=false;
  try {
    await db.query("CREATE SCHEMA "+schema);
    created=true;
    await db.query("SET search_path TO "+schema);
    await db.query(`CREATE TABLE contacts(
      id INTEGER PRIMARY KEY,channel TEXT NOT NULL,
      whatsapp_number TEXT,whatsapp_sender_id INTEGER
    )`);
    await db.query(`
      INSERT INTO contacts(id,channel,whatsapp_number,whatsapp_sender_id)
      SELECT i,'whatsapp','6000'||LPAD(i::text,8,'0'),CASE WHEN i%3=0 THEN NULL ELSE 1 END
      FROM generate_series(100,2800) AS i
    `);
    await db.query(`INSERT INTO contacts(id,channel,whatsapp_number,whatsapp_sender_id) VALUES
      (1,'whatsapp','60123456789',2),
      (2,'whatsapp','60123456789',NULL),
      (3,'whatsapp','60123456789',1),
      (4,'whatsapp','60123456789',3),
      (5,'facebook','60123456789',NULL),
      (6,'whatsapp','60123456780',NULL)`);
    await db.query("ANALYZE contacts");
    const lookup=`SELECT id FROM contacts WHERE id<>1 AND channel='whatsapp'
      AND whatsapp_number=ANY($1::text[])
      AND (whatsapp_sender_id IS NULL OR whatsapp_sender_id=ANY($2::integer[]))
      ORDER BY id`;
    const args=[["60123456789","60123456790"],[1]];
    const before=(await db.query(lookup,args)).rows.map(x=>x.id);
    assert.deepEqual(before,[2,3]);
    await db.query(migration);
    await db.query(migration); // repeatable migration in fresh CI schema
    const after=(await db.query(lookup,args)).rows.map(x=>x.id);
    assert.deepEqual(after,before,"index must never change recipient eligibility");
    await db.query("SET enable_seqscan=off");
    const explained=(await db.query(`EXPLAIN (FORMAT JSON)
       SELECT id FROM contacts WHERE channel='whatsapp'
       AND whatsapp_number=ANY(ARRAY['60123456789','60123456790']::text[])`)).rows[0]["QUERY PLAN"][0].Plan;
    const indexNames=[];
    function collect(n){if(n["Index Name"])indexNames.push(n["Index Name"]);
      for(const child of n.Plans||[])collect(child);}
    collect(explained);
    assert.ok(indexNames.includes("idx_contacts_whatsapp_number_cross_sender"),
      "PostgreSQL can use the new lookup index without changing the SQL predicate");
    await db.query("RESET enable_seqscan");
  }finally{
    await db.query("RESET enable_seqscan").catch(()=>{});
    await db.query("SET search_path TO public").catch(()=>{});
    if(created)await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
