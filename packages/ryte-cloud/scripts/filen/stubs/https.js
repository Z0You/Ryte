// Node-only module: the Filen SDK uses fetch/axios in the browser instead.
export function request() {
  throw new Error('https.request is not available in the browser')
}
export default { request }
