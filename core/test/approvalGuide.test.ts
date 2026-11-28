// What the AI is told after recording a candidate (#35): the page is on each person's computer, who may approve,
// and that there is no other approval page to point people to.
import { describe, expect, test } from 'bun:test';
import { approvalGuide } from '../src/renderers/approvalGuide';

describe('approval guide after a candidate is recorded', () => {
  test('names the approvers and says the page is on each computer, with no other page', () => {
    const t = approvalGuide(['佐藤'], 'http://127.0.0.1:4319/', true);
    expect(t).toContain('http://127.0.0.1:4319/');
    expect(t).toContain('承認できる人：佐藤');
    expect(t).toContain('自分のパソコンで同じアドレスを開く');
    expect(t).toContain('共有フォルダが同期されたあと');
    expect(t).toContain('ほかに承認のページやアドレス（社内の承認ページなど）はない');
    expect(t).not.toMatch(/Coheads|台帳/);
  });
  test('with nobody listed, every member may approve; outside a shared folder there is nothing to sync', () => {
    const t = approvalGuide([], 'http://127.0.0.1:4319/', false);
    expect(t).toContain('いまはメンバー全員');
    expect(t).not.toContain('同期');
  });
});
