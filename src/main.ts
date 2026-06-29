import './styles.css';
import { createFeed } from './feed';
import { initTelegram } from './telegram';

// Telegram Mini App (no-op outside Telegram): fullscreen under the notch,
// disable Telegram's own vertical swipe, mirror safe-area insets into --safe-*.
initTelegram();

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

createFeed(viewport, feedEl);
