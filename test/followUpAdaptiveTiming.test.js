const test = require("node:test");
const assert = require("node:assert/strict");
const { beforeExpiryDueSql } = require("../src/utils/followUpAdaptiveTiming");

const expression = beforeExpiryDueSql({
  inbound: "$1::timestamptz", previous: "$2::timestamptz",
  step: "$3::integer", offset: "$4::integer", gap: "$5::integer",
  quietHours: { enabled: true, start: "00:00", end: "07:00" },
  timeZone: "Asia/Kuala_Lumpur",
});

test("pre-expiry expression preserves minimum spacing and local quiet hours", () => {
  assert.match(expression, /interval '120 minutes'/);
  assert.match(expression, /interval '30 minutes'/);
  assert.match(expression, /Asia\/Kuala_Lumpur/);
});

test("real Postgres computes final testimonial times for pelvic scenarios", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL, ssl:false});
  async function due(inbound,prev,step=3,offset=120,gap=960) {
    const r = await pool.query(`SELECT ${expression} AS due_at`, [inbound,prev,step,offset,gap]);
    return r.rows[0].due_at.toISOString();
  }
  try {
    // Nominal 23:20 Malaysia time remains unchanged.
    assert.equal(await due("2026-10-07T17:20:00Z","2026-10-08T03:00:00Z"),"2026-10-08T15:20:00.000Z");
    // Nominal 05:03 and 05:09 are shifted to 23:30 before quiet hours.
    assert.equal(await due("2026-10-07T23:03:00Z","2026-10-08T05:04:00Z"),"2026-10-08T15:30:00.000Z");
    assert.equal(await due("2026-10-07T23:09:00Z","2026-10-08T05:09:00Z"),"2026-10-08T15:30:00.000Z");
    // Late Step 2 cannot violate the 2h gap to send during quiet hours.
    assert.equal(await due("2026-10-07T23:03:00Z","2026-10-08T15:00:00Z"),"2026-10-08T23:00:00.000Z");
    // Nonfinal pre-expiry steps retain the original due time and spacing.
    assert.equal(await due("2026-10-07T23:03:00Z","2026-10-08T05:00:00Z",2,120,360),"2026-10-08T21:03:00.000Z");
  } finally {await pool.end();}
});

test("disabled quiet hours leave the nominal 22-hour deadline",{
  skip: !process.env.TEST_DATABASE_URL,
},async()=>{
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  try {
    const sql=beforeExpiryDueSql({
      inbound:"$1::timestamptz",previous:"$2::timestamptz",step:"3",
      offset:"120",gap:"960",timeZone:"Asia/Kuala_Lumpur",
      quietHours:{enabled:false,start:"00:00",end:"07:00"},
    });
    const result=await pool.query(`SELECT ${sql} AS due_at`,["2026-10-07T23:03:00Z","2026-10-08T05:04:00Z"]);
    assert.equal(result.rows[0].due_at.toISOString(),"2026-10-08T21:03:00.000Z");
  } finally {await pool.end();}
});

test("20-hour final and its 5-minute pricing reminder fit before midnight quiet hours",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  try{
    const due=async(inbound,previous)=>{
      const result=await pool.query(`SELECT ${expression} AS due_at`,
        [inbound,previous,3,240,840]);
      return result.rows[0].due_at.toISOString();
    };
    const earlier=await due("2026-10-07T20:30:00Z","2026-10-08T02:30:00Z");
    assert.equal(earlier,"2026-10-08T15:30:00.000Z");
    assert.equal(new Date(new Date(earlier).getTime()+5*60000).toISOString(),
      "2026-10-08T15:35:00.000Z");

    // A very late second reminder cannot squeeze the final into quiet hours.
    assert.equal(await due("2026-10-07T20:30:00Z",
      "2026-10-08T14:30:00Z"),"2026-10-08T23:00:00.000Z");
  }finally{await pool.end();}
});

test("pricing due after midnight pulls a nominal 23:58 testimonial to 23:30",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  try{
    const withPricing=beforeExpiryDueSql({
      inbound:"$1::timestamptz",previous:"$2::timestamptz",
      step:"3",offset:"240",gap:"840",channel:"'whatsapp'",
      reservePricingMinutes:5,
      quietHours:{enabled:true,start:"00:00",end:"07:00"},
      timeZone:"Asia/Kuala_Lumpur",
    });
    const withoutPricing=beforeExpiryDueSql({
      inbound:"$1::timestamptz",previous:"$2::timestamptz",
      step:"3",offset:"240",gap:"840",
      quietHours:{enabled:true,start:"00:00",end:"07:00"},
      timeZone:"Asia/Kuala_Lumpur",
    });
    const params=["2026-10-07T19:58:00Z","2026-10-08T07:58:00Z"];
    const q=await pool.query(`SELECT ${withPricing} AS due_at`,params);
    assert.equal(q.rows[0].due_at.toISOString(),"2026-10-08T15:30:00.000Z");
    const baseline=await pool.query(`SELECT ${withoutPricing} AS due_at`,params);
    assert.equal(baseline.rows[0].due_at.toISOString(),"2026-10-08T15:58:00.000Z");

    const blocked=await pool.query(`SELECT ${withPricing} AS due_at`,[
      params[0],"2026-10-08T14:45:00Z",
    ]);
    assert.equal(blocked.rows[0].due_at.toISOString(),"2026-10-08T23:00:00.000Z");
  }finally{await pool.end();}
});

test("social pricing also reserves the 23:30 pre-quiet slot", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  try {
    for (const channel of ["'facebook'","'instagram'"]) {
      const expr = beforeExpiryDueSql({
        inbound:"$1::timestamptz",previous:"$2::timestamptz",
        step:"3",offset:"240",gap:"840",channel,
        reservePricingMinutes:5,
        reservePricingOnSocial:true,
        quietHours:{enabled:true,start:"00:00",end:"07:00"},
        timeZone:"Asia/Kuala_Lumpur",
      });
      const result = await pool.query(`SELECT ${expr} AS due_at`,
        ["2026-10-07T19:58:00Z","2026-10-08T07:58:00Z"]);
      assert.equal(result.rows[0].due_at.toISOString(),"2026-10-08T15:30:00.000Z");
    }
  } finally { await pool.end(); }
});
