"""Measure a Markdown gesture on a private Xvfb display.

Capture a verified target region with the fixture already in its expected
state. Repeat the gesture from its starting state and wait for those pixels
to appear. Persistence samples instead wait for the expected UTF-8 body to be
read back from a file or SQLite. Configure and verify each app outside timing.
"""

import argparse
import ctypes
from hashlib import sha256
import json
import mmap
from pathlib import Path
import re
import sqlite3
import struct
import time


INK_MASK = bytes(1 if blue < 144 else 0 for blue in range(256))


def private_framebuffer(pid):
    arguments = [arg.decode() for arg in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if arg]
    if not arguments or Path(arguments[0]).name != 'Xvfb':
        raise ValueError('Expected the PID of an isolated Xvfb process')
    try:
        display = next(arg for arg in arguments if re.fullmatch(r':\d+', arg))
        directory = Path(arguments[arguments.index('-fbdir') + 1]).resolve(strict=True)
        tcp_disabled = arguments[arguments.index('-nolisten') + 1] == 'tcp'
    except (StopIteration, ValueError, IndexError) as error:
        raise ValueError('Xvfb must have an explicit display, -fbdir, and -nolisten tcp') from error
    if not tcp_disabled:
        raise ValueError('The private test display must disable TCP')
    return display, directory / 'Xvfb_screen0'


class FrameBuffer:
    def __init__(self, file, region):
        self.file = file
        self.region = region

    def __enter__(self):
        with self.file.open('rb') as handle:
            self.data = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        header = struct.unpack_from('>25I', self.data)
        header_size, version, format_id, _, width, height = header[:6]
        bits_per_pixel, self.stride = header[11:13]
        self.little_endian_blue = header[7] == 0 and header[16] == 0xff
        self.start = header_size + header[19] * 12
        self.width, self.height = width, height
        x, y, w, h = self.region
        if (version != 7 or format_id != 2 or bits_per_pixel != 32 or self.stride < width * 4
                or self.start + height * self.stride > len(self.data)
                or min(x, y) < 0 or min(w, h) < 1 or x + w > width or y + h > height):
            self.data.close()
            raise ValueError('Invalid region or unsupported XWD framebuffer layout')
        return self

    def __exit__(self, *unused):
        self.data.close()

    def digest(self):
        x, y, width, height = self.region
        signature = sha256()
        for row in range(y, y + height):
            start = self.start + row * self.stride + 4 * x
            signature.update(self.data[start:start + 4 * width])
        return signature.hexdigest()

    def describe(self):
        return {'screen': [self.width, self.height], 'region': list(self.region)}

    def ink_rows(self):
        if not self.little_endian_blue:
            raise ValueError('Ink probes require the standard Xvfb BGRA layout')
        x, y, width, height = self.region
        rows = []
        for row in range(y, y + height):
            start = self.start + row * self.stride + x * 4
            rows.append(self.data[start:start + width * 4:4].translate(INK_MASK))
        return rows

    def find_ink(self, pattern, signature):
        rows = self.ink_rows()
        return next((signature for i, row in enumerate(rows) if row == pattern[0]
                     and rows[i:i + len(pattern)] == pattern), None)


