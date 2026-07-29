import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAMPAIGN = path.join(__dirname, 'campaign.example.json');
const DEFAULT_ENV = path.join(__dirname, '.env');
const STATE_FILE = path.join(__dirname, '.promotion-state.json');
const PLATFORMS = new Set(['x', 'tiktok', 'instagram']);

function clean(value) {
  return String(value ?? '').trim();
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadLocalEnv(envPath = DEFAULT_ENV) {
  try {
    const fileValues = parseEnv(await fs.readFile(envPath, 'utf8'));
    for (const [key, value] of Object.entries(fileValues)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function assertHttpsUrl(value, field) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${field} must use HTTPS.`);
  }
  return url.toString();
}

function expandText(text, publicUrl) {
  return String(text || '').replaceAll('{url}', publicUrl);
}

export function validateCampaign(input, env = process.env) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.posts)) {
    throw new Error('Campaign JSON must contain a posts array.');
  }
  const publicUrl = assertHttpsUrl(
    clean(env.PROMOTION_PUBLIC_URL) || input.publicUrl,
    'publicUrl'
  );
  const ids = new Set();
  const posts = input.posts.map((raw, index) => {
    const id = clean(raw && raw.id);
    if (!id || ids.has(id)) {
      throw new Error(`posts[${index}].id is missing or duplicated.`);
    }
    ids.add(id);
    const platforms = Array.isArray(raw.platforms)
      ? [...new Set(raw.platforms.map(clean))]
      : [];
    if (!platforms.length || platforms.some((item) => !PLATFORMS.has(item))) {
      throw new Error(`posts[${index}].platforms contains an unsupported platform.`);
    }
    const text = expandText(raw.text, publicUrl);
    if (!text.trim()) throw new Error(`posts[${index}].text is required.`);
    if (platforms.includes('x') && [...text].length > 280) {
      throw new Error(`posts[${index}] exceeds the 280-character X limit.`);
    }
    const media = raw.media && typeof raw.media === 'object'
      ? {
          type: clean(raw.media.type).toLowerCase(),
          url: assertHttpsUrl(raw.media.url, `posts[${index}].media.url`)
        }
      : null;
    if (platforms.some((item) => item !== 'x') && !media) {
      throw new Error(`posts[${index}] requires media for TikTok/Instagram.`);
    }
    return {
      ...raw,
      id,
      platforms,
      text,
      media
    };
  });
  return {
    campaign: clean(input.campaign) || 'promotion',
    publicUrl,
    posts
  };
}

function requiredEnv(platform, env = process.env) {
  const required = {
    x: ['X_USER_ACCESS_TOKEN'],
    tiktok: ['TIKTOK_ACCESS_TOKEN'],
    instagram: [
      'INSTAGRAM_ACCESS_TOKEN',
      'INSTAGRAM_USER_ID',
      'INSTAGRAM_API_VERSION'
    ]
  }[platform];
  return required.filter((key) => !clean(env[key]));
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 500) };
  }
  if (!response.ok || (body && body.error && body.error.code && body.error.code !== 'ok')) {
    const message = body?.error?.message || body?.detail || body?.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function checkX(env) {
  const body = await jsonRequest('https://api.x.com/2/users/me', {
    headers: bearer(env.X_USER_ACCESS_TOKEN)
  });
  return {
    accountId: body?.data?.id || null,
    username: body?.data?.username || null
  };
}

async function checkTikTok(env) {
  const body = await jsonRequest(
    'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
    {
      method: 'POST',
      headers: {
        ...bearer(env.TIKTOK_ACCESS_TOKEN),
        'Content-Type': 'application/json'
      },
      body: '{}'
    }
  );
  return {
    username: body?.data?.creator_username || null,
    privacyLevels: body?.data?.privacy_level_options || []
  };
}

function instagramUrl(env, resource, query = '') {
  const base = clean(env.INSTAGRAM_GRAPH_BASE_URL) || 'https://graph.instagram.com';
  const version = clean(env.INSTAGRAM_API_VERSION).replace(/^\/|\/$/g, '');
  return `${base.replace(/\/$/, '')}/${version}/${resource}${query}`;
}

async function checkInstagram(env) {
  const fields = encodeURIComponent('id,username,account_type');
  const body = await jsonRequest(
    instagramUrl(env, env.INSTAGRAM_USER_ID, `?fields=${fields}`),
    { headers: bearer(env.INSTAGRAM_ACCESS_TOKEN) }
  );
  return {
    accountId: body?.id || null,
    username: body?.username || null,
    accountType: body?.account_type || null
  };
}

async function uploadXMedia(post, env) {
  if (!post.media) return null;
  if (post.media.type !== 'image') {
    throw new Error('X publisher currently supports image media; publish video manually.');
  }
  const mediaResponse = await fetch(post.media.url, {
    signal: AbortSignal.timeout(60_000)
  });
  if (!mediaResponse.ok) throw new Error(`Could not download X media: ${mediaResponse.status}`);
  const contentType = mediaResponse.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error('X media URL did not return an image.');
  const bytes = await mediaResponse.arrayBuffer();
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('X image exceeds 5 MB.');
  const form = new FormData();
  form.set('media', new Blob([bytes], { type: contentType }), 'promotion-image');
  form.set('media_category', 'tweet_image');
  form.set('media_type', contentType);
  const body = await jsonRequest('https://api.x.com/2/media/upload', {
    method: 'POST',
    headers: bearer(env.X_USER_ACCESS_TOKEN),
    body: form
  });
  return clean(body?.data?.id);
}

async function publishX(post, env) {
  const mediaId = await uploadXMedia(post, env);
  const payload = { text: post.text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const body = await jsonRequest('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      ...bearer(env.X_USER_ACCESS_TOKEN),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return { platformPostId: body?.data?.id || null };
}

async function publishTikTok(post, env) {
  const postMode = clean(env.TIKTOK_POST_MODE).toUpperCase() || 'MEDIA_UPLOAD';
  const direct = postMode === 'DIRECT_POST';
  const postInfo = direct
    ? {
        title: post.text,
        privacy_level: clean(post.privacyLevel) || 'SELF_ONLY',
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false
      }
    : { title: post.text };
  let endpoint;
  let payload;
  if (post.media.type === 'video') {
    endpoint = direct
      ? 'https://open.tiktokapis.com/v2/post/publish/video/init/'
      : 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
    payload = {
      post_info: postInfo,
      source_info: { source: 'PULL_FROM_URL', video_url: post.media.url }
    };
  } else if (post.media.type === 'photo' || post.media.type === 'image') {
    endpoint = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
    payload = {
      post_info: postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: [post.media.url]
      },
      post_mode: postMode,
      media_type: 'PHOTO'
    };
  } else {
    throw new Error('TikTok media type must be video, photo, or image.');
  }
  const body = await jsonRequest(endpoint, {
    method: 'POST',
    headers: {
      ...bearer(env.TIKTOK_ACCESS_TOKEN),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return { publishId: body?.data?.publish_id || null, postMode };
}

async function waitForInstagramContainer(containerId, env) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = await jsonRequest(
      instagramUrl(env, containerId, '?fields=status_code,status'),
      { headers: bearer(env.INSTAGRAM_ACCESS_TOKEN) }
    );
    if (body?.status_code === 'FINISHED') return;
    if (body?.status_code === 'ERROR' || body?.status_code === 'EXPIRED') {
      throw new Error(`Instagram container failed: ${body?.status || body?.status_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error('Instagram container processing timed out.');
}

async function publishInstagram(post, env) {
  const create = new URLSearchParams({
    caption: post.text
  });
  if (post.media.type === 'reel' || post.media.type === 'video') {
    create.set('media_type', 'REELS');
    create.set('video_url', post.media.url);
    create.set('share_to_feed', 'true');
  } else if (post.media.type === 'image' || post.media.type === 'photo') {
    create.set('image_url', post.media.url);
  } else {
    throw new Error('Instagram media type must be reel, video, image, or photo.');
  }
  const created = await jsonRequest(instagramUrl(env, `${env.INSTAGRAM_USER_ID}/media`), {
    method: 'POST',
    headers: {
      ...bearer(env.INSTAGRAM_ACCESS_TOKEN),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: create
  });
  const containerId = clean(created?.id);
  if (!containerId) throw new Error('Instagram did not return a container ID.');
  await waitForInstagramContainer(containerId, env);
  const publish = new URLSearchParams({
    creation_id: containerId
  });
  const body = await jsonRequest(
    instagramUrl(env, `${env.INSTAGRAM_USER_ID}/media_publish`),
    {
      method: 'POST',
      headers: {
        ...bearer(env.INSTAGRAM_ACCESS_TOKEN),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: publish
    }
  );
  return { containerId, platformPostId: body?.id || null };
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return { published: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function parseArgs(argv) {
  const args = [...argv];
  const command = clean(args.shift()).toLowerCase() || 'help';
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith('--')) throw new Error(`Unknown argument: ${key}`);
    options[key.slice(2)] = args.shift() || '';
  }
  return { command, options };
}

function usage() {
  return [
    'Usage:',
    '  node promotion/promote.mjs check --platform all',
    '  node promotion/promote.mjs dry-run --campaign promotion/campaign.example.json',
    '  node promotion/promote.mjs publish --platform x --id launch-x-ja --campaign <file>',
    '',
    'Publishing additionally requires PROMOTION_CONFIRM_PUBLISH=YES in promotion/.env.'
  ].join('\n');
}

async function main() {
  await loadLocalEnv();
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help') {
    console.log(usage());
    return;
  }
  const selected = clean(options.platform || 'all').toLowerCase();
  const platforms = selected === 'all' ? [...PLATFORMS] : [selected];
  if (platforms.some((item) => !PLATFORMS.has(item))) {
    throw new Error(`Unsupported platform: ${selected}`);
  }
  if (command === 'check') {
    for (const platform of platforms) {
      const missing = requiredEnv(platform);
      if (missing.length) {
        console.log(`${platform}: NOT CONFIGURED (${missing.join(', ')})`);
        continue;
      }
      const checker = { x: checkX, tiktok: checkTikTok, instagram: checkInstagram }[platform];
      const result = await checker(process.env);
      console.log(`${platform}: OK ${JSON.stringify(result)}`);
    }
    return;
  }
  const campaignPath = path.resolve(options.campaign || DEFAULT_CAMPAIGN);
  const campaign = validateCampaign(
    JSON.parse(await fs.readFile(campaignPath, 'utf8')),
    process.env
  );
  const matching = campaign.posts.filter((post) => {
    const matchesPlatform = selected === 'all' || post.platforms.includes(selected);
    const matchesId = !options.id || post.id === options.id;
    return matchesPlatform && matchesId;
  });
  if (!matching.length) throw new Error('No matching campaign posts.');
  if (command === 'dry-run') {
    for (const post of matching) {
      console.log(JSON.stringify({
        id: post.id,
        platforms: post.platforms,
        text: post.text,
        media: post.media
      }, null, 2));
    }
    return;
  }
  if (command !== 'publish') throw new Error(`Unknown command: ${command}`);
  if (clean(process.env.PROMOTION_CONFIRM_PUBLISH) !== 'YES') {
    throw new Error('Publishing is locked. Set PROMOTION_CONFIRM_PUBLISH=YES.');
  }
  if (selected === 'all') {
    throw new Error('Publish one platform at a time with --platform.');
  }
  const missing = requiredEnv(selected);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const state = await loadState();
  for (const post of matching.filter((item) => item.platforms.includes(selected))) {
    const stateKey = `${campaign.campaign}:${selected}:${post.id}`;
    if (state.published[stateKey]) {
      throw new Error(`Already published: ${stateKey}`);
    }
    const publisher = {
      x: publishX,
      tiktok: publishTikTok,
      instagram: publishInstagram
    }[selected];
    const result = await publisher(post, process.env);
    state.published[stateKey] = {
      at: new Date().toISOString(),
      ...result
    };
    await saveState(state);
    console.log(`${selected}: PUBLISHED ${post.id} ${JSON.stringify(result)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`promotion error: ${error.message}`);
    process.exitCode = 1;
  });
}
