const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const {
  createBookingReadyOutcomeService,
} = require("../src/services/bookingReadyOutcomeService");
const telegramImmediateAlertRepo = require("../src/db/telegramImmediateAlertRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "Booking Ready waits on the Telegram contact lock before touching the contact row",
  { skip: !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 4 });
    const schemaName = `booking_deadlock_${process.pid}_${Date.now()}`;
    const setup = await pool.connect();
    let blocker = null;
    let staff = null;
    let lockHeld = false;
    let bookingPromise = null;

    try {
      await setup.query(`CREATE SCHEMA ${schemaName}`);
      await setup.query(`SET search_path TO ${schemaName}`);
      await setup.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          mode TEXT NOT NULL,
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE leads (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL,
          is_closed BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          temperature TEXT,
          temperature_locked BOOLEAN NOT NULL DEFAULT false,
          branch_name TEXT,
          treatment_interest TEXT,
          temperature_source TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE lead_activities (
          id SERIAL PRIMARY KEY,
          lead_id INTEGER NOT NULL,
          activity_type TEXT NOT NULL,
          description TEXT,
          actor TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        INSERT INTO contacts (id, mode) VALUES (42, 'ai');
        INSERT INTO leads (
          id, contact_id, temperature, temperature_locked
        ) VALUES (9, 42, 'warm', false);
      `);

      blocker = await pool.connect();
      staff = await pool.connect();
      await blocker.query(`SET search_path TO ${schemaName}`);
      await staff.query(`SET search_path TO ${schemaName}`);

      await blocker.query(
        "SELECT pg_advisory_lock($1::integer, $2::integer)",
        [telegramImmediateAlertRepo.HUMAN_ALERT_LOCK_NAMESPACE, 42]
      );
      lockHeld = true;

      let lockAttempted;
      const lockAttempt = new Promise((resolve) => {
        lockAttempted = resolve;
      });

      const database = {
        async connect() {
          const client = await pool.connect();
          await client.query(`SET search_path TO ${schemaName}`);
          return client;
        },
      };

      let alertCalls = 0;
      const markBookingReady = createBookingReadyOutcomeService({
        database,
        publish() {},
        async sendBookingReadyAlert() {
          alertCalls += 1;
          return { status: "queued", alertId: 1 };
        },
        async lockContactAlertQueue(contactId, query) {
          lockAttempted();
          return telegramImmediateAlertRepo.lockContactAlertQueue(contactId, query);
        },
      });

      bookingPromise = markBookingReady(42, 777);
      await lockAttempt;

      // Give Postgres a moment to put the Booking Ready session behind the held
      // advisory lock. It must not own the contact row while it is waiting.
      await new Promise((resolve) => setTimeout(resolve, 50));

      await staff.query("SET lock_timeout = '300ms'");
      const takeover = await staff.query(
        `UPDATE contacts
         SET mode = 'human', updated_at = now()
         WHERE id = 42
         RETURNING mode`
      );
      assert.equal(takeover.rows[0]?.mode, "human");

      await blocker.query(
        "SELECT pg_advisory_unlock($1::integer, $2::integer)",
        [telegramImmediateAlertRepo.HUMAN_ALERT_LOCK_NAMESPACE, 42]
      );
      lockHeld = false;

      const outcome = await bookingPromise;
      assert.equal(outcome.contactUpdated, false);
      assert.equal(outcome.leadChanged, false);
      assert.equal(alertCalls, 0);

      const finalContact = await staff.query(
        "SELECT mode, needs_attention FROM contacts WHERE id = 42"
      );
      assert.deepEqual(finalContact.rows[0], {
        mode: "human",
        needs_attention: false,
      });
    } finally {
      if (lockHeld && blocker) {
        await blocker.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer)",
          [telegramImmediateAlertRepo.HUMAN_ALERT_LOCK_NAMESPACE, 42]
        ).catch(() => {});
      }
      if (bookingPromise) {
        await bookingPromise.catch(() => {});
      }
      blocker?.release();
      staff?.release();
      await setup.query("SET search_path TO public").catch(() => {});
      await setup.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      setup.release();
      await pool.end();
    }
  }
);
