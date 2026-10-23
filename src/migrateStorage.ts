// axe:migration — imported FIRST by main.tsx, so that it runs before every
// other module (some read localStorage as they load) and before the first
// render. See ./lib/legacyStorage.ts.
import { migrateLegacyStorage } from "./lib/legacyStorage";

migrateLegacyStorage(() => window.localStorage);
