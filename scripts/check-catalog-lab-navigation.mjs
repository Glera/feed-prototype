import assert from 'node:assert/strict';

import {
  catalogFeedUrl,
  catalogLabAuthorizationAvailable,
  catalogLabAuthRequested,
  catalogLabAuthUrl,
  catalogLabOpenedFromFeed,
} from '../src/catalog-lab-navigation.mjs';

assert.equal(catalogLabAuthorizationAvailable(true), true);
for (const unavailable of [false, undefined, null, 1, 'true']) {
  assert.equal(catalogLabAuthorizationAvailable(unavailable), false);
}

assert.equal(catalogLabAuthRequested({ startParam: 'lab_auth' }), true);
assert.equal(catalogLabAuthRequested({ search: '?labAuth=1' }), true);
assert.equal(catalogLabAuthRequested({ search: '?labAuth=true' }), false);
assert.equal(catalogLabAuthRequested({ startParam: 'diag' }), false);

const launch = 'https://swipe.example/?island=42#tgWebAppData=signed&tgWebAppVersion=9.1';
const lab = catalogLabAuthUrl(launch);
assert.equal(
  lab,
  'https://swipe.example/?island=42&labAuth=1#tgWebAppData=signed&tgWebAppVersion=9.1',
  'opening LAB must preserve the current feed state and Telegram launch fragment',
);
assert.equal(catalogLabAuthUrl(lab), lab, 'opening LAB must be idempotent');
assert.equal(catalogLabOpenedFromFeed(new URL(lab).search), true);
assert.equal(catalogLabOpenedFromFeed('?labAuth=0'), false);
assert.equal(catalogFeedUrl(lab), launch, 'Close must return to the exact feed URL');
assert.equal(
  catalogFeedUrl('https://swipe.example/?labAuth=1&diag=1#launch'),
  'https://swipe.example/?diag=1#launch',
  'Close must remove only the LAB route',
);

console.log('catalog Lab navigation: 16 assertions passed');
