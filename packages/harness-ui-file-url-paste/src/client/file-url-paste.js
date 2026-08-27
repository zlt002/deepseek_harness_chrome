const FILE_URL = /file:\/\/\/[^\s<>"'`]+/gu

function isEmbeddedAsciiIdentifier(text, offset) {
  return offset > 0 && /[A-Za-z0-9+.-]/u.test(text[offset - 1])
}

/** Decode UTF-8 escapes only in independently pasted local-file URL tokens. */
export function decodePastedFileUrls(text) {
  return text.replace(FILE_URL, (url, offset, source) => {
    if (isEmbeddedAsciiIdentifier(source, offset) || !url.includes('%')) return url
    try {
      return decodeURI(url)
    } catch {
      return url
    }
  })
}
