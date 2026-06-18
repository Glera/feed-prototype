/**
 * Placeholder mini-game definitions for phase 1.
 *
 * These are NOT real playables yet — just visually-distinct stand-ins so we
 * can feel the feed paging. Per the brief they're intentionally near-identical
 * (same layout, only number + accent differ) so we're testing the SWIPE, not
 * reacting to flashy content. Real ~3–5 MB dummy bundles arrive when we tackle
 * background loading.
 */
export interface Mechanic {
  id: string;
  title: string;
  /** Two-stop background gradient for the game container. */
  accent: [string, string];
}

export const MECHANICS: Mechanic[] = [
  { id: 'm01', title: 'Mechanic 01', accent: ['#2b5876', '#4e4376'] },
  { id: 'm02', title: 'Mechanic 02', accent: ['#42275a', '#734b6d'] },
  { id: 'm03', title: 'Mechanic 03', accent: ['#0f2027', '#2c5364'] },
  { id: 'm04', title: 'Mechanic 04', accent: ['#3a1c71', '#d76d77'] },
  { id: 'm05', title: 'Mechanic 05', accent: ['#1f4037', '#99f2c8'] },
  { id: 'm06', title: 'Mechanic 06', accent: ['#41295a', '#2f0743'] },
];
