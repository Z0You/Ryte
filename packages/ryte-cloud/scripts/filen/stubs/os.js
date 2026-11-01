// Minimal "os" for the browser build of the Filen SDK (only used for Node temp paths).
export function tmpdir() {
  return '/tmp'
}
export function platform() {
  return 'browser'
}
export default { tmpdir, platform }
