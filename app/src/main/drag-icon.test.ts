import { expect, it } from 'vitest';
import { DRAG_ICON } from './drag-icon';

it('is a real PNG large enough to see while dragging', () => {
  const bytes = Buffer.from(DRAG_ICON.replace('data:image/png;base64,', ''), 'base64');
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([32, 32]);
});
