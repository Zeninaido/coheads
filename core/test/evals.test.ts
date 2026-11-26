// The behavior-eval files and runner. A stand-in for `claude -p` drives the real server, so this needs no login.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCases, loadSuite, validate } from '../src/evals/behavior';

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
