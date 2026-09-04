const test = require("node:test");
const assert = require("node:assert/strict");

const meta = require("../src/services/metaMessagingService");
const {
  createInboundMessageClaimService,
} = require("../src/services/inboundMessageClaimService");
const {
  recoverMetaResolutionJobs,
} = require("../src/services/inboundProcessingService");

test("message_edit webhooks become durable pre-ACK resolution placeholders", () => {
  const parsed = meta.parseIncomingMessages({
    object: "instagram",
    entry: [
      {
        id: "ig-business-1",
        messaging: [
          { message_edit: { mid: "ig-edit-mid-1", num_edit: 0 } },
        ],
      },
    ],
  });

  assert.deepEqual(parsed, [
    {
      id: "meta-edit:ig-edit-mid-1",
      from: "meta-edit:ig-edit-mid-1",
      channel: "instagram",
      metaResolutionOnly: true,
      metaMessageId: "ig-edit-mid-1",
      metaEntryId: "ig-business-1",
    },
  ]);
});

test("claim service stores unresolved message_edit without creating a fake contact/message", async () => {
  const calls = [];
  const service = createInboundMessageClaimService({
    contacts: {
      async getOrCreateContact() {
        throw new Error("should not create WhatsApp contact");
      },
      async getOrCreateChannelContact() {
        throw new Error("should not create social contact before sender is known");
      },
    },
    processing: {
      async storeMetaResolutionClaim(args) {
        calls.push(args);
        return { id: 91, status: "pending" };
      },
    },
  });

  const result = await service.storeIncomingMessage({
    id: "meta-edit:fb-mid-1",
    from: "meta-edit:fb-mid-1",
    channel: "facebook",
    metaResolutionOnly: true,
    metaMessageId: "fb-mid-1",
    metaEntryId: "page-1",
  });

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "facebook");
  assert.equal(calls[0].externalMessageId, "fb-mid-1");
  assert.equal(calls[0].entryId, "page-1");
});

test("resolved message_edit completes its resolution job after normal durable dedupe", async () => {
  const completed = [];
  const service = createInboundMessageClaimService({
    contacts: {
      async getOrCreateChannelContact(channel, externalId) {
        assert.equal(channel, "instagram");
        assert.equal(externalId, "igsid-1");
        return { id: 7, channel, external_id: externalId };
      },
    },
    processing: {
      async storeInboundClaim() {
        // Simulate a standard Instagram message webhook winning the race. The
        // message is already durable, so the resolution row can still finish.
        return null;
      },
      async markMetaResolutionCompleted(jobId) {
        completed.push(jobId);
        return { id: jobId, status: "completed" };
      },
    },
  });

  const result = await service.storeIncomingMessage({
    id: "ig-mid-duplicate",
    from: "igsid-1",
    channel: "instagram",
    text: "hello",
    mediaType: null,
    unsupportedType: null,
    metaResolutionJobId: 44,
  });

  assert.equal(result, null);
  assert.deepEqual(completed, [44]);
});

test("post-ACK resolver leases the durable message_edit job before Graph lookup", async (t) => {
  const originalFetch = global.fetch;
  const oldToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  const oldPageId = process.env.INSTAGRAM_PAGE_ID;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    else process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = oldToken;
    if (oldPageId === undefined) delete process.env.INSTAGRAM_PAGE_ID;
    else process.env.INSTAGRAM_PAGE_ID = oldPageId;
  });

  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = "ig-token";
  process.env.INSTAGRAM_PAGE_ID = "ig-page";

  const order = [];
  global.fetch = async (url) => {
    order.push("graph");
    assert.match(String(url), /ig-edit-mid-2/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        from: { id: "igsid-2" },
        message: "How much is HIFU?",
      }),
    };
  };

  const processing = {
    async getMetaResolutionByExternalId(channel, mid) {
      order.push("lookup");
      assert.equal(channel, "instagram");
      assert.equal(mid, "ig-edit-mid-2");
      return { id: 77, status: "pending" };
    },
    async claimMetaResolutionByExternalId(args) {
      order.push("claim");
      assert.equal(args.externalMessageId, "ig-edit-mid-2");
      return {
        id: 77,
        channel: "instagram",
        external_message_id: "ig-edit-mid-2",
        entry_id: "ig-business-2",
        status: "processing",
      };
    },
    async markMetaResolutionCompleted() {
      throw new Error("resolved customer message must complete only after normal durable store");
    },
    async markMetaResolutionFailed() {
      throw new Error("resolution should not fail");
    },
  };

  const resolved = await meta.resolveMessageEditEvents(
    {
      object: "instagram",
      entry: [
        {
          id: "ig-business-2",
          messaging: [{ message_edit: { mid: "ig-edit-mid-2" } }],
        },
      ],
    },
    { processing }
  );

  assert.deepEqual(order, ["lookup", "claim", "graph"]);
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0], {
    id: "ig-edit-mid-2",
    from: "igsid-2",
    channel: "instagram",
    profileName: null,
    text: "How much is HIFU?",
    mediaId: null,
    mediaUrl: null,
    mediaType: null,
    unsupportedType: null,
    metaResolutionJobId: 77,
  });
});

test("restart sweep resolves durable message_edit into the ordinary inbound pipeline", async () => {
  const stored = [];
  const resolutionJob = {
    id: 88,
    channel: "facebook",
    external_message_id: "fb-edit-mid-8",
    entry_id: "page-8",
    attempts: 1,
  };
  const repository = {
    async claimRecoverableMetaResolutions(options) {
      assert.equal(options.maxAttempts, 5);
      return [resolutionJob];
    },
    async markMetaResolutionCompleted() {
      throw new Error("resolved customer message should be completed by storeIncoming");
    },
    async markMetaResolutionFailed() {
      throw new Error("resolution should not fail");
    },
    async listExhaustedMetaResolutions() {
      return [];
    },
  };

  await recoverMetaResolutionJobs({
    repository,
    async resolveJob(job) {
      assert.equal(job.id, 88);
      return {
        id: "fb-edit-mid-8",
        from: "psid-8",
        channel: "facebook",
        text: "hello after restart",
        mediaType: null,
        unsupportedType: null,
        metaResolutionJobId: 88,
      };
    },
    async storeIncoming(incoming) {
      stored.push(incoming);
      return { savedInbound: { id: 501 } };
    },
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].metaResolutionJobId, 88);
});
