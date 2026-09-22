// Relative path (not "@/lib/build-info") so the Node test runner can load this module.
import { APP_VERSION } from "../build-info.ts";

export const SIMKL_API_BASE = "https://api.simkl.com";
export const SIMKL_CLIENT_ID =
  (import.meta.env?.VITE_SIMKL_CLIENT_ID as string | undefined) ||
  "9609ef0a6051b6fdcf3290fd962fd65e0f8e969c942555410cffd37afca91997";
export const SIMKL_VERIFY_URL = "https://simkl.com/pin";
export const WATCHED_RATIO = 0.85;
export const SIMKL_WATCHED_RATIO = 0.8;
export const SIMKL_APP_NAME = "harbor";
// Must track the real build version: Simkl's API answered 403 "Blocked" to the frozen
// app-name/app-version pair this used to hardcode (harbor/0.9.75), breaking account
// connection in every stable build (harborstremio/harbor#1336).
export const SIMKL_APP_VERSION = APP_VERSION;
