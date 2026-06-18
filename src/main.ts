import './styles.css';
import { Feed } from './feed';
import { MECHANICS } from './mechanics';

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

new Feed(viewport, feedEl, MECHANICS);
