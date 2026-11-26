// Approver-side CLI for the local demo. Approval lives here, never in the AI-facing tools.
//   bun run admin status
//   bun run admin propose --label 提案価格 --yen 130000 [--period monthly|yearly|one_time] [--tax excluded|included] [--from 2026-12-01] [--project a-sha] [--as sato]
//   bun run admin approve <id先頭8文字> [--as sato]
//   bun run admin reject <id先頭8文字> [--as sato]
//   bun run admin contact --project a-sha --name 田中 [--org 株式会社エー]
//   bun run admin log [--n 20]
//   bun run admin context "A社の提案価格は？" [--as suzuki] [--ceiling internal]
//   bun run admin reset
import { rmSync } from 'node:fs';
import { buildContextPack } from './contextPack';
import { approve, decisionsFor, propose, reject } from './ledger';
import { formatValue } from './normalize';
import { recentAccess } from './audit';
import { renderCopyText } from './renderers/copyText';
import { DATA_DIR, withStore } from './runtime';
import type { Classification } from './types';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else args.push(rest[i]);
}
const as = flags.as ?? 'sato';

async function resolveId(db: any, prefix: string): Promise<string> {
  const rows = await db.query('select id from decisions where id like $1', [prefix + '%']);
  if (rows.length !== 1) throw new Error(`IDが一意に決まりません: ${prefix}（${rows.length}件）`);
  return rows[0].id;
}

const label: Record<string, string> = { candidate: '候補', approved: '承認済み', on_hold: '保留', rejected: '却下', retired: '失効' };

async function main() {
  if (cmd === 'reset') {
    rmSync(DATA_DIR, { recursive: true, force: true });
    await withStore(async () => {});
    console.log('デモデータを初期状態に戻しました（12万円が11/24から現行）。');
    return;
  }
  await withStore(async (db, folder) => {
    if (cmd === 'status' || !cmd) {
      for (const p of ['a-sha', 'b-sha']) {
        const ds = await decisionsFor(db, p);
        if (!ds.length) continue;
        console.log(`\n[${p}]`);
        for (const d of ds) {
          const v = formatValue(d.value);
          console.log(`  ${d.id.slice(0, 8)}  ${label[d.status].padEnd(4, '　')}  ${d.label} ${v}  有効 ${d.validFrom ?? '-'} 〜 ${d.validTo ?? ''}`);
        }
      }
    } else if (cmd === 'propose') {
      const d = await propose(db, {
        projectId: flags.project ?? 'a-sha',
        topicKey: flags.topic ?? 'proposal.price',
        label: flags.label ?? '提案価格',
        value: flags.yen
          ? { type: 'money', amount: Number(flags.yen), currency: 'JPY', period: (flags.period ?? 'monthly') as any, tax: (flags.tax ?? 'excluded') as any }
          : { type: 'text', text: flags.text ?? '' },
        validFrom: flags.from,
        sources: flags.source ? [{ adapterId: 'admin', uri: flags.source }] : [],
        by: { type: 'user', id: as },
      });
      console.log(`候補を登録しました：${d.id.slice(0, 8)}`);
    } else if (cmd === 'approve') {
      const d = await approve(db, await resolveId(db, args[0]), as);
      console.log(`承認しました：${d.label} ${formatValue(d.value)}（${d.validFrom}から有効）`);
    } else if (cmd === 'reject') {
      await reject(db, await resolveId(db, args[0]), as);
      console.log('却下しました');
    } else if (cmd === 'contact') {
      // bun run admin contact --project a-sha --name 田中 [--org 株式会社エー]
      if (!flags.project || !flags.name) throw new Error('--project と --name を指定してください');
      await db.query('insert into project_contacts values ($1,$2,$3) on conflict (project_id, name) do update set organization = excluded.organization',
        [flags.project, flags.name, flags.org ?? null]);
      console.log(`関係者を登録しました：${flags.project} ${flags.name}`);
    } else if (cmd === 'log') {
      const rows = await recentAccess(db, Number(flags.n ?? 20));
      if (!rows.length) console.log('（記録なし）');
      for (const r of rows) {
        const at = new Date(r.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const ask = r.tool === 'server_start' ? '（サーバー起動）' : r.tool === 'get_document' ? r.request.id : r.tool === 'get_context' ? r.request.request : `${r.request.label} ${r.request.amount_yen ?? r.request.text ?? ''}`;
        console.log(`#${r.seq} ${at} ${r.user_id}（${r.destination}） ${r.tool}：${ask}`);
        console.log(`    案件=${r.project_id ?? '特定できず'} 返したもの=${JSON.stringify(r.returned)}`);
      }
    } else if (cmd === 'context') {
      const pack = await buildContextPack(db, [folder], {
        userId: flags.as ?? 'suzuki', query: args[0] ?? '',
        destination: { id: 'cli', ceiling: (flags.ceiling ?? 'confidential') as Classification },
      });
      console.log(renderCopyText(pack));
    } else {
      console.log('commands: status | propose | approve | reject | contact | log | context | reset');
    }
  });
}

main().catch(e => {
  console.error('エラー：' + (e as Error).message);
  process.exit(1);
});
