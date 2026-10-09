/**
 * Decode the pieces of a LiveSync binary document ("newnote").
 *
 * Each piece is encoded on its own, so pieces are decoded separately and
 * concatenated; joining the strings first would leave base64 padding in the
 * middle. Current LiveSync writes base64. Older versions wrote an encoding
 * marked by a leading "%" on the first piece, in which bytes 0x26-0x7e
 * (except ":") are kept as-is and every other byte b becomes U+00C0 + b.
 *
 * Returns null when a piece is not valid in the detected encoding.
 */
export function decodeLiveSyncBinary(pieces: string[]): Uint8Array | null {
  if (pieces.length === 0) return new Uint8Array();
  const legacy = pieces[0]!.startsWith("%");
  const decoded: Uint8Array[] = [];
  for (const [index, piece] of pieces.entries()) {
    const bytes = legacy
      ? decodeLegacyPiece(index === 0 ? piece.slice(1) : piece)
      : decodeBase64Piece(piece);
    if (!bytes) return null;
    decoded.push(bytes);
  }
  const result = new Uint8Array(decoded.reduce((total, bytes) => total + bytes.length, 0));
  let offset = 0;
  for (const bytes of decoded) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}

function decodeBase64Piece(piece: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(piece);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeLegacyPiece(piece: string): Uint8Array | null {
  const bytes = new Uint8Array(piece.length);
  for (let i = 0; i < piece.length; i++) {
    const code = piece.charCodeAt(i);
    if (code >= 0x26 && code <= 0x7e && code !== 0x3a) bytes[i] = code;
    else if (code >= 0xc0 && code <= 0x1bf) bytes[i] = code - 0xc0;
    else return null;
  }
  return bytes;
}
