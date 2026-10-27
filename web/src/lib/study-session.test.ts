import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markAnswered,
  markOpened,
  nextInSession,
  resumeDrill,
  savedDrill,
  startDrill,
  startSession,
} from './study-session';

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

describe('study-session', () => {
  let storage: ReturnType<typeof fakeStorage>;
  let local: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    local = fakeStorage();
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', local);
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
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('sessionStorage', denied);
    vi.stubGlobal('localStorage', denied);
    expect(() => startSession('aws', 'dop', ['Q-1'])).not.toThrow();
    expect(() => startDrill('aws', 'dop', ['Q-1'], 'all', 'random')).not.toThrow();
    expect(() => markAnswered('aws', 'dop', 'Q-1')).not.toThrow();
    expect(nextInSession('aws', 'dop', 'Q-1')).toEqual({ inSession: false, next: null });
    expect(savedDrill('aws', 'dop')).toBeNull();
  });

  describe('演習の続き', () => {
    const all = () => true;

    it('開いた問題・答えた問題の次から再開できる', () => {
      startDrill('aws', 'dop', ['Q-1', 'Q-2', 'Q-3'], 'review', 'sequential');
      expect(savedDrill('aws', 'dop')).toMatchObject({ filter: 'review', order: 'sequential', current: 'Q-1' });
      markOpened('aws', 'dop', 'Q-2');
      expect(savedDrill('aws', 'dop')?.current).toBe('Q-2');
      markAnswered('aws', 'dop', 'Q-2');
      expect(savedDrill('aws', 'dop')?.current).toBe('Q-3');

      // タブを閉じて開き直しても再開できる
      storage.items.clear();
      expect(resumeDrill('aws', 'dop', all)).toBe('Q-3');
      expect(nextInSession('aws', 'dop', 'Q-3')).toEqual({ inSession: true, next: null });
    });

    it('最後の問題に答えたら続きを消す', () => {
      startDrill('aws', 'dop', ['Q-1', 'Q-2'], 'all', 'random');
      markAnswered('aws', 'dop', 'Q-2');
      expect(savedDrill('aws', 'dop')).toBeNull();
    });

    it('問題マップから開いた並びでは続きを動かさない', () => {
      startDrill('aws', 'dop', ['Q-1', 'Q-2', 'Q-3'], 'all', 'sequential');
      startSession('aws', 'dop', ['Q-3']);
      markOpened('aws', 'dop', 'Q-3');
      markAnswered('aws', 'dop', 'Q-3');
      expect(savedDrill('aws', 'dop')?.current).toBe('Q-1');
    });

    it('別のタブで新しい演習を始めたら、古い演習のタブからは触らない', () => {
      startDrill('aws', 'dop', ['Q-1', 'Q-2'], 'all', 'sequential');
      const oldTab = new Map(storage.items);
      startDrill('aws', 'dop', ['Q-2', 'Q-1'], 'weak', 'random');
      storage.items.clear();
      oldTab.forEach((v, k) => storage.items.set(k, v));
      markAnswered('aws', 'dop', 'Q-1');
      expect(savedDrill('aws', 'dop')).toMatchObject({ filter: 'weak', current: 'Q-2' });
    });

    it('削除された問題は飛ばして再開する', () => {
      startDrill('aws', 'dop', ['Q-1', 'Q-2', 'Q-3', 'Q-4'], 'all', 'sequential');
      markOpened('aws', 'dop', 'Q-2');
      expect(resumeDrill('aws', 'dop', (id) => id !== 'Q-2')).toBe('Q-3');
      expect(savedDrill('aws', 'dop')).toMatchObject({ queue: ['Q-1', 'Q-3', 'Q-4'], current: 'Q-3' });
      expect(resumeDrill('aws', 'dop', () => false)).toBeNull();
      expect(savedDrill('aws', 'dop')).toBeNull();
    });

    it('保存が壊れている・形が違うときは続きなしとして扱う', () => {
      for (const raw of [
        '{broken',
        '{"id":"x","filter":"nope","order":"random","queue":["Q-1"],"current":"Q-1"}',
        '{"id":"x","filter":"all","order":"random","queue":["Q-1"],"current":"Q-9"}',
      ]) {
        local.items.set('study-drill:aws/dop', raw);
        expect(savedDrill('aws', 'dop')).toBeNull();
        expect(resumeDrill('aws', 'dop', all)).toBeNull();
      }
    });
  });
});
