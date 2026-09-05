/** Chrome Native Messaging uses one little-endian uint32 length followed by UTF-8 JSON. */
export const MAX_NATIVE_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * Decode every complete Native Messaging frame from a byte buffer.
 * @param {Buffer} input - bytes accumulated from stdin.
 * @returns {{messages: unknown[], remainder: Buffer, errors: string[]}}
 */
export function decodeNativeFrames(input) {
  const messages = []
  const errors = []
  let remainder = input

  while (remainder.length >= 4) {
    const length = remainder.readUInt32LE(0)
    if (length > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error(`native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`)
    }
    const frameLength = 4 + length
    if (remainder.length < frameLength) break
    const body = remainder.subarray(4, frameLength)
    remainder = remainder.subarray(frameLength)
    try {
      messages.push(JSON.parse(body.toString('utf8')))
    } catch (error) {
      errors.push(`invalid native JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { messages, remainder, errors }
}

/**
 * Encode one Native Messaging response.
 * @param {unknown} message - JSON-serializable response value.
 * @returns {Buffer}
 */
export function encodeNativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`)
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}
