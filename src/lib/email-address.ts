// Recipient check for the editable "To" field on /review (client and server). One plain address only:
// no display names, lists, or header-breaking characters.

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string): boolean {
  const v = value.trim();
  if (v.length > 254 || /[\r\n]/.test(value)) return false;
  const local = v.split("@")[0] ?? "";
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return ADDRESS.test(v) && /\.[A-Za-z]{2,}$|\.xn--[A-Za-z0-9-]+$/.test(v);
}
