import { en, zhHans, zhHant } from "vuetify/locale";
import { enChatRoom } from "./locales/en.js";
import { zhChatRoom } from "./locales/zhHans.js";
import { zhHantChatRoom } from "./locales/zhHant.js";

export type { AppLocale } from "./locales/types.js";
export {
  actionMessageKey,
  appIntlLocale,
  humanizeAction,
  initialAppLocale,
  sourceMessageKey,
  statusMessageKey,
} from "./locales/helpers.js";

export const chatroomLocaleMessages = {
  en: { ...en, chatroom: enChatRoom },
  zhHans: { ...zhHans, chatroom: zhChatRoom },
  zhHant: { ...zhHant, chatroom: zhHantChatRoom },
};
