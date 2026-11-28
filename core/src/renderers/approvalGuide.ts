/**
 * What the AI tells people after recording a candidate (#35). The approval page is on each person's own computer;
 * an approver who is someone else opens the same address on their computer. There is no shared or company page.
 */
export function approvalGuide(approvers: string[], url: string, shared: boolean): string {
  const who = approvers.length ? `承認できる人：${approvers.join('、')}。` : '承認できる人：いまはメンバー全員（承認する人はまだ指定されていない）。';
  return [
    `承認は、承認ページ（${url}）で人が行います。${who}`,
    `このページは、それぞれのパソコンの中で開くページです。承認する人が利用者と別の人なら、その人も自分のパソコンで同じアドレスを開くと、この候補が出ます${shared ? '（チームの共有フォルダが同期されたあと）' : ''}。`,
    '利用者には、このアドレスと承認できる人を伝えてください。ほかに承認のページやアドレス（社内の承認ページなど）はないので、案内しないでください。',
  ].join('\n');
}
