// Supplemental publication check, separate from the strict per-field schema.
// A token prefix must begin a word: "zygisk-<long ZIP name>" is a filename,
// while quoted keys, authorization values and keys in URLs still match.
const credentials = /\bgh[pousr]_[A-Za-z0-9]{25,}|\bsk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function hasPublicReleaseCredentialPattern(text) {
  return credentials.test(text);
}
