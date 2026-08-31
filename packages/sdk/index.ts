export type { Agent, ChatRequest, ChatResponse } from "./src/agent/interface.js";
export { Bot, isLoggedIn, login, logout, start } from "./src/bot.js";
export {
  listWeixinAccountIds,
  normalizeAccountId,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "./src/auth/accounts.js";
export {
  DEFAULT_ILINK_BOT_TYPE,
  renderWeixinQrCodePng,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./src/auth/login-qr.js";
export { sendMessageWeixin } from "./src/messaging/send.js";
export { sendWeixinMediaFile } from "./src/messaging/send-media.js";
export type { LoginOptions, StartOptions } from "./src/bot.js";