def x11_function(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = arguments
    return function


def send_gesture(display, gesture):
    x11 = ctypes.CDLL('libX11.so.6')
    xtest = ctypes.CDLL('libXtst.so.6')
    ptr, integer, ulong = ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong
    open_display = x11_function(x11, 'XOpenDisplay', ptr, ctypes.c_char_p)
    close_display = x11_function(x11, 'XCloseDisplay', integer, ptr)
    to_keysym = x11_function(x11, 'XStringToKeysym', ulong, ctypes.c_char_p)
    to_keycode = x11_function(x11, 'XKeysymToKeycode', ctypes.c_ubyte, ptr, ulong)
    send_key = x11_function(xtest, 'XTestFakeKeyEvent', integer, ptr, ctypes.c_uint, integer, ulong)
    move_mouse = x11_function(xtest, 'XTestFakeMotionEvent', integer, ptr, integer, integer, integer, ulong)
    click_button = x11_function(xtest, 'XTestFakeButtonEvent', integer, ptr, ctypes.c_uint, integer, ulong)
    flush = x11_function(x11, 'XFlush', integer, ptr)

    connection = open_display(display.encode())
    if not connection:
        raise RuntimeError(f'Cannot connect to isolated display {display}')
    try:
        click = re.fullmatch(r'click:(\d+),(\d+)', gesture)
        if click:
            x, y = map(int, click.groups())
            if not move_mouse(connection, 0, x, y, 0):
                raise RuntimeError('XTest rejected the cursor position')
            started = time.monotonic_ns()
            for down in (1, 0):
                if not click_button(connection, 1, down, 0):
                    raise RuntimeError('XTest rejected the click')
            flush(connection)
            return started
        keycodes = [to_keycode(connection, to_keysym(key.encode())) for key in gesture.split('+')]
        if 0 in keycodes:
            raise ValueError(f'Unknown X11 key in {gesture}')
        for modifier in keycodes[:-1]:
            if not send_key(connection, modifier, 1, 0):
                raise RuntimeError('XTest rejected a modifier')
        started = time.monotonic_ns()
        for keycode, down in [(keycodes[-1], 1), *((code, 0) for code in reversed(keycodes))]:
            if not send_key(connection, keycode, down, 0):
                raise RuntimeError('XTest rejected the gesture')
        flush(connection)
        return started
    finally:
        close_display(connection)


def wait_for_digest(read, expected, timeout_s, interval_s):
    deadline = time.monotonic() + timeout_s
    consecutive = 0
    while time.monotonic() < deadline:
        if read() == expected:
            if consecutive == 0:
                first = time.monotonic_ns()
            consecutive += 1
            if consecutive == 3:
                return first
        else:
            consecutive = 0
        time.sleep(interval_s)
    raise TimeoutError(f'Target did not match in {timeout_s:g} seconds')


def capture(frame, timeout_s, interval_s):
    reference = frame.digest()
    wait_for_digest(frame.digest, reference, timeout_s, interval_s)
    return {**frame.describe(), 'sha256': reference}


def file_digest(path):
    try:
        return sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def sqlite_digest(path, table, id_column, row_id, body_column):
    if any(not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*', name) for name in (table, id_column, body_column)):
        raise ValueError('Expected simple SQLite identifiers')
    if not path.is_file():
        return None
    connection = sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True, timeout=0)
    try:
        rows = connection.execute(f'SELECT "{body_column}" FROM "{table}" WHERE "{id_column}" = ?', (row_id,)).fetchall()
        if len(rows) > 1:
            raise ValueError('The persistence check must identify one row')
        return sha256(rows[0][0].encode()).hexdigest() if rows else None
    except sqlite3.OperationalError as error:
        if str(error) != 'database is locked':
            raise
        return None
    finally:
        connection.close()


def sample(display, read, expected, args):
    before = read()
    if before == expected:
        raise ValueError('Target already matches before the measured gesture')
    started = send_gesture(display, args.key)
    ended = wait_for_digest(read, expected, args.timeout, args.interval_ms / 1000)
    return {'gesture': args.key, 'beforeSha256': before, 'afterSha256': expected,
            'pollIntervalMs': args.interval_ms, 'ms': (ended - started) / 1_000_000}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--xvfb-pid', required=True, type=int)
    parser.add_argument('--timeout', type=float, default=10)
    parser.add_argument('--interval-ms', type=float, default=5)
    commands = parser.add_subparsers(dest='command', required=True)
    capture_command = commands.add_parser('capture')
    capture_command.add_argument('region', nargs=4, type=int, metavar='PIXELS', help='X Y WIDTH HEIGHT')
    ink_capture_command = commands.add_parser('capture-ink')
    ink_capture_command.add_argument('region', nargs=4, type=int, metavar='PIXELS', help='X Y WIDTH HEIGHT')
    ink_capture_command.add_argument('vertical_band', nargs=2, type=int, metavar='Y', help='TOP BOTTOM')
    frame_command = commands.add_parser('frame')
    frame_command.add_argument('key')
    frame_command.add_argument('reference', type=Path)
    ink_command = commands.add_parser('ink')
    ink_command.add_argument('key')
    ink_command.add_argument('reference', type=Path)
    file_command = commands.add_parser('file')
    file_command.add_argument('key')
    file_command.add_argument('path', type=Path)
    file_command.add_argument('expected', type=Path)
    db_command = commands.add_parser('sqlite')
    db_command.add_argument('key')
    db_command.add_argument('path', type=Path)
    db_command.add_argument('expected', type=Path)
    db_command.add_argument('table')
    db_command.add_argument('id_column')
    db_command.add_argument('row_id')
    db_command.add_argument('body_column')
    args = parser.parse_args()
    if not (0 < args.timeout <= 60 and 0 < args.interval_ms <= 100):
        parser.error('Expected positive, bounded timeout and poll interval')
    display, framebuffer = private_framebuffer(args.xvfb_pid)
    if args.command == 'capture':
        with FrameBuffer(framebuffer, args.region) as frame:
            result = capture(frame, args.timeout, args.interval_ms / 1000)
    elif args.command == 'capture-ink':
        with FrameBuffer(framebuffer, args.region) as frame:
            pattern = frame.ink_rows()
            top, bottom = args.vertical_band
            if not (0 <= top <= args.region[1] < args.region[1] + args.region[3] <= bottom <= frame.height):
                raise ValueError('The vertical band must include the captured glyphs')
            if not any(1 in row for row in pattern):
                raise ValueError('The captured region must include a dark glyph')
            result = {**frame.describe(), 'verticalBand': [top, bottom], 'inkRows': [row.hex() for row in pattern]}
    elif args.command == 'frame':
        reference = json.loads(args.reference.read_text())
        with FrameBuffer(framebuffer, reference['region']) as frame:
            if frame.describe() != {key: reference[key] for key in ('screen', 'region')}:
                raise ValueError('Frame reference has a different display size')
            result = sample(display, frame.digest, reference['sha256'], args)
    elif args.command == 'ink':
        reference = json.loads(args.reference.read_text())
        pattern = [bytes.fromhex(row) for row in reference['inkRows']]
        left, _, width, _ = reference['region']
        top, bottom = reference['verticalBand']
        if not pattern or any(len(row) != width for row in pattern) or len(pattern) > bottom - top:
            raise ValueError('Ink reference dimensions do not match the search region')
        with FrameBuffer(framebuffer, (left, top, width, bottom - top)) as frame:
            if frame.describe()['screen'] != reference['screen']:
                raise ValueError('Ink reference has a different display size')
            expected = sha256(b''.join(pattern)).hexdigest()
            result = sample(display, lambda: frame.find_ink(pattern, expected), expected, args)
    else:
        expected = sha256(args.expected.read_bytes()).hexdigest()
        if args.command == 'file':
            reader = lambda: file_digest(args.path)
        else:
            reader = lambda: sqlite_digest(args.path, args.table, args.id_column, args.row_id, args.body_column)
        result = sample(display, reader, expected, args)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
