import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drillProgress, nextInSession, startSession } from './study-session';

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

describe('study-session', () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('sessionStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('保存した並びをたどる', () => {
    startSession('aws', 'dop', ['Q-3', 'Q-1', 'Q-2']);
    expect(nextInSession('aws', 'dop', 'Q-3')).toEqual({ inSession: true, next: 'Q-1' });
    expect(nextInSession('aws', 'dop', 'Q-2')).toEqual({ inSession: true, next: null });
  });

  it('並びの外の問題や、別の資格の並びは使わない', () => {
    startSession('aws', 'dop', ['Q-1', 'Q-2']);
    expect(nextInSession('aws', 'dop', 'Q-9')).toEqual({ inSession: false, next: null });
    expect(nextInSession('aws', 'sap', 'Q-1')).toEqual({ inSession: false, next: null });
  });

  it('保存が壊れている・形が違うときは並びの外として扱う', () => {
    for (const raw of ['{broken', '{"queue":"Q-1"}', '{"queue":[1,2]}', 'null']) {
      storage.items.set('study:aws/dop', raw);
      expect(nextInSession('aws', 'dop', 'Q-1')).toEqual({ inSession: false, next: null });
    }
  });

  it('sessionStorage が使えなくても落ちない', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => startSession('aws', 'dop', ['Q-1'])).not.toThrow();
    expect(nextInSession('aws', 'dop', 'Q-1')).toEqual({ inSession: false, next: null });
    expect(drillProgress('aws', 'dop', 'Q-1', true)).toBeNull();
  });

  it('演習の中では、開いた問題・答えた問題の次を続きの位置として送る', () => {
    startSession('aws', 'dop', ['Q-1', 'Q-2'], 'd-1');
    expect(drillProgress('aws', 'dop', 'Q-1', false)).toEqual({ id: 'd-1', current: 'Q-1' });
    expect(drillProgress('aws', 'dop', 'Q-1', true)).toEqual({ id: 'd-1', current: 'Q-2' });
    // 最後の問題に答えたら続きを消す
    expect(drillProgress('aws', 'dop', 'Q-2', true)).toEqual({ id: 'd-1', current: null });
    expect(drillProgress('aws', 'dop', 'Q-9', true)).toBeNull();
  });

  it('問題マップから開いた並びでは続きを動かさない', () => {
    startSession('aws', 'dop', ['Q-1', 'Q-2']);
    expect(drillProgress('aws', 'dop', 'Q-1', true)).toBeNull();
  });
});
