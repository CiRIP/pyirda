import patch1001 from "./42101001.sb?inline"
import patch1002 from "./42101002.sb?inline"

const decode = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0))

export const STIR421X_PATCHES = [patch1001, patch1002].map(decode)
