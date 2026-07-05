import { sendSearchChatKeepResponse } from '../lib/search-chat-keep.js';

export default async function handler(req, res) {
  await sendSearchChatKeepResponse(req, res);
}
