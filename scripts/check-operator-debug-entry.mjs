import assert from 'node:assert/strict';

import {
  debugPanelQaRouteRequested,
  operatorDebugPanelAvailable,
} from '../src/operator-debug-entry.mjs';

let assertions = 0;
const eq = (actual, expected, message) => {
  assertions += 1;
  assert.equal(actual, expected, message);
};

// The operator is whoever the SERVER says is one. Fail closed on everything
// else, including the truthy-but-not-true shapes an older/partial backend or a
// tampered response could produce.
eq(operatorDebugPanelAvailable(true), true, 'the exact server capability must reveal the entry');
for (const unavailable of [false, undefined, null, 0, 1, '', 'true', 'yes', {}, []]) {
  eq(
    operatorDebugPanelAvailable(unavailable),
    false,
    `non-operator value ${JSON.stringify(unavailable) ?? String(unavailable)} must not reveal the entry`,
  );
}

// The pre-existing QA routes are independent of the capability and keep their
// old semantics: any ?diag value, start_param=diag, or a local dev build.
eq(debugPanelQaRouteRequested({ search: '?diag=1' }), true, '?diag=1 must keep working');
eq(debugPanelQaRouteRequested({ search: '?diag' }), true, 'a bare ?diag must keep working');
eq(debugPanelQaRouteRequested({ search: '?a=1&diag=0' }), true, '?diag=0 kept its historical meaning');
eq(debugPanelQaRouteRequested({ startParam: 'diag' }), true, 'startapp=diag must keep working');
eq(debugPanelQaRouteRequested({ dev: true }), true, 'local Vite dev must keep showing the entry');

eq(debugPanelQaRouteRequested(), false, 'a plain launch must not open the QA route');
eq(debugPanelQaRouteRequested({}), false, 'an empty source set must not open the QA route');
eq(debugPanelQaRouteRequested({ search: '?labAuth=1' }), false, 'an unrelated query must not open it');
eq(debugPanelQaRouteRequested({ search: '?diagnostics=1' }), false, 'a prefix match must not open it');
eq(debugPanelQaRouteRequested({ startParam: 'lab_auth' }), false, 'an unrelated start_param must not open it');
eq(debugPanelQaRouteRequested({ startParam: 'diagnose' }), false, 'a prefix start_param must not open it');
eq(debugPanelQaRouteRequested({ dev: 'true' }), false, 'the dev flag must be an exact boolean');
eq(debugPanelQaRouteRequested({ dev: 1 }), false, 'a truthy dev flag must not open the QA route');
eq(debugPanelQaRouteRequested({ search: null, startParam: undefined }), false, 'nullish sources fail closed');

console.log(`operator debug entry: ${assertions} assertions passed`);
