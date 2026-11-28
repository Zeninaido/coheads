// The behavior-eval files and runner. A stand-in for `claude -p` drives the real server, so this needs no login.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantText, loadCases, loadSuite, validate } from '../src/evals/behavior';

describe('behavior evals', () => {
  test('every case and suite file is valid', () => {
    const cases = loadCases();
    const suites = ['core', 'smoke', 'baselines'].map(loadSuite);
    expect(validate(cases, suites)).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  test('the runner sets up each run, reads what reached the AI, and writes results', () => {
    if (process.env.SB_ENGINE === 'postgres') return; // runs on the local store only
    const out = mkdtempSync(join(tmpdir(), 'coheads-eval-out-'));
    const p = Bun.spawnSync({
      cmd: [process.execPath, 'run', join(import.meta.dir, '..', 'src', 'evals', 'behavior.ts'), '--suite', 'smoke'],
      env: { ...process.env, SB_CLAUDE_BIN: `${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-claude.ts')}`, SB_EVAL_OUT: out },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const log = p.stdout.toString() + p.stderr.toString();
    expect(log).toContain('合格');
    expect(p.exitCode).toBe(0);
    const json = readdirSync(out).find(f => f.endsWith('.json'))!;
    const r = JSON.parse(readFileSync(join(out, json), 'utf8'));
    const byCase = Object.fromEntries(r.runs.map((x: any) => [x.case, x]));
    expect(byCase['quote-by-contact'].contextProjects).toEqual(['a-sha']);
    expect(byCase['agenda-no-project'].contextProjects).toEqual([null]);
    expect(byCase['conflict-grounded'].contextProjects).toEqual(['A社']);
    expect(byCase['approved-overrides-docs'].answer).toContain('130,000');
    expect(existsSync(join(out, json.replace('.json', '.md')))).toBe(true);
  }, 300_000);
});

describe('what the judge reads (#41)', () => {
  test('includes the lines the AI wrote before a tool call, not only the final answer', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'チームの現行の決定事項を踏まえて作ります。' }, { type: 'tool_use', name: 'get_context', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: '…' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'アジェンダです。' }] } },
      { type: 'result', result: 'アジェンダです。' },
    ];
    expect(assistantText(events)).toBe('チームの現行の決定事項を踏まえて作ります。\n\nアジェンダです。');
  });
  test('falls back to the final answer when no text blocks were streamed', () => {
    expect(assistantText([{ type: 'result', result: '答え' }])).toBe('答え');
  });
});

describe('project instructions condition', () => {
  test('reads the text a team pastes into its Claude project', async () => {
    const { projectInstructions } = await import('../src/evals/behavior');
    const t = projectInstructions();
    expect(t.startsWith('このプロジェクトは、チームの取引先・案件の仕事をする場所です。')).toBe(true);
    expect(t.includes('```')).toBe(false);
  });
});
