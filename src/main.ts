import './styles.css';
import { createFeed } from './feed';

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

createFeed(viewport, feedEl);
