import { createHash, timingSafeEqual } from 'node:crypto';

export function secureStringEqual(left, right) {
  const actual = String(left ?? '');
  const expected = String(right ?? '');
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const equalDigest = timingSafeEqual(actualDigest, expectedDigest);
  return equalDigest && Buffer.byteLength(actual, 'utf8') === Buffer.byteLength(expected, 'utf8');
}
