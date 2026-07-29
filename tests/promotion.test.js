import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, validateCampaign } from '../promotion/promote.mjs';

test('promotion env parser ignores comments and unwraps quoted values', () => {
  assert.deepEqual(
    parseEnv('# comment\nA=one\nB="two words"\nC=\'three\'\n'),
    { A: 'one', B: 'two words', C: 'three' }
  );
});

test('promotion campaign expands the public URL and validates X length', () => {
  const campaign = validateCampaign({
    campaign: 'test',
    publicUrl: 'https://example.com/',
    posts: [{
      id: 'x-1',
      platforms: ['x'],
      text: 'Open {url}'
    }]
  }, {});
  assert.equal(campaign.posts[0].text, 'Open https://example.com/');
  assert.throws(() => validateCampaign({
    publicUrl: 'https://example.com/',
    posts: [{
      id: 'x-2',
      platforms: ['x'],
      text: 'x'.repeat(281)
    }]
  }, {}), /280-character/);
});

test('promotion campaign requires HTTPS media for TikTok and Instagram', () => {
  assert.throws(() => validateCampaign({
    publicUrl: 'https://example.com/',
    posts: [{
      id: 'ig-1',
      platforms: ['instagram'],
      text: 'test',
      media: { type: 'image', url: 'http://example.com/a.png' }
    }]
  }, {}), /HTTPS/);
});
