"use strict";

const assert = require("node:assert/strict");
const { AtticCommittedSyncError, withAttic } = require("prisma-extension-attic");

assert.equal(typeof withAttic, "function");
assert.equal(new AtticCommittedSyncError("request-id").committed, true);
