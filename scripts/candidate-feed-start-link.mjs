import { encodeCandidateFeedStartParam } from '../src/candidate-feed-start-param.mjs';

const [releaseId, reviewBindingDigest] = process.argv.slice(2);
if (process.argv.length !== 4) {
  throw new Error('usage: candidate-feed-start-link <v5-release-id> <review-binding-sha256>');
}
const startParam = encodeCandidateFeedStartParam({ releaseId, reviewBindingDigest });
process.stdout.write(`https://t.me/swipeit_bot?startapp=${startParam}\n`);
