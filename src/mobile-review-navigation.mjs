const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMPACT_UUID = /^[a-f0-9]{32}$/;

function expandUuid(value) {
  const compact = String(value || '').toLowerCase();
  if (!COMPACT_UUID.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function mobileReviewNavigation({ search = '', startParam = null } = {}) {
  const query = new URLSearchParams(String(search || ''));
  const explicit = String(query.get('mobileReview') || '').toLowerCase();
  if (UUID.test(explicit)) return Object.freeze({ requested: true, bundleId: explicit });
  const launch = String(startParam || '').toLowerCase();
  if (launch === 'review') return Object.freeze({ requested: true, bundleId: null });
  const match = launch.match(/^review_([a-f0-9]{32})$/);
  return match
    ? Object.freeze({ requested: true, bundleId: expandUuid(match[1]) })
    : Object.freeze({ requested: false, bundleId: null });
}
