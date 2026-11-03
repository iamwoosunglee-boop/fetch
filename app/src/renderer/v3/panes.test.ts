import { describe, expect, it } from 'vitest';
import { panesFit, shownWidths } from './panes';

const both = { menu: true, panel: true };
const panelOnly = { menu: false, panel: true };
const menuOnly = { menu: true, panel: false };

describe('shown pane widths', () => {
  it.each([
    ['both at their defaults', { menu: 220, panel: 340 }, both, 1100, { menu: 220, panel: 340 }],
    ['a panel past what the list leaves it', { menu: 220, panel: 560 }, both, 1100, { menu: 220, panel: 400 }],
    ['a wide menu takes the room from the panel', { menu: 320, panel: 340 }, both, 1100, { menu: 320, panel: 300 }],
    ['a menu past what the list and the panel leave it', { menu: 320, panel: 300 }, both, 1000, { menu: 220, panel: 300 }],
    ['the panel alone in a wide window', { menu: 220, panel: 560 }, panelOnly, 1100, { menu: 0, panel: 560 }],
    ['the panel alone at the narrow edge: its lower limit wins', { menu: 220, panel: 560 }, panelOnly, 720, { menu: 0, panel: 300 }],
    ['the menu alone at the narrow edge', { menu: 320, panel: 340 }, menuOnly, 720, { menu: 240, panel: 0 }],
    ['the menu alone below its room: its lower limit wins', { menu: 320, panel: 340 }, menuOnly, 600, { menu: 180, panel: 0 }],
    ['both with no room: both lower limits win', { menu: 320, panel: 560 }, both, 720, { menu: 180, panel: 300 }],
    ['nothing open', { menu: 320, panel: 560 }, { menu: false, panel: false }, 1100, { menu: 0, panel: 0 }],
  ])('%s', (_case, saved, open, width, shown) => {
    expect(shownWidths(saved, open, width)).toEqual(shown);
  });
});

describe('fitting both panes', () => {
  it.each([[1040, true], [1039, false]])('at the default widths a %ipx window fits: %s', (width, fits) => {
    expect(panesFit({ menu: 220, panel: 340 }, width)).toBe(fits);
  });

  it('follows the saved widths, not a fixed window width', () => {
    expect(panesFit({ menu: 320, panel: 560 }, 1100)).toBe(false);
    expect(panesFit({ menu: 180, panel: 300 }, 960)).toBe(true);
  });
});
