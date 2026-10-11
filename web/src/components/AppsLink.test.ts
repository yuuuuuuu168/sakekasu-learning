import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppsLink } from './AppsLink';

describe('AppsLink', () => {
  it('4 アプリの入口の一覧へのリンクを、読み上げ用の名前つきで出す', () => {
    const html = renderToStaticMarkup(createElement(AppsLink));
    expect(html).toContain('href="https://sakekasu-builder.com/apps"');
    expect(html).toContain('aria-label="アプリ一覧"');
    expect(html).toContain('>アプリ一覧<');
    // 同じタブで移る
    expect(html).not.toContain('target=');
  });
});
