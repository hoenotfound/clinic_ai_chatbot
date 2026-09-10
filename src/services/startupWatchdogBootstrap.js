require("dotenv").config();

const { startStartupWatchdog } = require("../utils/startupWatchdog");

startStartupWatchdog();
