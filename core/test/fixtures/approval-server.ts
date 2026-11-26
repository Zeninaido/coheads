// Starts only the approval page, with the settings in the environment (SB_FOLDER, SB_DATA_DIR, SB_USER, SB_APPROVAL_PORT).
// Used by test/approvalPage.test.ts; it runs in its own process because the settings are read when modules load.
import { startApprovalPage } from '../../src/approvalPage';
import { LOCAL_USER } from '../../src/runtime';

startApprovalPage(LOCAL_USER, e => process.stderr.write(`${(e as Error)?.stack ?? e}\n`));
setInterval(() => {}, 1 << 30);
process.stdout.write('ready\n');
