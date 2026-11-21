"""Send pointer input through XTest to the X server in DISPLAY."""

import argparse
import ctypes as c


def bind(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = arguments
    return function


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
    move = commands.add_parser("move")
    move.add_argument("x", type=int)
    move.add_argument("y", type=int)
    commands.add_parser("down")
    commands.add_parser("up")
    args = parser.parse_args()

    try:
        x11 = c.CDLL("libX11.so.6")
        xtst = c.CDLL("libXtst.so.6")
    except OSError as error:
        parser.exit(1, f"{error}\n")
    open_display = bind(x11, "XOpenDisplay", c.c_void_p, c.c_char_p)
    close_display = bind(x11, "XCloseDisplay", c.c_int, c.c_void_p)
    sync = bind(x11, "XSync", c.c_int, c.c_void_p, c.c_int)
    query = bind(xtst, "XTestQueryExtension", c.c_int, c.c_void_p, *([c.POINTER(c.c_int)] * 4))
    motion = bind(xtst, "XTestFakeMotionEvent", c.c_int, c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_ulong)
    button = bind(xtst, "XTestFakeButtonEvent", c.c_int, c.c_void_p, c.c_uint, c.c_int, c.c_ulong)

    display = open_display(None)
    if not display:
        parser.exit(1, "Could not connect to the X11 display in DISPLAY.\n")
    try:
        if not query(display, *(c.byref(c.c_int()) for _ in range(4))):
            parser.exit(1, "The X11 display does not offer the XTest extension.\n")
        if args.command == "move":
            if not motion(display, -1, args.x, args.y, 0):
                parser.exit(1, "XTest could not move the pointer.\n")
        elif args.command in ("down", "up"):
            if not button(display, 1, args.command == "down", 0):
                parser.exit(1, "XTest could not change the left mouse button state.\n")
        sync(display, 0)
    finally:
        close_display(display)


if __name__ == "__main__":
    main()
