/** Remove Connector credentials from every diagnostic channel. */
export function redactSensitiveDiagnostic(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*)([^\r\n;]+)/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)([^\s,;]+)/gi, '$1[REDACTED]')
}
