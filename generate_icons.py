#!/usr/bin/env python3
import os
import struct
import zlib

BASE = os.path.dirname(os.path.abspath(__file__))

def write_png(path, width, height, scale=1.0):
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Простий власний PNG без Pillow/ImageMagick.
    # Іконка: зелений фон + світлий круг + хвіст повідомлення.
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            nx = (x - width / 2) / (width / 2)
            ny = (y - height / 2) / (height / 2)
            d = (nx * nx + ny * ny) ** 0.5

            r, g, b, a = 22, 163, 74, 255

            # Bubble circle
            if d < 0.62:
                r, g, b = 240, 253, 244

            # Bubble tail
            if width * 0.30 < x < width * 0.48 and height * 0.62 < y < height * 0.82:
                if (y - height * 0.62) > (x - width * 0.30) * 0.75:
                    r, g, b = 240, 253, 244

            # Inner green lines
            if d < 0.38:
                if abs(y - height * 0.44) < max(1, height * 0.025) and width * 0.36 < x < width * 0.66:
                    r, g, b = 22, 163, 74
                if abs(y - height * 0.54) < max(1, height * 0.025) and width * 0.34 < x < width * 0.72:
                    r, g, b = 22, 163, 74
                if abs(y - height * 0.64) < max(1, height * 0.025) and width * 0.40 < x < width * 0.62:
                    r, g, b = 22, 163, 74

            row.extend([r, g, b, a])
        rows.append(bytes([0]) + bytes(row))

    raw = b''.join(rows)

    def chunk(name, data):
        return (
            struct.pack('>I', len(data)) +
            name +
            data +
            struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
        )

    png = (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
        chunk(b'IDAT', zlib.compress(raw, 9)) +
        chunk(b'IEND', b'')
    )

    with open(path, 'wb') as f:
        f.write(png)

for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    write_png(os.path.join(BASE, 'build', 'icons', f'{size}x{size}.png'), size, size)

write_png(os.path.join(BASE, 'assets', 'icon.png'), 512, 512)
write_png(os.path.join(BASE, 'assets', 'tray.png'), 64, 64)

print('OK: icons generated')
