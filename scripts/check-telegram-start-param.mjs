import assert from 'node:assert/strict';

import { resolveTelegramStartParam } from '../src/telegram-start-param.mjs';

assert.equal(
  resolveTelegramStartParam({ search: '?tgWebAppStartParam=lab_auth' }),
  'lab_auth',
  'the URL launch parameter must route before initDataUnsafe is hydrated',
);
assert.equal(
  resolveTelegramStartParam({ hash: '#/launch?tgWebAppStartParam=lab_auth&tgWebAppVersion=9.1' }),
  'lab_auth',
  'Telegram launch service parameters after a fragment path must be supported',
);
assert.equal(
  resolveTelegramStartParam({
    search: '?tgWebAppStartParam=lab_auth',
    webViewStartParam: 'stale_previous_launch',
    unsafeStartParam: 'stale_previous_launch',
  }),
  'lab_auth',
  'the current URL must win over SDK state restored from an older WebView',
);
assert.equal(
  resolveTelegramStartParam({
    search: '?tgWebAppStartParam=lab_auth',
    unsafeStartParam: 'stale_previous_launch',
  }),
  'lab_auth',
  'the current launch URL must win over a stale WebView value',
);
assert.equal(
  resolveTelegramStartParam({ unsafeStartParam: 'diag' }),
  'diag',
  'the existing initDataUnsafe path must remain supported',
);
assert.equal(
  resolveTelegramStartParam({ initData: 'auth_date=1&start_param=i_42692410&hash=x' }),
  'i_42692410',
  'raw initData is a final compatibility fallback',
);
assert.equal(
  resolveTelegramStartParam({
    initData: 'auth_date=1&start_param=diag&hash=x',
    webViewStartParam: 'stale_previous_launch',
  }),
  'diag',
  'current raw initData must win over restored WebView state',
);
assert.equal(
  resolveTelegramStartParam({
    search: '?tgWebAppStartParam=',
    unsafeStartParam: 'fallback',
  }),
  'fallback',
  'an empty URL parameter must not erase a valid signed launch value',
);
assert.equal(resolveTelegramStartParam(), null);

console.log('telegram start param: 9 assertions passed');
