import assert from "node:assert/strict";

import { AtticCommittedSyncError, withAttic } from "prisma-extension-attic";

assert.equal(typeof withAttic, "function");
assert.equal(new AtticCommittedSyncError("request-id").committed, true);
