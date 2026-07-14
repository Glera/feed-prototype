import assert from 'node:assert/strict';

import { resolveTelegramStartParam } from '../src/telegram-start-param.mjs';

assert.equal(
  resolveTelegramStartParam({ search: '?tgWebAppStartParam=lab_auth' }),
  'lab_auth',
  'the URL launch parameter must route before initDataUnsafe is hydrated',
);
assert.equal(
  resolveTelegramStartParam({ hash: '#tgWebAppStartParam=lab_auth&tgWebAppVersion=9.1' }),
  'lab_auth',
  'Telegram launch service parameters in the URL fragment must be supported',
);
assert.equal(
  resolveTelegramStartParam({
    webViewStartParam: 'lab_auth',
    unsafeStartParam: 'stale_previous_launch',
  }),
  'lab_auth',
  'the SDK parsed WebView launch parameter must win over stale initDataUnsafe',
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
    search: '?tgWebAppStartParam=',
    unsafeStartParam: 'fallback',
  }),
  'fallback',
  'an empty URL parameter must not erase a valid signed launch value',
);
assert.equal(resolveTelegramStartParam(), null);

console.log('telegram start param: 8 assertions passed');
