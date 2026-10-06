using System.Buffers.Binary;

namespace Vystral.Core.Health;

/// <summary>
/// Reads an image's pixel size from the first bytes of a JPEG, PNG or WebP file without decoding it.
/// Untrusted input: every offset is bounds-checked and a malformed header yields null.
/// </summary>
public static class ImageHeader
{
    public static (int Width, int Height)? Size(ReadOnlySpan<byte> b)
    {
        if (b.Length < 24) return null;
        // PNG: signature, then the IHDR chunk.
        if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 && b[12] == (byte)'I' && b[13] == (byte)'H' && b[14] == (byte)'D' && b[15] == (byte)'R')
            return Valid(BinaryPrimitives.ReadInt32BigEndian(b[16..]), BinaryPrimitives.ReadInt32BigEndian(b[20..]));
        // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
        if (b.Length >= 30 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            var chunk = b.Slice(12, 4);
            if (chunk.SequenceEqual("VP8 "u8))
                return Valid(BinaryPrimitives.ReadUInt16LittleEndian(b[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(b[28..]) & 0x3FFF);
            if (chunk.SequenceEqual("VP8L"u8) && b[20] == 0x2F)
            {
                var bits = BinaryPrimitives.ReadUInt32LittleEndian(b[21..]);
                return Valid((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
            }
            if (chunk.SequenceEqual("VP8X"u8))
                return Valid((b[24] | b[25] << 8 | b[26] << 16) + 1, (b[27] | b[28] << 8 | b[29] << 16) + 1);
            return null;
        }
        // JPEG: walk the segments to the first start-of-frame marker.
        if (b[0] == 0xFF && b[1] == 0xD8)
        {
            var i = 2;
            while (i + 9 < b.Length)
            {
                if (b[i] != 0xFF) return null;
                var marker = b[i + 1];
                if (marker == 0xFF) { i++; continue; }
                if (marker is 0xD8 or 0x01 || marker is >= 0xD0 and <= 0xD7) { i += 2; continue; }
                var length = BinaryPrimitives.ReadUInt16BigEndian(b[(i + 2)..]);
                if (length < 2) return null;
                if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
                    return Valid(BinaryPrimitives.ReadUInt16BigEndian(b[(i + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(b[(i + 5)..]));
                i += 2 + length;
            }
        }
        return null;
    }

    private static (int, int)? Valid(int w, int h) => w is > 0 and <= 65535 && h is > 0 and <= 65535 ? (w, h) : null;
}
