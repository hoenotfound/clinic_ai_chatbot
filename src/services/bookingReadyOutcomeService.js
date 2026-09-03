const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");

const BOOKING_READY_REASON = "Booking ready: customer provided scheduling preferences; staff should confirm availability.";

module.exports = { BOOKING_READY_REASON };
