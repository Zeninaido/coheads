// Trials only: the Coheads local service (approval page + prompt hook endpoint) as its own process, on demo data.
import { startApprovalPage } from './approvalPage';
import { withStore } from './runtime';

await withStore(async () => undefined); // seed the demo store before the first request
startApprovalPage(process.env.SB_USER ?? 'suzuki', e => process.stderr.write(String(e) + '\n'));
console.log('hook server ready');
setInterval(() => {}, 1 << 30);
