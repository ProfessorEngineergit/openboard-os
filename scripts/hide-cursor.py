#!/usr/bin/env python3
"""Hide X11 cursors on the root and new top-level windows; restore on exit."""
import ctypes
import signal
import time
x11=ctypes.CDLL('libX11.so.6');fixes=ctypes.CDLL('libXfixes.so.3')
window=ctypes.c_ulong
x11.XOpenDisplay.argtypes=[ctypes.c_char_p];x11.XOpenDisplay.restype=ctypes.c_void_p
x11.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x11.XDefaultRootWindow.restype=window
x11.XFlush.argtypes=[ctypes.c_void_p];x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
x11.XQueryTree.argtypes=[ctypes.c_void_p,window,ctypes.POINTER(window),ctypes.POINTER(window),ctypes.POINTER(ctypes.POINTER(window)),ctypes.POINTER(ctypes.c_uint)]
x11.XFree.argtypes=[ctypes.c_void_p]
# Windows can disappear between querying and hiding. Ignore X11 BadWindow.
ERROR=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)
ignore_error=ERROR(lambda *_:0);x11.XSetErrorHandler(ignore_error)
fixes.XFixesHideCursor.argtypes=[ctypes.c_void_p,window]
display=x11.XOpenDisplay(None)
if not display:raise SystemExit('X11 display unavailable')
root=x11.XDefaultRootWindow(display);hidden=set()
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(SystemExit(0)))
try:
 while True:
  parent=window();rr=window();children=ctypes.POINTER(window)();count=ctypes.c_uint()
  targets={root}
  if x11.XQueryTree(display,root,ctypes.byref(rr),ctypes.byref(parent),ctypes.byref(children),ctypes.byref(count)):
   targets.update(children[i] for i in range(count.value))
   if children:x11.XFree(children)
  for target in targets-hidden:fixes.XFixesHideCursor(display,target)
  hidden=targets;x11.XFlush(display);time.sleep(.5)
finally:x11.XCloseDisplay(display)
